// agentdb/lib/migrate.js — M11-3 one-shot absorb: autoresearch.db -> agent.db
//
// SUPERPROMPT §2 + §5.2 + ROADMAP M11-3: the unified agent.db absorbs the
// legacy ~/.pi/agent/autoresearch.db (the autoresearch lifecycle's store:
// collect-metrics.js -> `runs`, aggregate-week.js -> `proposals`). This module
// is the one-time bridge: copy `runs` + `proposals` from the source into the
// unified DB, keep a `.pre-merge` backup of the old file, and (separately, in
// lifecycle/lib/db.js) repoint the lifecycle's live dbPath at agent.db so
// `apple-pi status` / `collect` read+write the unified DB afterwards.
//
// REQ-M11-3: after migrate, `apple-pi status` reads from agent.db; old rows
// present; old db backed up.
//
// PROPOSALS COLLISION (see agentdb/lib/schema.sql): agent.db's `proposals`
// (M6-1) is the NEW setting-change proposals written by `apple-pi improve`;
// the autoresearch `proposals` is the legacy weekly brief with an incompatible
// column set. They cannot be merged without data loss or breaking improve, so
// the legacy rows land in `legacy_proposals` (distinct name, verbatim shape).
// `runs` has no collision and lands verbatim in `runs`.
//
// Best-effort + no-throw posture (matches the rest of agentdb): a missing or
// unreadable source is a no-op (ok:true, noop:true), not an error — a fresh
// install with no autoresearch history is a valid state. Bad arguments
// (non-string paths) return ok:false with failures[]. The source is ONLY ever
// read (ATTACH + SELECT; never written), so the absorb cannot corrupt it; the
// `.pre-merge` backup is the belt-and-suspenders audit trail.
//
// API: absorbAutoresearch({ from, to, backup }) -> { ok, from, to, backup,
//   backupCreated, runsCopied, proposalsCopied, noop, failures? }
//   from          : source autoresearch.db (default autoresearchPath())
//   to            : target agent.db (default agentdb.dbPath())
//   backup        : pre-merge backup path (default `${from}.pre-merge`)
//   backupCreated : true iff this call created the backup (false if it already
//                   existed — a re-run preserves the TRUE pre-merge state)
//   runsCopied    : # rows inserted/replaced into agent.db.runs
//   proposalsCopied: # rows inserted/replaced into agent.db.legacy_proposals
//   noop          : true iff the source was missing/unreadable (nothing copied)
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { dbPath: agentDbPath, piDir } = require("./db");

// UNIFIED schema (sibling of this file in agentdb/lib/). Applied to the target
// so absorb controls WHERE it writes (the `to` path), not the default dbPath().
const SCHEMA_PATH = path.join(__dirname, "schema.sql");

// openTarget(tgt) — open `tgt` read-write and ensure the unified schema is
// present (runs + legacy_proposals included). Mirrors agentdb/lib/db.js open()
// but takes an explicit path so the migrate lands rows at `to`, not at the
// ambient dbPath(). Idempotent (every stmt is CREATE ... IF NOT EXISTS).
function openTarget(tgt) {
	const db = new DatabaseSync(tgt);
	db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// autoresearchPath() — the SOURCE autoresearch.db. After lifecycle/lib/db.js
// is repointed at agent.db, the lifecycle no longer knows this path, so the
// resolver lives here. $AUTORESEARCH_DB override (mirrors the legacy env hook)
// so tests can point at a fixture.
function autoresearchPath() {
	return process.env.AUTORESEARCH_DB || `${piDir()}/agent/autoresearch.db`;
}

// Column lists verbatim from lifecycle/schema.sql. Explicit (not SELECT *) so
// the copy is robust to column-order drift and self-documents the mapping.
// Keep in sync with lifecycle/schema.sql if the autoresearch shape changes.
const RUNS_COLS = [
	"id", "run_date", "collected_at", "session_count", "total_turns",
	"tokens_in", "tokens_out", "cache_read", "cache_write", "cost",
	"compaction_count", "error_count", "tool_calls_json", "models_json",
];
const PROPOSALS_COLS = [
	"id", "created_at", "week_start", "week_end", "brief_path",
	"summary", "changes_json", "status", "applied_at", "audit",
];

// sqlLit(s) — quote a string as a SQLite string literal (escape ' to '').
function sqlLit(s) {
	return "'" + String(s).replace(/'/g, "''") + "'";
}

// tableExists(db, schema, name) — does `name` exist in `schema` (a DB alias
// like "main" or an ATTACH'd alias like "src")? Queries <schema>.sqlite_master.
function tableExists(db, schema, name) {
	const row = db.prepare(
		`SELECT count(*) c FROM ${schema}.sqlite_master WHERE type='table' AND name=?`,
	).get(name);
	return !!(row && row.c > 0);
}

// copyTable(db, srcAlias, srcTable, tgtTable, cols) — INSERT OR REPLACE the
// source table into the target (same column list). Idempotent: PK/UNIQUE
// conflicts replace, so a re-run leaves the target byte-stable (no double
// count). Returns the # of rows inserted/replaced (db.changes). Returns 0 if
// the source table is absent (a partial/legacy schema is tolerated).
function copyTable(db, srcAlias, srcTable, tgtTable, cols) {
	if (!tableExists(db, srcAlias, srcTable)) return 0;
	const colList = cols.join(", ");
	const res = db.prepare(
		`INSERT OR REPLACE INTO ${tgtTable} (${colList}) SELECT ${colList} FROM ${srcAlias}.${srcTable}`,
	).run();
	return res.changes;
}

// absorbAutoresearch({ from, to, backup }) -> see file header.
function absorbAutoresearch(opts = {}) {
	const from = opts.from;
	const to = opts.to;

	if (typeof from !== "string" || from.length === 0) {
		return { ok: false, failures: ["absorbAutoresearch: from must be a non-empty path string"] };
	}
	if (to !== undefined && (typeof to !== "string" || to.length === 0)) {
		return { ok: false, failures: ["absorbAutoresearch: to must be a non-empty path string when provided"] };
	}
	const src = from;
	const tgt = to || agentDbPath();
	const backup = opts.backup || `${src}.pre-merge`;

	// best-effort: a missing/unreadable source is a no-op, not an error.
	let srcExists = false;
	try {
		srcExists = fs.existsSync(src) && fs.statSync(src).isFile();
	} catch (_) { srcExists = false; }
	if (!srcExists) {
		return { ok: true, noop: true, from: src, to: tgt, backup,
			backupCreated: false, runsCopied: 0, proposalsCopied: 0 };
	}

	// pre-merge backup: snapshot the source BEFORE copying. create-if-not-exists
	// so an idempotent re-run preserves the TRUE pre-merge state rather than
	// overwriting it with an already-absorbed snapshot.
	let backupCreated = false;
	try {
		if (!fs.existsSync(backup)) {
			fs.copyFileSync(src, backup);
			backupCreated = true;
		}
	} catch (e) {
		return { ok: false, from: src, to: tgt, backup,
			failures: [`backup failed: ${e && e.message ? e.message : String(e)}`] };
	}

	// open the TARGET (explicit path) and ensure the unified schema (incl. runs
	// + legacy_proposals) is present before the copy.
	const db = openTarget(tgt);
	let runsCopied = 0;
	let proposalsCopied = 0;
	let attached = false;
	try {
		// ATTACH the source and copy via INSERT ... SELECT (source is only read;
		// the only writes go to the target tables). A locked/unreadable source
		// is reported as a failure rather than thrown.
		db.exec(`ATTACH DATABASE ${sqlLit(src)} AS src`);
		attached = true;
		runsCopied = copyTable(db, "src", "runs", "runs", RUNS_COLS);
		proposalsCopied = copyTable(db, "src", "proposals", "legacy_proposals", PROPOSALS_COLS);
	} catch (e) {
		return { ok: false, from: src, to: tgt, backup, backupCreated,
			failures: [`absorb failed: ${e && e.message ? e.message : String(e)}`] };
	} finally {
		if (attached) {
			try { db.exec("DETACH DATABASE src"); } catch (_) { /* already detached */ }
		}
		try { db.close(); } catch (_) { /* ignore */ }
	}

	return { ok: true, from: src, to: tgt, backup, backupCreated,
		runsCopied, proposalsCopied, noop: false };
}

module.exports = { absorbAutoresearch, autoresearchPath };
