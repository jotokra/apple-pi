// agentdb/ingest/sessions.js — JSONL parser + event normalization (M4-1).
//
// ROADMAP M4-1: parse one line of a pi session JSONL file -> a normalized
// row suitable for INSERT into sess_events. The session files live at
// ~/.pi/sessions/<timestamp>_<uuid>.jsonl and contain one JSON object per
// line with shape:
//
//   {type: "session", id: "<uuid>", timestamp: "...", cwd: "..."}
//   {type: "model_change", id: "<model_id>", timestamp: "..."}
//   {type: "thinking_level_change", level: "minimal", timestamp: "..."}
//   {type: "message", role: "user"|"assistant"|"tool"|"system",
//    timestamp: "...", content: "...", tokens_in?: N, tokens_out?: N,
//    tool_calls?: [{tool: "...", args: {...}, result?: "..."}], is_error?: bool}
//
// Future event types pass through (event_json retained, type recorded).
//
// RED-BLUE CONTRACT:
//   - parseLine(line, seq) -> { ok, row, errors? } — never throws; a malformed
//     line returns ok:false rather than poisoning the whole file.
//   - Unknown event types are accepted (the field schema is forward-compat
//     by design; pi adds new types as the engine evolves).
//   - Optional fields (tokens_in, tokens_out, is_error, tool) default to
//     safe values (0 / 0 / 0 / null) so a partial JSON entry doesn't NPE
//     downstream.
//   - content_sha is the SHA-256 of the line (lowercased hex) — used by
//     M4-2's idempotency check on retry.
//
// Public API:
//   parseLine(line, seq)         -> { ok: bool, row: {session_id, seq, type,
//                                                  ts, role, tool, tokens_in,
//                                                  tokens_out, is_error,
//                                                  content_sha, event_json},
//                                       errors?: string[] }
"use strict";

const crypto = require("node:crypto");

// ISO8601 timestamp regex (matches the schema-card.js ISO_RE pattern).
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

// sha256Hex(text) -> string — 64-char lowercased hex.
function sha256Hex(text) {
	return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// extractSessionId(parsed) -> string — pull the session_id out of the parsed
// JSON. Pi JSONL files embed it in:
//   - the first "session" event's `id` field (the canonical source)
//   - the filename (we ignore here — the caller passes it explicitly)
// We prefer an explicit session_id field if present; fall back to .id.
// Returns "" if neither is present (the caller MUST supply one — this is a
// defensive fallback only).
function extractSessionId(parsed) {
	if (!parsed || typeof parsed !== "object") return "";
	if (typeof parsed.session_id === "string" && parsed.session_id.length > 0) return parsed.session_id;
	if (typeof parsed.id === "string" && parsed.id.length > 0) return parsed.id;
	return "";
}

// parseLine(line, seq) -> { ok, row, errors? }
//   line : raw JSONL line (string)
//   seq  : 0-indexed line position in the source file (caller-provided)
// Returns the normalized row + a content_sha. On failure, returns
// { ok: false, errors: [...] } without throwing.
function parseLine(line, seq) {
	if (typeof line !== "string") {
		return { ok: false, errors: [`parseLine: line must be a string (got ${typeof line})`] };
	}
	if (!Number.isInteger(seq) || seq < 0) {
		return { ok: false, errors: [`parseLine: seq must be a non-negative integer (got ${seq})`] };
	}

	const trimmed = line.trim();
	if (trimmed.length === 0) {
		return { ok: false, errors: ["parseLine: empty line"] };
	}

	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch (e) {
		return { ok: false, errors: [`parseLine: invalid JSON at seq=${seq} (${e.message})`] };
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, errors: [`parseLine: expected a JSON object at seq=${seq}`] };
	}

	// Required: type. Without type we can't index or route the event.
	const type = parsed.type;
	if (typeof type !== "string" || type.length === 0) {
		return { ok: false, errors: [`parseLine: missing 'type' field at seq=${seq}`] };
	}

	// Required: timestamp. Schema requires ISO8601; we don't strictly
	// enforce it (forward-compat) but we do require SOMETHING parseable.
	const ts = parsed.timestamp;
	if (typeof ts !== "string" || ts.length === 0) {
		return { ok: false, errors: [`parseLine: missing 'timestamp' field at seq=${seq}`] };
	}

	// session_id: prefer explicit session_id field, then id field.
	let session_id = "";
	if (typeof parsed.session_id === "string" && parsed.session_id.length > 0) {
		session_id = parsed.session_id;
	} else {
		session_id = extractSessionId(parsed);
	}

	// Optional fields with safe defaults.
	const role = (typeof parsed.role === "string" && parsed.role.length > 0) ? parsed.role : null;
	const tool = (typeof parsed.tool === "string" && parsed.tool.length > 0)
		? parsed.tool
		: extractToolFromToolCalls(parsed);

	const tokens_in = Number.isInteger(parsed.tokens_in) ? parsed.tokens_in : 0;
	const tokens_out = Number.isInteger(parsed.tokens_out) ? parsed.tokens_out : 0;
	const is_error = parsed.is_error === true ? 1 : 0;

	const content_sha = sha256Hex(trimmed);
	const event_json = trimmed;

	return {
		ok: true,
		row: {
			session_id,
			seq,
			type,
			ts,
			role,
			tool,
			tokens_in,
			tokens_out,
			is_error,
			content_sha,
			event_json,
		},
	};
}

// extractToolFromToolCalls(parsed) -> string | null — message events carry
// tool_calls[]; we surface the FIRST tool name in the event row so the
// tool_underuse / tool_overuse detector has a single tool column to scan.
// (The full tool_calls[] is in event_json for richer per-call analysis.)
function extractToolFromToolCalls(parsed) {
	if (!Array.isArray(parsed.tool_calls)) return null;
	for (const tc of parsed.tool_calls) {
		if (tc && typeof tc === "object" && typeof tc.tool === "string" && tc.tool.length > 0) {
			return tc.tool;
		}
	}
	return null;
}

module.exports = {
	parseLine,
	// Exported for tests + future re-use; not part of the public API.
	sha256Hex,
	extractSessionId,
	extractToolFromToolCalls,
	ISO_RE,
};