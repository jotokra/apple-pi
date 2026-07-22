// agentdb/analysis/improve.js — `apple-pi improve` (M8-6).
//
//   apple-pi improve [--apply] [--yes]
//
// ROADMAP M8-6: the CLI wrapper around propose (M6-1) + apply (M6-3). The
// default run proposes only — it scans analysis_findings for unlinked rows
// and writes proposals (status 'proposed'). --apply also runs apply (the D9
// --yes gate applies: NOTHING is written without --yes). This is the one-verb
// "find improvements AND optionally apply the latest" path — the counterpart
// to running `analyze` then `apply` as two steps.
//
// Sequence: open → propose() → (if --apply) apply({latest, yes}) → print.
// propose always runs first so an `improve --apply` against a fresh corpus
// still has a pending proposal to apply. apply targets the newest 'proposed'
// — i.e. the one propose just made, or a pre-existing one.
//
// RED-BLUE CONTRACT:
//   - improve never throws. Bad db / write failures are reported + exit 1.
//   - apply is gated by --yes exactly as in apply.js (D9): --apply without
//     --yes writes NOTHING (the byte-identical before/after snapshot in
//     improve.test.js covers it). The default (no --apply) never even
//     calls apply.
//   - Writes are scoped exactly to what propose + apply touch: proposals +
//     analysis_findings.proposal_id (propose), and on --yes the target
//     proposal row + one improvement_outcomes row (apply). sess_*/kb_*/
//     analysis_runs are read-only here.

"use strict";

const { open } = require("../lib/db");
const { propose } = require("./propose");
const { apply, formatApply } = require("./apply");

function help() {
	console.log(`apple-pi improve — propose findings → proposals, optionally apply the latest

  (default)       run propose: unlinked analysis_findings → proposals (status 'proposed')
  --apply         also run apply on the newest 'proposed' proposal
  --yes           REQUIRED for --apply to write anything (the D9 gate)
  -h, --help      show this help

  DB path is $AGENT_DB, else ~/.pi/agent/agent.db.
  No apply without --yes. The default (no --apply) proposes only.`);
}

// improveCmd(args) -> exit code.
//
// propose always runs (it is the read→write half of the wrapper). apply only
// runs when --apply is passed, and only writes when --yes is also present
// (apply.js enforces the gate; improve just forwards the flag). DB is closed
// in a finally so a mid-run throw never leaks the handle.
function improveCmd(args) {
	if (args.includes("-h") || args.includes("--help")) {
		help();
		return 0;
	}
	const doApply = args.includes("--apply");
	const yes = args.includes("--yes");

	const db = open();
	try {
		// 1. propose — always. Turns unlinked findings into 'proposed' rows.
		const pres = propose(db);
		if (!pres.ok) {
			console.error(`apple-pi improve: propose failed (${(pres.errors || []).join("; ")})`);
			return 1;
		}
		console.log(`apple-pi improve: proposed ${pres.proposalCount} proposal${pres.proposalCount === 1 ? "" : "s"} (status 'proposed')`);

		// 2. apply — only when asked. Gated by --yes (D9): nothing written
		//    without it. The default (no --apply) never calls apply, so a
		//    plain `improve` can never mutate a proposal to 'applied'.
		if (doApply) {
			const ares = apply(db, { latest: true, yes });
			if (!ares.ok) {
				console.error(`apple-pi improve: apply failed (${(ares.errors || []).join("; ")})`);
				return 1;
			}
			console.log(formatApply(ares));
		} else if (pres.proposalCount > 0) {
			console.log(`  review with 'apple-pi improve --apply' (add --yes to apply the latest)`);
		}
		return 0;
	} finally {
		db.close();
	}
}

function run(args) {
	// `apple-pi improve` takes no subcommand — args are flags only.
	return improveCmd(Array.isArray(args) ? args : []);
}

module.exports = { run, improveCmd, help };
