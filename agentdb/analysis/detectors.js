// agentdb/analysis/detectors.js — error + cost + drift + tool-use + card-stall detectors.
//
// ROADMAP M5-2 + M5-3: six detectors that scan sess_events +
// sess_sessions + kb_cards and emit findings via the runs.js
// recordFinding() convenience.
//
// Detectors (M5-2):
//   error_pattern: groups sess_events by (tool, is_error) and emits a
//     warn finding when the same tool has errored >= threshold times
//     across sessions. The threshold is configurable; default 5.
//   cost_spike: scans sess_sessions for sessions whose cost exceeds
//     the rolling p95 (last 50 sessions). Emits a critical finding
//     per spike. Sessions with cost=0 (unknown model) are skipped.
//   model_drift: per-model cost-per-message trend. Compares the most
//     recent 10 sessions for a model against the prior 40, computing
//     mean cost/message. A drift > 25% triggers a warn finding.
//
// Detectors (M5-3):
//   tool_overuse: aggregates sess_sessions.tool_calls_json across the
//     corpus; emits a finding when one tool is >= threshold (default
//     50%) of ALL tool calls. warn at threshold, critical at 1.5x.
//   tool_underuse: same aggregate; emits an info finding for a tool
//     whose total count is <= maxRare (default 1) when the corpus has
//     >= minDistinct (default 3) tools and >= minCalls (default 20)
//     total calls. ("rarely used" — never-used tools aren't in the map.)
//   card_stall: scans kb_cards for in_progress / blocked rows whose
//     updated_at is older than the per-status threshold (in_progress
//     default 7d, blocked default 3d). warn at threshold, critical at 2x.
//
// RED-BLUE CONTRACT:
//   - Each detector is a pure function over the db: db -> [finding].
//     Findings have the shape recordFinding() expects:
//     { detector, severity, title, evidence? }.
//   - Detectors never throw. A malformed row (NULL where expected, bad
//     numeric) is silently skipped — the rest of the findings still
//     land.
//   - A detector is a "no-op" if there isn't enough data (fewer than
//     the required rows for the rolling-window calculation). No false
//     positives from a tiny corpus.
//
// API:
//   detectErrorPatterns(db, opts={}) -> [finding]
//     opts: { minErrors?: number = 5 }
//   detectCostSpikes(db, opts={}) -> [finding]
//     opts: { windowSize?: number = 50 }
//   detectModelDrift(db, opts={}) -> [finding]
//     opts: { recentN?: number = 10, baselineN?: number = 40, threshold?: number = 0.25 }
//   detectToolOveruse(db, opts={}) -> [finding]
//     opts: { threshold?: number = 0.5, minCalls?: number = 20 }
//   detectToolUnderuse(db, opts={}) -> [finding]
//     opts: { maxRare?: number = 1, minDistinct?: number = 3, minCalls?: number = 20 }
//   detectCardStall(db, opts={}) -> [finding]
//     opts: { now?: ISO8601, inProgressDays?: number = 7, blockedDays?: number = 3 }
//   runAllDetectors(db, opts={}) -> { findings, detectorCount, errors? }
//     Convenience: runs all six and returns a flat list.
"use strict";

// percentile(sorted, p) -> number — linear interpolation between data points.
// sorted must be a sorted-ascending array. p in [0, 1].
function percentile(sorted, p) {
	if (sorted.length === 0) return 0;
	if (p <= 0) return sorted[0];
	if (p >= 1) return sorted[sorted.length - 1];
	const idx = p * (sorted.length - 1);
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

// detectErrorPatterns(db, opts={}) -> [finding]
// Groups sess_events by (tool, is_error=1) and emits a finding when
// a single tool has errored >= minErrors times. Default minErrors=5.
function detectErrorPatterns(db, opts = {}) {
	if (!db) return [];
	const minErrors = (Number.isInteger(opts.minErrors) && opts.minErrors > 0) ? opts.minErrors : 5;

	let rows;
	try {
		rows = db.prepare(
			`SELECT tool, COUNT(*) as n
			 FROM sess_events
			 WHERE is_error = 1 AND tool IS NOT NULL
			 GROUP BY tool
			 HAVING n >= ?`,
		).all(minErrors);
	} catch (_) {
		return [];
	}

	return rows.map(r => ({
		detector: "error_pattern",
		severity: r.n >= minErrors * 4 ? "critical" : "warn",
		title: `tool ${r.tool} errored ${r.n} times (threshold ${minErrors})`,
		evidence: { tool: r.tool, error_count: r.n, threshold: minErrors },
	}));
}

// detectCostSpikes(db, opts={}) -> [finding]
// Pulls the most recent N sessions (default 50), computes the p95 cost,
// and emits a critical finding for each session above the threshold.
function detectCostSpikes(db, opts = {}) {
	if (!db) return [];
	const windowSize = (Number.isInteger(opts.windowSize) && opts.windowSize > 0) ? opts.windowSize : 50;

	let rows;
	try {
		rows = db.prepare(
			`SELECT session_id, cost, model
			 FROM sess_sessions
			 WHERE cost > 0
			 ORDER BY ended_at DESC, session_id DESC
			 LIMIT ?`,
		).all(windowSize);
	} catch (_) {
		return [];
	}

	if (rows.length < 3) return []; // not enough data

	const costs = rows.map(r => r.cost).sort((a, b) => a - b);
	const p95 = percentile(costs, 0.95);

	return rows.filter(r => r.cost > p95).map(r => ({
		detector: "cost_spike",
		severity: "critical",
		title: `session ${r.session_id} cost $${r.cost.toFixed(4)} (p95 = $${p95.toFixed(4)})`,
		evidence: { session_id: r.session_id, cost: r.cost, model: r.model, p95 },
	}));
}

// detectModelDrift(db, opts={}) -> [finding]
// For each model that has both a recent and a baseline sample, compares
// the mean cost/message. A drift > threshold (default 25%) triggers a
// warn finding.
function detectModelDrift(db, opts = {}) {
	if (!db) return [];
	const recentN = (Number.isInteger(opts.recentN) && opts.recentN > 0) ? opts.recentN : 10;
	const baselineN = (Number.isInteger(opts.baselineN) && opts.baselineN > 0) ? opts.baselineN : 40;
	const threshold = (typeof opts.threshold === "number" && opts.threshold > 0) ? opts.threshold : 0.25;

	let rows;
	try {
		rows = db.prepare(
			`SELECT session_id, model, cost, message_count, ended_at
			 FROM sess_sessions
			 WHERE cost > 0 AND message_count > 0 AND model IS NOT NULL
			 ORDER BY ended_at DESC, session_id DESC
			 LIMIT ?`,
		).all(recentN + baselineN);
	} catch (_) {
		return [];
	}

	if (rows.length < recentN + 1) return []; // not enough data

	const recent = rows.slice(0, recentN);
	const baseline = rows.slice(recentN);

	const byModel = { recent: {}, baseline: {} };
	for (const r of recent) {
		const ratio = r.cost / r.message_count;
		if (!byModel.recent[r.model]) byModel.recent[r.model] = [];
		byModel.recent[r.model].push(ratio);
	}
	for (const r of baseline) {
		const ratio = r.cost / r.message_count;
		if (!byModel.baseline[r.model]) byModel.baseline[r.model] = [];
		byModel.baseline[r.model].push(ratio);
	}

	const findings = [];
	for (const model of Object.keys(byModel.recent)) {
		const recentRatios = byModel.recent[model];
		const baselineRatios = byModel.baseline[model];
		if (!recentRatios || !baselineRatios || recentRatios.length === 0 || baselineRatios.length === 0) continue;
		const recentMean = recentRatios.reduce((a, b) => a + b, 0) / recentRatios.length;
		const baselineMean = baselineRatios.reduce((a, b) => a + b, 0) / baselineRatios.length;
		if (baselineMean === 0) continue;
		const drift = (recentMean - baselineMean) / baselineMean;
		if (Math.abs(drift) >= threshold) {
			findings.push({
				detector: "model_drift",
				severity: Math.abs(drift) >= threshold * 2 ? "critical" : "warn",
				title: `model ${model} cost-per-message drifted ${(drift * 100).toFixed(1)}% (recent $${recentMean.toFixed(4)} vs baseline $${baselineMean.toFixed(4)})`,
				evidence: {
					model,
					recent_mean: recentMean,
					baseline_mean: baselineMean,
					drift,
					recent_n: recentRatios.length,
					baseline_n: baselineRatios.length,
				},
			});
		}
	}
	return findings;
}

// aggregateToolCalls(db) -> { totals: Map<tool,number>, grandTotal, sessions: Map<tool,number> }
// Reads sess_sessions.tool_calls_json (the M4-3 ingest aggregate) and
// folds every session's {tool: count} map into a corpus-wide total. Rows
// whose JSON is unparseable are skipped (a bad row never poisons the good
// ones). Returns null if the read itself throws (e.g. table missing).
function aggregateToolCalls(db) {
	let rows;
	try {
		rows = db.prepare(
			`SELECT tool_calls_json FROM sess_sessions WHERE tool_call_count > 0`,
		).all();
	} catch (_) {
		return null;
	}
	const totals = {};
	const sessions = {};
	let grandTotal = 0;
	for (const r of rows) {
		let m;
		try { m = JSON.parse(r.tool_calls_json || "{}"); } catch (_) { continue; }
		if (!m || typeof m !== "object") continue;
		for (const [tool, n] of Object.entries(m)) {
			const c = Number(n);
			if (!Number.isFinite(c) || c <= 0) continue;
			totals[tool] = (totals[tool] || 0) + c;
			sessions[tool] = (sessions[tool] || 0) + 1;
			grandTotal += c;
		}
	}
	return { totals, sessions, grandTotal };
}

// detectToolOveruse(db, opts={}) -> [finding]
// Emits a finding per tool whose share of the corpus-wide tool-call total
// is >= threshold (default 50%). warn at threshold, critical at 1.5x.
// No-op when grandTotal < minCalls (tiny corpus → no reliable dominance).
function detectToolOveruse(db, opts = {}) {
	if (!db) return [];
	const threshold = (typeof opts.threshold === "number" && opts.threshold > 0 && opts.threshold <= 1)
		? opts.threshold : 0.5;
	const minCalls = (Number.isInteger(opts.minCalls) && opts.minCalls > 0) ? opts.minCalls : 20;

	const agg = aggregateToolCalls(db);
	if (!agg || agg.grandTotal < minCalls) return [];

	const findings = [];
	for (const [tool, c] of Object.entries(agg.totals)) {
		const share = c / agg.grandTotal;
		if (share >= threshold) {
			findings.push({
				detector: "tool_overuse",
				severity: share >= Math.min(1, threshold * 1.5) ? "critical" : "warn",
				title: `tool ${tool} is ${(share * 100).toFixed(1)}% of all tool calls (threshold ${(threshold * 100).toFixed(0)}%)`,
				evidence: { tool, count: c, total: agg.grandTotal, share, threshold },
			});
		}
	}
	findings.sort((a, b) => b.evidence.share - a.evidence.share);
	return findings;
}

// detectToolUnderuse(db, opts={}) -> [finding]
// Emits an info finding for each tool whose corpus-wide total is <= maxRare
// (default 1), but only when the corpus is diverse enough to make rarity
// notable: >= minDistinct distinct tools AND >= minCalls total calls.
// (Never-used tools don't appear in tool_calls_json, so this is "rarely used".)
function detectToolUnderuse(db, opts = {}) {
	if (!db) return [];
	const maxRare = (Number.isInteger(opts.maxRare) && opts.maxRare >= 0) ? opts.maxRare : 1;
	const minDistinct = (Number.isInteger(opts.minDistinct) && opts.minDistinct > 0) ? opts.minDistinct : 3;
	const minCalls = (Number.isInteger(opts.minCalls) && opts.minCalls > 0) ? opts.minCalls : 20;

	const agg = aggregateToolCalls(db);
	if (!agg || agg.grandTotal < minCalls) return [];

	const tools = Object.keys(agg.totals);
	if (tools.length < minDistinct) return [];

	const findings = [];
	for (const [tool, c] of Object.entries(agg.totals)) {
		if (c <= maxRare) {
			findings.push({
				detector: "tool_underuse",
				severity: "info",
				title: `tool ${tool} used only ${c} time(s) across the corpus (${tools.length} distinct tools, ${agg.grandTotal} total calls)`,
				evidence: { tool, count: c, distinct_tools: tools.length, total_calls: agg.grandTotal, session_count: agg.sessions[tool] || 0 },
			});
		}
	}
	findings.sort((a, b) => a.evidence.count - b.evidence.count);
	return findings;
}

// detectCardStall(db, opts={}) -> [finding]
// Scans kb_cards for in_progress / blocked rows whose updated_at is older
// than the per-status threshold (in_progress default 7d, blocked default 3d).
// warn at the threshold, critical at 2x. Cards with NULL/unparseable or
// future-dated updated_at are skipped. opts.now (ISO8601) pins the clock
// for tests; defaults to real now.
function detectCardStall(db, opts = {}) {
	if (!db) return [];
	const nowMs = (typeof opts.now === "string" && opts.now.length > 0) ? Date.parse(opts.now) : Date.now();
	if (!Number.isFinite(nowMs)) return [];
	const inProgressDays = (Number.isFinite(opts.inProgressDays) && opts.inProgressDays > 0) ? opts.inProgressDays : 7;
	const blockedDays = (Number.isFinite(opts.blockedDays) && opts.blockedDays > 0) ? opts.blockedDays : 3;

	let rows;
	try {
		rows = db.prepare(
			`SELECT id, title, status, updated_at
			 FROM kb_cards
			 WHERE status IN ('in_progress', 'blocked') AND updated_at IS NOT NULL`,
		).all();
	} catch (_) {
		return [];
	}

	const DAY_MS = 86400000;
	const findings = [];
	for (const r of rows) {
		const t = Date.parse(r.updated_at);
		if (!Number.isFinite(t)) continue;
		const ageMs = nowMs - t;
		if (ageMs <= 0) continue; // future-dated / clock skew: not a stall
		const ageDays = ageMs / DAY_MS;

		let thresholdDays = null;
		if (r.status === "in_progress") thresholdDays = inProgressDays;
		else if (r.status === "blocked") thresholdDays = blockedDays;
		if (thresholdDays === null || ageMs <= thresholdDays * DAY_MS) continue;

		findings.push({
			detector: "card_stall",
			severity: ageDays >= thresholdDays * 2 ? "critical" : "warn",
			title: `card ${r.id} ${r.status} for ${ageDays.toFixed(1)} days (threshold ${thresholdDays}d)`,
			evidence: {
				card_id: r.id,
				title: r.title,
				status: r.status,
				age_days: ageDays,
				threshold_days: thresholdDays,
				updated_at: r.updated_at,
			},
		});
	}
	findings.sort((a, b) => b.evidence.age_days - a.evidence.age_days);
	return findings;
}

// runAllDetectors(db, opts={}) -> { findings, detectorCount, errors? }
// Convenience: runs all six detectors in sequence and returns a flat
// list. Each detector is independent; one failing doesn't affect the
// others.
function runAllDetectors(db, opts = {}) {
	if (!db) return { findings: [], detectorCount: 0, errors: ["runAllDetectors: db is required"] };
	const errs = [];
	const findings = [];
	try { findings.push(...detectErrorPatterns(db, opts)); } catch (e) { errs.push(`error_pattern: ${e.message}`); }
	try { findings.push(...detectCostSpikes(db, opts)); } catch (e) { errs.push(`cost_spike: ${e.message}`); }
	try { findings.push(...detectModelDrift(db, opts)); } catch (e) { errs.push(`model_drift: ${e.message}`); }
	try { findings.push(...detectToolOveruse(db, opts)); } catch (e) { errs.push(`tool_overuse: ${e.message}`); }
	try { findings.push(...detectToolUnderuse(db, opts)); } catch (e) { errs.push(`tool_underuse: ${e.message}`); }
	try { findings.push(...detectCardStall(db, opts)); } catch (e) { errs.push(`card_stall: ${e.message}`); }
	return { findings, detectorCount: 6, errors: errs };
}

module.exports = {
	detectErrorPatterns,
	detectCostSpikes,
	detectModelDrift,
	detectToolOveruse,
	detectToolUnderuse,
	detectCardStall,
	runAllDetectors,
	// Exported for tests; not part of the public API.
	percentile,
};