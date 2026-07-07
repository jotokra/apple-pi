// agentdb/analysis/detectors.js — error + cost + drift detectors (M5-2).
//
// ROADMAP M5-2: three detectors that scan sess_events + sess_sessions
// and emit findings via the runs.js recordFinding() convenience.
//
// Detectors:
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
//   runAllDetectors(db, opts={}) -> { findings, detectorCount, errors? }
//     Convenience: runs all three and returns a flat list.
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

// runAllDetectors(db, opts={}) -> { findings, detectorCount, errors? }
// Convenience: runs all three detectors in sequence and returns a flat
// list. Each detector is independent; one failing doesn't affect the
// others.
function runAllDetectors(db, opts = {}) {
	if (!db) return { findings: [], detectorCount: 0, errors: ["runAllDetectors: db is required"] };
	const errs = [];
	const findings = [];
	try { findings.push(...detectErrorPatterns(db, opts)); } catch (e) { errs.push(`error_pattern: ${e.message}`); }
	try { findings.push(...detectCostSpikes(db, opts)); } catch (e) { errs.push(`cost_spike: ${e.message}`); }
	try { findings.push(...detectModelDrift(db, opts)); } catch (e) { errs.push(`model_drift: ${e.message}`); }
	return { findings, detectorCount: 3, errors: errs };
}

module.exports = {
	detectErrorPatterns,
	detectCostSpikes,
	detectModelDrift,
	runAllDetectors,
	// Exported for tests; not part of the public API.
	percentile,
};