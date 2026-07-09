// agentdb/pi/query.test.js — pi agent tool db_query (M9-4).
//
// ROADMAP M9-4 acceptance gate (REQ-M9-4): "parameterized query; no mutation;
// returns JSON." This is the testable JS core of the pi tool; the pi extension
// (.ts harness binding) is a thin wrapper over this module (M9-6).
//
// What "parameterized query; no mutation; returns JSON" means, concretely:
//   - db_query is the read-only agent surface over the durable Tier-B tables
//     (sess_events / sess_sessions / analysis_findings / analysis_runs). It is
//     the same parameterized, AND-composed filter the `apple-pi db query` CLI
//     (M8-4) exposes — surfaced as a tool so an agent can ask "my last N
//     errors" or "sessions that touched card X" without leaving the loop.
//   - PARAMETERIZED: every caller-supplied value is bound via ? — never string-
//     concatenated into the WHERE. The only thing a caller can steer is the
//     value bound to a placeholder, never the SQL shape (mirrors kb/query.js).
//   - NO MUTATION: the tool fires SELECTs only — it never INSERTs/UPDATEs/
//     DELETEs anything. A query leaves every Tier-B row count byte-identical.
//   - RETURNS JSON: the result is a plain { ok, rows } object that round-trips
//     through JSON.stringify cleanly (the pi harness ships it verbatim as tool
//     result text; no BigInt / Buffer / undefined leaks).
//
// Best-effort, no-throw (mirrors pi/list.js): an unknown table or a bad filter
// returns { ok:false, error|errors } rather than throwing. The tool runs in TWO
// modes (mirrors pi/list.js / pi/next.js): (a) an injected db (tests +
// composition — caller owns the connection, no open/close), and (b) opening its
// OWN connection via lib/db.open() (the real "pi harness" path). Unlike the
// kb_* tools, NO ensureCurrent reconcile runs on the opens-own-db path —
// sess_*/analysis_* are authoritative in the DB itself (updated by `db ingest`
// / `analyze`, not mirrored from files), so there is nothing to reconcile.
//
// Test shape mirrors pi/list.test.js (injected-db happy path + opens-own-db
// path + red-blue) + db/cli.js QUERY_DEFS (the table/filter/column contract).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { db_query } = require("./query");
const { open } = require("../lib/db");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

// --- shared helpers (mirror pi/list.test.js) ---

// freshDB() — in-memory kb+tierB with the canonical schema applied.
function freshDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// insertSession(db, fields) — direct insert into sess_sessions.
function insertSession(db, f) {
	db.prepare(
		`INSERT INTO sess_sessions (session_id, started_at, ended_at, last_event_at,
		   message_count, tool_call_count, error_count, tokens_in, tokens_out, cost,
		   model, cwd, tool_calls_json, file_path)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		f.session_id, f.started_at ?? null, f.ended_at ?? null, f.last_event_at ?? null,
		f.message_count ?? 0, f.tool_call_count ?? 0, f.error_count ?? 0,
		f.tokens_in ?? 0, f.tokens_out ?? 0, f.cost ?? 0,
		f.model ?? null, f.cwd ?? null,
		JSON.stringify(f.tool_calls ?? {}), f.file_path ?? null,
	);
}

// insertEvent(db, fields) — direct insert into sess_events.
function insertEvent(db, f) {
	db.prepare(
		`INSERT INTO sess_events (session_id, seq, type, ts, role, tool,
		   tokens_in, tokens_out, is_error, content_sha, event_json)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		f.session_id, f.seq, f.type, f.ts ?? null, f.role ?? null, f.tool ?? null,
		f.tokens_in ?? 0, f.tokens_out ?? 0, f.is_error ? 1 : 0,
		f.content_sha ?? null, f.event_json ?? "{}",
	);
}

// insertRun(db, fields) — direct insert into analysis_runs.
function insertRun(db, f) {
	db.prepare(
		`INSERT INTO analysis_runs (id, started_at, ended_at, model, tokens_in,
		   tokens_out, finding_count, notes)
		 VALUES (?,?,?,?,?,?,?,?)`,
	).run(
		f.id, f.started_at ?? null, f.ended_at ?? null, f.model ?? null,
		f.tokens_in ?? 0, f.tokens_out ?? 0, f.finding_count ?? 0, f.notes ?? null,
	);
}

// insertFinding(db, fields) — direct insert into analysis_findings.
function insertFinding(db, f) {
	db.prepare(
		`INSERT INTO analysis_findings (id, run_id, detector, severity, title,
		   evidence_json, proposal_id, detected_at)
		 VALUES (?,?,?,?,?,?,?,?)`,
	).run(
		f.id, f.run_id, f.detector, f.severity, f.title,
		JSON.stringify(f.evidence ?? {}), f.proposal_id ?? null,
		f.detected_at ?? "2026-07-02T22:00:00.000Z",
	);
}

// seed(db) — 2 sessions, 6 events (2 errors), 1 run, 2 findings. Exercises
// every table + every filter axis the tool exposes.
function seed(db) {
	// sessions
	insertSession(db, {
		session_id: "s1", started_at: "2026-07-01T10:00:00Z", ended_at: "2026-07-01T11:00:00Z",
		last_event_at: "2026-07-01T11:00:00Z", message_count: 4, tool_call_count: 2,
		error_count: 1, tokens_in: 1000, tokens_out: 500, cost: 0.02,
		model: "glm-5.1", cwd: "/proj/alpha",
	});
	insertSession(db, {
		session_id: "s2", started_at: "2026-07-02T10:00:00Z", ended_at: "2026-07-02T10:30:00Z",
		last_event_at: "2026-07-02T10:30:00Z", message_count: 2, tool_call_count: 1,
		error_count: 1, tokens_in: 400, tokens_out: 100, cost: 0.01,
		model: "minimax-m3", cwd: "/proj/beta",
	});
	// events (session_id, seq order)
	insertEvent(db, { session_id: "s1", seq: 0, type: "session", ts: "2026-07-01T10:00:00Z" });
	insertEvent(db, { session_id: "s1", seq: 1, type: "message", ts: "2026-07-01T10:01:00Z", role: "user" });
	insertEvent(db, { session_id: "s1", seq: 2, type: "tool_call", ts: "2026-07-01T10:02:00Z", tool: "bash", tokens_out: 50 });
	insertEvent(db, { session_id: "s1", seq: 3, type: "tool_call", ts: "2026-07-01T10:03:00Z", tool: "bash", is_error: true });
	insertEvent(db, { session_id: "s2", seq: 0, type: "session", ts: "2026-07-02T10:00:00Z" });
	insertEvent(db, { session_id: "s2", seq: 1, type: "tool_call", ts: "2026-07-02T10:05:00Z", tool: "read", is_error: true });
	// run
	insertRun(db, { id: 1, started_at: "2026-07-03T00:00:00Z", ended_at: "2026-07-03T00:10:00Z", model: "glm-5.1", finding_count: 2 });
	// findings (detected_at DESC, id DESC order)
	insertFinding(db, { id: 1, run_id: 1, detector: "error_pattern", severity: "warn", title: "bash errors", detected_at: "2026-07-03T00:05:00Z" });
	insertFinding(db, { id: 2, run_id: 1, detector: "cost_spike", severity: "critical", title: "cost up", detected_at: "2026-07-03T00:06:00Z" });
}

function countOf(db, table) {
	return db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
}

// =====================================================================
// db_query — injected-db happy path: events
// =====================================================================

test("db_query events returns all rows in (session_id, seq) order with the CLI column shape", () => {
	const db = freshDB();
	seed(db);
	const res = db_query({ table: "events", db });
	assert.equal(res.ok, true);
	assert.equal(res.rows.length, 6, "all 6 seeded events returned");

	// default order is session_id, seq — matches `apple-pi db query events`
	const keys = res.rows.map(r => `${r.session_id}/${r.seq}`);
	assert.deepEqual(keys, ["s1/0", "s1/1", "s1/2", "s1/3", "s2/0", "s2/1"]);

	// the events projection omits the verbatim event_json blob (matches QUERY_DEFS)
	assert.deepEqual(
		Object.keys(res.rows[0]).sort(),
		["is_error", "role", "seq", "session_id", "tokens_in", "tokens_out", "tool", "ts", "type"],
		"events row has exactly the QUERY_DEFS columns (no event_json blob)",
	);
});

test("db_query result is JSON-serializable (the pi harness round-trips it)", () => {
	const db = freshDB();
	seed(db);
	const res = db_query({ table: "events", db });
	const json = JSON.stringify(res); // must not throw
	const back = JSON.parse(json);
	assert.equal(back.ok, true);
	assert.equal(back.rows.length, 6);
});

// =====================================================================
// db_query — parameterized filters
// =====================================================================

test("db_query events errors:true -> only the error events (the 'last N errors' shape)", () => {
	const db = freshDB();
	seed(db);
	const res = db_query({ table: "events", filters: { errors: true }, db });
	assert.equal(res.ok, true);
	assert.equal(res.rows.length, 2, "2 error events across both sessions");
	assert.ok(res.rows.every(r => r.is_error === 1), "every returned row is an error");
});

test("db_query events errors:false is ignored (only true narrows) — matches the bool filter contract", () => {
	const db = freshDB();
	seed(db);
	const res = db_query({ table: "events", filters: { errors: false }, db });
	assert.equal(res.ok, true);
	assert.equal(res.rows.length, 6, "errors:false is not a filter — all rows returned");
});

test("db_query events filters compose with AND (session + tool)", () => {
	const db = freshDB();
	seed(db);
	const res = db_query({ table: "events", filters: { session: "s1", tool: "bash" }, db });
	assert.equal(res.ok, true);
	assert.deepEqual(res.rows.map(r => `${r.session_id}/${r.seq}`), ["s1/2", "s1/3"],
		"only s1's bash tool calls");
});

test("db_query events filter by type / role", () => {
	const db = freshDB();
	seed(db);
	const r1 = db_query({ table: "events", filters: { type: "session" }, db });
	assert.equal(r1.ok, true);
	assert.equal(r1.rows.length, 2, "2 session events");
	const r2 = db_query({ table: "events", filters: { role: "user" }, db });
	assert.equal(r2.ok, true);
	assert.equal(r2.rows.length, 1, "1 user-role event");
});

test("db_query events limit caps the row count (last-N semantics)", () => {
	const db = freshDB();
	seed(db);
	const res = db_query({ table: "events", opts: { limit: 2 }, db });
	assert.equal(res.ok, true);
	assert.equal(res.rows.length, 2);
	assert.deepEqual(res.rows.map(r => `${r.session_id}/${r.seq}`), ["s1/0", "s1/1"],
		"limit applies in the default (session_id, seq) order");
});

test("db_query events limit:0 = unlimited", () => {
	const db = freshDB();
	seed(db);
	const res = db_query({ table: "events", opts: { limit: 0 }, db });
	assert.equal(res.ok, true);
	assert.equal(res.rows.length, 6, "limit 0 returns everything");
});

// =====================================================================
// db_query — sessions (incl. cwd substring = 'sessions that touched X')
// =====================================================================

test("db_query sessions returns rows ordered by started_at DESC NULLS LAST", () => {
	const db = freshDB();
	seed(db);
	const res = db_query({ table: "sessions", db });
	assert.equal(res.ok, true);
	assert.equal(res.rows.length, 2);
	assert.deepEqual(res.rows.map(r => r.session_id), ["s2", "s1"], "newest first");
	assert.equal(res.rows[0].model, "minimax-m3");
});

test("db_query sessions filter by model", () => {
	const db = freshDB();
	seed(db);
	const res = db_query({ table: "sessions", filters: { model: "glm-5.1" }, db });
	assert.equal(res.ok, true);
	assert.deepEqual(res.rows.map(r => r.session_id), ["s1"]);
});

test("db_query sessions filter by cwd substring ('sessions that touched project X')", () => {
	const db = freshDB();
	seed(db);
	const res = db_query({ table: "sessions", filters: { cwd: "proj/alpha" }, db });
	assert.equal(res.ok, true);
	assert.deepEqual(res.rows.map(r => r.session_id), ["s1"], "cwd LIKE match narrows to alpha");
	// the substring is a literal bound value — a non-matching project returns []
	const res2 = db_query({ table: "sessions", filters: { cwd: "proj/gamma" }, db });
	assert.equal(res2.ok, true);
	assert.equal(res2.rows.length, 0);
});

// =====================================================================
// db_query — findings + runs
// =====================================================================

test("db_query findings returns rows ordered by detected_at DESC, id DESC", () => {
	const db = freshDB();
	seed(db);
	const res = db_query({ table: "findings", db });
	assert.equal(res.ok, true);
	assert.equal(res.rows.length, 2);
	assert.deepEqual(res.rows.map(r => r.id), [2, 1], "id 2 detected later -> first");
});

test("db_query findings filter by severity / detector / run", () => {
	const db = freshDB();
	seed(db);
	const sev = db_query({ table: "findings", filters: { severity: "critical" }, db });
	assert.equal(sev.ok, true);
	assert.deepEqual(sev.rows.map(r => r.id), [2]);
	const det = db_query({ table: "findings", filters: { detector: "error_pattern" }, db });
	assert.equal(det.ok, true);
	assert.deepEqual(det.rows.map(r => r.id), [1]);
	const run = db_query({ table: "findings", filters: { run: 1 }, db });
	assert.equal(run.ok, true);
	assert.equal(run.rows.length, 2, "both findings belong to run 1");
});

test("db_query runs returns rows ordered by started_at DESC, id DESC", () => {
	const db = freshDB();
	seed(db);
	insertRun(db, { id: 2, started_at: "2026-07-04T00:00:00Z", finding_count: 0 });
	const res = db_query({ table: "runs", db });
	assert.equal(res.ok, true);
	assert.equal(res.rows.length, 2);
	assert.deepEqual(res.rows.map(r => r.id), [2, 1], "newest run first");
});

// =====================================================================
// db_query — bad input (best-effort, no-throw)
// =====================================================================

test("db_query unknown table -> { ok:false, error } (no SQL fired)", () => {
	const db = freshDB();
	seed(db);
	const res = db_query({ table: "kb_cards", db });
	assert.equal(res.ok, false);
	assert.ok(res.error && res.error.length > 0, "carries an error message");
	// nothing changed
	assert.equal(countOf(db, "sess_events"), 6);
});

test("db_query missing/empty table -> { ok:false, error }", () => {
	const db = freshDB();
	seed(db);
	for (const bad of [undefined, "", null, 42]) {
		const res = db_query({ table: bad, db });
		assert.equal(res.ok, false, `table=${JSON.stringify(bad)} rejected`);
		assert.ok(res.error, `table=${JSON.stringify(bad)} carries an error`);
	}
});

test("db_query bad filter value type -> { ok:false, errors } (no SQL fired)", () => {
	const db = freshDB();
	seed(db);
	// a non-boolean errors flag is rejected before SQL (the only boolean filter)
	const res = db_query({ table: "events", filters: { errors: "yes" }, db });
	assert.equal(res.ok, false);
	assert.ok(Array.isArray(res.errors) && res.errors.length > 0);
	assert.equal(countOf(db, "sess_events"), 6, "no SQL fired on reject");
});

test("db_query unknown filter key is silently ignored (forward-compat)", () => {
	const db = freshDB();
	seed(db);
	const res = db_query({ table: "events", filters: { bogus: "x" }, db });
	assert.equal(res.ok, true, "unknown keys never crash the tool");
	assert.equal(res.rows.length, 6);
});

test("db_query bad limit -> { ok:false, errors } (no SQL fired)", () => {
	const db = freshDB();
	seed(db);
	const res = db_query({ table: "events", opts: { limit: -1 }, db });
	assert.equal(res.ok, false);
	assert.ok(Array.isArray(res.errors) && res.errors.length > 0);
});

// =====================================================================
// RED-BLUE — injection payloads are bound, never concatenated
// =====================================================================

test("abuse: SQL injection via a session filter is bound as a literal (no table dropped)", () => {
	const db = freshDB();
	seed(db);
	const res = db_query({ table: "events", filters: { session: "' OR '1'='1" }, db });
	assert.equal(res.ok, true, "value reaches SQL as a bound parameter, not concatenated");
	assert.equal(res.rows.length, 0, "no row matches the literal injection string");
	// tables intact
	assert.equal(countOf(db, "sess_events"), 6);
	assert.equal(countOf(db, "sess_sessions"), 2);
});

test("abuse: DROP payload as a filter value is bound (table not dropped)", () => {
	const db = freshDB();
	seed(db);
	const res = db_query({ table: "sessions", filters: { model: "x'; DROP TABLE sess_events;--" }, db });
	assert.equal(res.ok, true);
	assert.equal(res.rows.length, 0, "literal payload matches nothing");
	assert.equal(countOf(db, "sess_events"), 6, "sess_events still intact (no DROP executed)");
});

// =====================================================================
// NO MUTATION — a query never writes
// =====================================================================

test("no mutation: a battery of queries leaves every Tier-B row count unchanged", () => {
	const db = freshDB();
	seed(db);
	const before = {
		sess_events: countOf(db, "sess_events"),
		sess_sessions: countOf(db, "sess_sessions"),
		analysis_findings: countOf(db, "analysis_findings"),
		analysis_runs: countOf(db, "analysis_runs"),
	};
	// run one of each table + filter + limit
	db_query({ table: "events", db });
	db_query({ table: "events", filters: { errors: true }, db });
	db_query({ table: "events", filters: { session: "s1", tool: "bash" }, db });
	db_query({ table: "sessions", db });
	db_query({ table: "sessions", filters: { cwd: "alpha" }, db });
	db_query({ table: "findings", filters: { severity: "critical" }, db });
	db_query({ table: "runs", db });
	db_query({ table: "events", opts: { limit: 1 }, db });
	const after = {
		sess_events: countOf(db, "sess_events"),
		sess_sessions: countOf(db, "sess_sessions"),
		analysis_findings: countOf(db, "analysis_findings"),
		analysis_runs: countOf(db, "analysis_runs"),
	};
	assert.deepEqual(after, before, "db_query fired SELECTs only — no row added/removed/changed");
});

// =====================================================================
// db_query — opens-OWN-db path (the real "pi harness" path)
// =====================================================================

test("db_query with NO injected db opens AGENT_DB and reads the persisted rows", () => {
	// seed a throwaway AGENT_DB file (Tier B is authoritative in the DB; no
	// file reconcile like the kb_* tools — so we seed via a direct connection).
	const tmpDb = path.join(os.tmpdir(), `pi-query-db-${process.pid}-${Date.now()}.sqlite`);
	process.env.AGENT_DB = tmpDb;
	try {
		{
			const seedDb = open(); // applies schema idempotently
			try { seed(seedDb); } finally { seedDb.close(); }
		}
		// the tool opens its OWN connection to the same file — no db injected
		const res = db_query({ table: "events", filters: { errors: true } });
		assert.equal(res.ok, true, "opens-own-db path must succeed");
		assert.equal(res.rows.length, 2, "the 2 error events from the seeded file");
		assert.ok(res.rows.every(r => r.is_error === 1));

		// a second table works too
		const sess = db_query({ table: "sessions", filters: { cwd: "proj/alpha" } });
		assert.equal(sess.ok, true);
		assert.deepEqual(sess.rows.map(r => r.session_id), ["s1"]);

		assert.ok(fs.existsSync(tmpDb), "AGENT_DB file exists");
	} finally {
		delete process.env.AGENT_DB;
		try { fs.unlinkSync(tmpDb); } catch (_) {}
	}
});
