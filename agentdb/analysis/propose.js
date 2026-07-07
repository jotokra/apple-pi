// agentdb/analysis/propose.js — findings → proposals (M6-1).
//
// ROADMAP M6-1: turns analysis_findings into machine-checkable
// self-improvement proposals. Each proposal is a concrete setting
// change: { setting, from, to, rationale, expected_delta } plus the
// source_finding_ids that justify it. Status starts 'proposed'.
//
// The proposals table (agentdb/lib/schema.sql) already carries the M6
// columns: source_finding_ids_json (JSON array of analysis_findings.id)
// and outcome_id (FK to improvement_outcomes, set later by M6-4 measure).
// This module is what populates them.
//
// API:
//   propose(db, opts={}) -> { ok, proposalCount, proposals?, errors? }
//     Scans analysis_findings for rows with proposal_id IS NULL (not yet
//     linked to a proposal), maps each to a well-formed proposal via a
//     per-detector template, inserts a proposals row (status 'proposed'),
//     and back-fills analysis_findings.proposal_id to point at it.
//     Idempotent: a second call finds nothing new (every finding it
//     produced last time is now linked).
//   findingToProposal(finding) -> { setting, from, to, rationale, expected_delta }
//     Pure mapping from one finding (with evidence) to a proposal body.
//     Exported for tests. Unknown detector kinds fall back to a generic
//     proposal so a new detector never silently produces no proposal.
//
// RED-BLUE CONTRACT:
//   - propose() never throws. Bad inputs (no db, read failure) return
//     ok:false with errors[]. A single malformed finding (unparseable
//     evidence) is skipped — the rest still land.
//   - Only analysis_findings.proposal_id (back-fill) and proposals rows
//     are written. sess_*/kb_*/runs are read-only here.
//   - source_finding_ids is always the JSON-encoded [finding.id]; a
//     proposal cites exactly the finding that produced it. The back-fill
//     makes the link bidirectional (analysis_findings.proposal_id ↔
//     proposals.source_finding_ids_json) so review/apply/measure can
//     trace either way.
"use strict";

// ---- proposal body templates ----------------------------------------

// error_pattern evidence: { tool, error_count, threshold }
function proposalErrorPattern(e) {
	const tool = e.tool ?? "unknown";
	const budget = Number.isFinite(e.threshold) ? e.threshold : 5;
	const errors = Number.isFinite(e.error_count) ? e.error_count : budget;
	return {
		setting: `agent.tools.${tool}.error_budget`,
		from: null,
		to: budget,
		rationale: `tool ${tool} errored ${errors} time(s); cap retries at a ${budget}-error budget so failures surface earlier`,
		expected_delta: { [`sess_events.errors.${tool}`]: -(errors - budget) },
	};
}

// cost_spike evidence: { session_id, cost, model, p95 }
function proposalCostSpike(e) {
	const model = e.model ?? "default";
	const cost = Number.isFinite(e.cost) ? e.cost : 0;
	const p95 = Number.isFinite(e.p95) ? e.p95 : cost;
	const cap = Number(p95.toFixed(4));
	return {
		setting: `agent.models.${model}.max_session_cost`,
		from: null,
		to: cap,
		rationale: `session ${e.session_id ?? "?"} cost $${cost.toFixed(4)} exceeded p95 $${p95.toFixed(4)}; set a per-session cost ceiling`,
		expected_delta: { "sess_sessions.cost_p95": Number((p95 - cost).toFixed(4)) },
	};
}

// model_drift evidence: { model, recent_mean, baseline_mean, drift, ... }
function proposalModelDrift(e) {
	const model = e.model ?? "default";
	const drift = Number.isFinite(e.drift) ? e.drift : 0;
	const recent = Number.isFinite(e.recent_mean) ? e.recent_mean : 0;
	const baseline = Number.isFinite(e.baseline_mean) ? e.baseline_mean : recent;
	return {
		setting: `agent.models.${model}.fallback_enabled`,
		from: false,
		to: true,
		rationale: `model ${model} cost-per-message drifted ${(drift * 100).toFixed(1)}% (recent $${recent.toFixed(4)} vs baseline $${baseline.toFixed(4)}); enable fallback to a cheaper provider`,
		expected_delta: { [`sess_sessions.cost_per_message.${model}`]: Number((baseline - recent).toFixed(4)) },
	};
}

// tool_overuse evidence: { tool, count, total, share, threshold }
function proposalToolOveruse(e) {
	const tool = e.tool ?? "unknown";
	const share = Number.isFinite(e.share) ? e.share : 0;
	const threshold = Number.isFinite(e.threshold) ? e.threshold : 0.5;
	return {
		setting: `agent.tools.${tool}.max_share`,
		from: null,
		to: threshold,
		rationale: `tool ${tool} is ${(share * 100).toFixed(1)}% of all tool calls (threshold ${(threshold * 100).toFixed(0)}%); enforce a max-share to rebalance`,
		expected_delta: { [`sess_sessions.tool_share.${tool}`]: `${((threshold - share) * 100).toFixed(1)}pp` },
	};
}

// tool_underuse evidence: { tool, count, distinct_tools, total_calls, session_count }
function proposalToolUnderuse(e) {
	const tool = e.tool ?? "unknown";
	const count = Number.isFinite(e.count) ? e.count : 0;
	return {
		setting: `agent.skills.${tool}`,
		from: "absent",
		to: "stub",
		rationale: `tool ${tool} used only ${count} time(s) across the corpus; add a skill stub to encourage deliberate use`,
		expected_delta: { [`sess_sessions.tool_calls.${tool}`]: `+N (lift above ${count})` },
	};
}

// card_stall evidence: { card_id, title, status, age_days, threshold_days, updated_at }
function proposalCardStall(e) {
	const cardId = e.card_id ?? "unknown";
	const status = e.status ?? "in_progress";
	const to = status === "blocked" ? "todo" : "review";
	const ageDays = Number.isFinite(e.age_days) ? e.age_days : 0;
	const title = e.title ?? "";
	return {
		setting: `kanban.cards.${cardId}.status`,
		from: status,
		to,
		rationale: `card ${cardId}${title ? ` "${title}"` : ""} stalled ${ageDays.toFixed(1)}d in ${status} (threshold ${e.threshold_days ?? "?"}d); move to ${to} to unstick`,
		expected_delta: { [`kb_cards.${status}_age_days`]: -Number(ageDays.toFixed(1)) },
	};
}

// Generic fallback: any detector without a dedicated template still
// produces a well-formed proposal (no silent drop on a new detector).
function proposalGeneric(detector, title) {
	return {
		setting: `agent.proposals.${detector}`,
		from: null,
		to: "review",
		rationale: `${detector} finding: ${title}`,
		expected_delta: {},
	};
}

const TEMPLATES = {
	error_pattern: proposalErrorPattern,
	cost_spike: proposalCostSpike,
	model_drift: proposalModelDrift,
	tool_overuse: proposalToolOveruse,
	tool_underuse: proposalToolUnderuse,
	card_stall: proposalCardStall,
};

// findingToProposal(finding) -> { setting, from, to, rationale, expected_delta }
// Pure: takes a finding (with parsed evidence) and returns a proposal body.
// finding.evidence_json may be a string (DB row) or already-parsed; both work.
function findingToProposal(finding) {
	const detector = finding.detector;
	const title = finding.title ?? "";
	let evidence = {};
	const raw = finding.evidence_json ?? finding.evidence;
	if (typeof raw === "string" && raw.length > 0) {
		try { evidence = JSON.parse(raw) || {}; } catch (_) { evidence = {}; }
	} else if (raw && typeof raw === "object") {
		evidence = raw;
	}
	const fn = TEMPLATES[detector];
	if (!fn) return proposalGeneric(detector, title);
	try {
		return fn(evidence);
	} catch (_) {
		return proposalGeneric(detector, title);
	}
}

// ---- decode / encode -------------------------------------------------

// encodeJsonValue(v) -> TEXT|NULL. null stays SQL NULL; everything else
// is JSON.stringify'd so the proposals.from_value/to_value columns round-
// trip structured data.
function encodeJsonValue(v) {
	if (v === undefined) return null;
	if (v === null) return null;
	return JSON.stringify(v);
}

// decodeProposal(row) -> plain proposal object. Parses the JSON-encoded
// columns back into JS values so callers see {from, to, expected_delta,
// source_finding_ids}, not raw strings.
function decodeProposal(row) {
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

function safeParse(s) {
	if (s === null || s === undefined) return null;
	try { return JSON.parse(s); } catch (_) { return null; }
}

// ---- main entry ------------------------------------------------------

// propose(db, opts={}) -> { ok, proposalCount, proposals?, errors? }
function propose(db, opts = {}) {
	if (!db) return { ok: false, errors: ["propose: db is required"] };
	const ts = (opts.now || (() => new Date().toISOString()))();

	let findings;
	try {
		findings = db.prepare(
			`SELECT id, run_id, detector, severity, title, evidence_json, proposal_id
			 FROM analysis_findings
			 WHERE proposal_id IS NULL
			 ORDER BY id`,
		).all();
	} catch (e) {
		return { ok: false, errors: [`propose: read analysis_findings failed (${e.message})`] };
	}

	const proposals = [];
	const errors = [];
	for (const f of findings) {
		const body = findingToProposal(f);
		const sourceIds = [f.id];
		try {
			const info = db.prepare(
				`INSERT INTO proposals
				   (status, setting, from_value, to_value, rationale,
				    expected_delta_json, source_finding_ids_json, outcome_id,
				    proposed_at, applied_at)
				 VALUES ('proposed', ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
			).run(
				body.setting,
				encodeJsonValue(body.from),
				encodeJsonValue(body.to),
				body.rationale,
				JSON.stringify(body.expected_delta || {}),
				JSON.stringify(sourceIds),
				ts,
			);
			// Back-fill the bidirectional link so review/apply/measure can
			// trace proposal → finding and finding → proposal.
			db.prepare("UPDATE analysis_findings SET proposal_id = ? WHERE id = ?").run(info.lastInsertRowid, f.id);
			const row = db.prepare("SELECT * FROM proposals WHERE id = ?").get(info.lastInsertRowid);
			proposals.push(decodeProposal(row));
		} catch (e) {
			errors.push(`propose: finding ${f.id} (${f.detector}) failed (${e.message})`);
		}
	}

	return { ok: true, proposalCount: proposals.length, proposals, errors: errors.length ? errors : undefined };
}

module.exports = {
	propose,
	findingToProposal,
	// Exported for tests; not part of the public API.
	TEMPLATES,
};
