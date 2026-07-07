// agentdb/ingest/aggregates.js — session aggregates + cost (M4-3).
//
// ROADMAP M4-3: derive sess_sessions rollups from sess_events:
//   - message_count (human + assistant messages only; not tool/system)
//   - tool_call_count (events with type === "message" AND tool IS NOT NULL)
//   - error_count (events with is_error=1)
//   - tokens_in / tokens_out (sum)
//   - cost (USD; model-priced)
//   - started_at / ended_at / last_event_at (min/max ts)
//   - model (last model_change event)
//   - cwd (from the first "session" event)
//   - tool_calls_json (per-tool call counts)
//
// Called by ingestFile after a successful ingest to refresh the rollup
// row. Pure function — takes a db, a session_id, an optional model-pricing
// table; never mutates anything outside sess_sessions for that session_id.
//
// RED-BLUE CONTRACT:
//   - recompute(db, sessionId, opts={}) -> { ok, session, errors? } never throws
//   - Session rows are upserted (INSERT OR REPLACE); a re-rollup is idempotent
//   - tool_calls_json is recomputed from scratch on each call (no partial merge)
//   - Cost uses the model's per-1k-token rates; falls back to 0 if the model
//     is unknown (forward-compat: a new model shows up as "uncosted" rather
//     than crashing)
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// DEFAULT_PRICING — per-1k-token USD rates. Conservative defaults (these are
// the rates the user sees on the provider's billing page; cost_spike detector
// uses them to compute the rolling p95). Add new entries when a new model
// enters regular use.
const DEFAULT_PRICING = {
	"MiniMax-M3":         { input: 0.0008, output: 0.0024 }, // ~$0.80/$2.40 per 1M
	"MiniMax-M2.7":       { input: 0.0004, output: 0.0012 },
	"MiniMax-M2.7-highspeed": { input: 0.0008, output: 0.0024 },
	"glm-5.2":            { input: 0.0006, output: 0.0022 }, // z.ai
	"glm-5.1":            { input: 0.0006, output: 0.0022 },
	"glm-5-turbo":        { input: 0.0003, output: 0.0009 },
	"glm-4.7":            { input: 0.0003, output: 0.0009 },
	"claude-sonnet-4":    { input: 0.003,  output: 0.015 },
	"claude-opus-4":      { input: 0.015,  output: 0.075 },
	"gpt-4o":             { input: 0.005,  output: 0.015 },
	"gpt-4o-mini":        { input: 0.00015, output: 0.0006 },
};

// loadPricing(opts) -> { model: {input, output} } — merge default pricing
// with optional overrides from a JSON file (opt-in; lets the user point
// at a config file when prices change).
function loadPricing(opts = {}) {
	let pricing = Object.assign({}, DEFAULT_PRICING);
	if (opts.pricingFile) {
		try {
			const raw = JSON.parse(fs.readFileSync(opts.pricingFile, "utf8"));
			pricing = Object.assign(pricing, raw);
		} catch (_) { /* ignore bad pricing file; defaults win */ }
	}
	if (opts.pricingOverride && typeof opts.pricingOverride === "object") {
		pricing = Object.assign(pricing, opts.pricingOverride);
	}
	return pricing;
}

// costFor(model, tokensIn, tokensOut, pricing) -> number — USD.
// Per-1k-token rates: cost = (tokens_in / 1000) * input + (tokens_out / 1000) * output.
// Unknown models return 0 (forward-compat: cost_spike will skip them).
// Result is rounded to 8 decimal places (~ micro-cent precision) to
// avoid 0.1 + 0.2 = 0.30000000000000004 style IEEE-754 surprises.
function costFor(model, tokensIn, tokensOut, pricing) {
	const rates = pricing[model];
	if (!rates) return 0;
	const inCost = (Number.isFinite(tokensIn) ? tokensIn : 0) / 1000 * rates.input;
	const outCost = (Number.isFinite(tokensOut) ? tokensOut : 0) / 1000 * rates.output;
	const total = inCost + outCost;
	return Math.round(total * 1e8) / 1e8;
}

// computeRollup(db, sessionId, opts={}) -> { ok, rollup, errors? }
// Reads sess_events for the session, computes aggregates in JS, returns
// the rollup row ready for INSERT into sess_sessions. Does NOT write;
// the caller decides whether to persist (recompute() is the persistor).
function computeRollup(db, sessionId, opts = {}) {
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		return { ok: false, errors: ["computeRollup: sessionId must be a non-empty string"] };
	}
	const pricing = loadPricing(opts);

	let rows;
	try {
		rows = db.prepare(
			`SELECT seq, type, ts, role, tool, tokens_in, tokens_out, is_error, event_json
			 FROM sess_events
			 WHERE session_id = ?
			 ORDER BY seq`,
		).all(sessionId);
	} catch (e) {
		return { ok: false, errors: [`computeRollup: SELECT failed (${e.message})`] };
	}

	let message_count = 0;
	let tool_call_count = 0;
	let error_count = 0;
	let tokens_in = 0;
	let tokens_out = 0;
	let started_at = null;
	let ended_at = null;
	let last_event_at = null;
	let model = null;
	let cwd = null;
	const toolCalls = {};

	for (const e of rows) {
		if (e.is_error === 1) error_count++;
		if (Number.isFinite(e.tokens_in)) tokens_in += e.tokens_in;
		if (Number.isFinite(e.tokens_out)) tokens_out += e.tokens_out;
		if (e.ts) {
			if (started_at === null || e.ts < started_at) started_at = e.ts;
			if (ended_at === null || e.ts > ended_at) ended_at = e.ts;
			last_event_at = e.ts;
		}

		// Message-type rows: count user/assistant as "messages", tool/system not.
		// model_change events carry the model name in event_json; we extract
		// the LAST model seen (most-recent wins — matches the session's
		// active model at the end of the file).
		if (e.type === "message") {
			if (e.role === "user" || e.role === "assistant") message_count++;
			if (e.tool) {
				tool_call_count++;
				toolCalls[e.tool] = (toolCalls[e.tool] || 0) + 1;
			}
		} else if (e.type === "model_change") {
			// event_json is verbatim; parse to get the id field
			try {
				const p = JSON.parse(e.event_json);
				if (p && typeof p.id === "string" && p.id.length > 0) model = p.id;
			} catch (_) {}
		} else if (e.type === "session" && !cwd) {
			// session event carries cwd; take the first one.
			try {
				const p = JSON.parse(e.event_json);
				if (p && typeof p.cwd === "string" && p.cwd.length > 0) cwd = p.cwd;
			} catch (_) {}
		}
	}

	const cost = costFor(model, tokens_in, tokens_out, pricing);

	return {
		ok: true,
		rollup: {
			session_id: sessionId,
			started_at,
			ended_at,
			last_event_at: last_event_at || ended_at || started_at,
			message_count,
			tool_call_count,
			error_count,
			tokens_in,
			tokens_out,
			cost,
			model,
			cwd,
			tool_calls_json: JSON.stringify(toolCalls),
		},
	};
}

// recompute(db, sessionId, opts={}) -> { ok, session, errors? }
// Computes the rollup AND persists it (INSERT OR REPLACE into sess_sessions).
// Also updates sess_files.file_path on the session row so M4-4 prune can
// reach the underlying file by session. This is the canonical "ingest done;
// refresh aggregates" call.
function recompute(db, sessionId, opts = {}) {
	const computed = computeRollup(db, sessionId, opts);
	if (!computed.ok) return { ok: false, errors: computed.errors };

	try {
		db.prepare(
			`INSERT OR REPLACE INTO sess_sessions
			 (session_id, started_at, ended_at, last_event_at, message_count, tool_call_count,
			  error_count, tokens_in, tokens_out, cost, model, cwd, tool_calls_json, file_path)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			computed.rollup.session_id,
			computed.rollup.started_at,
			computed.rollup.ended_at,
			computed.rollup.last_event_at,
			computed.rollup.message_count,
			computed.rollup.tool_call_count,
			computed.rollup.error_count,
			computed.rollup.tokens_in,
			computed.rollup.tokens_out,
			computed.rollup.cost,
			computed.rollup.model,
			computed.rollup.cwd,
			computed.rollup.tool_calls_json,
			opts.filePath || null,
		);
	} catch (e) {
		return { ok: false, errors: [`recompute: INSERT failed (${e.message})`] };
	}

	return { ok: true, session: computed.rollup };
}

module.exports = {
	computeRollup,
	recompute,
	// Exported for tests + future re-use.
	loadPricing,
	costFor,
	DEFAULT_PRICING,
};