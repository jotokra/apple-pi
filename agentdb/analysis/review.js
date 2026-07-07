// agentdb/analysis/review.js — review (human gate, read-only) (M6-2).
//
// ROADMAP M6-2: `apple-pi review [--latest]` lists pending proposals +
// their diffs and the source findings that justify them. Reads proposals
// + analysis_findings; writes nothing. Mirrors the autoresearch review
// gate (lifecycle/apply-update.js latestProposal + renderDiff) but on the
// unified proposals table that M6-1 propose() populates.
//
// API:
//   review(db, opts={}) -> { ok, proposalCount, proposals, errors? }
//     opts: { latest?: boolean }
//     "pending" = status='proposed'. Default returns ALL pending, newest
//     first. latest=true returns only the single newest pending proposal
//     (falls back to newest of ANY status if nothing is pending — same
//     fallback the autoresearch review uses, so a fully-applied corpus
//     still shows the last decision instead of an empty screen).
//   formatReview(result) -> string
//     Human-readable rendering for the CLI: one block per proposal with
//     setting, the from→to diff, rationale, and the citing findings.
//
// Each proposal in the result carries the decoded body (from/to/
// expected_delta/source_finding_ids) PLUS a `source_findings` array —
// the analysis_findings rows cited by source_finding_ids, with their
// evidence_json parsed back into an object so the human reviewer sees
// the supporting data, not a JSON blob.
//
// RED-BLUE CONTRACT:
//   - review() never throws and NEVER writes. Bad inputs return ok:false.
//   - Only proposals + analysis_findings are read; sess_*/kb_*/runs/
//     improvement_outcomes are not touched. The no-mutation guarantee is
//     covered by review.test.js's red-blue suite (row snapshots before
//     vs after are byte-identical).
"use strict";

// safeParse(s) -> value|null. Tolerates null/undefined/garbage so a
// malformed JSON column never breaks the whole review.
function safeParse(s) {
	if (s === null || s === undefined) return null;
	try { return JSON.parse(s); } catch (_) { return null; }
}

// decodeProposalRow(row) -> plain proposal object. Mirrors propose.js's
// decodeProposal: parses the JSON-encoded columns (from_value, to_value,
// expected_delta_json, source_finding_ids_json) back into JS values so
// callers see structured data, not raw strings. Kept local to keep M6-2
// atomic (no edit to M6-1's propose.js); the schema is the shared
// contract between encoder and decoder.
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
	};
}

// loadSourceFindings(db, ids) -> [finding]. Reads the analysis_findings
// rows cited by a proposal's source_finding_ids, evidence parsed. Returns
// [] on any error or empty input — a missing/odd citation never fails
// the whole review.
function loadSourceFindings(db, ids) {
	if (!Array.isArray(ids) || ids.length === 0) return [];
	const placeholders = ids.map(() => "?").join(",");
	let rows;
	try {
		rows = db.prepare(
			`SELECT id, run_id, detector, severity, title, evidence_json, proposal_id, detected_at
			 FROM analysis_findings
			 WHERE id IN (${placeholders})
			 ORDER BY id`,
		).all(...ids);
	} catch (_) {
		return [];
	}
	return rows.map((r) => ({
		id: r.id,
		run_id: r.run_id,
		detector: r.detector,
		severity: r.severity,
		title: r.title,
		evidence: safeParse(r.evidence_json) || {},
		proposal_id: r.proposal_id,
		detected_at: r.detected_at,
	}));
}

// review(db, opts={}) -> { ok, proposalCount, proposals, errors? }
// Read-only: selects pending proposals (or just the latest), decodes each,
// and attaches its source findings. Never writes.
function review(db, opts = {}) {
	if (!db) return { ok: false, errors: ["review: db is required"] };
	const o = opts && typeof opts === "object" ? opts : {};
	const latest = o.latest === true;

	let rows;
	try {
		if (latest) {
			// Newest 'proposed' first; fall back to newest of any status
			// when nothing is pending (mirrors autoresearch latestProposal).
			rows = db.prepare(
				`SELECT * FROM proposals WHERE status = 'proposed' ORDER BY id DESC LIMIT 1`,
			).all();
			if (rows.length === 0) {
				rows = db.prepare(
					`SELECT * FROM proposals ORDER BY id DESC LIMIT 1`,
				).all();
			}
		} else {
			rows = db.prepare(
				`SELECT * FROM proposals WHERE status = 'proposed' ORDER BY id DESC`,
			).all();
		}
	} catch (e) {
		return { ok: false, errors: [`review: read proposals failed (${e.message})`] };
	}

	const proposals = rows.map((row) => {
		const p = decodeProposalRow(row);
		p.source_findings = loadSourceFindings(db, p.source_finding_ids);
		return p;
	});

	return { ok: true, proposalCount: proposals.length, proposals };
}

// formatReview(result) -> string. Human-readable block per proposal:
// header line (id + status + setting), the from→to diff, rationale,
// expected delta, and each citing finding. Empty result → one line.
function formatReview(result) {
	if (!result || !result.proposals || result.proposals.length === 0) {
		return "No proposals pending review.";
	}
	const lines = [];
	lines.push(`## Proposals pending review (${result.proposals.length})`);
	for (const p of result.proposals) {
		lines.push(`- [#${p.id} ${p.status}] \`${p.setting}\`: ${JSON.stringify(p.from)} → ${JSON.stringify(p.to)}`);
		lines.push(`    ${p.rationale}`);
		const delta = p.expected_delta || {};
		const deltaKeys = Object.keys(delta);
		if (deltaKeys.length > 0) {
			const pairs = deltaKeys.map((k) => `${k}=${JSON.stringify(delta[k])}`).join(", ");
			lines.push(`    expected delta: ${pairs}`);
		}
		const findings = p.source_findings || [];
		if (findings.length > 0) {
			lines.push(`    source findings:`);
			for (const sf of findings) {
				lines.push(`      - [${sf.severity}] ${sf.detector}: ${sf.title}`);
			}
		}
	}
	return lines.join("\n");
}

module.exports = {
	review,
	formatReview,
	// Exported for tests; not part of the public API.
	decodeProposalRow,
	loadSourceFindings,
};
