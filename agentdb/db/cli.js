// agentdb/db/cli.js — `apple-pi db <subcommand>` dispatch (M8-4).
//
//   apple-pi db ingest [<path>] [--json]        append-only resume ingest (M4-2)
//        <path>  a *.jsonl file OR a directory of them (flat); default
//                ~/.pi/sessions ($PI_CODING_AGENT_DIR-aware)
//   apple-pi db status [--json]                 row counts (sess_*/analysis_*)
//   apple-pi db query <table> [filters] [--json]   parameterized filter over
//        events | sessions | findings | runs      sess_*/analysis_*
//
// ROADMAP M8-4: the CLI surface over the durable Tier-B tables. `ingest` wraps
// M4-2's ingestFile (append-only resume via prefix_hash) and refreshes the
// M4-3 sess_sessions rollup for every session it touched — so `status` and
// `query sessions` see fresh aggregates without a separate step. `status` is
// the dashboard read (file/session/event/error/run/finding counts). `query`
// is the parameterized, AND-composed filter (all SQL bound via ? — no string
// concat into a WHERE clause; red-blue: the only thing a caller can steer is
// the value bound to a placeholder, never the SQL shape).
//
// Read-only on the world EXCEPT ingest: ingest writes sess_files/sess_events
// (Tier B) + sess_sessions (Tier B rollup). It never touches kb_* (Tier A) —
// the tier-isolation contract from M2-2 holds. analysis_runs/analysis_findings
// are read-only here (analyze owns them).
//
// The DB path is whatever lib/db.js resolves ($AGENT_DB, else
// ~/.pi/agent/agent.db) — so a test or an operator points a throwaway
// AGENT_DB at the work without ever touching the live DB. Mirrors
// agentdb/cli.js + agentdb/analysis/cli.js + vault/cli.js: CommonJS, run(args)
// entry, node: built-ins only.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { open, piDir } = require("../lib/db");
const { ingestFile } = require("../ingest/incremental");
const { recompute } = require("../ingest/aggregates");
const { prune } = require("../ingest/prune");

// --- flag parsing --------------------------------------------------------
// Minimal parser matching agentdb/cli.js's shape: value flags consume the
// next arg; bool flags are presence-only; unknown --flags are ignored
// (forward-compat); anything else is a positional.
const VALUE_FLAGS = new Set([
	"--session", "--type", "--tool", "--role", "--model",
	"--severity", "--detector", "--run", "--limit",
	"--before",
]);
const BOOL_FLAGS = new Set(["--json", "--errors", "--yes", "--dry"]);

function parseOpts(args) {
	const out = { values: {}, bools: {}, positionals: [] };
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (BOOL_FLAGS.has(a)) { out.bools[a] = true; continue; }
		if (VALUE_FLAGS.has(a)) {
			out.values[a] = args[i + 1];
			i++; // consume the value
			continue;
		}
		if (a.startsWith("--")) continue; // unknown flag → ignore
		out.positionals.push(a);
	}
	return out;
}

// intOrUndef(s) -> number|undefined. Only a clean integer string coerces;
// anything else returns undefined so the caller can reject loudly rather
// than binding a bogus value.
function intOrUndef(s) {
	if (typeof s === "string" && /^-?\d+$/.test(s.trim())) return Number(s);
	return undefined;
}

// --- ingest --------------------------------------------------------------

// resolveIngestFiles(positional) -> { ok, files, label } | { ok:false, errors }.
// A positional that's a file → [file]; a dir → its flat *.jsonl entries
// (sorted, for deterministic output); missing → ok:false. No positional →
// the default pi sessions dir (best-effort: a missing default dir yields []
// with ok:true, matching reconcileNow's best-effort contract).
function resolveIngestFiles(positional) {
	const target = positional || path.join(piDir(), "sessions");
	let st;
	try {
		st = fs.statSync(target);
	} catch (e) {
		// A missing EXPLICIT path is a user error (exit 1). A missing DEFAULT
		// sessions dir is "nothing to ingest yet" (exit 0, zero files) — the
		// same best-effort posture as the watch reconcile path.
		if (!positional) return { ok: true, files: [], label: target };
		return { ok: false, errors: [`ingest: no such file or directory: '${target}'`] };
	}
	if (st.isFile()) return { ok: true, files: [target], label: target };
	if (st.isDirectory()) {
		let entries = [];
		try {
			entries = fs.readdirSync(target, { withFileTypes: true })
				.filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
				.map((d) => path.join(target, d.name))
				.sort();
		} catch (e) {
			return { ok: false, errors: [`ingest: cannot read directory '${target}' (${e.code || e.message})`] };
		}
		return { ok: true, files: entries, label: target };
	}
	return { ok: false, errors: [`ingest: not a file or directory: '${target}'`] };
}

// ingestCmd(args) -> exit code. Ingests every resolved file (append-only
// resume via ingestFile), then refreshes the sess_sessions rollup for every
// session touched. ingestFile never throws (returns {ok, stats, errors?});
// a single bad file is reported but never aborts the batch — mirrors the
// best-effort posture of reconcileNow / the kb primitives.
function ingestCmd(args) {
	const opts = parseOpts(args);
	const json = !!opts.bools["--json"];
	const resolved = resolveIngestFiles(opts.positionals[0]);
	if (!resolved.ok) {
		for (const e of resolved.errors) console.error(`apple-pi db ingest: ${e}`);
		return 1;
	}

	const db = open();
	const touched = new Set(); // session_ids whose rollup needs a refresh
	const totals = { files: 0, changed: 0, noop: 0, inserted: 0, appended: 0, skipped: 0, errors: 0, deleted: 0 };
	try {
		for (const file of resolved.files) {
			totals.files++;
			let res;
			try {
				res = ingestFile(db, file);
			} catch (e) {
				totals.errors++;
				if (!json) console.error(`apple-pi db ingest: ${file}: ${e.message}`);
				continue;
			}
			if (!res.ok) {
				totals.errors += (res.stats && res.stats.errors) ? 0 : 1;
				for (const e of (res.errors || [])) {
					totals.errors++;
					if (!json) console.error(`apple-pi db ingest: ${file}: ${e}`);
				}
				continue;
			}
			const s = res.stats || {};
			totals.inserted += s.ingested || 0;
			totals.appended += s.appended || 0;
			totals.skipped += s.skipped || 0;
			totals.deleted += s.deleted || 0;
			totals.errors += s.errors || 0;
			const changed = (s.ingested || 0) + (s.appended || 0) + (s.deleted || 0) > 0;
			if (changed) {
				totals.changed++;
				// look up the session_id for this file so we can refresh its rollup
				try {
					const row = db.prepare("SELECT session_id FROM sess_files WHERE file_path = ?").get(file);
					if (row && row.session_id) touched.add(row.session_id);
				} catch (_) { /* best-effort: rollup refresh is a nicety, not a gate */ }
			} else {
				totals.noop++;
			}
		}

		// refresh the sess_sessions rollup for every session we touched. Idempotent
		// (INSERT OR REPLACE); a recompute never throws (returns {ok, errors?}).
		for (const sid of touched) {
			try { recompute(db, sid); } catch (_) { /* best-effort */ }
		}
	} finally {
		db.close();
	}

	if (json) {
		process.stdout.write(JSON.stringify({
			path: resolved.label, files: totals.files, changed: totals.changed, noop: totals.noop,
			inserted: totals.inserted, appended: totals.appended, skipped: totals.skipped,
			deleted: totals.deleted, errors: totals.errors,
			sessions: touched.size,
		}, null, 2) + "\n");
		return 0;
	}
	console.log(`apple-pi db ingest: ${resolved.label}`);
	console.log(`  files      : ${totals.files} processed, ${totals.changed} changed, ${totals.noop} no-op`);
	console.log(`  events     : ${totals.inserted} inserted, ${totals.appended} appended, ${totals.skipped} skipped`);
	console.log(`  sessions   : ${touched.size} rollup${touched.size === 1 ? "" : "s"} refreshed`);
	if (totals.deleted) console.log(`  re-ingested: ${totals.deleted} old event${totals.deleted === 1 ? "" : "s"} deleted`);
	if (totals.errors) console.log(`  errors     : ${totals.errors}`);
	return 0;
}

// --- status --------------------------------------------------------------

// safeCount(db, sql) -> number. A missing table / failed read returns 0
// (forward-compat: a fresh DB has the tables, but a count must never break
// status). Used for the optional analysis_* counts.
function safeCount(db, sql, ...params) {
	try { return db.prepare(sql).get(...params).c; } catch (_) { return 0; }
}

// statusCmd(args) -> exit code. Row counts across the durable Tier-B tables.
function statusCmd(args) {
	const opts = parseOpts(args);
	const json = !!opts.bools["--json"];
	const db = open();
	let out;
	try {
		const files = safeCount(db, "SELECT COUNT(*) c FROM sess_files");
		const sessions = safeCount(db, "SELECT COUNT(*) c FROM sess_sessions");
		const events = safeCount(db, "SELECT COUNT(*) c FROM sess_events");
		const errors = safeCount(db, "SELECT COUNT(*) c FROM sess_events WHERE is_error = 1");
		const runs = safeCount(db, "SELECT COUNT(*) c FROM analysis_runs");
		const findings = safeCount(db, "SELECT COUNT(*) c FROM analysis_findings");
		out = { files, sessions, events, errors, runs, findings };
	} finally {
		db.close();
	}

	if (json) {
		process.stdout.write(JSON.stringify(out, null, 2) + "\n");
		return 0;
	}
	console.log("apple-pi db status");
	console.log(`  files    : ${out.files}     (sess_files — ingested session files)`);
	console.log(`  sessions : ${out.sessions}    (sess_sessions — aggregate rollups)`);
	console.log(`  events   : ${out.events}   (sess_events — parsed events)`);
	console.log(`  errors   : ${out.errors}   (sess_events with is_error=1)`);
	console.log(`  runs     : ${out.runs}     (analysis_runs)`);
	console.log(`  findings : ${out.findings} (analysis_findings)`);
	return 0;
}

// --- query ---------------------------------------------------------------

// Per-table column projections (the useful metadata; we deliberately omit the
// verbatim event_json blob from events). Kept as a constant so the SELECT +
// the --json row shape stay in one place.
const QUERY_DEFS = {
	events: {
		columns: "session_id, seq, type, ts, role, tool, tokens_in, tokens_out, is_error",
		order: "session_id, seq",
		filters: {
			"--session": (v) => ["session_id = ?", v],
			"--type": (v) => ["type = ?", v],
			"--tool": (v) => ["tool = ?", v],
			"--role": (v) => ["role = ?", v],
		},
		bools: { "--errors": "is_error = 1" },
	},
	sessions: {
		columns: "session_id, started_at, ended_at, last_event_at, message_count, tool_call_count, error_count, tokens_in, tokens_out, cost, model, cwd",
		order: "started_at DESC NULLS LAST, session_id",
		filters: {
			"--model": (v) => ["model = ?", v],
		},
		bools: {},
	},
	findings: {
		columns: "id, run_id, detector, severity, title, detected_at",
		order: "detected_at DESC, id DESC",
		filters: {
			"--severity": (v) => ["severity = ?", v],
			"--detector": (v) => ["detector = ?", v],
			"--run": (v) => ["run_id = ?", v],
		},
		bools: {},
	},
	runs: {
		columns: "id, started_at, ended_at, model, tokens_in, tokens_out, finding_count",
		order: "started_at DESC, id DESC",
		filters: {},
		bools: {},
	},
};

// queryCmd(args) -> exit code. Parameterized, AND-composed filter over the
// supported tables. Every caller-supplied value is bound via ? — the SQL
// shape is fixed per table, so a caller can only steer bound values, never
// inject. --limit caps the row count (default 1000 to keep a runaway query
// bounded; pass --limit 0 for unlimited).
function queryCmd(args) {
	const opts = parseOpts(args);
	const json = !!opts.bools["--json"];
	const table = opts.positionals[0];
	const def = QUERY_DEFS[table];
	if (!def) {
		console.error(`apple-pi db query: unknown table '${table ?? ""}' (try one of: ${Object.keys(QUERY_DEFS).join(", ")})`);
		return 2;
	}

	const where = [];
	const params = [];
	for (const [flag, fn] of Object.entries(def.filters)) {
		if (opts.values[flag] !== undefined) {
			const [clause, val] = fn(opts.values[flag]);
			where.push(clause);
			params.push(val);
		}
	}
	for (const [flag, clause] of Object.entries(def.bools)) {
		if (opts.bools[flag]) where.push(clause);
	}

	let limit = 1000;
	if (opts.values["--limit"] !== undefined) {
		const n = intOrUndef(opts.values["--limit"]);
		if (n === undefined || n < 0) {
			console.error(`apple-pi db query: --limit must be a non-negative integer (got '${opts.values["--limit"]}')`);
			return 2;
		}
		limit = n;
	}

	let sql = `SELECT ${def.columns} FROM ${table === "events" ? "sess_events" : table === "sessions" ? "sess_sessions" : table === "findings" ? "analysis_findings" : "analysis_runs"}`;
	if (where.length) sql += " WHERE " + where.join(" AND ");
	sql += ` ORDER BY ${def.order}`;
	if (limit > 0) { sql += " LIMIT ?"; params.push(limit); }

	const db = open();
	let rows;
	try {
		rows = db.prepare(sql).all(...params);
	} catch (e) {
		console.error(`apple-pi db query: ${e.message}`);
		return 1;
	} finally {
		db.close();
	}

	if (json) {
		process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
		return 0;
	}
	console.log(`apple-pi db query ${table}`);
	for (const r of rows) {
		const c = table === "events"
			? `${r.session_id} seq=${r.seq} ${r.type}${r.role ? "/" + r.role : ""}${r.tool ? " tool=" + r.tool : ""}${r.is_error ? " ERR" : ""}`
			: table === "sessions"
				? `${r.session_id} msgs=${r.message_count} tok_in=${r.tokens_in} tok_out=${r.tokens_out}${r.model ? " " + r.model : ""}`
				: table === "findings"
					? `[${r.id}] run=${r.run_id} ${r.severity} ${r.detector}: ${r.title}`
					: `[${r.id}] ${r.started_at}${r.model ? " " + r.model : ""} findings=${r.finding_count}`;
		console.log(`  ${c}`);
	}
	console.log(`  ${table}: ${rows.length}`);
	return 0;
}

// --- prune --------------------------------------------------------------

// pruneCmd(args) -> exit code. Wraps M4-4's prune (agentdb/ingest/prune.js):
// dry-run (default) counts the rows older than --before; --yes actually
// deletes them, scoped to sess_events/sess_sessions/sess_files ONLY.
// kb_* (Tier A) + analysis_*/proposals (analysis tier) are NEVER touched —
// the tier-isolation invariant is owned by prune()'s PRUNE_TABLES whitelist.
// Every prune (dry or yes) is logged to analysis_runs.notes (audit trail).
//
// RED-BLUE: --before is required + validated by prune()/parseDate (bad date
// → ok:false, no mutation). dry is the DEFAULT (--dry is an explicit no-op
// marker); --yes is the sole gate to mutate. The CLI never lets the caller
// steer which tables are pruned — the whitelist is fixed in the primitive.
function pruneCmd(args) {
	const opts = parseOpts(args);
	const json = !!opts.bools["--json"];
	const yes = !!opts.bools["--yes"];
	const dry = !yes; // --dry is accepted as an explicit marker; default is dry
	const before = opts.values["--before"];

	if (before === undefined) {
		console.error("apple-pi db prune: --before <YYYY-MM-DD|ISO8601> is required (try 'apple-pi db help')");
		return 2;
	}

	const db = open();
	let res;
	try {
		res = prune({ db, before, dry });
	} finally {
		db.close();
	}

	if (!res.ok) {
		for (const e of (res.errors || ["prune: failed"])) console.error(`apple-pi db ${e}`);
		return 1;
	}

	if (json) {
		const out = { ok: true, dry: res.dry, before: res.before };
		if (res.dry) out.counts = res.counts;
		else out.deleted = res.deleted;
		process.stdout.write(JSON.stringify(out, null, 2) + "\n");
		return 0;
	}

	const c = res.dry ? res.counts : res.deleted;
	const suffix = res.dry ? "" : " deleted";
	console.log("apple-pi db prune");
	console.log(`  before   : ${res.before}`);
	console.log(`  mode     : ${res.dry ? "dry-run (no rows deleted; pass --yes to delete)" : "yes (rows DELETED)"}`);
	console.log(`  events   : ${c.sess_events}${suffix}`);
	console.log(`  sessions : ${c.sess_sessions}${suffix}`);
	console.log(`  files    : ${c.sess_files}${suffix}`);
	console.log(`  audit    : logged to analysis_runs.notes`);
	return 0;
}

// --- dispatch ------------------------------------------------------------

function help() {
	console.log(`apple-pi db — durable Tier-B (sess_*/analysis_*) CLI

  ingest [<path>] [--json]        append-only resume ingest (M4-2)
        <path>  a *.jsonl file OR a dir of them (flat); default ~/.pi/sessions
        refreshes the sess_sessions rollup for every session touched

  status [--json]                 row counts (files / sessions / events /
                                  errors / runs / findings)

  query <table> [filters] [--json]   parameterized filter (AND-composed)
        tables: events | sessions | findings | runs
        events filters:   --session ID --type T --tool NAME --role R --errors
        sessions filters: --model M
        findings filters: --severity S --detector D --run N
        all tables:       --limit N (default 1000; 0 = unlimited)

  prune --before <date> [--yes] [--dry] [--json]   opt-in retention (M4-4)
        <date>  YYYY-MM-DD or ISO8601; rows older than this are eligible
        (default)  DRY-RUN: report the counts, write nothing
        --yes      actually delete sess_events/sess_sessions/sess_files
        --dry      explicit dry-run marker (default is already dry)
        scoped to sess_* ONLY — kb_* (Tier A) + analysis_*/proposals are
        NEVER pruned; every run is logged to analysis_runs.notes

  DB path is $AGENT_DB, else ~/.pi/agent/agent.db.
  ingest writes sess_* only (Tier B); it never touches kb_* (Tier A).`);
}

function run(args) {
	const [sub, ...rest] = Array.isArray(args) ? args : [];
	switch (sub) {
		case undefined:
		case "-h":
		case "--help":
		case "help":
			return help();
		case "ingest":
			return ingestCmd(rest);
		case "status":
			return statusCmd(rest);
		case "query":
			return queryCmd(rest);
		case "prune":
			return pruneCmd(rest);
		default:
			console.error(`apple-pi db: unknown subcommand '${sub}' (try 'apple-pi db help')`);
			return 2;
	}
}

module.exports = { run, ingestCmd, statusCmd, queryCmd, pruneCmd, help, parseOpts, resolveIngestFiles };
