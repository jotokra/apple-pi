// agentdb/ingest/aggregates.test.js — session aggregates + cost (M4-3).
//
// ROADMAP M4-3 acceptance gate: aggregates match a hand-computed fixture;
// recompute on re-ingest. Test layout: abuse suite first (bad inputs,
// empty sessions, unknown models), then happy path (counts/tokens/cost/
// model/tool_calls_json/endpoints all match a known fixture).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { computeRollup, recompute, costFor, loadPricing } = require("./aggregates");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

function freshDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// insertEvent(db, opts) — INSERT one sess_events row directly (bypassing
// the parser). Lets us build hand-crafted fixtures with exact token counts.
function insertEvent(db, opts) {
	db.prepare(
		`INSERT INTO sess_events (session_id, seq, type, ts, role, tool, tokens_in, tokens_out, is_error, content_sha, event_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		opts.session_id,
		opts.seq,
		opts.type,
		opts.ts ?? null,
		opts.role ?? null,
		opts.tool ?? null,
		opts.tokens_in ?? 0,
		opts.tokens_out ?? 0,
		opts.is_error ?? 0,
		opts.content_sha ?? `sha-${opts.seq}`,
		opts.event_json ?? "{}",
	);
}

// =====================================================================
// ABUSE SUITE — must run first
// =====================================================================

test("abuse: non-string sessionId returns ok:false", () => {
	const db = freshDB();
	for (const sid of [null, undefined, 42, "", [], {}]) {
		const res = computeRollup(db, sid);
		assert.equal(res.ok, false, `expected reject for sessionId=${JSON.stringify(sid)}`);
	}
});

test("abuse: unknown session (no rows in sess_events) returns a valid zero-rollup", () => {
	const db = freshDB();
	const res = computeRollup(db, "no-such-session");
	assert.equal(res.ok, true);
	assert.equal(res.rollup.message_count, 0);
	assert.equal(res.rollup.tool_call_count, 0);
	assert.equal(res.rollup.error_count, 0);
	assert.equal(res.rollup.tokens_in, 0);
	assert.equal(res.rollup.tokens_out, 0);
	assert.equal(res.rollup.cost, 0);
	assert.equal(res.rollup.model, null);
});

test("abuse: costFor with non-finite token values defaults the affected side to 0", () => {
	const pricing = loadPricing();
	// NaN input: input side zeroed, output side still counted.
	// 100 out * 0.0024/1000 = 0.00024.
	assert.equal(costFor("MiniMax-M3", NaN, 100, pricing), 0.00024,
		"NaN input → input side = 0; 100 out * 0.0024/1000 = 0.00024");
	// Infinity output: output side zeroed, input side still counted.
	// 100 in * 0.0008/1000 = 0.00008.
	assert.equal(costFor("MiniMax-M3", 100, Infinity, pricing), 0.00008,
		"Infinity output → output side = 0; 100 in * 0.0008/1000 = 0.00008");
	// Both non-finite: result is 0.
	assert.equal(costFor("MiniMax-M3", NaN, Infinity, pricing), 0);
	// Mixed with a real model: still produces a real number.
	const mixed = costFor("MiniMax-M3", 1000, NaN, pricing);
	assert.equal(mixed, 0.0008, "1000 in * 0.0008/1000 = 0.0008; NaN out defaults to 0");
});

test("abuse: costFor with unknown model returns 0 (forward-compat)", () => {
	const pricing = loadPricing();
	assert.equal(costFor("gpt-99-future", 1000, 1000, pricing), 0);
});

test("abuse: loadPricing merges overrides over defaults", () => {
	const pricing = loadPricing({ pricingOverride: { "MiniMax-M3": { input: 0.001, output: 0.003 } } });
	assert.equal(pricing["MiniMax-M3"].input, 0.001, "override wins");
	assert.equal(pricing["MiniMax-M3"].output, 0.003, "override wins");
	assert.ok(pricing["glm-5.2"], "other models keep their defaults");
});

// =====================================================================
// HAPPY PATH
// =====================================================================

test("happy: costFor computes (tokens/1000) * rate for known models", () => {
	const pricing = loadPricing();
	// MiniMax-M3: 0.0008/0.0024 per 1k -> 1000 input + 1000 output = $0.0008 + $0.0024 = $0.0032
	assert.equal(costFor("MiniMax-M3", 1000, 1000, pricing), 0.0032);
	// glm-5.2: 0.0006/0.0022 per 1k -> 5000 input + 500 output = $0.003 + $0.0011 = $0.0041
	assert.equal(costFor("glm-5.2", 5000, 500, pricing), 0.0041);
});

test("happy: a session with 2 user + 2 assistant + 1 tool message rolls up correctly", () => {
	const db = freshDB();
	insertEvent(db, { session_id: "s-A", seq: 0, type: "session", ts: "2026-01-01T00:00:00.000Z", event_json: JSON.stringify({ type: "session", id: "s-A", cwd: "/Users/jay/Projects" }) });
	insertEvent(db, { session_id: "s-A", seq: 1, type: "model_change", ts: "2026-01-01T00:00:01.000Z", event_json: JSON.stringify({ type: "model_change", id: "MiniMax-M3" }) });
	insertEvent(db, { session_id: "s-A", seq: 2, type: "message", role: "user",      ts: "2026-01-01T00:00:02.000Z", tokens_in: 100, tokens_out: 0 });
	insertEvent(db, { session_id: "s-A", seq: 3, type: "message", role: "assistant", ts: "2026-01-01T00:00:03.000Z", tokens_in: 0, tokens_out: 200 });
	insertEvent(db, { session_id: "s-A", seq: 4, type: "message", role: "tool", tool: "search_files", ts: "2026-01-01T00:00:04.000Z", tokens_in: 50, tokens_out: 0 });
	insertEvent(db, { session_id: "s-A", seq: 5, type: "message", role: "user",      ts: "2026-01-01T00:00:05.000Z", tokens_in: 80, tokens_out: 0, is_error: 1 });
	insertEvent(db, { session_id: "s-A", seq: 6, type: "message", role: "assistant", ts: "2026-01-01T00:00:06.000Z", tokens_in: 0, tokens_out: 150 });

	const res = computeRollup(db, "s-A");
	assert.equal(res.ok, true);
	const r = res.rollup;
	assert.equal(r.message_count, 4, "user(2) + assistant(2); tool message not counted");
	assert.equal(r.tool_call_count, 1, "only seq=4 has .tool set");
	assert.equal(r.error_count, 1, "only seq=5 has is_error=1");
	assert.equal(r.tokens_in, 100 + 50 + 80, "100+50+80 = 230 (assistant tokens_in=0 don't add)");
	assert.equal(r.tokens_out, 200 + 150, "200+150 = 350 (user/tool tokens_out=0 don't add)");
	assert.equal(r.model, "MiniMax-M3", "last model_change wins");
	assert.equal(r.cwd, "/Users/jay/Projects", "first session event's cwd");
	assert.equal(r.started_at, "2026-01-01T00:00:00.000Z");
	assert.equal(r.ended_at, "2026-01-01T00:00:06.000Z");
	assert.equal(r.last_event_at, "2026-01-01T00:00:06.000Z");
	const tcMap = JSON.parse(r.tool_calls_json);
	assert.deepEqual(tcMap, { search_files: 1 }, "tool_calls_json has the per-tool counts");
});

test("happy: cost is computed from the resolved model + tokens", () => {
	const db = freshDB();
	insertEvent(db, { session_id: "s-A", seq: 0, type: "session", event_json: "{}" });
	insertEvent(db, { session_id: "s-A", seq: 1, type: "model_change", event_json: JSON.stringify({ id: "MiniMax-M3" }) });
	// 1M input + 1M output -> (1000000/1000)*0.0008 + (1000000/1000)*0.0024 = 0.8 + 2.4 = 3.2
	insertEvent(db, { session_id: "s-A", seq: 2, type: "message", role: "assistant", tokens_in: 1000000, tokens_out: 1000000 });
	const res = computeRollup(db, "s-A");
	assert.equal(res.rollup.cost, 3.2, "MiniMax-M3: 1M in + 1M out = $3.20");
});

test("happy: tool_calls_json rolls up multiple calls of the same tool", () => {
	const db = freshDB();
	insertEvent(db, { session_id: "s-A", seq: 0, type: "session", event_json: "{}" });
	insertEvent(db, { session_id: "s-A", seq: 1, type: "model_change", event_json: JSON.stringify({ id: "MiniMax-M3" }) });
	insertEvent(db, { session_id: "s-A", seq: 2, type: "message", role: "tool", tool: "search_files", ts: "2026-01-01T00:00:01.000Z" });
	insertEvent(db, { session_id: "s-A", seq: 3, type: "message", role: "tool", tool: "search_files", ts: "2026-01-01T00:00:02.000Z" });
	insertEvent(db, { session_id: "s-A", seq: 4, type: "message", role: "tool", tool: "terminal",     ts: "2026-01-01T00:00:03.000Z" });
	insertEvent(db, { session_id: "s-A", seq: 5, type: "message", role: "tool", tool: "search_files", ts: "2026-01-01T00:00:04.000Z" });
	const res = computeRollup(db, "s-A");
	const tcMap = JSON.parse(res.rollup.tool_calls_json);
	assert.deepEqual(tcMap, { search_files: 3, terminal: 1 });
});

test("happy: cost is 0 when model is unknown", () => {
	const db = freshDB();
	insertEvent(db, { session_id: "s-A", seq: 0, type: "session", event_json: "{}" });
	insertEvent(db, { session_id: "s-A", seq: 1, type: "model_change", event_json: JSON.stringify({ id: "unknown-model-2099" }) });
	insertEvent(db, { session_id: "s-A", seq: 2, type: "message", role: "assistant", tokens_in: 1000, tokens_out: 1000 });
	const res = computeRollup(db, "s-A");
	assert.equal(res.rollup.cost, 0, "unknown model = $0 (forward-compat, no throw)");
});

test("happy: recompute persists the rollup to sess_sessions (INSERT OR REPLACE)", () => {
	const db = freshDB();
	insertEvent(db, { session_id: "s-A", seq: 0, type: "session", event_json: "{}" });
	insertEvent(db, { session_id: "s-A", seq: 1, type: "model_change", event_json: JSON.stringify({ id: "MiniMax-M3" }) });
	insertEvent(db, { session_id: "s-A", seq: 2, type: "message", role: "user", tokens_in: 100, tokens_out: 0 });
	const r = recompute(db, "s-A");
	assert.equal(r.ok, true);
	const row = db.prepare("SELECT * FROM sess_sessions WHERE session_id = ?").get("s-A");
	assert.ok(row);
	assert.equal(row.message_count, 1);
	assert.equal(row.tokens_in, 100);
	assert.equal(row.cost, 0.0008 * 100 / 1000);
	assert.equal(row.model, "MiniMax-M3");
	assert.equal(row.tool_calls_json, "{}");
});

test("happy: recompute on the same session overwrites (idempotent, not duplicate)", () => {
	const db = freshDB();
	insertEvent(db, { session_id: "s-A", seq: 0, type: "session", event_json: "{}" });
	insertEvent(db, { session_id: "s-A", seq: 1, type: "model_change", event_json: JSON.stringify({ id: "MiniMax-M3" }) });
	insertEvent(db, { session_id: "s-A", seq: 2, type: "message", role: "user", tokens_in: 100 });
	recompute(db, "s-A");
	recompute(db, "s-A");
	recompute(db, "s-A");
	const sessRows = db.prepare("SELECT * FROM sess_sessions WHERE session_id = ?").all("s-A");
	assert.equal(sessRows.length, 1, "INSERT OR REPLACE means one row, not duplicates");
});

test("happy: started_at = min ts, ended_at = max ts", () => {
	const db = freshDB();
	insertEvent(db, { session_id: "s-A", seq: 0, type: "session", ts: "2026-01-01T00:00:00.000Z" });
	insertEvent(db, { session_id: "s-A", seq: 1, type: "message", role: "user", ts: "2026-01-01T00:05:00.000Z" });
	insertEvent(db, { session_id: "s-A", seq: 2, type: "message", role: "assistant", ts: "2026-01-01T00:01:00.000Z" });
	insertEvent(db, { session_id: "s-A", seq: 3, type: "message", role: "user", ts: "2026-01-01T00:10:00.000Z" });
	const res = computeRollup(db, "s-A");
	assert.equal(res.rollup.started_at, "2026-01-01T00:00:00.000Z", "min ts");
	assert.equal(res.rollup.ended_at, "2026-01-01T00:10:00.000Z", "max ts");
	assert.equal(res.rollup.last_event_at, "2026-01-01T00:10:00.000Z", "max ts (most recent event)");
});

test("happy: last model_change wins (most-recent wins)", () => {
	const db = freshDB();
	insertEvent(db, { session_id: "s-A", seq: 0, type: "session", event_json: "{}" });
	insertEvent(db, { session_id: "s-A", seq: 1, type: "model_change", event_json: JSON.stringify({ id: "MiniMax-M3" }) });
	insertEvent(db, { session_id: "s-A", seq: 2, type: "model_change", event_json: JSON.stringify({ id: "glm-5.2" }) });
	insertEvent(db, { session_id: "s-A", seq: 3, type: "model_change", event_json: JSON.stringify({ id: "claude-sonnet-4" }) });
	const res = computeRollup(db, "s-A");
	assert.equal(res.rollup.model, "claude-sonnet-4");
});

test("happy: cwd comes from the first 'session' event (not subsequent ones)", () => {
	const db = freshDB();
	insertEvent(db, { session_id: "s-A", seq: 0, type: "session", ts: "2026-01-01T00:00:00.000Z", event_json: JSON.stringify({ cwd: "/first/cwd" }) });
	insertEvent(db, { session_id: "s-A", seq: 1, type: "message", role: "user", ts: "2026-01-01T00:00:01.000Z" });
	insertEvent(db, { session_id: "s-A", seq: 2, type: "session", ts: "2026-01-01T00:00:02.000Z", event_json: JSON.stringify({ cwd: "/second/cwd" }) });
	insertEvent(db, { session_id: "s-A", seq: 3, type: "message", role: "user", ts: "2026-01-01T00:00:03.000Z" });
	const res = computeRollup(db, "s-A");
	assert.equal(res.rollup.cwd, "/first/cwd", "first session event wins (later events don't overwrite)");
});