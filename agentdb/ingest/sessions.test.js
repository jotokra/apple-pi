// agentdb/ingest/sessions.test.js — JSONL parser + event normalization (M4-1).
//
// ROADMAP M4-1 acceptance gate: each fixture line -> expected normalized
// row; unknown types pass through (event_json retained, type recorded).
// Test layout: abuse suite first (malformed JSON, missing fields, bad
// types, unknown event types), then happy path (each event type round-trips).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseLine, sha256Hex, extractSessionId } = require("./sessions");

// =====================================================================
// ABUSE SUITE — must run first
// =====================================================================

test("abuse: empty line returns ok:false (not a throw)", () => {
	const res = parseLine("", 0);
	assert.equal(res.ok, false);
	assert.match(res.errors.join(" "), /empty/);
});

test("abuse: whitespace-only line returns ok:false", () => {
	const res = parseLine("   \t  \n ", 0);
	assert.equal(res.ok, false);
});

test("abuse: malformed JSON returns ok:false with seq in error", () => {
	const res = parseLine("{not json}", 5);
	assert.equal(res.ok, false);
	assert.match(res.errors.join(" "), /invalid JSON/);
	assert.match(res.errors.join(" "), /seq=5/);
});

test("abuse: JSON array (not object) returns ok:false", () => {
	const res = parseLine("[1,2,3]", 0);
	assert.equal(res.ok, false);
	assert.match(res.errors.join(" "), /JSON object/);
});

test("abuse: JSON null returns ok:false", () => {
	const res = parseLine("null", 0);
	assert.equal(res.ok, false);
});

test("abuse: missing 'type' field returns ok:false", () => {
	const res = parseLine(JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z" }), 0);
	assert.equal(res.ok, false);
	assert.match(res.errors.join(" "), /type/);
});

test("abuse: empty 'type' field returns ok:false", () => {
	const res = parseLine(JSON.stringify({ type: "", timestamp: "2026-01-01T00:00:00.000Z" }), 0);
	assert.equal(res.ok, false);
});

test("abuse: missing 'timestamp' field returns ok:false", () => {
	const res = parseLine(JSON.stringify({ type: "message" }), 0);
	assert.equal(res.ok, false);
	assert.match(res.errors.join(" "), /timestamp/);
});

test("abuse: non-string line returns ok:false", () => {
	for (const bad of [null, undefined, 42, true, [], {}]) {
		const res = parseLine(bad, 0);
		assert.equal(res.ok, false, `expected reject for line=${JSON.stringify(bad)}`);
		assert.match(res.errors.join(" "), /string/);
	}
});

test("abuse: negative seq returns ok:false", () => {
	const res = parseLine('{"type":"message","timestamp":"2026-01-01T00:00:00.000Z"}', -1);
	assert.equal(res.ok, false);
	assert.match(res.errors.join(" "), /seq/);
});

test("abuse: non-integer seq returns ok:false", () => {
	const cases = [0.5, "0", null, NaN, Infinity];
	for (const seq of cases) {
		const res = parseLine('{"type":"message","timestamp":"2026-01-01T00:00:00.000Z"}', seq);
		assert.equal(res.ok, false, `expected reject for seq=${JSON.stringify(seq)}`);
	}
});

test("abuse: tokens_in as a string (non-integer) defaults to 0 silently", () => {
	const res = parseLine(JSON.stringify({
		type: "message",
		timestamp: "2026-01-01T00:00:00.000Z",
		tokens_in: "100",  // wrong type — must not throw
	}), 0);
	assert.equal(res.ok, true);
	assert.equal(res.row.tokens_in, 0, "non-integer tokens_in must default to 0, not throw");
});

test("abuse: is_error = false (literal) is treated as 0, not as truthy 'false'", () => {
	const res = parseLine(JSON.stringify({
		type: "message",
		timestamp: "2026-01-01T00:00:00.000Z",
		is_error: false,
	}), 0);
	assert.equal(res.ok, true);
	assert.equal(res.row.is_error, 0, "false must map to 0, not 1");
});

test("abuse: is_error = truthy non-true (e.g. 'yes', 1) is treated as 0 unless === true", () => {
	// Strict equality to true keeps the binary column honest. "yes"/1/strings
	// are all 0 (not an error). True becomes 1.
	for (const v of ["yes", 1, "true", [], {}]) {
		const res = parseLine(JSON.stringify({
			type: "message",
			timestamp: "2026-01-01T00:00:00.000Z",
			is_error: v,
		}), 0);
		assert.equal(res.ok, true);
		assert.equal(res.row.is_error, 0, `is_error=${JSON.stringify(v)} must be 0`);
	}
});

// =====================================================================
// HAPPY PATH
// =====================================================================

test("happy: session event exposes session_id from .id", () => {
	const res = parseLine(JSON.stringify({
		type: "session",
		id: "abc-123-uuid",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/Users/<user>/Projects",
	}), 0);
	assert.equal(res.ok, true);
	assert.equal(res.row.session_id, "abc-123-uuid");
	assert.equal(res.row.type, "session");
	assert.equal(res.row.ts, "2026-01-01T00:00:00.000Z");
	assert.equal(res.row.role, null);
	assert.equal(res.row.tool, null);
	assert.equal(res.row.tokens_in, 0);
	assert.equal(res.row.tokens_out, 0);
	assert.equal(res.row.is_error, 0);
	assert.equal(res.row.seq, 0);
});

test("happy: model_change event has no role/tool/tokens (defaults)", () => {
	const res = parseLine(JSON.stringify({
		type: "model_change",
		id: "MiniMax-M3",
		timestamp: "2026-01-01T00:00:00.000Z",
	}), 0);
	assert.equal(res.ok, true);
	assert.equal(res.row.type, "model_change");
	assert.equal(res.row.session_id, "MiniMax-M3", "session_id falls back to .id");
	assert.equal(res.row.role, null);
	assert.equal(res.row.tool, null);
	assert.equal(res.row.tokens_in, 0);
	assert.equal(res.row.tokens_out, 0);
});

test("happy: thinking_level_change event round-trips", () => {
	const res = parseLine(JSON.stringify({
		type: "thinking_level_change",
		level: "minimal",
		timestamp: "2026-01-01T00:00:01.000Z",
	}), 0);
	assert.equal(res.ok, true);
	assert.equal(res.row.type, "thinking_level_change");
});

test("happy: message event with role=tokens surfaces them", () => {
	const res = parseLine(JSON.stringify({
		type: "message",
		role: "assistant",
		timestamp: "2026-01-01T00:00:02.000Z",
		content: "Hello world",
		tokens_in: 100,
		tokens_out: 50,
	}), 0);
	assert.equal(res.ok, true);
	assert.equal(res.row.role, "assistant");
	assert.equal(res.row.tokens_in, 100);
	assert.equal(res.row.tokens_out, 50);
});

test("happy: is_error=true maps to 1", () => {
	const res = parseLine(JSON.stringify({
		type: "message",
		role: "tool",
		timestamp: "2026-01-01T00:00:03.000Z",
		is_error: true,
	}), 0);
	assert.equal(res.ok, true);
	assert.equal(res.row.is_error, 1);
});

test("happy: tool_calls[].tool surfaces the first tool name in .tool column", () => {
	const res = parseLine(JSON.stringify({
		type: "message",
		role: "assistant",
		timestamp: "2026-01-01T00:00:04.000Z",
		tool_calls: [
			{ tool: "search_files", args: { pattern: "*.js" } },
			{ tool: "terminal", args: { command: "ls" } },
		],
	}), 0);
	assert.equal(res.ok, true);
	assert.equal(res.row.tool, "search_files", "first tool wins");
});

test("happy: top-level .tool field wins over tool_calls[].tool", () => {
	const res = parseLine(JSON.stringify({
		type: "message",
		role: "tool",
		tool: "delegate_task",
		timestamp: "2026-01-01T00:00:05.000Z",
		tool_calls: [{ tool: "search_files" }],
	}), 0);
	assert.equal(res.ok, true);
	assert.equal(res.row.tool, "delegate_task", "top-level .tool takes precedence over tool_calls[]");
});

test("happy: explicit session_id field beats .id fallback", () => {
	const res = parseLine(JSON.stringify({
		type: "message",
		id: "wrong-id",
		session_id: "right-id",
		timestamp: "2026-01-01T00:00:06.000Z",
	}), 0);
	assert.equal(res.ok, true);
	assert.equal(res.row.session_id, "right-id");
});

test("happy: unknown event type passes through (forward-compat)", () => {
	const res = parseLine(JSON.stringify({
		type: "future_event_type_added_in_pi_v2",
		timestamp: "2026-01-01T00:00:07.000Z",
		any_future_field: "preserved-in-event_json",
	}), 0);
	assert.equal(res.ok, true);
	assert.equal(res.row.type, "future_event_type_added_in_pi_v2");
	assert.match(res.row.event_json, /any_future_field/);
});

test("happy: content_sha is the SHA-256 of the trimmed line", () => {
	const line = JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:00.000Z" });
	const res = parseLine(line, 0);
	assert.equal(res.ok, true);
	assert.equal(res.row.content_sha, sha256Hex(line.trim()));
	assert.equal(res.row.content_sha.length, 64);
});

test("happy: event_json is the trimmed original line (verbatim)", () => {
	const line = JSON.stringify({ type: "message", role: "user", timestamp: "2026-01-01T00:00:00.000Z", content: "verbatim" });
	const res = parseLine(line, 0);
	assert.equal(res.row.event_json, line.trim());
});

test("happy: leading/trailing whitespace in the line is trimmed before parsing", () => {
	const line = '   {"type":"message","timestamp":"2026-01-01T00:00:00.000Z"}   ';
	const res = parseLine(line, 0);
	assert.equal(res.ok, true);
	assert.equal(res.row.type, "message");
});

test("happy: a message event with is_error=true AND tokens surfaces both", () => {
	const res = parseLine(JSON.stringify({
		type: "message",
		role: "tool",
		timestamp: "2026-01-01T00:00:10.000Z",
		is_error: true,
		tokens_in: 200,
		tokens_out: 0,
	}), 0);
	assert.equal(res.row.is_error, 1);
	assert.equal(res.row.tokens_in, 200);
	assert.equal(res.row.tokens_out, 0);
});

test("happy: full 4-type fixture round-trips (session + model + thinking + message)", () => {
	const lines = [
		{ type: "session", id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/x" },
		{ type: "model_change", id: "MiniMax-M3", timestamp: "2026-01-01T00:00:01.000Z" },
		{ type: "thinking_level_change", level: "minimal", timestamp: "2026-01-01T00:00:02.000Z" },
		{ type: "message", role: "user", timestamp: "2026-01-01T00:00:03.000Z", content: "hi" },
	];
	for (let i = 0; i < lines.length; i++) {
		const res = parseLine(JSON.stringify(lines[i]), i);
		assert.equal(res.ok, true, `line ${i} should parse`);
		assert.equal(res.row.seq, i);
		assert.equal(res.row.type, lines[i].type);
	}
	// Real-world: only the first "session" event has the canonical session_id.
	// Later events rely on the indexer (M4-2) to backfill session_id from
	// the preceding "session" event during ingest. The parser does NOT
	// synthesize session_id across event types — that would be the indexer's
	// job, and doing it here would conflate parse with ingest.
	assert.equal(parseLine(JSON.stringify(lines[0]), 0).row.session_id, "sess-1");
	assert.equal(parseLine(JSON.stringify(lines[1]), 1).row.session_id, "MiniMax-M3", "model_change uses its own .id (the model name), not the session's id");
	assert.equal(parseLine(JSON.stringify(lines[3]), 3).row.session_id, "", "message events without id/session_id carry empty session_id; indexer backfills it");
});

test("happy: extractSessionId prefers session_id over id", () => {
	const p = { session_id: "explicit", id: "fallback" };
	assert.equal(extractSessionId(p), "explicit");
	const p2 = { id: "fallback" };
	assert.equal(extractSessionId(p2), "fallback");
	const p3 = { foo: "bar" };
	assert.equal(extractSessionId(p3), "", "missing id returns empty string");
});

test("happy: content_sha is deterministic for identical lines", () => {
	const line = JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:00.000Z" });
	const r1 = parseLine(line, 0);
	const r2 = parseLine(line, 1); // different seq → different row but same content_sha
	assert.equal(r1.row.content_sha, r2.row.content_sha, "content_sha is content-only, ignores seq");
});