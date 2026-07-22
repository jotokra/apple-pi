// agentdb/analysis/apply.js — apply (gated, audited) (M6-3).
//
// ROADMAP M6-3: `apple-pi apply --latest --yes` applies the latest approved
// proposal — writes an audit (what actually changed), snapshots the 'before'
// metric, and flips the proposal's status to 'applied'. `--yes` is REQUIRED
// (decision D9); without it apply is a no-op + a notice. Nothing is ever
// auto-applied. This is the write-side counterpart to M6-2's read-only review.
//
// The target is the newest 'proposed' proposal (the same row review shows).
// 'Approved' = the user passed --yes; review never mutates status, so the
// explicit --yes at apply time IS the approval gate (mirrors the autoresearch
// lifecycle/apply-update.js review-gate contract).
//
// API:
//   apply(db, opts={}) -> result
//     opts: { latest?: boolean (default true), yes?: boolean (default false),
//             now?: ()=>isoString, snapshotMetrics?: (db, ts)=>object }
//     - latest=true (the documented verb) targets the single newest 'proposed'.
//     - yes is the D9 gate. false (or omitted) -> no-op + notice, NOTHING written.
//     - now / snapshotMetrics are injectable for deterministic tests.
//     Returns one of:
//       { ok:false, errors[] }                       bad db / write failure
//       { ok:true, applied:false, proposal:null, reason }   nothing pending
//       { ok:true, applied:false, gated:true, proposal, notice }  --yes missing
//       { ok:true, applied:true, proposal, audit, before_snapshot, outcome_id }
//
//   formatApply(result) -> string
//     Human-readable rendering for the CLI: the gate notice when refused, or
//     the applied setting + from→to diff + outcome id when applied.
//
// Two persisted artifacts (the spec's "audit" + "before-snapshot"):
//   - proposals.audit      = JSON [{setting, before, after}] — the config delta
//                            that was applied. Mirrors the autoresearch
//                            lifecycle proposals.audit (same name + shape).
//   - improvement_outcomes = one new row: before_json = metric snapshot at apply
//                            time, after_json='{}', delta_json='{}',
//                            verdict='pending' (transitional; M6-4 measure
//                            finalizes after_json + delta + verdict).
//                            proposals.outcome_id is set to the new row.
//
// The INSERT (outcome) + UPDATE (proposal) run in ONE transaction, so a
// mid-write failure leaves the DB unchanged (the audit and the outcome can
// never disagree).
//
// RED-BLUE CONTRACT (D9):
//   - apply() never throws. Bad inputs / write failures return ok:false.
//   - The --yes gate is absolute: yes !== true writes NOTHING (verified by the
//     test's byte-identical before/after snapshot of every table).
//   - On apply, ONLY the target proposal row mutates (status/applied_at/audit/
//     outcome_id) and exactly ONE improvement_outcomes row is added. sess_*/,
//     kb_*/, analysis_findings, analysis_runs are read-only here (the red-blue
//     suite snapshots them before vs after).
//   - Only 'proposed' proposals are ever targeted — an already-applied or
//     rejected proposal is never re-applied.
"use strict";

// safeParse(s) -> value|null. Tolerates null/undefined/garbage so a malformed
// JSON column never breaks the decode.
function safeParse(s) {
	if (s === null || s === undefined) return null;
	try { return JSON.parse(s); } catch (_) { return null; }
}

// decodeProposalRow(row) -> plain proposal object. Mirrors propose.js's
// decodeProposal / review.js's decodeProposalRow: parses the JSON-encoded
// columns (from_value, to_value, expected_delta_json, source_finding_ids_json,
// audit) back into JS values. Kept local to keep M6-3 atomic (no edit to
// M6-1/M6-2); the schema is the shared contract between encoder + decoder.
function decodeProposalRow(row) {
	return {
		id: row.id,
		status: row.status,
		setting: row.setting,
		from: row.from_value === null ? null : safeParse(row.from_value),
		to: row.to_value === null ? null : safeParse(row.to_value),
		rationale: row.rationale,
		expected_delta: safeParse(row.expected_delta_json) || {},
		source_finding_ids: safeParse(row.source_finding_ids_json) || [],
		outcome_id: row.outcome_id,
		proposed_at: row.proposed_at,
		applied_at: row.applied_at,
		audit: safeParse(row.audit),
	};
}

// defaultSnapshotMetrics(db, ts) -> object. The 'before' metric baseline at
// apply time: the corpus-level aggregates the improvement loop tracks, read
// straight from sess_sessions. These are exactly what M6-4's 'after' snapshot
// will diff against. Cheap (one aggregate query), real (reads the DB, not
// hardcoded zeros), and always available (empty corpus -> zeros).
function defaultSnapshotMetrics(db, ts) {
	let agg;
	try {
		agg = db.prepare(
			`SELECT
			   COUNT(*)                                   AS sessions,
			   COALESCE(SUM(message_count), 0)            AS messages,
			   COALESCE(SUM(tool_call_count), 0)          AS tool_calls,
			   COALESCE(SUM(error_count), 0)              AS errors,
			   COALESCE(SUM(cost), 0)                     AS cost
			 FROM sess_sessions`,
		).get();
	} catch (e) {
		// sess_sessions always exists (schema.sql), but never let a read
		// failure block the apply — fall back to an empty baseline.
		agg = { sessions: 0, messages: 0, tool_calls: 0, errors: 0, cost: 0 };
	}
	return {
		measured_at: ts,
		sessions: agg.sessions,
		messages: agg.messages,
		tool_calls: agg.tool_calls,
		errors: agg.errors,
		cost: Number(agg.cost) || 0,
	};
}

// resolveTarget(db) -> row|null. The newest 'proposed' proposal, or null when
// nothing is pending. apply never falls back to non-proposed statuses — an
// already-applied/rejected proposal is never re-targeted (unlike review, which
// surfaces the last decision for display).
function resolveTarget(db) {
	return db.prepare(
		`SELECT * FROM proposals WHERE status = 'proposed' ORDER BY id DESC LIMIT 1`,
	).get() || null;
}

// apply(db, opts={}) -> result. See module header for the contract.
function apply(db, opts = {}) {
	if (!db) return { ok: false, errors: ["apply: db is required"] };
	const o = opts && typeof opts === "object" ? opts : {};
	const yes = o.yes === true;
	const latest = o.latest !== false; // default true (the documented verb)
	const now = typeof o.now === "function" ? o.now : () => new Date().toISOString();
	const snapshotMetrics = typeof o.snapshotMetrics === "function" ? o.snapshotMetrics : defaultSnapshotMetrics;

	// latest=false (batch apply of all pending) is intentionally NOT
	// implemented yet — it is a separate card. Surface it clearly rather than
	// silently applying only one.
	if (latest !== true) {
		return { ok: false, errors: ["apply: batch apply (latest=false) is not implemented yet"] };
	}

	let target;
	try {
		target = resolveTarget(db);
	} catch (e) {
		return { ok: false, errors: [`apply: read proposals failed (${e.message})`] };
	}

	if (!target) {
		return { ok: true, applied: false, proposal: null, reason: "no pending proposal to apply" };
	}

	const proposal = decodeProposalRow(target);

	// --- D9 GATE: --yes required. Nothing written without it. ---
	if (!yes) {
		return {
			ok: true,
			applied: false,
			gated: true,
			proposal,
			notice: "Refusing to apply without --yes. Re-run: apple-pi apply --latest --yes  (no changes written)",
		};
	}

	// --- APPLY (yes=true) ---
	const ts = now();
	// What actually changed (config delta). before/after come from the
	// proposal's from/to; this is the apply action's durable log.
	const audit = [{ setting: proposal.setting, before: proposal.from, after: proposal.to }];
	// The 'before' metric baseline, persisted for M6-4's before/after compare.
	const beforeSnapshot = snapshotMetrics(db, ts);

	try {
		// Atomic: the outcome INSERT and the proposal UPDATE land together or
		// not at all, so the audit and the outcome can never disagree.
		db.exec("BEGIN");
		const ins = db.prepare(
			`INSERT INTO improvement_outcomes
			   (proposal_id, measured_at, before_json, after_json, delta_json, verdict, notes)
			 VALUES (?, ?, ?, '{}', '{}', 'pending', NULL)`,
		).run(target.id, ts, JSON.stringify(beforeSnapshot));
		const outcomeId = Number(ins.lastInsertRowid);
		db.prepare(
			`UPDATE proposals
			   SET status = 'applied', applied_at = ?, audit = ?, outcome_id = ?
			 WHERE id = ?`,
		).run(ts, JSON.stringify(audit), ins.lastInsertRowid, target.id);
		db.exec("COMMIT");

		const refreshed = db.prepare("SELECT * FROM proposals WHERE id = ?").get(target.id);
		return {
			ok: true,
			applied: true,
			proposal: decodeProposalRow(refreshed),
			audit,
			before_snapshot: beforeSnapshot,
			outcome_id: outcomeId,
		};
	} catch (e) {
		try { db.exec("ROLLBACK"); } catch (_) { /* best-effort; txn may already be gone */ }
		return { ok: false, errors: [`apply: write failed (${e.message})`] };
	}
}

// formatApply(result) -> string. Human-readable for the CLI: the gate notice
// when refused, the applied diff when applied, and a short line otherwise.
function formatApply(result) {
	if (!result || result.ok === false) {
		const errs = (result && result.errors) ? result.errors.join("; ") : "apply failed";
		return `apply: ${errs}`;
	}
	if (result.applied !== true) {
		if (result.gated) return result.notice || "Refusing to apply without --yes.";
		return result.reason || "Nothing to apply.";
	}
	const p = result.proposal;
	const lines = [];
	lines.push(`applied proposal #${p.id} (\`${p.setting}\`): ${JSON.stringify(p.from)} → ${JSON.stringify(p.to)}`);
	if (Array.isArray(result.audit)) {
		for (const a of result.audit) {
			lines.push(`  ${a.setting}: ${JSON.stringify(a.before)} → ${JSON.stringify(a.after)}`);
		}
	}
	const snap = result.before_snapshot || {};
	const snapKeys = Object.keys(snap);
	if (snapKeys.length > 0) {
		const pairs = snapKeys.map((k) => `${k}=${JSON.stringify(snap[k])}`).join(", ");
		lines.push(`  before-snapshot: ${pairs}`);
	}
	if (result.outcome_id) lines.push(`  outcome id : ${result.outcome_id}`);
	lines.push(`marked proposal #${p.id} 'applied'.`);
	return lines.join("\n");
}

module.exports = {
	apply,
	formatApply,
	// Exported for tests; not part of the public API.
	decodeProposalRow,
	defaultSnapshotMetrics,
	resolveTarget,
};
