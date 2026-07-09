// bin/apple-pi.db.prune.test.js — REQ-M8-8
//
// `apple-pi db prune --before <date>` — the CLI surface over M4-4's prune.
//   prune  : dry-run (default) reports the rows that would be deleted;
//            --yes actually deletes them. Scoped to sess_* only —
//            kb_* (Tier A) + analysis_*/proposals (analysis tier) are
//            NEVER touched, even with --yes. Each prune is logged to
//            analysis_runs.notes (the audit trail).
//
// ACCEPTANCE (REQ-M8-8): dry vs yes; kb_*/analysis_* untouched.
//
// This suite drives the REAL bin/apple-pi wrapper as a subprocess (the path a
// user hits), points AGENT_DB + cwd at throwaway paths, and asserts:
//   - dry (default): exit 0 + stdout reports the to-be-deleted counts +
//     the DB is UNCHANGED (rows survive) — THE DRY HEADLINE
//   - --dry explicit: same as default (no rows deleted)
//   - --yes:         exit 0 + the OLD session's sess_* rows are DELETED and
//     the NEW session's rows SURVIVE — THE YES HEADLINE
//   - tier isolation: --yes on a future date deletes every sess_* row but
//     leaves kb_cards / proposals byte-identical and only ADDS the audit
//     row to analysis_runs (RED-BLUE: the CLI wrapper must not weaken the
//     M4-4 tier-isolation invariant)
//   - --before is required + validated: missing → exit non-zero; a bad
//     date string → exit non-zero (no mutation)
//   - --json: structured { ok, dry, before, counts|deleted }
//
// The fixture JSONL matches the shape ingest/sessions.parseLine consumes
// (mirrors bin/apple-pi.db.test.js's builder). Two sessions are ingested via
// the REAL `apple-pi db ingest` path; the OLD session's sess_files.ingested_at
// is back-dated via SQL because ingested_at is ingest-time (today), not
// event-time — a back-date makes all three prune columns agree the session
// is "old", so the test is deterministic across the events/sessions/files
// tables at once.
//
// Verify: node --test bin/apple-pi.db.prune.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const BIN = path.join(__dirname, "apple-pi");

// --- JSONL fixture helpers (mirror bin/apple-pi.db.test.js) ---

// sessionLine(opts) -> one JSONL line. Object.assign defaults the timestamp.
function sessionLine(opts) {
	return JSON.stringify(Object.assign({ timestamp: "2026-01-01T00:00:00.000Z" }, opts));
}

// buildJSONL({session_id, n, startTs, intervalMs, errorAt}) -> string.
// Produces a session event on line 0 then n-1 messages. The event timestamps
// derive from startTs so a "2025-12" start yields 2025-12 sess_events.ts rows.
function buildJSONL(opts) {
	const {
		session_id = "sess-A", n = 10,
		startTs = "2026-01-01T00:00:00.000Z", intervalMs = 1000, errorAt = null,
	} = opts;
	const lines = [];
	lines.push(sessionLine({ type: "session", id: session_id, timestamp: startTs, cwd: "/work" }));
	for (let i = 1; i < n; i++) {
		const ts = new Date(new Date(startTs).getTime() + i * intervalMs).toISOString();
		const ev = {
			type: "message",
			role: i % 2 === 0 ? "user" : "assistant",
			timestamp: ts,
			tokens_in: i * 10,
			tokens_out: i * 5,
			content: `msg ${i}`,
		};
		if (errorAt === i) ev.is_error = true;
		lines.push(sessionLine(ev));
	}
	return lines.join("\n") + "\n";
}

// freshRoot() -> { root, dbFile, env } — a tmpdir + an isolated DB path.
function freshRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "db-prune-cli-"));
	const dbFile = path.join(root, "agent.db");
	return { root, dbFile, env: { ...process.env, AGENT_DB: dbFile } };
}

// runDb(sub, args, { cwd, env }) — spawn the real bin/apple-pi db prune …
// node --no-warnings suppresses the node:sqlite ExperimentalWarning.
function runDb(args, { cwd, env }) {
	const r = spawnSync(process.execPath, ["--no-warnings", BIN, "db", "prune", ...args], {
		cwd, env, encoding: "utf8",
	});
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ingest(dbFile, root, env, file) — drive the REAL ingest CLI to populate
// sess_* (proves prune works against the real ingest data path).
function ingest(file, { cwd, env }) {
	return spawnSync(process.execPath, ["--no-warnings", BIN, "db", "ingest", file], {
		cwd, env, encoding: "utf8",
	});
}

// count(dbFile, table, where=[]) -> number — convenience for DB assertions.
function count(dbFile, table, where = []) {
	const db = new DatabaseSync(dbFile);
	try {
		const sql = `SELECT COUNT(*) c FROM ${table}` + (where.length ? ` WHERE ${where.join(" AND ")}` : "");
		return db.prepare(sql).get().c;
	} finally { db.close(); }
}

// backDateIngestedAt(dbFile, session_id, ts) — sess_files.ingested_at is
// ingest-time (today), not event-time. Back-date it so all three prune
// columns (sess_events.ts / sess_sessions.last_event_at / sess_files.ingested_at)
// agree this session is "old" relative to --before. (sess_events.ts +
// sess_sessions.last_event_at already come from the JSONL timestamps.)
function backDateIngestedAt(dbFile, session_id, ts) {
	const db = new DatabaseSync(dbFile);
	try {
		db.prepare("UPDATE sess_files SET ingested_at = ? WHERE session_id = ?").run(ts, session_id);
	} finally { db.close(); }
}

// seedTierRows(dbFile) — drop a kb_cards row (Tier A) + an analysis_runs row +
// a proposals row (analysis tier) directly, so a tier-isolation prune can
// assert they survive byte-identical. Mirrors agentdb/ingest/prune.test.js.
function seedTierRows(dbFile) {
	const db = new DatabaseSync(dbFile);
	try {
		db.prepare(
			`INSERT INTO kb_cards (id, title, status, file_path, frontmatter_json, body, file_hash)
			 VALUES ('c-1', 'Old card', 'done', '/x/c-1.card.md', '{}', '', 'hash-c-1')`,
		).run();
		db.prepare(
			`INSERT INTO analysis_runs (started_at, ended_at, finding_count, notes)
			 VALUES ('2025-12-01T00:00:00.000Z', '2025-12-01T00:00:00.000Z', 0, 'pre-existing audit row')`,
		).run();
		db.prepare(
			`INSERT INTO proposals (setting, rationale, proposed_at, source_finding_ids_json)
			 VALUES ('agent.max_turns', 'old proposal', '2025-12-01T00:00:00.000Z', '[]')`,
		).run();
	} finally { db.close(); }
}

function parseJson(stdout) {
	return JSON.parse(stdout);
}

// ===========================================================================
// REQ-M8-8: dry (default) vs --yes (HEADLINE ACCEPTANCE)
// ===========================================================================

test("apple-pi db prune --before: DRY (default) reports counts, writes nothing (REQ-M8-8)", () => {
	const { root, dbFile, env } = freshRoot();
	// OLD session: events in 2025-12; NEW session: events in 2026-06.
	const oldFile = path.join(root, "old.jsonl");
	const newFile = path.join(root, "new.jsonl");
	fs.writeFileSync(oldFile, buildJSONL({ session_id: "sess-old", n: 10, startTs: "2025-12-01T00:00:00.000Z" }), "utf8");
	fs.writeFileSync(newFile, buildJSONL({ session_id: "sess-new", n: 6, startTs: "2026-06-01T00:00:00.000Z" }), "utf8");

	// populate via the REAL ingest path
	assert.equal(ingest(oldFile, { cwd: root, env }).status, 0);
	assert.equal(ingest(newFile, { cwd: root, env }).status, 0);
	// back-date the OLD session's ingested_at so files match too (see helper)
	backDateIngestedAt(dbFile, "sess-old", "2025-12-01T00:01:00.000Z");

	const eventsBefore = count(dbFile, "sess_events");
	const sessionsBefore = count(dbFile, "sess_sessions");
	const filesBefore = count(dbFile, "sess_files");

	// dry-run is the DEFAULT (no --yes)
	const r = runDb(["--before", "2026-01-01"], { cwd: root, env });
	assert.equal(r.status, 0, `dry exit 0; stderr=\n${r.stderr}`);

	// stdout reports what WOULD be pruned: the OLD session only (10 events,
	// 1 session, 1 file). NEW (6 events) is newer than the threshold.
	assert.match(r.stdout, /prune/i, `stdout should report prune; got:\n${r.stdout}`);
	assert.match(r.stdout, /dry/i, `dry-run should be labelled; got:\n${r.stdout}`);
	assert.match(r.stdout, /10/, `should report the 10 old events; got:\n${r.stdout}`);

	// THE DRY HEADLINE: DB is UNCHANGED — nothing deleted.
	assert.equal(count(dbFile, "sess_events"), eventsBefore, "dry-run must not delete events");
	assert.equal(count(dbFile, "sess_sessions"), sessionsBefore, "dry-run must not delete sessions");
	assert.equal(count(dbFile, "sess_files"), filesBefore, "dry-run must not delete files");
});

test("apple-pi db prune --before --yes: YES deletes the OLD rows, keeps NEW (REQ-M8-8)", () => {
	const { root, dbFile, env } = freshRoot();
	const oldFile = path.join(root, "old.jsonl");
	const newFile = path.join(root, "new.jsonl");
	fs.writeFileSync(oldFile, buildJSONL({ session_id: "sess-old", n: 10, startTs: "2025-12-01T00:00:00.000Z" }), "utf8");
	fs.writeFileSync(newFile, buildJSONL({ session_id: "sess-new", n: 6, startTs: "2026-06-01T00:00:00.000Z" }), "utf8");
	assert.equal(ingest(oldFile, { cwd: root, env }).status, 0);
	assert.equal(ingest(newFile, { cwd: root, env }).status, 0);
	backDateIngestedAt(dbFile, "sess-old", "2025-12-01T00:01:00.000Z");

	// THE YES HEADLINE: --yes actually deletes.
	const r = runDb(["--before", "2026-01-01", "--yes"], { cwd: root, env });
	assert.equal(r.status, 0, `yes exit 0; stderr=\n${r.stderr}`);

	// OLD session fully removed across all three sess_* tables; NEW survives.
	assert.equal(count(dbFile, "sess_events", ["session_id = 'sess-old'"]), 0, "old events deleted");
	assert.equal(count(dbFile, "sess_events", ["session_id = 'sess-new'"]), 6, "new events survive");
	assert.equal(count(dbFile, "sess_sessions", ["session_id = 'sess-old'"]), 0, "old session deleted");
	assert.equal(count(dbFile, "sess_sessions", ["session_id = 'sess-new'"]), 1, "new session survives");
	assert.equal(count(dbFile, "sess_files", ["session_id = 'sess-old'"]), 0, "old file deleted");
	assert.equal(count(dbFile, "sess_files", ["session_id = 'sess-new'"]), 1, "new file survives");
});

test("apple-pi db prune --before --dry: explicit dry is the same as the default (REQ-M8-8)", () => {
	const { root, dbFile, env } = freshRoot();
	const file = path.join(root, "old.jsonl");
	fs.writeFileSync(file, buildJSONL({ session_id: "sess-old", n: 5, startTs: "2025-12-01T00:00:00.000Z" }), "utf8");
	assert.equal(ingest(file, { cwd: root, env }).status, 0);
	backDateIngestedAt(dbFile, "sess-old", "2025-12-01T00:01:00.000Z");
	const before = count(dbFile, "sess_events");

	const r = runDb(["--before", "2026-01-01", "--dry"], { cwd: root, env });
	assert.equal(r.status, 0, `--dry exit 0; stderr=\n${r.stderr}`);
	assert.equal(count(dbFile, "sess_events"), before, "--dry writes nothing");
});

// ===========================================================================
// REQ-M8-8: tier isolation — kb_*/analysis_*/proposals untouched (RED-BLUE)
// ===========================================================================

test("apple-pi db prune --yes never touches kb_*/proposals and only ADDS the audit row (REQ-M8-8 red-blue)", () => {
	const { root, dbFile, env } = freshRoot();
	const file = path.join(root, "old.jsonl");
	fs.writeFileSync(file, buildJSONL({ session_id: "sess-old", n: 4, startTs: "2025-12-01T00:00:00.000Z" }), "utf8");
	assert.equal(ingest(file, { cwd: root, env }).status, 0);
	seedTierRows(dbFile); // Tier A (kb_cards) + analysis tier (analysis_runs + proposals)

	const kbBefore = count(dbFile, "kb_cards");
	const propBefore = count(dbFile, "proposals");
	const analysisBefore = count(dbFile, "analysis_runs");

	// A FUTURE before date prunes EVERY sess_* row (ingested_at=today < 2099).
	const r = runDb(["--before", "2099-01-01", "--yes"], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);

	// Tier A: kb_cards byte-identical.
	assert.equal(count(dbFile, "kb_cards"), kbBefore, "kb_cards never pruned");
	// analysis tier: proposals byte-identical.
	assert.equal(count(dbFile, "proposals"), propBefore, "proposals never pruned");
	// analysis_runs: the PRE-EXISTING row survives; the prune only ADDS its
	// own audit row (notes LIKE 'PRUNE-%'). So total grows by exactly 1 and
	// the pre-existing note is still present.
	assert.equal(count(dbFile, "analysis_runs"), analysisBefore + 1, "only the audit row was added");
	const db = new DatabaseSync(dbFile);
	let preSurvives = false;
	try {
		preSurvives = !!db.prepare("SELECT 1 FROM analysis_runs WHERE notes = 'pre-existing audit row'").get();
	} finally { db.close(); }
	assert.ok(preSurvives, "the pre-existing analysis_runs row survives the prune");
	// sess_*: all gone (every row was older than 2099).
	assert.equal(count(dbFile, "sess_events"), 0, "all sess_events pruned");
	assert.equal(count(dbFile, "sess_sessions"), 0, "all sess_sessions pruned");
	assert.equal(count(dbFile, "sess_files"), 0, "all sess_files pruned");
});

// ===========================================================================
// REQ-M8-8: argument validation (RED-BLUE)
// ===========================================================================

test("apple-pi db prune with no --before: exits non-zero (REQ-M8-8 red-blue)", () => {
	const { root, env } = freshRoot();
	const r = runDb([], { cwd: root, env });
	assert.notEqual(r.status, 0, "missing --before must exit non-zero");
	assert.match(r.stderr, /before/i, "stderr should name the missing --before");
});

test("apple-pi db prune --yes with no --before: still exits non-zero (REQ-M8-8 red-blue)", () => {
	const { root, env } = freshRoot();
	const r = runDb(["--yes"], { cwd: root, env });
	assert.notEqual(r.status, 0, "--yes does not exempt --before");
	assert.match(r.stderr, /before/i, "stderr should name the missing --before");
});

test("apple-pi db prune --before <bad-date>: exits non-zero, no mutation (REQ-M8-8 red-blue)", () => {
	const { root, dbFile, env } = freshRoot();
	const file = path.join(root, "old.jsonl");
	fs.writeFileSync(file, buildJSONL({ session_id: "sess-old", n: 3, startTs: "2025-12-01T00:00:00.000Z" }), "utf8");
	assert.equal(ingest(file, { cwd: root, env }).status, 0);
	const before = count(dbFile, "sess_events");

	const r = runDb(["--before", "yesterday", "--yes"], { cwd: root, env });
	assert.notEqual(r.status, 0, "bad date must exit non-zero even with --yes");
	assert.match(r.stderr, /before|date|iso/i, "stderr should explain the bad date");
	// no mutation: a bad date must not delete anything.
	assert.equal(count(dbFile, "sess_events"), before, "bad date deletes nothing");
});

// ===========================================================================
// REQ-M8-8: --json (machine-readable)
// ===========================================================================

test("apple-pi db prune --before --json (dry): structured counts (REQ-M8-8)", () => {
	const { root, dbFile, env } = freshRoot();
	const file = path.join(root, "old.jsonl");
	fs.writeFileSync(file, buildJSONL({ session_id: "sess-old", n: 8, startTs: "2025-12-01T00:00:00.000Z" }), "utf8");
	assert.equal(ingest(file, { cwd: root, env }).status, 0);
	backDateIngestedAt(dbFile, "sess-old", "2025-12-01T00:01:00.000Z");

	const r = runDb(["--before", "2026-01-01", "--json"], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	const out = parseJson(r.stdout);
	assert.equal(out.ok, true);
	assert.equal(out.dry, true, "default is dry");
	assert.equal(out.before, "2026-01-01T00:00:00.000Z");
	assert.equal(out.counts.sess_events, 8, "8 events match the threshold");
	assert.equal(out.counts.sess_sessions, 1);
	assert.equal(out.counts.sess_files, 1);
	// nothing deleted by a dry-run
	assert.equal(count(dbFile, "sess_events"), 8, "dry-run wrote nothing");
});

test("apple-pi db prune --before --yes --json: structured deleted (REQ-M8-8)", () => {
	const { root, dbFile, env } = freshRoot();
	const file = path.join(root, "old.jsonl");
	fs.writeFileSync(file, buildJSONL({ session_id: "sess-old", n: 7, startTs: "2025-12-01T00:00:00.000Z" }), "utf8");
	assert.equal(ingest(file, { cwd: root, env }).status, 0);
	backDateIngestedAt(dbFile, "sess-old", "2025-12-01T00:01:00.000Z");

	const r = runDb(["--before", "2026-01-01", "--yes", "--json"], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	const out = parseJson(r.stdout);
	assert.equal(out.ok, true);
	assert.equal(out.dry, false, "--yes deletes");
	assert.equal(out.before, "2026-01-01T00:00:00.000Z");
	assert.equal(out.deleted.sess_events, 7, "7 events deleted");
	assert.equal(out.deleted.sess_sessions, 1);
	assert.equal(out.deleted.sess_files, 1);
	assert.equal(count(dbFile, "sess_events"), 0, "rows actually gone");
});
