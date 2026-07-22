// bin/apple-pi.db.test.js — REQ-M8-4
//
// `apple-pi db ingest|status|query` — the CLI surface over the durable
// Tier-B tables (sess_files / sess_events / sess_sessions / analysis_*).
//   ingest  : M4-2 append-only resume ingest (one file, a dir, or the
//             default ~/.pi/sessions), then refresh sess_sessions rollups
//   status  : row counts (files / sessions / events / errors / runs / findings)
//   query   : parameterized filter over sess_*/analysis_* (events / sessions /
//             findings / runs), --json for machine rows
//
// ACCEPTANCE (REQ-M8-4): ingest resumes append-only; status shows
// session/event counts.
//
// This suite drives the REAL bin/apple-pi wrapper as a subprocess (the path a
// user hits), points AGENT_DB + cwd at throwaway paths, and asserts:
//   - ingest:   a fresh JSONL file → exit 0 + the events land in sess_events
//   - ingest:   appending lines → only the new tail is ingested (append-only
//               resume; total grows by exactly the appended line count, no
//               dupes) — THE HEADLINE ACCEPTANCE
//   - ingest:   re-running on an unchanged file is a no-op
//   - ingest:   a directory of *.jsonl files → every file ingested
//   - status:   exit 0 + stdout reports session + event counts that match
//               the DB; --json returns the same counts as structured fields
//   - query:    events filters (--session / --type / --errors / --limit)
//               AND-compose; --json returns raw rows; runs/findings exit 0
//               even when empty (forward-compat)
//
// The fixture JSONL matches the shape ingest/sessions.parseLine consumes
// (one JSON object per line; first line is the "session" event carrying the
// id + cwd; subsequent lines are messages with role/tokens/content). Mirrors
// agentdb/ingest/incremental.test.js's builder so the CLI tests stay
// consistent with the library tests.
//
// Verify: node --test bin/apple-pi.db.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const BIN = path.join(__dirname, "apple-pi");

// --- JSONL fixture helpers (mirror agentdb/ingest/incremental.test.js) ---

// sessionLine(opts) -> one JSONL line. Object.assign defaults the timestamp.
function sessionLine(opts) {
	return JSON.stringify(Object.assign({ timestamp: "2026-01-01T00:00:00.000Z" }, opts));
}

// buildJSONL({session_id, n, startTs, intervalMs, errorAt}) -> string.
// Produces a session event on line 0 then n-1 messages. errorAt (a 1-indexed
// message number) marks ONE message is_error:true so --errors filtering has
// something to find.
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "db-cli-"));
	const dbFile = path.join(root, "agent.db");
	return { root, dbFile, env: { ...process.env, AGENT_DB: dbFile } };
}

// runDb(sub, args, { cwd, env }) — spawn the real bin/apple-pi db <sub>.
// node --no-warnings suppresses the node:sqlite ExperimentalWarning.
function runDb(sub, args, { cwd, env }) {
	const r = spawnSync(process.execPath, ["--no-warnings", BIN, "db", sub, ...args], {
		cwd, env, encoding: "utf8",
	});
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// count(dbFile, table, where=[]) -> number — convenience for DB assertions.
function count(dbFile, table, where = []) {
	const db = new DatabaseSync(dbFile);
	try {
		const sql = `SELECT COUNT(*) c FROM ${table}` + (where.length ? ` WHERE ${where.join(" AND ")}` : "");
		return db.prepare(sql).get().c;
	} finally { db.close(); }
}

function parseJson(stdout) {
	return JSON.parse(stdout);
}

// ===========================================================================
// REQ-M8-4: `apple-pi db ingest` — append-only resume (HEADLINE ACCEPTANCE)
// ===========================================================================

test("apple-pi db ingest <file>: fresh JSONL → exit 0, events land in sess_events (REQ-M8-4)", () => {
	const { root, dbFile, env } = freshRoot();
	const file = path.join(root, "sess-A.jsonl");
	fs.writeFileSync(file, buildJSONL({ session_id: "sess-A", n: 10 }), "utf8");

	const r = runDb("ingest", [file], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);

	// the file + its 10 events are in the DB
	assert.equal(count(dbFile, "sess_files"), 1, "one file ingested");
	assert.equal(count(dbFile, "sess_events"), 10, "10 events ingested");
	// ingest refreshes the aggregate rollup → sess_sessions has the session row
	assert.equal(count(dbFile, "sess_sessions"), 1, "aggregate row written");

	// stdout reports the file path it ingested
	assert.match(r.stdout, /ingest/, `stdout should report ingest; got:\n${r.stdout}`);
});

test("apple-pi db ingest: appending lines resumes APPEND-ONLY (the headline acceptance) (REQ-M8-4)", () => {
	const { root, dbFile, env } = freshRoot();
	const file = path.join(root, "sess-A.jsonl");
	const first = buildJSONL({ session_id: "sess-A", n: 50 });

	// 1. ingest 50 events
	fs.writeFileSync(file, first, "utf8");
	const r1 = runDb("ingest", [file], { cwd: root, env });
	assert.equal(r1.status, 0, `first ingest exit 0; stderr=\n${r1.stderr}`);
	assert.equal(count(dbFile, "sess_events"), 50);

	// 2. append a 10-line tail to the SAME file (prefix unchanged) and re-ingest.
	//    A correct append-only resume inserts EXACTLY the 10 new events — no
	//    dupes, no full re-ingest. Total grows 50 → 60, not 50 → 110.
	const tail = buildJSONL({ session_id: "sess-A", n: 10, startTs: "2026-01-01T00:01:00.000Z" })
		.replace(/^\{"type":"session".*\n/, ""); // drop the synthetic 2nd session event
	fs.writeFileSync(file, first + tail, "utf8");

	const r2 = runDb("ingest", [file], { cwd: root, env });
	assert.equal(r2.status, 0, `append ingest exit 0; stderr=\n${r2.stderr}`);

	assert.equal(
		count(dbFile, "sess_events", ["session_id = 'sess-A'"]),
		60,
		"append-only resume: 50 + 10 = 60 total events (no dupes)",
	);
	// still exactly one file row (same path), one session
	assert.equal(count(dbFile, "sess_files"), 1);
	assert.equal(count(dbFile, "sess_sessions"), 1);
});

test("apple-pi db ingest: re-running on an unchanged file is a no-op (REQ-M8-4)", () => {
	const { root, dbFile, env } = freshRoot();
	const file = path.join(root, "sess-A.jsonl");
	fs.writeFileSync(file, buildJSONL({ session_id: "sess-A", n: 8 }), "utf8");

	const r1 = runDb("ingest", [file], { cwd: root, env });
	assert.equal(r1.status, 0);
	assert.equal(count(dbFile, "sess_events"), 8);

	const r2 = runDb("ingest", [file], { cwd: root, env });
	assert.equal(r2.status, 0, `second ingest exit 0; stderr=\n${r2.stderr}`);
	assert.equal(count(dbFile, "sess_events"), 8, "no-op: no new events on unchanged file");
});

test("apple-pi db ingest <dir>: ingests every *.jsonl in the directory (REQ-M8-4)", () => {
	const { root, dbFile, env } = freshRoot();
	const dir = path.join(root, "sessions");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "a.jsonl"), buildJSONL({ session_id: "sess-A", n: 5 }), "utf8");
	fs.writeFileSync(path.join(dir, "b.jsonl"), buildJSONL({ session_id: "sess-B", n: 7 }), "utf8");
	fs.writeFileSync(path.join(dir, "not-json.txt"), "ignore me\n", "utf8"); // non-jsonl → skipped

	const r = runDb("ingest", [dir], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	assert.equal(count(dbFile, "sess_files"), 2, "two jsonl files ingested");
	assert.equal(count(dbFile, "sess_events"), 12, "5 + 7 events");
	assert.equal(count(dbFile, "sess_sessions"), 2, "two aggregate rows");
});

test("apple-pi db ingest <missing>: exits non-zero with an error (REQ-M8-4 red-blue)", () => {
	const { root, env } = freshRoot();
	const r = runDb("ingest", [path.join(root, "nope.jsonl")], { cwd: root, env });
	assert.notEqual(r.status, 0, "missing file must exit non-zero");
	assert.match(r.stderr, /nope\.jsonl|cannot read|no such/i, "stderr should name the missing path");
});

// ===========================================================================
// REQ-M8-4: `apple-pi db status` — shows session/event counts
// ===========================================================================

test("apple-pi db status: exit 0 + stdout reports session + event counts (REQ-M8-4)", () => {
	const { root, dbFile, env } = freshRoot();
	const dir = path.join(root, "sessions");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "a.jsonl"), buildJSONL({ session_id: "sess-A", n: 10 }), "utf8");
	fs.writeFileSync(path.join(dir, "b.jsonl"), buildJSONL({ session_id: "sess-B", n: 6 }), "utf8");

	// seed the DB via ingest, then ask status
	runDb("ingest", [dir], { cwd: root, env });

	const r = runDb("status", [], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);

	// ACCEPTANCE: "status shows session/event counts" — stdout carries the
	// counts, and they match the DB (2 files, 2 sessions, 16 events).
	assert.match(r.stdout, /sessions?\s*:?\s*2/i, `should report 2 sessions; got:\n${r.stdout}`);
	assert.match(r.stdout, /events?\s*:?\s*16/i, `should report 16 events; got:\n${r.stdout}`);
});

test("apple-pi db status --json: structured counts match the DB (REQ-M8-4)", () => {
	const { root, dbFile, env } = freshRoot();
	const file = path.join(root, "sess-A.jsonl");
	fs.writeFileSync(file, buildJSONL({ session_id: "sess-A", n: 10, errorAt: 3 }), "utf8");
	runDb("ingest", [file], { cwd: root, env });

	const r = runDb("status", ["--json"], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	const out = parseJson(r.stdout);
	assert.equal(out.files, 1, "files == sess_files count");
	assert.equal(out.sessions, 1, "sessions == sess_sessions count");
	assert.equal(out.events, 10, "events == sess_events count");
	assert.equal(out.errors, 1, "errors == is_error=1 count");
	// analysis tables exist in the schema; counts are 0 here (no analyze run)
	assert.equal(out.runs, 0);
	assert.equal(out.findings, 0);
});

test("apple-pi db status on an empty DB: exit 0 + zero counts (REQ-M8-4 forward-compat)", () => {
	const { root, env } = freshRoot();
	const r = runDb("status", ["--json"], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	const out = parseJson(r.stdout);
	assert.equal(out.files, 0);
	assert.equal(out.sessions, 0);
	assert.equal(out.events, 0);
});

// ===========================================================================
// REQ-M8-4: `apple-pi db query` — parameterized filter over sess_*/analysis_*
// ===========================================================================

test("apple-pi db query events --json: returns the events as rows (REQ-M8-4)", () => {
	const { root, env } = freshRoot();
	const file = path.join(root, "sess-A.jsonl");
	fs.writeFileSync(file, buildJSONL({ session_id: "sess-A", n: 5 }), "utf8");
	runDb("ingest", [file], { cwd: root, env });

	const r = runDb("query", ["events", "--json"], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	const rows = parseJson(r.stdout);
	assert.equal(rows.length, 5, "5 events");
	// rows carry the useful metadata columns (no verbatim event_json blob)
	const ev0 = rows.find(x => x.type === "session");
	assert.ok(ev0, "session event present");
	assert.equal(ev0.session_id, "sess-A");
});

test("apple-pi db query events --session narrows by session_id (REQ-M8-4)", () => {
	const { root, env } = freshRoot();
	const dir = path.join(root, "sessions");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "a.jsonl"), buildJSONL({ session_id: "sess-A", n: 5 }), "utf8");
	fs.writeFileSync(path.join(dir, "b.jsonl"), buildJSONL({ session_id: "sess-B", n: 4 }), "utf8");
	runDb("ingest", [dir], { cwd: root, env });

	const r = runDb("query", ["events", "--session", "sess-B", "--json"], { cwd: root, env });
	assert.equal(r.status, 0);
	const rows = parseJson(r.stdout);
	assert.equal(rows.length, 4, "--session narrows to sess-B's events");
	assert.ok(rows.every(x => x.session_id === "sess-B"), "all rows belong to sess-B");
});

test("apple-pi db query events --type narrows by event type (REQ-M8-4)", () => {
	const { root, env } = freshRoot();
	const file = path.join(root, "sess-A.jsonl");
	fs.writeFileSync(file, buildJSONL({ session_id: "sess-A", n: 10 }), "utf8");
	runDb("ingest", [file], { cwd: root, env });

	const r = runDb("query", ["events", "--type", "session", "--json"], { cwd: root, env });
	assert.equal(r.status, 0);
	const rows = parseJson(r.stdout);
	assert.equal(rows.length, 1, "exactly one 'session' event per file");
	assert.equal(rows[0].type, "session");
});

test("apple-pi db query events --errors returns only error events (REQ-M8-4)", () => {
	const { root, env } = freshRoot();
	const file = path.join(root, "sess-A.jsonl");
	// n=10 with one marked error at message index 3
	fs.writeFileSync(file, buildJSONL({ session_id: "sess-A", n: 10, errorAt: 3 }), "utf8");
	runDb("ingest", [file], { cwd: root, env });

	const r = runDb("query", ["events", "--errors", "--json"], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	const rows = parseJson(r.stdout);
	assert.equal(rows.length, 1, "exactly one error event");
	assert.equal(rows[0].is_error, 1);
});

test("apple-pi db query events --limit caps the row count (REQ-M8-4)", () => {
	const { root, env } = freshRoot();
	const file = path.join(root, "sess-A.jsonl");
	fs.writeFileSync(file, buildJSONL({ session_id: "sess-A", n: 20 }), "utf8");
	runDb("ingest", [file], { cwd: root, env });

	const r = runDb("query", ["events", "--limit", "5", "--json"], { cwd: root, env });
	assert.equal(r.status, 0);
	assert.equal(parseJson(r.stdout).length, 5, "--limit caps rows");
});

test("apple-pi db query sessions --json: returns the aggregate rows (REQ-M8-4)", () => {
	const { root, env } = freshRoot();
	const dir = path.join(root, "sessions");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "a.jsonl"), buildJSONL({ session_id: "sess-A", n: 10 }), "utf8");
	fs.writeFileSync(path.join(dir, "b.jsonl"), buildJSONL({ session_id: "sess-B", n: 6 }), "utf8");
	runDb("ingest", [dir], { cwd: root, env });

	const r = runDb("query", ["sessions", "--json"], { cwd: root, env });
	assert.equal(r.status, 0);
	const rows = parseJson(r.stdout);
	assert.equal(rows.length, 2);
	const ids = rows.map(x => x.session_id).sort();
	assert.deepEqual(ids, ["sess-A", "sess-B"]);
	// the rollup carries message_count + token totals
	const a = rows.find(x => x.session_id === "sess-A");
	assert.ok(a.message_count >= 1);
	assert.ok(a.tokens_in > 0);
});

test("apple-pi db query runs / findings: exit 0 + empty array when no analyze run (REQ-M8-4 forward-compat)", () => {
	const { root, env } = freshRoot();
	for (const table of ["runs", "findings"]) {
		const r = runDb("query", [table, "--json"], { cwd: root, env });
		assert.equal(r.status, 0, `${table}: exit 0 even when empty; stderr=\n${r.stderr}`);
		assert.deepEqual(parseJson(r.stdout), [], `${table} empty -> []`);
	}
});

test("apple-pi db query <bogus-table>: exits non-zero (REQ-M8-4 red-blue)", () => {
	const { root, env } = freshRoot();
	const r = runDb("query", ["nope", "--json"], { cwd: root, env });
	assert.notEqual(r.status, 0, "unknown table must exit non-zero");
	assert.match(r.stderr, /nope|unknown/i, "stderr should name the bad table");
});
