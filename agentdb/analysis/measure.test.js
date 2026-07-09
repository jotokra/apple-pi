// agentdb/analysis/measure.test.js — measure (closes the loop) (M6-4).
//
// ROADMAP M6-4 acceptance gate (REQ-M6-4):
//   `analysis/measure.js` for applied proposals past a window: compare
//   before vs after metric → improvement_outcomes (improved|neutral|
//   regressed). Regressed → next analyze can propose a revert.
//
// This suite drives agentdb/analysis/measure.js's measure() directly
// against an in-memory schema DB (mirrors apply.test.js / review.test.js).
//
// Two seeding strategies:
//   1. DIRECT — seed an applied proposal + a 'pending' outcome row with a
//      known before_json, inject measure's `after` snapshot. Isolates the
//      verdict/delta logic precisely (improved / regressed / neutral / mixed).
//   2. INTEGRATION — propose() → apply(--yes) writes the real before
//      snapshot from sess_sessions; mutate the aggregates; measure() reads
//      the real after snapshot. Proves the loop closes end-to-end with the
//      SAME defaultSnapshotMetrics apply uses.
//
// Audit home  : improvement_outcomes.after_json + delta_json + verdict
//               (finalized from the 'pending' row M6-3 apply wrote).
// Window     : outcomes whose proposal.applied_at is within windowMs of
//               `now` are skipped (left 'pending') — measure is safe to
//               schedule; only ripe outcomes finalize.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { start, recordFinding } = require("./runs");
const { propose } = require("./propose");
const { apply } = require("./apply");
const { measure, formatMeasure, computeVerdict } = require("./measure");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

const FIXED_TS = "2026-07-09T12:00:00.000Z";
const LATER_TS = "2026-07-10T12:00:00.000Z"; // 24h after FIXED_TS

// approxEq: cost is a REAL sum, so its delta carries float error (0.7-0.5 =
// 0.19999...). Integer metrics (errors/tool_calls/...) compare with ===.
const approxEq = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

function freshDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// DIRECT seed: an 'applied' proposal + a 'pending' outcome with a known
// before_json. Returns { proposalId, outcomeId }.
function seedPendingOutcome(db, { before, appliedAt = FIXED_TS, proposalId } = {}) {
	const pid = proposalId != null ? proposalId : db.prepare(
		`INSERT INTO proposals
		   (status, setting, from_value, to_value, rationale,
		    expected_delta_json, source_finding_ids_json, outcome_id,
		    proposed_at, applied_at)
		 VALUES ('applied', 'agent.x', '1', '2', 'rationale', '{}', '[]',
		         NULL, ?, ?)`,
	).run(appliedAt, appliedAt).lastInsertRowid;
	const oid = db.prepare(
		`INSERT INTO improvement_outcomes
		   (proposal_id, measured_at, before_json, after_json, delta_json,
		    verdict, notes)
		 VALUES (?, ?, ?, '{}', '{}', 'pending', NULL)`,
	).run(pid, appliedAt, JSON.stringify(before || {})).lastInsertRowid;
	// Link the proposal back to the outcome (mirrors apply).
	db.prepare("UPDATE proposals SET outcome_id = ? WHERE id = ?").run(oid, pid);
	return { proposalId: Number(pid), outcomeId: Number(oid) };
}

// INTEGRATION seed helpers (mirrors apply.test.js).
function seedFinding(db, finding) {
	const r = start(db);
	const f = recordFinding(db, r.run_id, finding);
	assert.equal(f.ok, true, `seed finding failed: ${JSON.stringify(f)}`);
	return f.finding_id;
}
function seedProposed(db, finding) {
	const fid = seedFinding(db, finding);
	const res = propose(db);
	assert.equal(res.ok, true);
	assert.equal(res.proposalCount, 1);
	return { proposal: res.proposals[0], findingId: fid };
}
function seedSession(db, { session_id = "s-1", cost = 0, errors = 0, messages = 0, tool_calls = 0 } = {}) {
	db.prepare(
		`INSERT INTO sess_sessions
		   (session_id, started_at, ended_at, last_event_at, message_count,
		    tool_call_count, error_count, tokens_in, tokens_out, cost, model,
		    cwd, tool_calls_json, file_path)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, '<model>', '/x', '{}', NULL)`,
	).run(session_id, FIXED_TS, FIXED_TS, FIXED_TS, messages, tool_calls, errors, cost);
}

const ERROR_PATTERN_FINDING = {
	detector: "error_pattern",
	severity: "warn",
	title: "tool bash errored 5 times (threshold 5)",
	evidence: { tool: "bash", error_count: 5, threshold: 5 },
};

// =====================================================================
// ABUSE SUITE — must run first
// =====================================================================

test("abuse: missing db returns ok:false", () => {
	const res = measure();
	assert.equal(res.ok, false);
	assert.ok(res.errors && res.errors.length > 0);
});

test("abuse: no pending outcomes is a safe no-op", () => {
	const db = freshDB();
	const res = measure(db, { now: () => LATER_TS });
	assert.equal(res.ok, true);
	assert.deepEqual(res.measured, []);
	assert.deepEqual(res.skipped, []);
});

// =====================================================================
// REQ-M6-4 — seeded before/after yields the right verdict + delta
// =====================================================================

test("REQ-M6-4 improved: errors+cost both down → 'improved' + negative deltas", () => {
	const db = freshDB();
	const before = { sessions: 2, messages: 14, tool_calls: 170, errors: 5, cost: 0.5, measured_at: FIXED_TS };
	const { outcomeId, proposalId } = seedPendingOutcome(db, { before });
	const after = { sessions: 3, messages: 20, tool_calls: 200, errors: 2, cost: 0.3, measured_at: LATER_TS };

	const res = measure(db, {
		now: () => LATER_TS,
		snapshotMetrics: () => after,
	});

	assert.equal(res.ok, true, `errors=${JSON.stringify(res.errors)}`);
	assert.equal(res.measured.length, 1);
	const m = res.measured[0];
	assert.equal(m.outcome_id, outcomeId);
	assert.equal(m.proposal_id, proposalId);
	assert.equal(m.verdict, "improved");

	// delta is computed for every numeric metric in the after snapshot.
	assert.equal(m.delta.errors, -3, "errors dropped 5→2");
	assert.ok(approxEq(m.delta.cost, -0.2), `cost dropped 0.5→0.3 (got ${m.delta.cost})`);
	assert.equal(m.delta.tool_calls, 30, "tool_calls rose 170→200 (volume, not directional)");
	assert.equal(m.delta.messages, 6);

	// Row finalized in the DB.
	const row = db.prepare("SELECT * FROM improvement_outcomes WHERE id = ?").get(outcomeId);
	assert.equal(row.verdict, "improved");
	assert.notEqual(row.after_json, "{}", "after_json must be filled");
	assert.notEqual(row.delta_json, "{}", "delta_json must be filled");
	assert.equal(row.measured_at, LATER_TS, "measured_at updated to the measurement time");
	const persistedAfter = JSON.parse(row.after_json);
	assert.equal(persistedAfter.errors, 2);
	const persistedDelta = JSON.parse(row.delta_json);
	assert.equal(persistedDelta.errors, -3);
});

test("REQ-M6-4 regressed: errors+cost both up → 'regressed' (feeds a revert)", () => {
	const db = freshDB();
	const before = { errors: 5, cost: 0.5, measured_at: FIXED_TS };
	const { outcomeId } = seedPendingOutcome(db, { before });
	const after = { errors: 8, cost: 0.7, measured_at: LATER_TS };

	const res = measure(db, { now: () => LATER_TS, snapshotMetrics: () => after });

	assert.equal(res.ok, true);
	assert.equal(res.measured.length, 1);
	assert.equal(res.measured[0].verdict, "regressed");
	assert.equal(res.measured[0].delta.errors, 3);
	assert.ok(approxEq(res.measured[0].delta.cost, 0.2), `got ${res.measured[0].delta.cost}`);

	// The regressed outcome is visible to the next analyze (revert source).
	const row = db.prepare("SELECT verdict FROM improvement_outcomes WHERE id = ?").get(outcomeId);
	assert.equal(row.verdict, "regressed");
});

test("REQ-M6-4 neutral: identical before/after → 'neutral' + zero deltas", () => {
	const db = freshDB();
	const snap = { errors: 5, cost: 0.5, tool_calls: 10, measured_at: FIXED_TS };
	const { outcomeId } = seedPendingOutcome(db, { before: snap });

	const res = measure(db, { now: () => LATER_TS, snapshotMetrics: () => snap });

	assert.equal(res.ok, true);
	assert.equal(res.measured.length, 1);
	assert.equal(res.measured[0].verdict, "neutral");
	assert.equal(res.measured[0].delta.errors, 0);
	assert.equal(res.measured[0].delta.cost, 0);
	assert.equal(res.measured[0].delta.tool_calls, 0);

	const row = db.prepare("SELECT verdict FROM improvement_outcomes WHERE id = ?").get(outcomeId);
	assert.equal(row.verdict, "neutral");
});

test("REQ-M6-4 mixed: errors down but cost up → 'neutral' (signs cancel)", () => {
	const db = freshDB();
	const before = { errors: 5, cost: 0.5, measured_at: FIXED_TS };
	seedPendingOutcome(db, { before });
	const after = { errors: 2, cost: 0.9, measured_at: LATER_TS }; // errors improved, cost regressed

	const res = measure(db, { now: () => LATER_TS, snapshotMetrics: () => after });

	assert.equal(res.measured.length, 1);
	assert.equal(res.measured[0].verdict, "neutral");
});

test("REQ-M6-4 integration: apply writes before, measure reads after from the real DB", () => {
	const db = freshDB();
	const { proposal } = seedProposed(db, ERROR_PATTERN_FINDING);
	// Real 'before' metrics so apply's snapshot is non-trivial.
	seedSession(db, { session_id: "s-1", cost: 0.42, errors: 5, messages: 10, tool_calls: 140 });
	seedSession(db, { session_id: "s-2", cost: 0.08, errors: 1, messages: 4, tool_calls: 30 });

	const applied = apply(db, { latest: true, yes: true, now: () => FIXED_TS });
	assert.equal(applied.applied, true);
	assert.equal(applied.before_snapshot.errors, 6);
	assert.equal(applied.before_snapshot.cost, 0.5);

	// Simulate the window elapsing + new (better) data landing.
	db.prepare("UPDATE sess_sessions SET error_count = 1, cost = 0.1").run();

	const res = measure(db, { now: () => LATER_TS });
	assert.equal(res.ok, true);
	assert.equal(res.measured.length, 1);
	assert.equal(res.measured[0].outcome_id, applied.outcome_id);
	assert.equal(res.measured[0].verdict, "improved", "errors 6→2, cost 0.5→0.2");
	assert.equal(res.measured[0].delta.errors, -4);
	assert.ok(approxEq(res.measured[0].delta.cost, -0.3), `got ${res.measured[0].delta.cost}`);

	const row = db.prepare("SELECT * FROM improvement_outcomes WHERE id = ?").get(applied.outcome_id);
	assert.equal(row.verdict, "improved");
});

// =====================================================================
// WINDOW — outcomes within windowMs are skipped, left 'pending'
// =====================================================================

test("window: outcome within windowMs is skipped (stays 'pending')", () => {
	const db = freshDB();
	const before = { errors: 5, cost: 0.5, measured_at: FIXED_TS };
	const { outcomeId } = seedPendingOutcome(db, { before, appliedAt: FIXED_TS });

	// now == appliedAt, window = 1h → not ripe.
	const res = measure(db, {
		now: () => FIXED_TS,
		windowMs: 60 * 60 * 1000,
		snapshotMetrics: () => ({ errors: 1, cost: 0.1, measured_at: FIXED_TS }),
	});

	assert.equal(res.ok, true);
	assert.deepEqual(res.measured, []);
	assert.equal(res.skipped.length, 1);
	assert.equal(res.skipped[0].outcome_id, outcomeId);
	assert.ok(res.skipped[0].reason.toLowerCase().includes("window"));

	// Untouched.
	const row = db.prepare("SELECT verdict, after_json FROM improvement_outcomes WHERE id = ?").get(outcomeId);
	assert.equal(row.verdict, "pending");
	assert.equal(row.after_json, "{}");
});

test("window: once ripe (now - applied_at >= windowMs) it measures", () => {
	const db = freshDB();
	const before = { errors: 5, cost: 0.5, measured_at: FIXED_TS };
	seedPendingOutcome(db, { before, appliedAt: FIXED_TS });

	const res = measure(db, {
		now: () => LATER_TS, // 24h later
		windowMs: 60 * 60 * 1000, // 1h window — ripe
		snapshotMetrics: () => ({ errors: 2, cost: 0.3, measured_at: LATER_TS }),
	});

	assert.equal(res.measured.length, 1);
	assert.equal(res.measured[0].verdict, "improved");
});

// =====================================================================
// IDEMPOTENT — finalized outcomes are never re-measured
// =====================================================================

test("idempotent: a second measure() measures nothing (verdict already set)", () => {
	const db = freshDB();
	const before = { errors: 5, cost: 0.5, measured_at: FIXED_TS };
	seedPendingOutcome(db, { before });

	const first = measure(db, {
		now: () => LATER_TS,
		snapshotMetrics: () => ({ errors: 2, cost: 0.3, measured_at: LATER_TS }),
	});
	assert.equal(first.measured.length, 1);

	// Even with a wildly different after snapshot, the finalized row stays.
	const second = measure(db, {
		now: () => LATER_TS,
		snapshotMetrics: () => ({ errors: 99, cost: 9, measured_at: LATER_TS }),
	});
	assert.equal(second.ok, true);
	assert.equal(second.measured.length, 0);
	assert.deepEqual(second.skipped, []);

	// Original verdict preserved.
	const rows = db.prepare("SELECT verdict FROM improvement_outcomes").all();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].verdict, "improved");
});

// =====================================================================
// RED-BLUE — scoped mutation: only improvement_outcomes changes
// =====================================================================

test("red-blue: measure mutates only improvement_outcomes (after/delta/verdict/measured_at)", () => {
	const db = freshDB();
	const before = { errors: 5, cost: 0.5, measured_at: FIXED_TS };
	seedPendingOutcome(db, { before });

	const snap = (d) => ({
		proposals: d.prepare("SELECT * FROM proposals ORDER BY id").all(),
		sess_sessions: d.prepare("SELECT * FROM sess_sessions ORDER BY session_id").all(),
		sess_events: d.prepare("SELECT * FROM sess_events ORDER BY session_id, seq").all(),
		kb_cards: d.prepare("SELECT * FROM kb_cards ORDER BY id").all(),
		analysis_findings: d.prepare("SELECT * FROM analysis_findings ORDER BY id").all(),
		analysis_runs: d.prepare("SELECT * FROM analysis_runs ORDER BY id").all(),
	});
	const beforeSnap = snap(db);
	const beforeOutcomeRow = db.prepare("SELECT before_json FROM improvement_outcomes").get();

	const res = measure(db, {
		now: () => LATER_TS,
		snapshotMetrics: () => ({ errors: 2, cost: 0.3, measured_at: LATER_TS }),
	});
	assert.equal(res.measured.length, 1);

	// Every read-only table byte-identical.
	const afterSnap = snap(db);
	for (const tbl of Object.keys(beforeSnap)) {
		assert.deepEqual(afterSnap[tbl], beforeSnap[tbl], `read-only contract violated: ${tbl} changed`);
	}

	// The ONE outcome row: before_json preserved, only after/delta/verdict/
	// measured_at changed.
	const outcomes = db.prepare("SELECT * FROM improvement_outcomes").all();
	assert.equal(outcomes.length, 1);
	assert.equal(outcomes[0].before_json, beforeOutcomeRow.before_json, "before_json must not change");
	assert.notEqual(outcomes[0].after_json, "{}");
	assert.notEqual(outcomes[0].delta_json, "{}");
	assert.equal(outcomes[0].verdict, "improved");
	assert.equal(outcomes[0].measured_at, LATER_TS);
});

// =====================================================================
// computeVerdict — pure unit (the directional rule)
// =====================================================================

test("computeVerdict: directional rule over errors+cost (both lower-is-better)", () => {
	const V = (b, a) => computeVerdict({ errors: b, cost: 0 }, { errors: a, cost: 0 });
	assert.equal(V(5, 2), "improved");
	assert.equal(V(2, 5), "regressed");
	assert.equal(V(5, 5), "neutral");

	const C = (b, a) => computeVerdict({ errors: 0, cost: b }, { errors: 0, cost: a });
	assert.equal(C(0.5, 0.3), "improved");
	assert.equal(C(0.3, 0.5), "regressed");
	assert.equal(C(0.5, 0.5), "neutral");

	// Mixed signs → neutral.
	assert.equal(computeVerdict({ errors: 5, cost: 0.5 }, { errors: 2, cost: 0.9 }), "neutral");
	assert.equal(computeVerdict({ errors: 2, cost: 0.3 }, { errors: 5, cost: 0.1 }), "neutral");
});

// =====================================================================
// formatMeasure — CLI presentation helper (mirrors formatApply)
// =====================================================================

test("formatMeasure: nothing measured renders a short line", () => {
	const out = formatMeasure({ ok: true, measured: [], skipped: [] });
	assert.equal(typeof out, "string");
	assert.ok(out.length > 0);
});

test("formatMeasure: measured result renders the verdict + deltas", () => {
	const db = freshDB();
	const before = { errors: 5, cost: 0.5, measured_at: FIXED_TS };
	seedPendingOutcome(db, { before });
	const res = measure(db, {
		now: () => LATER_TS,
		snapshotMetrics: () => ({ errors: 2, cost: 0.3, measured_at: LATER_TS }),
	});
	const out = formatMeasure(res);
	assert.equal(typeof out, "string");
	assert.ok(out.toLowerCase().includes("improved"), "mentions the verdict");
	assert.ok(/errors/.test(out), "mentions a metric");
});

test("formatMeasure: error result renders the errors", () => {
	const out = formatMeasure({ ok: false, errors: ["boom"] });
	assert.ok(out.toLowerCase().includes("boom"));
});
