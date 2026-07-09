// bin/apple-pi.measure.test.js — REQ-M8-7
//
// `apple-pi measure [--window <ms>]` — the CLI wrapper around M6-4
// measure.js. It finalizes 'pending' improvement_outcomes rows for applied
// proposals past a measurement window: compares the before-snapshot
// (recorded at apply time) against a fresh after-snapshot read from
// sess_sessions, computes the delta, and writes a verdict
// (improved|neutral|regressed). Default window 0 = measure every pending
// outcome now (the manual-run default). --window <ms> skips outcomes whose
// proposal was applied within the last <ms> (so a scheduled measure only
// finalizes outcomes with enough post-apply data).
//
// ACCEPTANCE (REQ-M8-7): records outcomes for applied proposals past window.
//
// This suite drives the REAL bin/apple-pi wrapper as a subprocess (the path a
// user hits), points AGENT_DB at a throwaway file, seeds an applied proposal +
// a 'pending' outcome + the sess_sessions aggregates measure reads directly,
// and asserts:
//   - measure (default):      finalizes the pending outcome (verdict set,
//                             after_json + delta_json filled, measured_at
//                             stamped) from the real after-snapshot; exit 0
//   - measure (default):      with nothing pending is a no-op; exit 0
//   - measure --window <ms>:  an outcome whose proposal was applied within the
//                             window is SKIPPED (stays 'pending'); exit 0
//   - measure --window <ms>:  once the window has elapsed, it measures; exit 0
//   - measure (idempotent):   a second run measures nothing (no re-finalize)
//   - measure --window junk:  invalid value → exit 2 (usage error)
//
// Verify: node --test bin/apple-pi.measure.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const BIN = path.join(__dirname, "apple-pi");
const SCHEMA_PATH = path.join(__dirname, "..", "agentdb", "lib", "schema.sql");

// cost is a REAL sum, so its delta carries float error (0.2+0.1 =
// 0.30000000000000004). Integer metrics (errors/tool_calls/...) compare ===.
const approxEq = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// freshDB() -> { dir, dbFile, env } — a tmpdir + schema'd DB + env with
// AGENT_DB pointed at it. Each test gets its own.
function freshDB() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "measure-cli-"));
	const dbFile = path.join(dir, "agent.db");
	const db = new DatabaseSync(dbFile);
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	db.close();
	return { dir, dbFile, env: { ...process.env, AGENT_DB: dbFile } };
}

// seedAppliedOutcome(dbFile, { before, appliedAt }) -> { proposalId, outcomeId }.
// Seeds an 'applied' proposal + a 'pending' outcome row with a known
// before_json (the baseline M6-3 apply recorded). Mirrors apply's own write so
// measure has something real to finalize. Links proposal.outcome_id back too.
function seedAppliedOutcome(dbFile, { before, appliedAt } = {}) {
	const db = new DatabaseSync(dbFile);
	try {
		const ts = appliedAt || "2026-07-01T00:00:00.000Z";
		const pid = db.prepare(
			`INSERT INTO proposals
			   (status, setting, from_value, to_value, rationale,
			    expected_delta_json, source_finding_ids_json, outcome_id,
			    proposed_at, applied_at)
			 VALUES ('applied', 'agent.x', '1', '2', 'rationale', '{}', '[]',
			         NULL, ?, ?)`,
		).run(ts, ts).lastInsertRowid;
		const oid = db.prepare(
			`INSERT INTO improvement_outcomes
			   (proposal_id, measured_at, before_json, after_json, delta_json,
			    verdict, notes)
			 VALUES (?, ?, ?, '{}', '{}', 'pending', NULL)`,
		).run(pid, ts, JSON.stringify(before || {})).lastInsertRowid;
		db.prepare("UPDATE proposals SET outcome_id = ? WHERE id = ?").run(oid, pid);
		return { proposalId: Number(pid), outcomeId: Number(oid) };
	} finally { db.close(); }
}

// seedSession(dbFile, { ... }) — insert a sess_sessions row so measure's
// defaultSnapshotMetrics (the real after-snapshot) is non-trivial.
function seedSession(dbFile, { session_id = "s-1", cost = 0, errors = 0, messages = 0, tool_calls = 0 } = {}) {
	const db = new DatabaseSync(dbFile);
	try {
		const ts = "2026-07-09T00:00:00.000Z";
		db.prepare(
			`INSERT INTO sess_sessions
			   (session_id, started_at, ended_at, last_event_at, message_count,
			    tool_call_count, error_count, tokens_in, tokens_out, cost, model,
			    cwd, tool_calls_json, file_path)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, '<model>', '/x', '{}', NULL)`,
		).run(session_id, ts, ts, ts, messages, tool_calls, errors, cost);
	} finally { db.close(); }
}

// runMeasure(args, env) — spawn the real bin/apple-pi measure <args>.
function runMeasure(args, env) {
	const r = spawnSync(process.execPath, ["--no-warnings", BIN, "measure", ...args], {
		cwd: __dirname, env, encoding: "utf8",
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

// getOutcome(dbFile, outcomeId) -> row — read a single outcome for assertions.
function getOutcome(dbFile, outcomeId) {
	const db = new DatabaseSync(dbFile);
	try {
		return db.prepare("SELECT * FROM improvement_outcomes WHERE id = ?").get(outcomeId);
	} finally { db.close(); }
}

// ===========================================================================
// REQ-M8-7: `apple-pi measure` (default) — finalizes a pending outcome
// ===========================================================================

test("apple-pi measure (default) finalizes a pending outcome from the real after-snapshot (REQ-M8-7)", () => {
	const { dbFile, env } = freshDB();
	const before = { sessions: 2, messages: 14, tool_calls: 170, errors: 6, cost: 0.5, measured_at: "2026-07-01T00:00:00.000Z" };
	const { outcomeId } = seedAppliedOutcome(dbFile, { before, appliedAt: "2026-07-01T00:00:00.000Z" });
	// real after-snapshot: errors 6→2, cost 0.5→0.3 → improved
	seedSession(dbFile, { session_id: "s-1", cost: 0.2, errors: 1, messages: 5, tool_calls: 40 });
	seedSession(dbFile, { session_id: "s-2", cost: 0.1, errors: 1, messages: 3, tool_calls: 20 });

	const r = runMeasure([], env);
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);

	// outcome finalized: verdict set, after/delta filled, measured_at stamped
	const row = getOutcome(dbFile, outcomeId);
	assert.equal(row.verdict, "improved", "errors+cost both down → improved");
	assert.notEqual(row.after_json, "{}", "after_json must be filled");
	assert.notEqual(row.delta_json, "{}", "delta_json must be filled");
	assert.ok(row.measured_at, "measured_at must be stamped");
	const after = JSON.parse(row.after_json);
	assert.equal(after.errors, 2, "after-snapshot errors = 2");
	assert.ok(approxEq(after.cost, 0.3), `after-snapshot cost ~0.3 (got ${after.cost})`);
	const delta = JSON.parse(row.delta_json);
	assert.equal(delta.errors, -4, "delta errors = 2-6 = -4");

	// stdout reports the verdict
	assert.match(r.stdout, /improved/i, `stdout should mention verdict; got:\n${r.stdout}`);
});

test("apple-pi measure with nothing pending is a no-op (REQ-M8-7)", () => {
	const { dbFile, env } = freshDB();
	// no proposals, no outcomes — nothing to measure
	const r = runMeasure([], env);
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	assert.equal(count(dbFile, "improvement_outcomes"), 0, "no outcomes written");
	assert.match(r.stdout, /nothing/i, `stdout should say nothing to measure; got:\n${r.stdout}`);
});

// ===========================================================================
// REQ-M8-7: `--window` — outcomes applied within the window are skipped
// ===========================================================================

test("apple-pi measure --window skips an outcome applied within the window (REQ-M8-7)", () => {
	const { dbFile, env } = freshDB();
	const nowIso = new Date().toISOString();
	const before = { errors: 6, cost: 0.5, measured_at: nowIso };
	const { outcomeId } = seedAppliedOutcome(dbFile, { before, appliedAt: nowIso });
	seedSession(dbFile, { session_id: "s-1", cost: 0.1, errors: 1 });

	// 1h window; the proposal was applied just now → not ripe → skipped
	const r = runMeasure(["--window", "3600000"], env);
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);

	const row = getOutcome(dbFile, outcomeId);
	assert.equal(row.verdict, "pending", "skipped: stays 'pending'");
	assert.equal(row.after_json, "{}", "after_json untouched");
	assert.equal(row.delta_json, "{}", "delta_json untouched");
	assert.match(r.stdout, /skip/i, `stdout should mention skip; got:\n${r.stdout}`);
});

test("apple-pi measure --window measures once the window has elapsed (REQ-M8-7)", () => {
	const { dbFile, env } = freshDB();
	// applied long ago — well past any reasonable window
	const longAgo = "2020-01-01T00:00:00.000Z";
	const before = { errors: 6, cost: 0.5, measured_at: longAgo };
	const { outcomeId } = seedAppliedOutcome(dbFile, { before, appliedAt: longAgo });
	seedSession(dbFile, { session_id: "s-1", cost: 0.1, errors: 1 });

	// 1h window; applied years ago → ripe → measured
	const r = runMeasure(["--window", "3600000"], env);
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);

	const row = getOutcome(dbFile, outcomeId);
	assert.equal(row.verdict, "improved", "measured: errors+cost down");
	assert.notEqual(row.after_json, "{}", "after_json filled");
});

// ===========================================================================
// REQ-M8-7: idempotent — finalized outcomes are never re-measured
// ===========================================================================

test("apple-pi measure is idempotent: a second run measures nothing (REQ-M8-7)", () => {
	const { dbFile, env } = freshDB();
	const before = { errors: 6, cost: 0.5, measured_at: "2026-07-01T00:00:00.000Z" };
	seedAppliedOutcome(dbFile, { before, appliedAt: "2026-07-01T00:00:00.000Z" });
	seedSession(dbFile, { session_id: "s-1", cost: 0.1, errors: 1 });

	const r1 = runMeasure([], env);
	assert.equal(r1.status, 0, `first run exit 0; stderr=\n${r1.stderr}`);
	assert.equal(count(dbFile, "improvement_outcomes", ["verdict<>'pending'"]), 1, "first run finalized the outcome");

	const r2 = runMeasure([], env);
	assert.equal(r2.status, 0, `second run exit 0; stderr=\n${r2.stderr}`);
	assert.equal(count(dbFile, "improvement_outcomes"), 1, "no new rows");
	assert.equal(count(dbFile, "improvement_outcomes", ["verdict='pending'"]), 0, "no re-pending");
});

// ===========================================================================
// REQ-M8-7: `--window junk` is a usage error (exit 2)
// ===========================================================================

test("apple-pi measure --window with an invalid value exits 2 (REQ-M8-7)", () => {
	const { env } = freshDB();
	const r = runMeasure(["--window", "junk"], env);
	assert.equal(r.status, 2, `usage error exit 2; stderr=\n${r.stderr}`);
});
