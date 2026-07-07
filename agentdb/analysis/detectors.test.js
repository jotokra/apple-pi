// agentdb/analysis/detectors.test.js — error + cost + drift detectors (M5-2).
//
// ROADMAP M5-2 acceptance gate: over a seeded sess_* fixture, each
// detector emits the expected finding with evidence_json.
//
// Test layout: abuse suite first (no db, tiny corpus, malformed data),
// then happy path (error_pattern, cost_spike, model_drift, runAll).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const {
	detectErrorPatterns,
	detectCostSpikes,
	detectModelDrift,
	runAllDetectors,
	percentile,
} = require("./detectors");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

function freshDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// insertEvent(db, opts) — INSERT one sess_events row directly.
function insertEvent(db, opts) {
	db.prepare(
		`INSERT INTO sess_events (session_id, seq, type, ts, role, tool, tokens_in, tokens_out, is_error, content_sha, event_json)
		 VALUES (?, ?, 'message', ?, ?, ?, ?, ?, ?, ?, '{}')`,
	).run(
		opts.session_id,
		opts.seq,
		opts.ts,
		opts.role ?? "user",
		opts.tool ?? null,
		opts.tokens_in ?? 0,
		opts.tokens_out ?? 0,
		opts.is_error ?? 0,
		opts.content_sha ?? `sha-${opts.session_id}-${opts.seq}`,
	);
}

// insertSession(db, opts) — INSERT one sess_sessions row + its events.
function insertSession(db, opts) {
	const { session_id, cost, message_count, model, ended_at, events = [] } = opts;
	db.prepare(
		`INSERT INTO sess_sessions (session_id, started_at, ended_at, last_event_at, message_count, tool_call_count, error_count, tokens_in, tokens_out, cost, model, cwd, tool_calls_json, file_path)
		 VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, '/x', '{}', NULL)`,
	).run(session_id, opts.started_at || ended_at, ended_at, ended_at, message_count, cost, model);
	for (let i = 0; i < events.length; i++) {
		insertEvent(db, { ...events[i], session_id, seq: i });
	}
}

// =====================================================================
// ABUSE SUITE — must run first
// =====================================================================

test("abuse: missing db returns empty array (no throw)", () => {
	assert.deepEqual(detectErrorPatterns(), []);
	assert.deepEqual(detectCostSpikes(), []);
	assert.deepEqual(detectModelDrift(), []);
});

test("abuse: empty db returns no findings (no-op)", () => {
	const db = freshDB();
	assert.deepEqual(detectErrorPatterns(db), []);
	assert.deepEqual(detectCostSpikes(db), []);
	assert.deepEqual(detectModelDrift(db), []);
});

test("abuse: tiny corpus (fewer than 3 cost rows) is a no-op for cost_spike", () => {
	const db = freshDB();
	insertSession(db, { session_id: "s-1", cost: 0.5, message_count: 5, model: "MiniMax-M3", ended_at: "2026-01-01T00:00:00.000Z" });
	insertSession(db, { session_id: "s-2", cost: 0.3, message_count: 3, model: "MiniMax-M3", ended_at: "2026-01-02T00:00:00.000Z" });
	const findings = detectCostSpikes(db);
	assert.equal(findings.length, 0, "fewer than 3 sessions with cost = no p95 baseline");
});

test("abuse: tiny corpus (fewer than recentN+1) is a no-op for model_drift", () => {
	const db = freshDB();
	// Only 5 sessions; recentN=10 + baselineN=40 = 50 minimum
	for (let i = 0; i < 5; i++) {
		insertSession(db, { session_id: `s-${i}`, cost: 0.01, message_count: 1, model: "MiniMax-M3", ended_at: `2026-01-0${i+1}T00:00:00.000Z` });
	}
	const findings = detectModelDrift(db);
	assert.equal(findings.length, 0);
});

test("abuse: bad opts (negative threshold, etc.) silently fall back to defaults", () => {
	const db = freshDB();
	for (let i = 0; i < 10; i++) {
		insertEvent(db, { session_id: `s-${i}`, seq: 0, ts: "2026-01-01T00:00:00.000Z", tool: "search_files", is_error: 1 });
	}
	const findings = detectErrorPatterns(db, { minErrors: -5 });
	assert.ok(findings.length > 0, "negative threshold falls back to default (5); the 10 error rows still trigger");
});

test("abuse: percentile is robust to empty / single-element arrays", () => {
	assert.equal(percentile([], 0.5), 0);
	assert.equal(percentile([42], 0.5), 42);
	assert.equal(percentile([42], 0), 42);
	assert.equal(percentile([42], 1), 42);
});

// =====================================================================
// HAPPY PATH
// =====================================================================

test("happy: error_pattern emits a warn finding for a tool that errored >= 5 times", () => {
	const db = freshDB();
	// 5 errors with tool=search_files
	for (let i = 0; i < 5; i++) {
		insertEvent(db, { session_id: `s-${i}`, seq: 0, ts: "2026-01-01T00:00:00.000Z", tool: "search_files", is_error: 1 });
	}
	const findings = detectErrorPatterns(db);
	assert.equal(findings.length, 1);
	assert.equal(findings[0].detector, "error_pattern");
	assert.equal(findings[0].severity, "warn");
	assert.match(findings[0].title, /search_files/);
	assert.equal(findings[0].evidence.tool, "search_files");
	assert.equal(findings[0].evidence.error_count, 5);
	assert.equal(findings[0].evidence.threshold, 5);
});

test("happy: error_pattern promotes to critical at 4x threshold", () => {
	const db = freshDB();
	// 20 errors with tool=terminal
	for (let i = 0; i < 20; i++) {
		insertEvent(db, { session_id: `s-${i}`, seq: 0, ts: "2026-01-01T00:00:00.000Z", tool: "terminal", is_error: 1 });
	}
	const findings = detectErrorPatterns(db, { minErrors: 5 });
	assert.equal(findings.length, 1);
	assert.equal(findings[0].severity, "critical", "20 errors / 5 threshold = 4x = critical");
});

test("happy: error_pattern does NOT emit when tool is null (anonymous errors)", () => {
	const db = freshDB();
	for (let i = 0; i < 10; i++) {
		insertEvent(db, { session_id: `s-${i}`, seq: 0, ts: "2026-01-01T00:00:00.000Z", tool: null, is_error: 1 });
	}
	const findings = detectErrorPatterns(db);
	assert.equal(findings.length, 0, "tool=NULL events don't count for the per-tool pattern");
});

test("happy: cost_spike emits critical findings for sessions above p95", () => {
	const db = freshDB();
	// 50 sessions: 49 cheap, 1 expensive (spike)
	for (let i = 0; i < 49; i++) {
		insertSession(db, {
			session_id: `s-cheap-${i}`,
			cost: 0.001,
			message_count: 10,
			model: "MiniMax-M3",
			ended_at: `2026-01-01T${String(i).padStart(2, "0")}:00:00.000Z`,
		});
	}
	// 1 spike (well above the p95 of the others)
	insertSession(db, { session_id: "s-spike", cost: 1.0, message_count: 10, model: "MiniMax-M3", ended_at: "2026-01-03T00:00:00.000Z" });
	const findings = detectCostSpikes(db);
	assert.ok(findings.length >= 1, "the spike session should be detected");
	const spike = findings.find(f => f.evidence.session_id === "s-spike");
	assert.ok(spike, "spike session specifically detected");
	assert.equal(spike.severity, "critical");
	assert.ok(spike.evidence.cost > spike.evidence.p95, "spike cost > p95");
});

test("happy: cost_spike skips sessions with cost=0 (unknown model)", () => {
	const db = freshDB();
	for (let i = 0; i < 10; i++) {
		insertSession(db, { session_id: `s-${i}`, cost: 0, message_count: 5, model: null, ended_at: `2026-01-0${i+1}T00:00:00.000Z` });
	}
	const findings = detectCostSpikes(db);
	assert.equal(findings.length, 0, "cost=0 sessions are excluded (forward-compat unknown model)");
});

test("happy: model_drift emits a warn finding when recent mean cost-per-message > 25% above baseline (warn-band)", () => {
	const db = freshDB();
	// Baseline: 40 sessions @ $0.001/msg
	for (let i = 0; i < 40; i++) {
		insertSession(db, {
			session_id: `base-${i}`,
			cost: 0.01,
			message_count: 10,
			model: "MiniMax-M3",
			ended_at: `2026-01-01T${String(i % 24).padStart(2, "0")}:${String(Math.floor(i / 24)).padStart(2, "0")}:00.000Z`,
		});
	}
	// Recent: 10 sessions @ $0.0013/msg = 30% above baseline (in the warn band, 25% < 50%)
	for (let i = 0; i < 10; i++) {
		insertSession(db, {
			session_id: `recent-${i}`,
			cost: 0.013,
			message_count: 10,
			model: "MiniMax-M3",
			ended_at: `2026-03-01T${String(i).padStart(2, "0")}:00:00.000Z`,
		});
	}
	const findings = detectModelDrift(db);
	assert.equal(findings.length, 1);
	const f = findings[0];
	assert.equal(f.detector, "model_drift");
	assert.equal(f.evidence.model, "MiniMax-M3");
	assert.equal(f.severity, "warn", "30% drift = warn band (25% < 50%)");
	assert.ok(f.evidence.drift >= 0.25, `drift=${f.evidence.drift}`);
	assert.ok(f.evidence.drift < 0.50, `drift=${f.evidence.drift} (must be < 50% to be warn)`);
});

test("happy: model_drift promotes to critical at 2x threshold (50%)", () => {
	const db = freshDB();
	for (let i = 0; i < 40; i++) {
		insertSession(db, {
			session_id: `base-${i}`,
			cost: 0.01, message_count: 10, model: "MiniMax-M3",
			ended_at: `2026-01-01T${String(i % 24).padStart(2, "0")}:${String(Math.floor(i / 24)).padStart(2, "0")}:00.000Z`,
		});
	}
	// Recent: 60% more expensive
	for (let i = 0; i < 10; i++) {
		insertSession(db, {
			session_id: `recent-${i}`,
			cost: 0.16, message_count: 10, model: "MiniMax-M3",
			ended_at: `2026-03-01T${String(i).padStart(2, "0")}:00:00.000Z`,
		});
	}
	const findings = detectModelDrift(db);
	assert.equal(findings.length, 1);
	assert.equal(findings[0].severity, "critical", "60% drift >= 2x threshold (50%) = critical");
});

test("happy: model_drift does NOT emit when recent is within threshold of baseline", () => {
	const db = freshDB();
	for (let i = 0; i < 40; i++) {
		insertSession(db, { session_id: `base-${i}`, cost: 0.01, message_count: 10, model: "MiniMax-M3", ended_at: `2026-01-01T${String(i % 24).padStart(2, "0")}:${String(Math.floor(i / 24)).padStart(2, "0")}:00.000Z` });
	}
	for (let i = 0; i < 10; i++) {
		insertSession(db, { session_id: `recent-${i}`, cost: 0.011, message_count: 10, model: "MiniMax-M3", ended_at: `2026-03-01T${String(i).padStart(2, "0")}:00:00.000Z` });
	}
	const findings = detectModelDrift(db);
	assert.equal(findings.length, 0, "10% drift < 25% threshold = no finding");
});

test("happy: model_drift is per-model (one model drifting doesn't trigger for others)", () => {
	const db = freshDB();
	// Use ONE date format (2026-MM-DDT...) and assign by index so
	// the 50 most-recent rows contain BOTH models equally (the order
	// shouldn't depend on model). Recent vs baseline split is by
	// the recency window, not by model.
	const mkDate = (i) => {
		// 50 dates from 2026-01-01 .. 2026-02-19 (50 days)
		const d = new Date(Date.UTC(2026, 0, 1 + i));
		return d.toISOString();
	};
	// Baseline 30 sessions of MiniMax-M3 (days 0-29)
	for (let i = 0; i < 30; i++) {
		insertSession(db, { session_id: `mm-base-${i}`, cost: 0.01, message_count: 10, model: "MiniMax-M3", ended_at: mkDate(i) });
	}
	// Baseline 10 sessions of glm-5.2 (days 30-39)
	for (let i = 30; i < 40; i++) {
		insertSession(db, { session_id: `glm-base-${i}`, cost: 0.005, message_count: 10, model: "glm-5.2", ended_at: mkDate(i) });
	}
	// Recent: MiniMax-M3 drifts (days 40-49, cost goes up 5x)
	for (let i = 40; i < 50; i++) {
		insertSession(db, { session_id: `mm-recent-${i}`, cost: 0.05, message_count: 10, model: "MiniMax-M3", ended_at: mkDate(i) });
	}
	const findings = detectModelDrift(db);
	const models = findings.map(f => f.evidence.model);
	assert.deepEqual(models, ["MiniMax-M3"], "only the drifting model triggers a finding (glm-5.2 stable across baseline + recent)");
});

test("happy: runAllDetectors returns flat list across all three", () => {
	const db = freshDB();
	// Set up: error_pattern trigger
	for (let i = 0; i < 6; i++) {
		insertEvent(db, { session_id: `s-${i}`, seq: 0, ts: "2026-01-01T00:00:00.000Z", tool: "search_files", is_error: 1 });
	}
	// Set up: cost_spike trigger (need 50+ sessions, 1 expensive)
	for (let i = 0; i < 50; i++) {
		insertSession(db, { session_id: `s-cheap-${i}`, cost: 0.001, message_count: 5, model: "MiniMax-M3", ended_at: `2026-01-01T${String(i).padStart(2, "0")}:00:00.000Z` });
	}
	insertSession(db, { session_id: "s-spike", cost: 1.0, message_count: 5, model: "MiniMax-M3", ended_at: "2026-03-01T00:00:00.000Z" });
	const res = runAllDetectors(db);
	assert.ok(res.findings.length >= 2, `expected at least 2 findings, got ${res.findings.length}`);
	assert.equal(res.detectorCount, 3);
	const detectors = new Set(res.findings.map(f => f.detector));
	assert.ok(detectors.has("error_pattern"));
	assert.ok(detectors.has("cost_spike"));
});

test("happy: each finding has the shape recordFinding expects (detector, severity, title, evidence)", () => {
	const db = freshDB();
	for (let i = 0; i < 6; i++) {
		insertEvent(db, { session_id: `s-${i}`, seq: 0, ts: "2026-01-01T00:00:00.000Z", tool: "search_files", is_error: 1 });
	}
	const findings = detectErrorPatterns(db);
	for (const f of findings) {
		assert.equal(typeof f.detector, "string");
		assert.ok(["info", "warn", "critical"].includes(f.severity));
		assert.equal(typeof f.title, "string");
		assert.ok(f.title.length > 0);
	}
});