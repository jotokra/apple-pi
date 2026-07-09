// agentdb/analysis/apply.test.js — apply (gated, audited) (M6-3).
//
// ROADMAP M6-3 acceptance gate (REQ-M6-3):
//   `apple-pi apply --latest --yes` applies the latest approved proposal:
//   writes an audit (what actually changed), snapshots the 'before' metric,
//   flips status 'applied'. `--yes` is REQUIRED (D9); without it apply is a
//   no-op + a notice. Nothing is ever auto-applied.
//
// This suite drives agentdb/analysis/apply.js's apply() directly against an
// in-memory schema DB (mirrors review.test.js / propose.test.js). The gate
// (D9) is the headline red-blue contract: a missing --yes must leave every
// table byte-identical.
//
// Audit home  : proposals.audit (JSON [{setting,before,after}]) — mirrors the
//               autoresearch lifecycle proposals.audit exactly.
// Before-snap : improvement_outcomes.before_json (the schema's designed home
//               for "metric snapshot before the proposal"); proposals.outcome_id
//               is set to the new row. M6-4 measure fills after_json + verdict.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { start, recordFinding } = require("./runs");
const { propose } = require("./propose");
const { apply, formatApply } = require("./apply");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

const FIXED_TS = "2026-07-09T12:00:00.000Z";

function freshDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// seedFinding(db, finding) -> finding_id. Mirrors review.test.js.
function seedFinding(db, finding) {
	const r = start(db);
	const f = recordFinding(db, r.run_id, finding);
	assert.equal(f.ok, true, `seed finding failed: ${JSON.stringify(f)}`);
	return f.finding_id;
}

// Produce one 'proposed' proposal (via the real propose() producer) from a
// single finding. Returns { proposal, findingId }.
function seedProposed(db, finding) {
	const fid = seedFinding(db, finding);
	const res = propose(db);
	assert.equal(res.ok, true);
	assert.equal(res.proposalCount, 1);
	return { proposal: res.proposals[0], findingId: fid };
}

// Insert a proposals row directly with an explicit status, for testing the
// target filter (propose() only ever emits 'proposed').
function seedProposalRow(db, { status, setting = "agent.x", from = null, to = "1" }) {
	const info = db.prepare(
		`INSERT INTO proposals
		   (status, setting, from_value, to_value, rationale,
		    expected_delta_json, source_finding_ids_json, outcome_id,
		    proposed_at, applied_at)
		 VALUES (?, ?, ?, ?, 'rationale', '{}', '[]', NULL, ?, NULL)`,
	).run(status, setting, from === null ? null : JSON.stringify(from), JSON.stringify(to), new Date().toISOString());
	return info.lastInsertRowid;
}

// Insert one sess_sessions aggregate row so the before-snapshot has REAL
// metrics to read (proves snapshotMetrics reads the DB, not hardcoded zeros).
function seedSession(db, { session_id = "s-1", cost = 0, errors = 0, messages = 0, tool_calls = 0 } = {}) {
	db.prepare(
		`INSERT INTO sess_sessions
		   (session_id, started_at, ended_at, last_event_at, message_count,
		    tool_call_count, error_count, tokens_in, tokens_out, cost, model,
		    cwd, tool_calls_json, file_path)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'glm-5.1', '/x', '{}', NULL)`,
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
	const res = apply();
	assert.equal(res.ok, false);
	assert.ok(res.errors && res.errors.length > 0);
});

test("abuse: no pending proposal + --yes is a safe no-op", () => {
	const db = freshDB();
	const res = apply(db, { latest: true, yes: true, now: () => FIXED_TS });
	assert.equal(res.ok, true);
	assert.equal(res.applied, false);
	assert.equal(res.proposal, null);
	// Nothing written.
	assert.equal(db.prepare("SELECT COUNT(*) n FROM improvement_outcomes").get().n, 0);
});

// =====================================================================
// REQ-M6-3 (part 1) — GATE: without --yes -> no-op + notice
// =====================================================================

test("REQ-M6-3 gate: without --yes -> no-op + notice, nothing written", () => {
	const db = freshDB();
	const { proposal } = seedProposed(db, ERROR_PATTERN_FINDING);

	// Snapshot before.
	const beforeRow = db.prepare("SELECT * FROM proposals WHERE id = ?").get(proposal.id);
	const beforeOutcomes = db.prepare("SELECT COUNT(*) c FROM improvement_outcomes").get().c;

	const res = apply(db, { latest: true, yes: false, now: () => FIXED_TS });

	// ok:true (the call succeeded by correctly refusing), applied:false,
	// gated:true, and a human-readable notice. The target is returned so a
	// CLI can show what WOULD be applied (mirrors review).
	assert.equal(res.ok, true);
	assert.equal(res.applied, false);
	assert.equal(res.gated, true);
	assert.equal(typeof res.notice, "string");
	assert.ok(res.notice.length > 0);
	assert.ok(res.notice.toLowerCase().includes("--yes"), `notice should mention --yes; got: ${res.notice}`);
	assert.ok(res.proposal, "gate returns the proposal it would have applied");
	assert.equal(res.proposal.id, proposal.id);

	// RED-BLUE (D9): byte-identical — nothing written.
	const afterRow = db.prepare("SELECT * FROM proposals WHERE id = ?").get(proposal.id);
	assert.deepEqual(afterRow, beforeRow, "proposals row must not change without --yes");
	assert.equal(afterRow.status, "proposed", "status must stay 'proposed'");
	assert.equal(afterRow.applied_at, null, "applied_at must stay NULL");
	assert.equal(afterRow.audit, null, "audit must stay NULL");
	assert.equal(afterRow.outcome_id, null, "outcome_id must stay NULL");
	assert.equal(
		db.prepare("SELECT COUNT(*) c FROM improvement_outcomes").get().c,
		beforeOutcomes,
		"no improvement_outcomes row may be created without --yes",
	);
});

test("REQ-M6-3 gate: --yes is the ONLY thing that applies (default yes=false refuses)", () => {
	const db = freshDB();
	seedProposed(db, ERROR_PATTERN_FINDING);

	// Calling apply() with no opts at all must also refuse (yes defaults false).
	const res = apply(db);
	assert.equal(res.ok, true);
	assert.equal(res.applied, false);
	assert.equal(res.gated, true);
	// Still proposed.
	assert.equal(db.prepare("SELECT status FROM proposals ORDER BY id DESC LIMIT 1").get().status, "proposed");
});

// =====================================================================
// REQ-M6-3 (part 2) — APPLY: with --yes -> applied + audit + before-snapshot
// =====================================================================

test("REQ-M6-3 apply: with --yes -> status flipped + audit + before-snapshot recorded", () => {
	const db = freshDB();
	const { proposal } = seedProposed(db, ERROR_PATTERN_FINDING);
	// Real metrics so the before-snapshot is non-trivial.
	seedSession(db, { session_id: "s-1", cost: 0.42, errors: 5, messages: 10, tool_calls: 140 });
	seedSession(db, { session_id: "s-2", cost: 0.08, errors: 1, messages: 4, tool_calls: 30 });

	const res = apply(db, { latest: true, yes: true, now: () => FIXED_TS });

	assert.equal(res.ok, true, `apply should succeed; errors=${JSON.stringify(res.errors)}`);
	assert.equal(res.applied, true);
	assert.ok(res.proposal);
	assert.equal(res.proposal.id, proposal.id);

	// --- status flipped + applied_at recorded ---
	const row = db.prepare("SELECT * FROM proposals WHERE id = ?").get(proposal.id);
	assert.equal(row.status, "applied");
	assert.equal(row.applied_at, FIXED_TS);

	// --- audit recorded (what actually changed) ---
	assert.ok(Array.isArray(res.audit), "audit is an array of changes");
	assert.equal(res.audit.length, 1);
	const a = res.audit[0];
	assert.equal(a.setting, proposal.setting);
	assert.deepEqual(a.before, proposal.from);
	assert.deepEqual(a.after, proposal.to);
	// ... and persisted on the row.
	assert.notEqual(row.audit, null, "proposals.audit must be persisted");
	const persistedAudit = JSON.parse(row.audit);
	assert.deepEqual(persistedAudit, [{ setting: proposal.setting, before: proposal.from, after: proposal.to }]);

	// --- before-snapshot recorded (improvement_outcomes row) ---
	assert.ok(res.outcome_id, "apply returns the new outcome id");
	assert.equal(typeof res.before_snapshot, "object");
	assert.notEqual(res.before_snapshot, null);
	// The snapshot is a REAL read of the DB, not hardcoded zeros.
	assert.equal(res.before_snapshot.sessions, 2);
	assert.equal(res.before_snapshot.errors, 6);
	assert.equal(res.before_snapshot.messages, 14);
	assert.equal(res.before_snapshot.tool_calls, 170);
	assert.equal(res.before_snapshot.cost, 0.5); // 0.42 + 0.08
	assert.equal(res.before_snapshot.measured_at, FIXED_TS);

	// proposals.outcome_id links to the new outcome row.
	assert.equal(Number(row.outcome_id), Number(res.outcome_id));

	const outcome = db.prepare("SELECT * FROM improvement_outcomes WHERE id = ?").get(res.outcome_id);
	assert.ok(outcome, "improvement_outcomes row exists");
	assert.equal(Number(outcome.proposal_id), proposal.id);
	assert.equal(outcome.measured_at, FIXED_TS);
	// before_json holds the metric snapshot (parsed back to an object).
	assert.notEqual(outcome.before_json, null);
	const beforeSnap = JSON.parse(outcome.before_json);
	assert.equal(beforeSnap.sessions, 2);
	assert.equal(beforeSnap.cost, 0.5);
	// after/delta are M6-4's job — left empty at apply time.
	assert.equal(outcome.after_json, "{}");
	assert.equal(outcome.delta_json, "{}");
	// verdict starts 'pending' (transitional); M6-4 measure finalizes it.
	assert.equal(outcome.verdict, "pending");
});

test("REQ-M6-3 apply: --latest targets the NEWEST 'proposed' only", () => {
	const db = freshDB();
	seedProposed(db, ERROR_PATTERN_FINDING);
	const newest = seedProposed(db, {
		detector: "card_stall",
		severity: "warn",
		title: "card M6-1 stalled",
		evidence: { card_id: "M6-1", title: "propose", status: "in_progress", age_days: 14, threshold_days: 7, updated_at: "2026-06-23T00:00:00.000Z" },
	});

	const res = apply(db, { latest: true, yes: true, now: () => FIXED_TS });
	assert.equal(res.applied, true);
	assert.equal(res.proposal.id, newest.proposal.id);

	// The older proposal stays 'proposed'; only the newest flipped.
	const statuses = db.prepare("SELECT id, status FROM proposals ORDER BY id").all();
	const flipped = statuses.filter((s) => s.status === "applied");
	assert.equal(flipped.length, 1);
	assert.equal(flipped[0].id, newest.proposal.id);
});

test("REQ-M6-3 apply: re-apply is a no-op (only 'proposed' is ever targeted)", () => {
	const db = freshDB();
	seedProposed(db, ERROR_PATTERN_FINDING);

	const first = apply(db, { latest: true, yes: true, now: () => FIXED_TS });
	assert.equal(first.applied, true);
	const outcomesAfterFirst = db.prepare("SELECT COUNT(*) c FROM improvement_outcomes").get().c;

	// Second apply: nothing is 'proposed' anymore -> safe no-op.
	const second = apply(db, { latest: true, yes: true, now: () => FIXED_TS });
	assert.equal(second.ok, true);
	assert.equal(second.applied, false);
	assert.equal(second.proposal, null);
	assert.equal(
		db.prepare("SELECT COUNT(*) c FROM improvement_outcomes").get().c,
		outcomesAfterFirst,
		"no second outcome row on re-apply",
	);
});

test("REQ-M6-3 apply: already-applied/rejected proposals are never re-targeted", () => {
	const db = freshDB();
	seedProposalRow(db, { status: "applied", setting: "agent.applied" });
	seedProposalRow(db, { status: "rejected", setting: "agent.rejected" });

	const res = apply(db, { latest: true, yes: true, now: () => FIXED_TS });
	assert.equal(res.ok, true);
	assert.equal(res.applied, false);
	assert.equal(res.proposal, null);
	assert.equal(db.prepare("SELECT COUNT(*) c FROM improvement_outcomes").get().c, 0);
});

// =====================================================================
// RED-BLUE — scoped mutation: only proposals + one outcome row change
// =====================================================================

test("red-blue: apply mutates only the target proposal + adds one outcome row", () => {
	const db = freshDB();
	const { proposal } = seedProposed(db, ERROR_PATTERN_FINDING);
	seedSession(db, { session_id: "s-1", cost: 0.1, errors: 2 });

	// Snapshot the read-only-on-the-world tables.
	const snap = (d) => ({
		sess_sessions: d.prepare("SELECT * FROM sess_sessions ORDER BY session_id").all(),
		sess_events: d.prepare("SELECT * FROM sess_events ORDER BY session_id, seq").all(),
		kb_cards: d.prepare("SELECT * FROM kb_cards ORDER BY id").all(),
		analysis_findings: d.prepare("SELECT * FROM analysis_findings ORDER BY id").all(),
		analysis_runs: d.prepare("SELECT * FROM analysis_runs ORDER BY id").all(),
	});
	const before = snap(db);
	const beforeProposalOthers = db.prepare("SELECT COUNT(*) c FROM proposals").get().c;

	const res = apply(db, { latest: true, yes: true, now: () => FIXED_TS });
	assert.equal(res.applied, true);

	// Read-side tables byte-identical.
	const after = snap(db);
	for (const tbl of Object.keys(before)) {
		assert.deepEqual(after[tbl], before[tbl], `read-only contract violated: ${tbl} changed`);
	}

	// proposals: same count (we UPDATE the target, not insert), only the
	// target row's apply-fields changed.
	assert.equal(db.prepare("SELECT COUNT(*) c FROM proposals").get().c, beforeProposalOthers);
	const others = db.prepare("SELECT * FROM proposals WHERE id != ?").all(proposal.id);
	assert.ok(others.length === 0, "only the seeded proposal exists");

	// Exactly one improvement_outcomes row, linked to the target.
	const outcomes = db.prepare("SELECT * FROM improvement_outcomes").all();
	assert.equal(outcomes.length, 1);
	assert.equal(Number(outcomes[0].proposal_id), proposal.id);
});

// =====================================================================
// formatApply — CLI presentation helper (mirrors review.formatReview)
// =====================================================================

test("formatApply: gate result renders the notice (no --yes)", () => {
	const db = freshDB();
	seedProposed(db, ERROR_PATTERN_FINDING);
	const res = apply(db, { latest: true, yes: false });
	const out = formatApply(res);
	assert.equal(typeof out, "string");
	assert.ok(out.length > 0);
	assert.ok(out.toLowerCase().includes("--yes"), "notice text mentions --yes");
});

test("formatApply: applied result renders the setting + from→to diff", () => {
	const db = freshDB();
	const { proposal } = seedProposed(db, ERROR_PATTERN_FINDING);
	const res = apply(db, { latest: true, yes: true, now: () => FIXED_TS });
	const out = formatApply(res);
	assert.equal(typeof out, "string");
	assert.ok(out.includes(proposal.setting), "mentions the setting");
	assert.ok(/→/.test(out), "renders a from→to diff");
});
