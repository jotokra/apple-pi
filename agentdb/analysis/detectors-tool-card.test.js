// agentdb/analysis/detectors-tool-card.test.js — tool-usage + card-stall detectors (M5-3).
//
// ROADMAP M5-3 acceptance gate (REQ-M5-3): fixtures trigger each finding
// type — tool_underuse, tool_overuse, card_stall (in_progress + blocked).
// The detectors read sess_sessions.tool_calls_json (aggregated by M4-3
// ingest) and kb_cards.status + updated_at.
//
// Test layout: abuse suite first (no db, tiny corpus, missing updated_at,
// other statuses), then happy path per detector.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const {
	detectToolUnderuse,
	detectToolOveruse,
	detectCardStall,
} = require("./detectors");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

function freshDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// insertSessionTools(db, opts) — one sess_sessions row whose tool_calls_json
// is the given {tool: count} map. tool_call_count is the sum of the map.
// cost is left at 0 so this fixture doesn't accidentally feed cost_spike.
function insertSessionTools(db, opts) {
	const toolCalls = (opts.tool_calls && typeof opts.tool_calls === "object") ? opts.tool_calls : {};
	let total = 0;
	for (const v of Object.values(toolCalls)) {
		const n = Number(v);
		if (Number.isFinite(n) && n > 0) total += n;
	}
	const ts = opts.ended_at || "2026-07-01T00:00:00.000Z";
	db.prepare(
		`INSERT INTO sess_sessions (session_id, started_at, ended_at, last_event_at, message_count, tool_call_count, error_count, tokens_in, tokens_out, cost, model, cwd, tool_calls_json, file_path)
		 VALUES (?, ?, ?, ?, 0, ?, 0, 0, 0, 0, ?, '/x', ?, NULL)`,
	).run(
		opts.session_id,
		ts,
		ts,
		ts,
		total,
		opts.model || "MiniMax-M3",
		JSON.stringify(toolCalls),
	);
}

// insertCard(db, opts) — one kb_cards row.
function insertCard(db, opts) {
	db.prepare(
		`INSERT INTO kb_cards (id, title, status, project, updated_at, file_path, frontmatter_json, file_hash)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		opts.id,
		opts.title || opts.id,
		opts.status,
		opts.project || "p",
		opts.updated_at || null,
		`/x/${opts.id}.card.md`,
		JSON.stringify({ id: opts.id, status: opts.status }),
		`sha-${opts.id}`,
	);
}

// =====================================================================
// ABUSE SUITE — must run first
// =====================================================================

test("abuse: missing db returns empty array (no throw)", () => {
	assert.deepEqual(detectToolUnderuse(), []);
	assert.deepEqual(detectToolOveruse(), []);
	assert.deepEqual(detectCardStall(), []);
});

test("abuse: empty db returns no findings", () => {
	const db = freshDB();
	assert.deepEqual(detectToolUnderuse(db), []);
	assert.deepEqual(detectToolOveruse(db), []);
	assert.deepEqual(detectCardStall(db), []);
});

test("abuse: tool detectors no-op on a tiny corpus (< minCalls)", () => {
	const db = freshDB();
	insertSessionTools(db, { session_id: "s-1", tool_calls: { read: 2, edit: 1 } });
	assert.deepEqual(detectToolOveruse(db), [], "grand total 3 < minCalls(20) → no overuse");
	assert.deepEqual(detectToolUnderuse(db), [], "grand total 3 < minCalls(20) → no underuse");
});

test("abuse: malformed tool_calls_json rows are skipped, not fatal", () => {
	const db = freshDB();
	// Hand-insert a row with garbage JSON; the good row still counts.
	db.prepare(
		`INSERT INTO sess_sessions (session_id, started_at, ended_at, last_event_at, message_count, tool_call_count, error_count, tokens_in, tokens_out, cost, model, cwd, tool_calls_json, file_path)
		 VALUES ('s-bad','2026-07-01','2026-07-01','2026-07-01',0,5,0,0,0,0,'M','/x','{not json',NULL)`,
	).run();
	insertSessionTools(db, { session_id: "s-good", tool_calls: { read: 50, edit: 30, search: 20 } });
	const findings = detectToolOveruse(db);
	assert.ok(findings.length > 0, "the good row still produces a finding despite the bad row");
});

test("abuse: card_stall skips cards with no updated_at", () => {
	const db = freshDB();
	insertCard(db, { id: "c-1", status: "in_progress" }); // updated_at NULL
	insertCard(db, { id: "c-2", status: "blocked" });     // updated_at NULL
	const findings = detectCardStall(db, { now: "2026-07-07T00:00:00.000Z" });
	assert.equal(findings.length, 0, "cards without updated_at can't be aged");
});

test("abuse: card_stall ignores statuses other than in_progress/blocked", () => {
	const db = freshDB();
	insertCard(db, { id: "c-done", status: "done", updated_at: "2026-01-01T00:00:00.000Z" });
	insertCard(db, { id: "c-review", status: "review", updated_at: "2026-01-01T00:00:00.000Z" });
	insertCard(db, { id: "c-triage", status: "triage", updated_at: "2026-01-01T00:00:00.000Z" });
	const findings = detectCardStall(db, { now: "2026-07-07T00:00:00.000Z" });
	assert.equal(findings.length, 0, "only in_progress + blocked are stall candidates");
});

test("abuse: card_stall does not flag a fresh card (within threshold)", () => {
	const db = freshDB();
	insertCard(db, { id: "c-fresh", status: "in_progress", updated_at: "2026-07-05T00:00:00.000Z" });
	const findings = detectCardStall(db, { now: "2026-07-07T00:00:00.000Z", inProgressDays: 7 });
	assert.equal(findings.length, 0, "2 days < 7d threshold → not stalled");
});

test("abuse: bad opts fall back to defaults (no throw)", () => {
	const db = freshDB();
	insertCard(db, { id: "c-1", status: "in_progress", updated_at: "2026-01-01T00:00:00.000Z" });
	const findings = detectCardStall(db, { now: "2026-07-07T00:00:00.000Z", inProgressDays: -3, blockedDays: "nope" });
	assert.ok(findings.length > 0, "negative/non-numeric opts fall back to defaults; old card still flags");
});

test("abuse: card_stall ignores a future-dated updated_at (clock skew)", () => {
	const db = freshDB();
	insertCard(db, { id: "c-future", status: "in_progress", updated_at: "2026-12-31T00:00:00.000Z" });
	const findings = detectCardStall(db, { now: "2026-07-07T00:00:00.000Z" });
	assert.equal(findings.length, 0, "negative age is not a stall");
});

// =====================================================================
// HAPPY PATH: tool_overuse
// =====================================================================

test("happy: tool_overuse flags a tool that is >= 50% of all calls (warn band)", () => {
	const db = freshDB();
	// read 50, edit 20, search 10 → total 80; read = 62.5% (warn band)
	insertSessionTools(db, { session_id: "s-1", tool_calls: { read: 50, edit: 20, search: 10 } });
	const findings = detectToolOveruse(db);
	const read = findings.find(f => f.evidence.tool === "read");
	assert.ok(read, "read is flagged as overused");
	assert.equal(read.severity, "warn", "62.5% is in warn band (50% <= x < 75%)");
	assert.ok(read.evidence.share >= 0.5);
	assert.ok(read.evidence.share < 0.75);
	assert.equal(read.evidence.total, 80);
	// edit/search are below threshold → not flagged
	assert.ok(!findings.find(f => f.evidence.tool === "edit"));
	assert.ok(!findings.find(f => f.evidence.tool === "search"));
});

test("happy: tool_overuse promotes to critical at >= 75% share", () => {
	const db = freshDB();
	// read 90, edit 5, search 5 → total 100; read = 90%
	insertSessionTools(db, { session_id: "s-1", tool_calls: { read: 90, edit: 5, search: 5 } });
	const findings = detectToolOveruse(db);
	const read = findings.find(f => f.evidence.tool === "read");
	assert.ok(read);
	assert.equal(read.severity, "critical", "90% >= 75% = critical");
});

test("happy: tool_overuse does NOT flag when no tool dominates", () => {
	const db = freshDB();
	insertSessionTools(db, { session_id: "s-1", tool_calls: { read: 30, edit: 30, search: 30 } });
	const findings = detectToolOveruse(db);
	assert.equal(findings.length, 0, "even split, no tool >= 50%");
});

test("happy: tool_overuse aggregates across multiple sessions", () => {
	const db = freshDB();
	insertSessionTools(db, { session_id: "s-1", tool_calls: { read: 40, edit: 5 } });
	insertSessionTools(db, { session_id: "s-2", tool_calls: { read: 40, search: 5 } });
	// read = 80/90 ≈ 89% across two sessions
	const findings = detectToolOveruse(db);
	const read = findings.find(f => f.evidence.tool === "read");
	assert.ok(read);
	assert.equal(read.evidence.total, 90);
	assert.ok(read.evidence.share >= 0.75);
});

// =====================================================================
// HAPPY PATH: tool_underuse
// =====================================================================

test("happy: tool_underuse flags a tool used <= maxRare times in a diverse corpus", () => {
	const db = freshDB();
	// search used once; read/edit heavily used. 3 distinct tools, grand > 20.
	insertSessionTools(db, { session_id: "s-1", tool_calls: { read: 60, edit: 30, search: 1 } });
	const findings = detectToolUnderuse(db);
	const search = findings.find(f => f.evidence.tool === "search");
	assert.ok(search, "search (1 use) is flagged as underused");
	assert.equal(search.evidence.count, 1);
	assert.equal(search.evidence.distinct_tools, 3);
	assert.equal(search.detector, "tool_underuse");
	// well-used tools should NOT appear
	assert.ok(!findings.find(f => f.evidence.tool === "read"));
	assert.ok(!findings.find(f => f.evidence.tool === "edit"));
});

test("happy: tool_underuse no-op when fewer than minDistinct tools", () => {
	const db = freshDB();
	insertSessionTools(db, { session_id: "s-1", tool_calls: { read: 60, search: 1 } });
	const findings = detectToolUnderuse(db);
	assert.equal(findings.length, 0, "only 2 distinct tools < minDistinct(3); rare use isn't notable");
});

test("happy: tool_underuse respects a custom maxRare", () => {
	const db = freshDB();
	// search=2; with default maxRare=1 it isn't flagged (2 > 1), with maxRare=2 it is (2 <= 2).
	insertSessionTools(db, { session_id: "s-1", tool_calls: { read: 60, edit: 30, search: 2 } });
	assert.equal(detectToolUnderuse(db).length, 0, "2 > default maxRare(1) → not flagged");
	const findings = detectToolUnderuse(db, { maxRare: 2 });
	assert.equal(findings.length, 1);
	assert.equal(findings[0].evidence.tool, "search");
});

// =====================================================================
// HAPPY PATH: card_stall
// =====================================================================

test("happy: card_stall flags an in_progress card older than the threshold (warn band)", () => {
	const db = freshDB();
	// 10 days in_progress (threshold 7); 10 < 14 (2x) → warn
	insertCard(db, { id: "c-prog", status: "in_progress", updated_at: "2026-06-27T00:00:00.000Z" });
	const findings = detectCardStall(db, { now: "2026-07-07T00:00:00.000Z" });
	const f = findings.find(x => x.evidence.card_id === "c-prog");
	assert.ok(f, "in_progress card flagged");
	assert.equal(f.detector, "card_stall");
	assert.equal(f.severity, "warn", "10 days < 2x threshold (14d) → warn");
	assert.ok(f.evidence.age_days > 7);
	assert.equal(f.evidence.status, "in_progress");
	assert.equal(f.evidence.threshold_days, 7);
});

test("happy: card_stall flags a blocked card older than its threshold (warn band)", () => {
	const db = freshDB();
	// 5 days blocked (threshold 3); 5 < 6 (2x) → warn
	insertCard(db, { id: "c-block", status: "blocked", updated_at: "2026-07-02T00:00:00.000Z" });
	const findings = detectCardStall(db, { now: "2026-07-07T00:00:00.000Z" });
	const f = findings.find(x => x.evidence.card_id === "c-block");
	assert.ok(f, "blocked card flagged");
	assert.equal(f.severity, "warn", "5 days < 2x threshold (6d) → warn");
	assert.ok(f.evidence.age_days > 3);
	assert.equal(f.evidence.threshold_days, 3);
});

test("happy: card_stall promotes to critical at 2x threshold (in_progress)", () => {
	const db = freshDB();
	// 20 days in_progress; 2x of 7d = 14d → critical
	insertCard(db, { id: "c-old", status: "in_progress", updated_at: "2026-06-17T00:00:00.000Z" });
	const findings = detectCardStall(db, { now: "2026-07-07T00:00:00.000Z" });
	const f = findings.find(x => x.evidence.card_id === "c-old");
	assert.ok(f);
	assert.equal(f.severity, "critical", "20 days >= 2x threshold (14d) → critical");
});

test("happy: card_stall respects custom thresholds (blockedDays)", () => {
	const db = freshDB();
	// 2 days blocked; default threshold 3 → no finding. With blockedDays=1 → finding.
	insertCard(db, { id: "c-block", status: "blocked", updated_at: "2026-07-05T00:00:00.000Z" });
	assert.equal(detectCardStall(db, { now: "2026-07-07T00:00:00.000Z" }).length, 0, "2d < default 3d");
	const findings = detectCardStall(db, { now: "2026-07-07T00:00:00.000Z", blockedDays: 1 });
	assert.equal(findings.length, 1, "2d >= custom 1d → flagged");
});

test("happy: card_stall surfaces both in_progress and blocked in one pass", () => {
	const db = freshDB();
	insertCard(db, { id: "c-prog", status: "in_progress", updated_at: "2026-06-01T00:00:00.000Z" });
	insertCard(db, { id: "c-block", status: "blocked", updated_at: "2026-06-01T00:00:00.000Z" });
	const findings = detectCardStall(db, { now: "2026-07-07T00:00:00.000Z" });
	const ids = new Set(findings.map(f => f.evidence.card_id));
	assert.ok(ids.has("c-prog"));
	assert.ok(ids.has("c-block"));
});

// =====================================================================
// SHAPE
// =====================================================================

test("happy: each finding has the shape recordFinding expects", () => {
	const db = freshDB();
	insertCard(db, { id: "c-1", status: "in_progress", updated_at: "2026-01-01T00:00:00.000Z" });
	insertSessionTools(db, { session_id: "s-1", tool_calls: { read: 90, edit: 5, search: 5 } });
	const all = [
		...detectCardStall(db, { now: "2026-07-07T00:00:00.000Z" }),
		...detectToolOveruse(db),
	];
	for (const f of all) {
		assert.equal(typeof f.detector, "string");
		assert.ok(["info", "warn", "critical"].includes(f.severity));
		assert.equal(typeof f.title, "string");
		assert.ok(f.title.length > 0);
		assert.ok(f.evidence && typeof f.evidence === "object");
	}
});
