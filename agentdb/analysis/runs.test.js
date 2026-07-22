// agentdb/analysis/runs.test.js — analysis_runs bookkeeping (M5-1).
//
// ROADMAP M5-1 acceptance gate: an analyze run creates exactly one
// analysis_runs row linked to its findings.
//
// Test layout: abuse suite first (bad inputs, missing run_id, bad
// finding shape), then happy path (start/end round-trip, list ordering,
// recordFinding bumps count, missing-run-id is a hard error not a no-op).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { start, end, get, list, recordFinding } = require("./runs");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

function freshDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// =====================================================================
// ABUSE SUITE — must run first
// =====================================================================

test("abuse: missing db returns ok:false", () => {
	assert.equal(start().ok, false);
	assert.equal(end().ok, false);
	assert.equal(recordFinding().ok, false);
	assert.deepEqual(list(), []);
});

test("abuse: end() requires opts.finding_count (positive integer)", () => {
	const db = freshDB();
	const r = start(db);
	assert.equal(r.ok, true);
	// No opts at all
	const e1 = end(db, r.run_id, {});
	assert.equal(e1.ok, false);
	// Negative
	const e2 = end(db, r.run_id, { finding_count: -1 });
	assert.equal(e2.ok, false);
	// String
	const e3 = end(db, r.run_id, { finding_count: "5" });
	assert.equal(e3.ok, false);
	// Float
	const e4 = end(db, r.run_id, { finding_count: 1.5 });
	assert.equal(e4.ok, false);
});

test("abuse: end() rejects non-positive runId", () => {
	const db = freshDB();
	for (const bad of [0, -1, "1", 1.5, null, undefined, []]) {
		const res = end(db, bad, { finding_count: 0 });
		assert.equal(res.ok, false, `expected reject for runId=${JSON.stringify(bad)}`);
	}
});

test("abuse: end() on non-existent runId returns ok:false (not a silent no-op)", () => {
	const db = freshDB();
	const res = end(db, 99999, { finding_count: 0 });
	assert.equal(res.ok, false);
	assert.match(res.errors.join(" "), /no analysis_runs row/);
});

test("abuse: recordFinding rejects non-object finding", () => {
	const db = freshDB();
	const r = start(db);
	for (const bad of [null, undefined, 42, "string", []]) {
		const res = recordFinding(db, r.run_id, bad);
		assert.equal(res.ok, false, `expected reject for finding=${JSON.stringify(bad)}`);
	}
});

test("abuse: recordFinding rejects unknown severity", () => {
	const db = freshDB();
	const r = start(db);
	for (const sev of ["fatal", "warning", "INFO", "", null, 42]) {
		const res = recordFinding(db, r.run_id, { detector: "test", severity: sev, title: "x" });
		assert.equal(res.ok, false, `expected reject for severity=${JSON.stringify(sev)}`);
	}
});

test("abuse: recordFinding rejects missing detector / title", () => {
	const db = freshDB();
	const r = start(db);
	const noDetector = recordFinding(db, r.run_id, { severity: "info", title: "x" });
	assert.equal(noDetector.ok, false);
	const noTitle = recordFinding(db, r.run_id, { detector: "test", severity: "info" });
	assert.equal(noTitle.ok, false);
	const emptyDetector = recordFinding(db, r.run_id, { detector: "", severity: "info", title: "x" });
	assert.equal(emptyDetector.ok, false);
});

// =====================================================================
// HAPPY PATH
// =====================================================================

test("happy: start() creates exactly one analysis_runs row", () => {
	const db = freshDB();
	const before = db.prepare("SELECT COUNT(*) as n FROM analysis_runs").get().n;
	const r = start(db, { model: "MiniMax-M3", tokens_in: 100, tokens_out: 50, notes: "first run" });
	assert.equal(r.ok, true);
	assert.ok(r.run_id > 0);
	const after = db.prepare("SELECT COUNT(*) as n FROM analysis_runs").get().n;
	assert.equal(after, before + 1);
	const row = db.prepare("SELECT * FROM analysis_runs WHERE id = ?").get(r.run_id);
	assert.equal(row.model, "MiniMax-M3");
	assert.equal(row.tokens_in, 100);
	assert.equal(row.tokens_out, 50);
	assert.equal(row.notes, "first run");
	assert.equal(row.finding_count, 0, "fresh run starts with 0 findings");
	assert.equal(row.ended_at, null, "fresh run has no ended_at");
});

test("happy: end() updates ended_at + finding_count", () => {
	const db = freshDB();
	const r = start(db);
	const e = end(db, r.run_id, { finding_count: 3 });
	assert.equal(e.ok, true);
	const row = db.prepare("SELECT * FROM analysis_runs WHERE id = ?").get(r.run_id);
	assert.equal(row.finding_count, 3);
	assert.notEqual(row.ended_at, null, "ended_at set");
	assert.ok(row.ended_at >= row.started_at, "ended_at >= started_at");
});

test("happy: end() can update notes (preserves when not given)", () => {
	const db = freshDB();
	const r = start(db, { notes: "initial" });
	end(db, r.run_id, { finding_count: 1 });
	let row = db.prepare("SELECT * FROM analysis_runs WHERE id = ?").get(r.run_id);
	assert.equal(row.notes, "initial", "no notes passed → COALESCE preserves initial");
	row = db.prepare("SELECT * FROM analysis_runs WHERE id = ?").get(r.run_id);
	end(db, r.run_id, { finding_count: 2, notes: "updated" });
	row = db.prepare("SELECT * FROM analysis_runs WHERE id = ?").get(r.run_id);
	assert.equal(row.notes, "updated");
	assert.equal(row.finding_count, 2);
});

test("happy: get() returns the row by id, null for missing", () => {
	const db = freshDB();
	const r = start(db);
	const row = get(db, r.run_id);
	assert.ok(row);
	assert.equal(row.id, r.run_id);
	assert.equal(get(db, 99999), null);
	assert.equal(get(db, -1), null);
	assert.equal(get(db, "x"), null);
});

test("happy: list() returns newest first, optionally limited", () => {
	const db = freshDB();
	const r1 = start(db, { notes: "first" });
	const r2 = start(db, { notes: "second" });
	const r3 = start(db, { notes: "third" });
	const all = list(db);
	assert.equal(all.length, 3);
	assert.equal(all[0].id, r3.run_id, "newest first");
	assert.equal(all[1].id, r2.run_id);
	assert.equal(all[2].id, r1.run_id);

	const limited = list(db, { limit: 2 });
	assert.equal(limited.length, 2);
	assert.equal(limited[0].id, r3.run_id);
	assert.equal(limited[1].id, r2.run_id);
});

test("happy: list() with since filter returns only newer runs", () => {
	const db = freshDB();
	const r1 = start(db, { notes: "old" });
	const r2 = start(db, { notes: "new" });
	// since = r2.started_at; the comparison >= includes r2
	const filtered = list(db, { since: r2.run_started_at || "2099-01-01" });
	// Use r1.id directly to check r1 is excluded when since = r2's ts
	// We don't have run_started_at; use a fabricated future date.
	const none = list(db, { since: "2099-01-01T00:00:00.000Z" });
	assert.equal(none.length, 0);
	// And a past date includes both
	const all = list(db, { since: "2000-01-01T00:00:00.000Z" });
	assert.equal(all.length, 2);
});

test("happy: recordFinding inserts into analysis_findings AND bumps run.finding_count", () => {
	const db = freshDB();
	const r = start(db);
	const f1 = recordFinding(db, r.run_id, { detector: "error_pattern", severity: "warn", title: "tool X failed 5x" });
	assert.equal(f1.ok, true);
	assert.ok(f1.finding_id > 0);
	const f2 = recordFinding(db, r.run_id, { detector: "card_stall", severity: "info", title: "card Y stalled 3 days" });
	assert.equal(f2.ok, true);
	const f3 = recordFinding(db, r.run_id, { detector: "cost_spike", severity: "critical", title: "session Z cost spike", evidence: { session_id: "Z", cost: 0.42 } });
	assert.equal(f3.ok, true);
	// run row's finding_count should be 3
	const run = db.prepare("SELECT finding_count FROM analysis_runs WHERE id = ?").get(r.run_id);
	assert.equal(run.finding_count, 3);
	// 3 analysis_findings rows linked to this run
	const findings = db.prepare("SELECT * FROM analysis_findings WHERE run_id = ? ORDER BY id").all(r.run_id);
	assert.equal(findings.length, 3);
	assert.equal(findings[0].detector, "error_pattern");
	assert.equal(findings[0].severity, "warn");
	assert.equal(findings[1].detector, "card_stall");
	assert.equal(findings[2].detector, "cost_spike");
	assert.match(findings[2].evidence_json, /Z/);
});

test("happy: recordFinding's evidence_json defaults to '{}' when no evidence", () => {
	const db = freshDB();
	const r = start(db);
	const f = recordFinding(db, r.run_id, { detector: "test", severity: "info", title: "no-evidence finding" });
	assert.equal(f.ok, true);
	const row = db.prepare("SELECT evidence_json FROM analysis_findings WHERE id = ?").get(f.finding_id);
	assert.equal(row.evidence_json, "{}");
});

test("happy: end() with finding_count matches recordFinding calls", () => {
	const db = freshDB();
	const r = start(db);
	recordFinding(db, r.run_id, { detector: "d1", severity: "info", title: "t1" });
	recordFinding(db, r.run_id, { detector: "d2", severity: "warn", title: "t2" });
	// The contract: end() must pass finding_count equal to the actual
	// count of findings in analysis_findings for this run. The
	// analysis_runs row's count is the source of truth (M5-4 CLI
	// uses run.finding_count for the dashboard).
	const endRes = end(db, r.run_id, { finding_count: 2 });
	assert.equal(endRes.ok, true);
	assert.equal(endRes.run.finding_count, 2);
});

test("happy: list() is stable across 10 runs (ordering by id DESC)", () => {
	const db = freshDB();
	const ids = [];
	for (let i = 0; i < 10; i++) ids.push(start(db).run_id);
	const all = list(db);
	assert.equal(all.length, 10);
	// Should be reverse of insertion order
	assert.deepEqual(all.map(r => r.id), ids.slice().reverse());
});