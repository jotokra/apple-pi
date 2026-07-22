// agentdb/analysis/measure.js — measure (closes the loop) (M6-4).
//
// ROADMAP M6-4: `analysis/measure.js` finalizes the 'pending'
// improvement_outcomes rows that M6-3 apply wrote. For each applied
// proposal past a measurement window it compares the before-snapshot
// (recorded at apply time) against a fresh after-snapshot, computes the
// delta, and writes a verdict: improved | neutral | regressed. A
// regressed verdict is the signal the next analyze can turn into a
// revert proposal — that is what "closes the loop" means.
//
// API:
//   measure(db, opts={}) -> result
//     opts: { now?: ()=>isoString, windowMs?: number=0,
//             snapshotMetrics?: (db, ts)=>object }
//     - Candidates: improvement_outcomes rows with verdict='pending' whose
//       linked proposal has status='applied'. (apply sets both together in
//       one transaction, so a pending outcome always has an applied
//       proposal; the status check is defensive.)
//     - windowMs gates ripeness: an outcome whose proposal.applied_at is
//       within windowMs of `now` is SKIPPED (left 'pending') so a scheduled
//       measure only finalizes outcomes with enough post-apply data. Default
//       0 = measure every pending outcome now (the manual-run default).
//     - snapshotMetrics defaults to apply.defaultSnapshotMetrics — the SAME
//       aggregate shape apply used for the before-snapshot, so before/after
//       are directly comparable. Injectable for deterministic tests.
//     Returns one of:
//       { ok:false, errors[] }                            bad db / write failure
//       { ok:true, measured:[{outcome_id, proposal_id, verdict, before, after, delta}],
//         skipped:[{outcome_id, proposal_id, reason}] }
//
//   formatMeasure(result) -> string
//     Human-readable rendering for the CLI: one line per measured outcome
//     (verdict + the directional deltas) plus a skip summary.
//
//   computeVerdict(before, after) -> 'improved'|'neutral'|'regressed'
//     Pure helper exported for unit tests. The directional rule uses the
//     two unambiguously-lower-is-better metrics in this schema — errors
//     and cost (every detector treats more errors / more cost as worse):
//       improved  : both <= and at least one strictly better
//       regressed : both >= and at least one strictly worse
//       neutral   : all-zero OR mixed signs (cancel out)
//     Volume metrics (sessions/messages/tool_calls) are recorded in the
//     delta for human audit but do not move the verdict on their own.
//
// Two persisted updates per measured outcome (the spec's after-snapshot +
// delta + verdict): after_json, delta_json, verdict, measured_at. The
// before_json column is NEVER touched (apply owns it). Each outcome row is
// updated in its own statement (no cross-row transaction needed — every
// update is independent and a mid-loop failure leaves the un-measured rows
// 'pending' for the next run; the measured rows are already consistent).
//
// RED-BLUE CONTRACT:
//   - measure() never throws. Bad inputs / write failures return ok:false.
//   - Only improvement_outcomes mutates (after_json/delta_json/verdict/
//     measured_at); before_json is preserved. proposals / sess_* / kb_* /
//     analysis_* are read-only here (the red-blue suite snapshots them
//     before vs after).
//   - Idempotent: only verdict='pending' rows are ever targeted. A
//     finalized outcome (improved/neutral/regressed) is never re-measured,
//     so scheduling measure is safe.
"use strict";

const { defaultSnapshotMetrics } = require("./apply");

// safeParse(s) -> value|null. Tolerates null/undefined/garbage so a malformed
// JSON column never breaks the decode (mirrors apply/review/propose).
function safeParse(s) {
	if (s === null || s === undefined) return null;
	try { return JSON.parse(s); } catch (_) { return null; }
}

// num(v) -> finite number (0 fallback). Coerces SQLite REAL/INT and tolerates
// missing/non-numeric keys so a sparse snapshot never yields NaN in the delta.
function num(v) {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : 0;
}

// computeVerdict(before, after) -> 'improved'|'neutral'|'regressed'.
// Pure. See module header for the directional rule.
function computeVerdict(before, after) {
	const b = before && typeof before === "object" ? before : {};
	const a = after && typeof after === "object" ? after : {};
	const dErr = num(a.errors) - num(b.errors);
	const dCost = num(a.cost) - num(b.cost);
	if (dErr <= 0 && dCost <= 0 && (dErr < 0 || dCost < 0)) return "improved";
	if (dErr >= 0 && dCost >= 0 && (dErr > 0 || dCost > 0)) return "regressed";
	return "neutral";
}

// computeDelta(before, after) -> {metric: after-before}.
// Includes every numeric key present in `after` except `measured_at` (a
// timestamp, not a metric). Missing-before keys default to 0.
function computeDelta(before, after) {
	const b = before && typeof before === "object" ? before : {};
	const a = after && typeof after === "object" ? after : {};
	const delta = {};
	for (const k of Object.keys(a)) {
		if (k === "measured_at") continue;
		if (typeof a[k] !== "number" && num(a[k]) === 0 && !Object.prototype.hasOwnProperty.call(b, k)) {
			// Skip non-numeric junk that wasn't a metric to begin with.
			continue;
		}
		delta[k] = num(a[k]) - num(b[k]);
	}
	return delta;
}

// loadCandidates(db) -> [row]. Every 'pending' outcome joined to its proposal.
// proposal columns are prefixed p_ so the caller can read both without
// collision. Never throws — a read failure returns [] (caller proceeds with
// nothing to measure, which is a safe no-op).
function loadCandidates(db) {
	try {
		return db.prepare(
			`SELECT o.id              AS o_id,
			        o.proposal_id     AS o_proposal_id,
			        o.before_json     AS o_before_json,
			        p.status          AS p_status,
			        p.applied_at      AS p_applied_at
			 FROM improvement_outcomes o
			 JOIN proposals p ON p.id = o.proposal_id
			 WHERE o.verdict = 'pending'
			 ORDER BY o.id`,
		).all();
	} catch (_) {
		return [];
	}
}

// measure(db, opts={}) -> result. See module header for the contract.
function measure(db, opts = {}) {
	if (!db) return { ok: false, errors: ["measure: db is required"] };
	const o = opts && typeof opts === "object" ? opts : {};
	const now = typeof o.now === "function" ? o.now : () => new Date().toISOString();
	const windowMs = Number.isFinite(o.windowMs) && o.windowMs >= 0 ? o.windowMs : 0;
	const snapshotMetrics = typeof o.snapshotMetrics === "function" ? o.snapshotMetrics : defaultSnapshotMetrics;

	let candidates;
	try {
		candidates = loadCandidates(db);
	} catch (e) {
		return { ok: false, errors: [`measure: read outcomes failed (${e.message})`] };
	}

	const measured = [];
	const skipped = [];
	const errors = [];

	for (const c of candidates) {
		const outcomeId = Number(c.o_id);
		const proposalId = Number(c.o_proposal_id);

		// Defensive: a pending outcome should always link to an applied
		// proposal (apply sets both in one txn). A non-applied proposal
		// means the row is in an unexpected state — skip, never finalize.
		if (c.p_status !== "applied") {
			skipped.push({ outcome_id: outcomeId, proposal_id: proposalId, reason: `proposal status is '${c.p_status}' (expected 'applied')` });
			continue;
		}

		// Window gate: only finalize outcomes whose proposal was applied
		// at least windowMs ago.
		const appliedAtMs = Date.parse(c.p_applied_at);
		const nowMs = Date.parse(now());
		if (Number.isFinite(appliedAtMs) && Number.isFinite(nowMs) && (nowMs - appliedAtMs) < windowMs) {
			skipped.push({ outcome_id: outcomeId, proposal_id: proposalId, reason: `within measurement window (applied ${c.p_applied_at}, window ${windowMs}ms)` });
			continue;
		}

		const before = safeParse(c.o_before_json) || {};
		const ts = now();
		let after;
		try {
			after = snapshotMetrics(db, ts);
		} catch (e) {
			errors.push(`measure: after-snapshot failed for outcome ${outcomeId} (${e.message})`);
			continue;
		}
		if (!after || typeof after !== "object") after = {};

		const delta = computeDelta(before, after);
		const verdict = computeVerdict(before, after);

		try {
			db.prepare(
				`UPDATE improvement_outcomes
				   SET after_json = ?, delta_json = ?, verdict = ?, measured_at = ?
				 WHERE id = ?`,
			).run(JSON.stringify(after), JSON.stringify(delta), verdict, ts, outcomeId);
		} catch (e) {
			errors.push(`measure: UPDATE failed for outcome ${outcomeId} (${e.message})`);
			continue;
		}

		measured.push({
			outcome_id: outcomeId,
			proposal_id: proposalId,
			verdict,
			before,
			after,
			delta,
		});
	}

	// A write failure on any row is surfaced in errors[] but does not abort
	// the rest of the run — the operator sees which outcomes finalized and
	// which did not. ok:false only when NOTHING could be attempted (bad db),
	// which is already handled above.
	return { ok: true, measured, skipped, ...(errors.length ? { errors } : {}) };
}

// formatMeasure(result) -> string. Human-readable for the CLI.
function formatMeasure(result) {
	if (!result || result.ok === false) {
		const errs = (result && result.errors) ? result.errors.join("; ") : "measure failed";
		return `measure: ${errs}`;
	}
	const measured = Array.isArray(result.measured) ? result.measured : [];
	const skipped = Array.isArray(result.skipped) ? result.skipped : [];
	const lines = [];
	if (measured.length === 0 && skipped.length === 0) {
		return "measure: nothing to measure (no pending outcomes).";
	}
	lines.push(`## measure: ${measured.length} finalized${skipped.length ? `, ${skipped.length} skipped` : ""}`);
	for (const m of measured) {
		const bySev = { improved: "✓ improved", neutral: "= neutral", regressed: "✗ regressed" };
		lines.push(`- outcome #${m.outcome_id} (proposal #${m.proposal_id}): ${bySev[m.verdict] || m.verdict}`);
		const d = m.delta || {};
		const parts = Object.keys(d)
			.filter((k) => d[k] !== 0)
			.map((k) => `${k}=${d[k] >= 0 ? "+" : ""}${d[k]}`);
		if (parts.length) lines.push(`    delta: ${parts.join(", ")}`);
	}
	if (skipped.length) {
		lines.push(`skipped:`);
		for (const s of skipped) lines.push(`  - outcome #${s.outcome_id}: ${s.reason}`);
	}
	if (Array.isArray(result.errors) && result.errors.length) {
		lines.push(`errors:`);
		for (const e of result.errors) lines.push(`  - ${e}`);
	}
	return lines.join("\n");
}

module.exports = {
	measure,
	formatMeasure,
	// Exported for tests; not part of the public API.
	computeVerdict,
	computeDelta,
	loadCandidates,
};
