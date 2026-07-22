// agentdb/analysis/propose.test.js — findings → proposals (M6-1).
//
// ROADMAP M6-1 acceptance gate: a finding of a given kind yields a
// well-formed proposal citing its finding ids.
//
// Test layout: abuse suite first (no db, no findings, unknown detector),
// then happy path (per-kind mapping, status 'proposed', back-filled
// analysis_findings.proposal_id, idempotency, full field set).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { start, recordFinding } = require("./runs");
const { propose } = require("./propose");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

function freshDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// seedFinding(db, finding) -> finding_id — one analysis_findings row.
function seedFinding(db, finding) {
	const r = start(db);
	const f = recordFinding(db, r.run_id, finding);
	assert.equal(f.ok, true, `seed finding failed: ${JSON.stringify(f)}`);
	return f.finding_id;
}

// A representative evidence payload per detector kind, mirroring the
// shapes detectors.js actually emits (see detectors.test.js).
const FIXTURES = [
	{
		name: "error_pattern",
		finding: {
			detector: "error_pattern",
			severity: "warn",
			title: "tool bash errored 5 times (threshold 5)",
			evidence: { tool: "bash", error_count: 5, threshold: 5 },
		},
	},
	{
		name: "cost_spike",
		finding: {
			detector: "cost_spike",
			severity: "critical",
			title: "session S1 cost spike",
			evidence: { session_id: "S1", cost: 0.42, model: "glm-5.1", p95: 0.12 },
		},
	},
	{
		name: "model_drift",
		finding: {
			detector: "model_drift",
			severity: "warn",
			title: "model glm-5.1 drifted",
			evidence: { model: "glm-5.1", recent_mean: 0.05, baseline_mean: 0.03, drift: 0.66, recent_n: 10, baseline_n: 40 },
		},
	},
	{
		name: "tool_overuse",
		finding: {
			detector: "tool_overuse",
			severity: "warn",
			title: "tool bash dominant",
			evidence: { tool: "bash", count: 80, total: 100, share: 0.8, threshold: 0.5 },
		},
	},
	{
		name: "tool_underuse",
		finding: {
			detector: "tool_underuse",
			severity: "info",
			title: "tool edit rarely used",
			evidence: { tool: "edit", count: 1, distinct_tools: 4, total_calls: 100, session_count: 1 },
		},
	},
	{
		name: "card_stall",
		finding: {
			detector: "card_stall",
			severity: "warn",
			title: "card M6-1 stalled",
			evidence: { card_id: "M6-1", title: "propose", status: "in_progress", age_days: 14, threshold_days: 7, updated_at: "2026-06-23T00:00:00.000Z" },
		},
	},
];

// =====================================================================
// ABUSE SUITE — must run first
// =====================================================================

test("abuse: missing db returns ok:false", () => {
	const res = propose();
	assert.equal(res.ok, false);
	assert.ok(res.errors && res.errors.length > 0);
});

test("abuse: no unlinked findings yields ok:true, zero proposals", () => {
	const db = freshDB();
	const res = propose(db);
	assert.equal(res.ok, true);
	assert.equal(res.proposalCount, 0);
	assert.deepEqual(res.proposals, []);
});

test("abuse: unknown detector kind still yields a well-formed proposal", () => {
	const db = freshDB();
	const fid = seedFinding(db, {
		detector: "mystery_detector",
		severity: "warn",
		title: "something odd",
		evidence: { foo: "bar" },
	});
	const res = propose(db);
	assert.equal(res.ok, true);
	assert.equal(res.proposalCount, 1);
	const p = res.proposals[0];
	assert.equal(p.status, "proposed");
	assert.equal(typeof p.setting, "string");
	assert.ok(p.setting.length > 0);
	assert.equal(typeof p.rationale, "string");
	assert.ok(p.rationale.length > 0);
	assert.deepEqual(p.source_finding_ids, [fid]);
	// expected_delta is present (object), even if minimal
	assert.equal(typeof p.expected_delta, "object");
	assert.notEqual(p.expected_delta, null);
});

// =====================================================================
// HAPPY PATH — REQ-M6-1
// =====================================================================

test("happy: each detector kind yields a well-formed proposal citing its finding id", () => {
	for (const fx of FIXTURES) {
		const db = freshDB();
		const fid = seedFinding(db, fx.finding);

		const res = propose(db);
		assert.equal(res.ok, true, `${fx.name}: propose failed`);
		assert.equal(res.proposalCount, 1, `${fx.name}: expected 1 proposal`);
		assert.equal(res.proposals.length, 1, `${fx.name}: proposals array length`);

		const p = res.proposals[0];
		assert.equal(p.status, "proposed", `${fx.name}: status`);
		// Required fields are present and the right type.
		assert.equal(typeof p.setting, "string", `${fx.name}: setting`);
		assert.ok(p.setting.length > 0, `${fx.name}: setting non-empty`);
		assert.equal(typeof p.rationale, "string", `${fx.name}: rationale`);
		assert.ok(p.rationale.length > 0, `${fx.name}: rationale non-empty`);
		assert.equal(typeof p.expected_delta, "object", `${fx.name}: expected_delta`);
		assert.notEqual(p.expected_delta, null, `${fx.name}: expected_delta not null`);
		// 'to' is defined (not undefined). 'from' may be null (unset).
		assert.notEqual(p.to, undefined, `${fx.name}: to defined`);
		// source_finding_ids cites THIS finding.
		assert.ok(Array.isArray(p.source_finding_ids), `${fx.name}: source_finding_ids is array`);
		assert.deepEqual(p.source_finding_ids, [fid], `${fx.name}: cites the finding id`);
	}
});

test("happy: proposal row persisted with status 'proposed' + correct encoded columns", () => {
	const db = freshDB();
	const fid = seedFinding(db, FIXTURES[0].finding);

	const res = propose(db);
	assert.equal(res.ok, true);
	const p = res.proposals[0];

	// Exactly one proposals row, status proposed.
	const rows = db.prepare("SELECT * FROM proposals ORDER BY id").all();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].status, "proposed");
	assert.equal(rows[0].setting, p.setting);
	assert.equal(rows[0].rationale, p.rationale);
	assert.equal(rows[0].id, p.id);
	// source_finding_ids_json decodes to the cited id.
	assert.deepEqual(JSON.parse(rows[0].source_finding_ids_json), [fid]);
	// expected_delta_json decodes to the object we returned.
	assert.deepEqual(JSON.parse(rows[0].expected_delta_json), p.expected_delta);
	// outcome_id is NULL until measure (M6-4); applied_at NULL until apply (M6-3).
	assert.equal(rows[0].outcome_id, null);
	assert.equal(rows[0].applied_at, null);
	assert.notEqual(rows[0].proposed_at, null);
});

test("happy: analysis_findings.proposal_id is back-filled to point at the proposal", () => {
	const db = freshDB();
	const fid = seedFinding(db, FIXTURES[0].finding);

	const res = propose(db);
	const proposalId = res.proposals[0].id;

	const row = db.prepare("SELECT proposal_id FROM analysis_findings WHERE id = ?").get(fid);
	assert.equal(row.proposal_id, proposalId);
});

test("happy: propose is idempotent — a second run finds no unlinked findings", () => {
	const db = freshDB();
	seedFinding(db, FIXTURES[0].finding);

	const first = propose(db);
	assert.equal(first.ok, true);
	assert.equal(first.proposalCount, 1);

	const second = propose(db);
	assert.equal(second.ok, true);
	assert.equal(second.proposalCount, 0, "already-linked findings are not re-proposed");
	assert.deepEqual(second.proposals, []);
});

test("happy: multiple unlinked findings → one proposal each, each citing its own id", () => {
	const db = freshDB();
	const ids = FIXTURES.slice(0, 3).map(fx => seedFinding(db, fx.finding));

	const res = propose(db);
	assert.equal(res.ok, true);
	assert.equal(res.proposalCount, 3);

	const cited = res.proposals.map(p => p.source_finding_ids[0]).sort();
	assert.deepEqual(cited, ids.slice().sort());

	// Every source finding now back-linked.
	const linked = db.prepare("SELECT COUNT(*) as n FROM analysis_findings WHERE proposal_id IS NOT NULL").get().n;
	assert.equal(linked, 3);
});

test("happy: error_pattern proposal references the offending tool in its setting", () => {
	const db = freshDB();
	seedFinding(db, FIXTURES[0].finding); // tool 'bash'
	const res = propose(db);
	const p = res.proposals[0];
	assert.match(p.setting, /bash/, "error_pattern setting names the tool");
	assert.match(p.rationale, /bash/, "rationale references the tool");
});

test("happy: card_stall proposal moves the stalled card's status", () => {
	const db = freshDB();
	seedFinding(db, FIXTURES[5].finding); // card_stall, status in_progress
	const res = propose(db);
	const p = res.proposals[0];
	assert.match(p.setting, /M6-1/, "card_stall setting names the card");
	assert.notEqual(p.from, p.to, "card_stall proposes a real status change");
});
