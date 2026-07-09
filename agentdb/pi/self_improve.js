// agentdb/pi/self_improve.js — pi agent tool self_improve (M9-5).
//
// ROADMAP M9-5 (SUPERPROMPT §6 module map + §8 self-improvement loop): the
// testable JS core of the pi agent tool that surfaces the autonomous `analyze`
// pass (M5-4 cli.js, factored as a callable) to the agent INSIDE a session.
// It is the in-session trigger of the self-improvement loop — the agent may
// ask "what's wrong with my recent runs?" mid-turn and get structured
// findings back, without leaving the loop or shelling out to a CLI.
//
//   self_improve({ db?, propose?, now? }) -> result
//     db       : inject an open DatabaseSync (skips open/close — tests +
//                composition; the caller owns the connection).
//     propose  : boolean (default false). When true, ALSO runs propose (M6-1)
//                on the freshly-recorded findings -> 'proposed' proposal rows.
//     now      : injectable clock (() => ISO8601) for deterministic tests.
//
// REQ-M9-5 contract, made concrete:
//   - RUNS ANALYZE: starts an analysis_runs row, runs all six detectors
//     (detectors.js runAllDetectors), records each finding (runs.js
//     recordFinding), ends the run — exactly what `apple-pi analyze` does.
//   - RETURNS FINDINGS: the persisted findings for this run are returned to
//     the caller (id + run_id + detector + severity + title + parsed evidence
//     + detected_at). evidence_json is dropped in favour of the parsed
//     `evidence` field (clean nested JSON — matches pi/list.js).
//   - APPLIES NOTHING: self_improve has NO code path that calls apply (M6-3).
//     There is no yes/apply option. The result ALWAYS carries applied:false.
//     `apply` is CLI-gated only (decision D9 — the human apply gate; mirrors
//     the autoresearch lifecycle). Optional propose writes ONLY 'proposed'
//     rows; it never flips one to 'applied' and never creates an
//     improvement_outcomes row.
//
// TWO MODES (mirrors pi/list.js + pi/query.js + pi/next.js):
//   (a) injected `db` — tests + composition; the caller owns the connection, so
//       NO open/close runs.
//   (b) no injected db — the real "pi harness" path: open() the unified
//       agent.db, run, close in a finally. NO ensureCurrent reconcile runs:
//       Tier B (sess_*/analysis_*/proposals) is authoritative in the DB itself,
//       not mirrored from files (same as pi/query.js).
//
// Best-effort, no-throw (mirrors kb/query.js + pi/query.js): a bad db returns
// { ok:false, errors }, never throws. An empty corpus returns { ok:true,
// findings:[] } — an empty analyze is a success, not an error.
//
// RED-BLUE: this layer adds NO SQL of its own except a single fixed-string
// SELECT (the findings re-fetch for the run) with a bound run_id. All detector
// + propose logic is delegated. So the injection surface is exactly the
// delegated layers' surfaces — no new string-concatenation is introduced here.
// The deliberate NON-import of apply.js is itself the security control: there
// is no way to reach apply from this module, by construction.

"use strict";

const { open } = require("../lib/db");
const { start, end, recordFinding } = require("../analysis/runs");
const { runAllDetectors } = require("../analysis/detectors");
const { propose } = require("../analysis/propose");

// NOTE: apply (../analysis/apply) is DELIBERATELY NOT required here.
// REQ-M9-5: self_improve NEVER applies. The absence of the import is the
// guarantee — there is no code path that can reach apply from this module.

// safeParse(s) -> value|null. Tolerates null/undefined/garbage (mirrors
// propose.js / apply.js) so a malformed evidence_json never breaks the decode.
function safeParse(s) {
	if (s === null || s === undefined) return null;
	try { return JSON.parse(s); } catch (_) { return null; }
}

// fetchFindings(db, runId) -> [finding]. Re-reads the persisted findings for
// this run as the source of truth (includes the autoincremented id +
// detected_at that the detector objects do not carry). Fixed SQL string +
// bound run_id — no user input is concatenated. evidence_json is decoded into
// a parsed `evidence` field; the raw column is dropped from the output.
function fetchFindings(db, runId) {
	const rows = db.prepare(
		"SELECT id, run_id, detector, severity, title, evidence_json, detected_at " +
		"FROM analysis_findings WHERE run_id = ? ORDER BY id",
	).all(runId);
	return rows.map(({ evidence_json, ...rest }) => ({
		...rest,
		evidence: safeParse(evidence_json) || {},
	}));
}

// runAnalyze(db, opts) -> { ok, run_id, findings, findingCount, detectorCount,
//   errors?, applied:false } | { ok:false, errors }
// The analyze pass (M5-4 cli.js factored as a callable): start run → run all
// detectors → record each finding → end run → return the persisted findings.
function runAnalyze(db, { now } = {}) {
	const startOpts = now ? { now } : {};
	const startRes = start(db, startOpts);
	if (!startRes.ok) {
		return { ok: false, errors: startRes.errors || ["self_improve: could not start analysis run"] };
	}
	const runId = startRes.run_id;

	// runAllDetectors never throws (a failing detector is caught + listed in
	// errors[]); the rest still land. recordFinding is best-effort too.
	const { findings: detFindings, detectorCount, errors } = runAllDetectors(db);
	for (const f of detFindings) {
		recordFinding(db, runId, f);
	}

	const endOpts = { finding_count: detFindings.length };
	if (now) endOpts.now = now;
	end(db, runId, endOpts); // closes the run (sets ended_at + finding_count)

	// re-fetch as the source of truth — includes ids + detected_at the agent
	// (and a later propose) can cite.
	let findings;
	try {
		findings = fetchFindings(db, runId);
	} catch (e) {
		// the run + findings were recorded; a read failure here is reported but
		// does not undo the analyze. Fall back to the detector objects.
		findings = detFindings.map(f => ({ run_id: runId, ...f, evidence: f.evidence || {} }));
		return {
			ok: true, run_id: runId, findings, findingCount: findings.length,
			detectorCount, errors: [...(errors || []), `self_improve: findings re-fetch failed (${e.message})`],
			applied: false,
		};
	}

	return {
		ok: true,
		run_id: runId,
		findings,
		findingsCount: findings.length,
		findingCount: findings.length,
		detectorCount,
		errors,
		applied: false, // REQ-M9-5: ALWAYS false — apply is never reachable here.
	};
}

// self_improve({ db?, propose?, now? }) -> result
//   db      : inject an open DatabaseSync (skips open/close)
//   propose : boolean (default false) — also run propose on the findings
//   now     : injectable clock for deterministic tests
//
// Returns (analyze-only):
//   { ok:true, run_id, findings, findingCount, findingsCount, detectorCount,
//     errors?, applied:false }
// Returns (propose=true, adds):
//   { ..., proposedCount, proposeErrors? }
// Returns (failure):
//   { ok:false, errors[], applied:false }
//
// applied is ALWAYS present and ALWAYS false — the headline REQ-M9-5 invariant.
function self_improve({ db: injectedDb, propose: doPropose, now } = {}) {
	const run = (db) => {
		const res = runAnalyze(db, { now });
		if (!res.ok) return res;

		// Optional propose: turn the freshly-recorded findings into 'proposed'
		// rows. STILL no apply — propose writes only status='proposed' and
		// never touches improvement_outcomes (M6-1 contract).
		if (doPropose) {
			const pres = propose(db, now ? { now } : {});
			if (pres.ok) {
				res.proposedCount = pres.proposalCount;
			} else {
				res.proposedCount = 0;
				res.proposeErrors = pres.errors || [];
			}
		}

		// applied stays false regardless of propose — there is no apply call.
		return res;
	};

	if (injectedDb) return run(injectedDb);

	// Opens-own-db path: open() can throw on a bad/unopenable AGENT_DB. The
	// module's no-throw contract (mirrors kb/query.js) requires we surface that
	// as { ok:false, errors, applied:false } rather than letting it escape — an
	// agent calling this tool mid-session must never be killed by a DB open
	// failure. applied stays false (nothing was applied, nothing was even run).
	try {
		const db = open();
		try {
			// NO ensureCurrent: Tier B is authoritative in the DB (ingested +
			// analyze-recorded, not mirrored from files). Mirrors pi/query.js.
			return run(db);
		} finally {
			db.close();
		}
	} catch (e) {
		return { ok: false, errors: [`self_improve: ${e.code || e.message}`], applied: false };
	}
}

module.exports = { self_improve };
