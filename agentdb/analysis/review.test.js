// agentdb/analysis/review.test.js — review (human gate, read-only) (M6-2).
//
// ROADMAP M6-2 acceptance gate: `review` shows pending proposals with
// their source findings and writes nothing. Mirrors the autoresearch
// review gate (lifecycle/apply-update.js latestProposal + renderDiff)
// but on the unified proposals table populated by M6-1 propose().
//
// Test layout: abuse suite first (no db, empty table), then happy path
// (pending list + source findings + decoded body + --latest + status
// filtering + the no-mutation red-blue contract).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { start, recordFinding } = require("./runs");
const { propose } = require("./propose");
const { review, formatReview } = require("./review");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

function freshDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// seedFinding(db, finding) -> finding_id.
function seedFinding(db, finding) {
	const r = start(db);
	const f = recordFinding(db, r.run_id, finding);
	assert.equal(f.ok, true, `seed finding failed: ${JSON.stringify(f)}`);
	return f.finding_id;
}

// Produce one 'proposed' proposal (via the real propose() producer) from
// a single finding. Returns { proposal, findingId }.
function seedProposed(db, finding) {
	const fid = seedFinding(db, finding);
	const res = propose(db);
	assert.equal(res.ok, true);
	assert.equal(res.proposalCount, 1);
	return { proposal: res.proposals[0], findingId: fid };
}

// Insert a proposals row directly with an explicit status, for testing
// the status filter (propose() only ever emits 'proposed').
function seedProposalRow(db, { status, setting = "agent.x", source_finding_ids = [] }) {
	const info = db.prepare(
		`INSERT INTO proposals
		   (status, setting, from_value, to_value, rationale,
		    expected_delta_json, source_finding_ids_json, outcome_id,
		    proposed_at, applied_at)
		 VALUES (?, ?, NULL, '1', 'rationale', '{}', ?, NULL, ?, NULL)`,
	).run(status, setting, JSON.stringify(source_finding_ids), new Date().toISOString());
	return info.lastInsertRowid;
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
	const res = review();
	assert.equal(res.ok, false);
	assert.ok(res.errors && res.errors.length > 0);
});

test("abuse: empty proposals table yields ok:true, zero proposals", () => {
	const db = freshDB();
	const res = review(db);
	assert.equal(res.ok, true);
	assert.equal(res.proposalCount, 0);
	assert.deepEqual(res.proposals, []);
});

test("abuse: --latest on empty table yields ok:true, zero proposals", () => {
	const db = freshDB();
	const res = review(db, { latest: true });
	assert.equal(res.ok, true);
	assert.equal(res.proposalCount, 0);
	assert.deepEqual(res.proposals, []);
});

// =====================================================================
// HAPPY PATH — REQ-M6-2: shows pending proposals with source findings
// =====================================================================

test("happy: pending proposal is listed with decoded body + source findings", () => {
	const db = freshDB();
	const { proposal, findingId } = seedProposed(db, ERROR_PATTERN_FINDING);

	const res = review(db);
	assert.equal(res.ok, true);
	assert.equal(res.proposalCount, 1);
	assert.equal(res.proposals.length, 1);

	const p = res.proposals[0];
	// Same row we just produced.
	assert.equal(p.id, proposal.id);
	assert.equal(p.status, "proposed");
	assert.equal(p.setting, proposal.setting);
	assert.equal(p.rationale, proposal.rationale);
	// Decoded JSON columns round-trip (not raw strings).
	assert.deepEqual(p.source_finding_ids, [findingId]);
	assert.equal(typeof p.expected_delta, "object");
	assert.notEqual(p.expected_delta, null);
	// The diff pair is present.
	assert.notEqual(p.to, undefined);

	// Source findings are attached + decoded.
	assert.ok(Array.isArray(p.source_findings));
	assert.equal(p.source_findings.length, 1);
	const sf = p.source_findings[0];
	assert.equal(sf.id, findingId);
	assert.equal(sf.detector, "error_pattern");
	assert.equal(sf.severity, "warn");
	assert.equal(sf.title, ERROR_PATTERN_FINDING.title);
	// evidence is parsed back into an object, not left as a JSON string.
	assert.equal(typeof sf.evidence, "object");
	assert.deepEqual(sf.evidence, ERROR_PATTERN_FINDING.evidence);
});

test("happy: default lists ALL pending (status='proposed'), newest first", () => {
	const db = freshDB();
	const a = seedProposed(db, ERROR_PATTERN_FINDING);
	const b = seedProposed(db, {
		detector: "card_stall",
		severity: "warn",
		title: "card M6-1 stalled",
		evidence: { card_id: "M6-1", title: "propose", status: "in_progress", age_days: 14, threshold_days: 7, updated_at: "2026-06-23T00:00:00.000Z" },
	});

	const res = review(db);
	assert.equal(res.ok, true);
	assert.equal(res.proposalCount, 2);
	// Newest first (higher id first).
	assert.equal(res.proposals[0].id, b.proposal.id);
	assert.equal(res.proposals[1].id, a.proposal.id);
});

test("happy: --latest returns only the single newest pending proposal", () => {
	const db = freshDB();
	seedProposed(db, ERROR_PATTERN_FINDING);
	const newest = seedProposed(db, {
		detector: "cost_spike",
		severity: "critical",
		title: "session S1 cost spike",
		evidence: { session_id: "S1", cost: 0.42, model: "glm-5.1", p95: 0.12 },
	});

	const res = review(db, { latest: true });
	assert.equal(res.ok, true);
	assert.equal(res.proposalCount, 1);
	assert.equal(res.proposals.length, 1);
	assert.equal(res.proposals[0].id, newest.proposal.id);
});

test("happy: applied/rejected proposals are excluded from the default pending list", () => {
	const db = freshDB();
	const pending = seedProposed(db, ERROR_PATTERN_FINDING);
	seedProposalRow(db, { status: "applied", setting: "agent.applied" });
	seedProposalRow(db, { status: "rejected", setting: "agent.rejected" });

	const res = review(db);
	assert.equal(res.ok, true);
	assert.equal(res.proposalCount, 1);
	assert.equal(res.proposals[0].id, pending.proposal.id);
});

test("happy: --latest falls back to newest of any status when nothing is pending", () => {
	const db = freshDB();
	const appliedId = seedProposalRow(db, { status: "applied", setting: "agent.applied" });
	// A second applied row with a higher id (newer).
	const newerId = seedProposalRow(db, { status: "applied", setting: "agent.applied2" });
	assert.ok(newerId > appliedId);

	const res = review(db, { latest: true });
	assert.equal(res.ok, true);
	assert.equal(res.proposalCount, 1);
	assert.equal(res.proposals[0].id, newerId);
	assert.equal(res.proposals[0].status, "applied");
});

test("happy: proposal with no source findings yields an empty source_findings list", () => {
	const db = freshDB();
	seedProposalRow(db, { status: "proposed", setting: "agent.manual", source_finding_ids: [] });

	const res = review(db);
	assert.equal(res.ok, true);
	assert.equal(res.proposalCount, 1);
	assert.deepEqual(res.proposals[0].source_findings, []);
	assert.deepEqual(res.proposals[0].source_finding_ids, []);
});

// =====================================================================
// RED-BLUE: review is READ-ONLY — no mutation of any table
// =====================================================================

test("red-blue: review writes nothing — row counts and contents unchanged", () => {
	const db = freshDB();
	seedProposed(db, ERROR_PATTERN_FINDING);
	seedProposalRow(db, { status: "applied", setting: "agent.applied" });

	// Snapshot before.
	const beforeProposals = db.prepare("SELECT * FROM proposals ORDER BY id").all();
	const beforeFindings = db.prepare("SELECT * FROM analysis_findings ORDER BY id").all();
	const beforeRuns = db.prepare("SELECT * FROM analysis_runs ORDER BY id").all();
	const beforeOutcomes = db.prepare("SELECT COUNT(*) c FROM improvement_outcomes").get().c;

	// Run review twice (default + latest).
	const r1 = review(db);
	const r2 = review(db, { latest: true });
	assert.equal(r1.ok, true);
	assert.equal(r2.ok, true);

	// Snapshot after — must be byte-identical.
	const afterProposals = db.prepare("SELECT * FROM proposals ORDER BY id").all();
	const afterFindings = db.prepare("SELECT * FROM analysis_findings ORDER BY id").all();
	const afterRuns = db.prepare("SELECT * FROM analysis_runs ORDER BY id").all();
	const afterOutcomes = db.prepare("SELECT COUNT(*) c FROM improvement_outcomes").get().c;

	assert.deepEqual(afterProposals, beforeProposals, "proposals table must not change");
	assert.deepEqual(afterFindings, beforeFindings, "analysis_findings must not change");
	assert.deepEqual(afterRuns, beforeRuns, "analysis_runs must not change");
	assert.equal(afterOutcomes, beforeOutcomes, "improvement_outcomes must not change");
});

// =====================================================================
// formatReview — CLI presentation helper
// =====================================================================

test("formatReview: empty result renders a 'no proposals' line", () => {
	const out = formatReview({ ok: true, proposalCount: 0, proposals: [] });
	assert.equal(typeof out, "string");
	assert.ok(out.length > 0);
});

test("formatReview: lists each proposal's setting + from→to diff + rationale", () => {
	const db = freshDB();
	const res = review(db); // re-run on a populated db
	// Re-seed a fresh db for a deterministic render.
	const db2 = freshDB();
	const { proposal } = seedProposed(db2, ERROR_PATTERN_FINDING);
	const populated = review(db2);

	const out = formatReview(populated);
	assert.equal(typeof out, "string");
	assert.ok(out.includes(proposal.setting), "mentions the setting");
	assert.ok(/→/.test(out), "renders a from→to diff");
	assert.ok(out.includes(proposal.rationale), "includes the rationale");
});
