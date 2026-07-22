// agentdb/analysis/cli.js — `apple-pi analyze` dispatch (M5-4).
//
//   apple-pi analyze   run all detectors, print a findings summary,
//                      write analysis_runs + analysis_findings.
//
// ROADMAP M5-4: the autonomous, read-only analyze pass. It starts a run,
// runs every detector (detectors.js runAllDetectors), records each finding
// (runs.js recordFinding), ends the run, and prints a one-block summary.
//
// Read-only on the world: the only tables this ever writes are
// analysis_runs (one row) and analysis_findings (one per finding). It
// reads sess_sessions / sess_events / kb_cards but never mutates them —
// the detectors are pure db→[finding] functions. No LLM is involved, so
// there are no tokens to bill and no network to touch.
//
// The DB path is whatever lib/db.js resolves ($AGENT_DB, else
// ~/.pi/agent/agent.db) — so a test or an operator points a throwaway
// AGENT_DB at the work without ever touching the live DB. Mirrors
// agentdb/cli.js + vault/cli.js + sync/cli.js: CommonJS, run(args) entry,
// node: built-ins only.

"use strict";

const { open } = require("../lib/db");
const { start, end, recordFinding } = require("./runs");
const { runAllDetectors } = require("./detectors");

function help() {
	console.log(`apple-pi analyze — run all detectors, print findings, write analysis_*

  (default)   run all six detectors, print a summary, persist the run + findings
  -h, --help  show this help

  DB path is $AGENT_DB, else ~/.pi/agent/agent.db.
  Read-only on the world: mutates only analysis_runs + analysis_findings.`);
}

// analyzeCmd(args) -> exit code.
//
// Sequence: open → start run → runAllDetectors → record each finding →
// end run (with finding_count) → print summary. Detector errors are
// reported in the summary but never fatal — a detector that throws is
// caught inside runAllDetectors and listed in errors[], the rest still
// land (matches detectors.js's red-blue contract). The DB is closed in
// a finally so a mid-run throw never leaks the handle.
function analyzeCmd(args) {
	if (args.includes("-h") || args.includes("--help")) {
		help();
		return 0;
	}

	const db = open();
	let runId;
	try {
		const startRes = start(db);
		if (!startRes.ok) {
			console.error(`apple-pi analyze: could not start run (${(startRes.errors || []).join("; ")})`);
			return 1;
		}
		runId = startRes.run_id;

		const { findings, detectorCount, errors } = runAllDetectors(db);

		// Record each finding against this run. recordFinding also bumps
		// run.finding_count, so by the time we end() the run the count is
		// already findings.length — end() takes the same number to keep the
		// row self-consistent (the M5-1 contract).
		for (const f of findings) {
			recordFinding(db, runId, f);
		}

		end(db, runId, { finding_count: findings.length });

		// Summary block — mirrors the shape of agentdb/cli.js's index report.
		const bySev = { critical: 0, warn: 0, info: 0 };
		for (const f of findings) bySev[f.severity] = (bySev[f.severity] || 0) + 1;
		console.log(`apple-pi analyze: ${findings.length} finding${findings.length === 1 ? "" : "s"} from ${detectorCount} detectors`);
		console.log(`  critical : ${bySev.critical}`);
		console.log(`  warn     : ${bySev.warn}`);
		console.log(`  info     : ${bySev.info}`);
		if (errors && errors.length) {
			console.log(`  detector errors : ${errors.length}`);
			for (const e of errors) console.log(`    ${e}`);
		}
		console.log(`  run id   : ${runId}`);
		return 0;
	} finally {
		db.close();
	}
}

function run(args) {
	// `apple-pi analyze` takes no subcommand — args are flags only.
	return analyzeCmd(Array.isArray(args) ? args : []);
}

module.exports = { run, analyzeCmd, help };
