// lifecycle/lib/brief.js — pure helpers: compute deltas + derive proposals.
// Kept separate from aggregate-week.js so the logic is unit-checkable.

"use strict";

function toolPct(tools, name) {
	const total = Object.values(tools).reduce((a, b) => a + b, 0);
	return total ? (tools[name] || 0) * 100 / total : 0;
}
function readLikePct(tools) {
	const total = Object.values(tools).reduce((a, b) => a + b, 0);
	if (!total) return 0;
	const readLike = (tools.read || 0) + (tools.grep || 0) + (tools.find || 0) + (tools.ls || 0);
	return readLike * 100 / total;
}
function totalTools(tools) { return Object.values(tools).reduce((a, b) => a + b, 0); }

// Roll 7 daily rows into one week-summary object.
function rollWeek(rows) {
	const w = {
		days: rows.length,
		sessions: 0, turns: 0,
		tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
		errors: 0, compaction: 0,
		tools: {}, models: {},
	};
	for (const r of rows) {
		w.sessions += r.session_count;
		w.turns += r.total_turns;
		w.tokensIn += r.tokens_in;
		w.tokensOut += r.tokens_out;
		w.cacheRead += r.cache_read;
		w.cacheWrite += r.cache_write;
		w.cost += r.cost;
		w.errors += r.error_count;
		w.compaction += r.compaction_count;
		const t = typeof r.tool_calls_json === "string" ? JSON.parse(r.tool_calls_json) : (r.tool_calls_json || {});
		const m = typeof r.models_json === "string" ? JSON.parse(r.models_json) : (r.models_json || {});
		for (const [k, v] of Object.entries(t)) w.tools[k] = (w.tools[k] || 0) + v;
		for (const [k, v] of Object.entries(m)) w.models[k] = (w.models[k] || 0) + v;
	}
	w.bashPct = Math.round(toolPct(w.tools, "bash"));
	w.readPct = Math.round(readLikePct(w.tools));
	return w;
}

// Derive concrete config-change proposals from this week vs the prior week.
// Deterministic, LLM-free. Each proposal has {setting, from, to, rationale, severity}.
function deriveProposals(curr, prev, currentSettings) {
	const out = [];
	const get = (p) => {
		const parts = p.split(".");
		let v = currentSettings;
		for (const x of parts) v = v && v[x];
		return v;
	};

	// 1. Tool discipline: bash% climbing vs last week → flag the persona rule.
	if (prev && prev.tools && curr.tools) {
		const bp = toolPct(curr.tools, "bash");
		const bpp = toolPct(prev.tools, "bash");
		if (bp > 60 && bp > bpp + 5) {
			out.push({
				setting: "(persona: tool-discipline)",
				from: `bash ${Math.round(bpp)}%`,
				to: `bash ${Math.round(bp)}%`,
				rationale: `Bash share rose ${Math.round(bp - bpp)}pts to ${Math.round(bp)}% of tool calls this week. Consider re-asserting the read/grep/find-over-bash rule in the persona.`,
				severity: "warning",
			});
		}
	}

	// 2. Compaction pressure: many compactions on a big-context model → raise reserve.
	const keepRecent = get("compaction.keepRecentTokens");
	if (curr.compaction > 10 && typeof keepRecent === "number") {
		const proposed = Math.min(keepRecent * 2, 500000);
		if (proposed !== keepRecent) {
			out.push({
				setting: "compaction.keepRecentTokens",
				from: keepRecent,
				to: proposed,
				rationale: `${curr.compaction} compaction events this week — raising keepRecentTokens gives the model more raw context per compaction on a large-context model.`,
				severity: "medium",
			});
		}
	}

	// 3. Error rate: tool errors high → surface for review (no auto-change).
	if (curr.turns > 0) {
		const errRate = curr.errors * 100 / Math.max(curr.turns, 1);
		if (errRate > 5) {
			out.push({
				setting: "(review: error rate)",
				from: `${curr.errors} tool errors`,
				to: `${errRate.toFixed(1)}% of turns`,
				rationale: `Tool error rate is ${errRate.toFixed(1)}% this week. No config change proposed — review the errors, may indicate a flaky tool or a prompt issue.`,
				severity: "info",
			});
		}
	}

	// 4. Errors very low + read% healthy → a positive note (no change).
	return out;
}

module.exports = { rollWeek, deriveProposals, toolPct, readLikePct, totalTools };
