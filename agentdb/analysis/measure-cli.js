// agentdb/analysis/measure-cli.js — `apple-pi measure` (M8-7).
//
//   apple-pi measure [--window <ms>]
//
// ROADMAP M8-7: the CLI wrapper around M6-4 measure.js. It finalizes the
// 'pending' improvement_outcomes rows that M6-3 apply wrote — for each
// applied proposal past a measurement window it compares the before-snapshot
// (recorded at apply time) against a fresh after-snapshot read from the DB,
// computes the delta, and writes a verdict (improved|neutral|regressed). A
// 'regressed' verdict is the signal the next analyze can turn into a revert
// proposal — that is what "closes the loop" means. This is the one-verb
// "finalize the applied proposals I already shipped" path.
//
// --window <ms> gates ripeness: an outcome whose proposal.applied_at is within
// <ms> of now is SKIPPED (left 'pending') so a scheduled measure only finalizes
// outcomes with enough post-apply data. Default 0 = measure every pending
// outcome now (the manual-run default).
//
// Sequence: open → measure({windowMs}) → formatMeasure → close.
//
// RED-BLUE CONTRACT:
//   - measure never throws. Bad db / write failures are reported + exit 1.
//   - Mutates only improvement_outcomes (after_json/delta_json/verdict/
//     measured_at). before_json is preserved (apply owns it). proposals /
//     sess_*/kb_*/analysis_* are read-only here.
//   - Idempotent + window-safe: only verdict='pending' rows past the window
//     finalize. A finalized outcome (improved/neutral/regressed) is never
//     re-measured, so scheduling measure is safe.

"use strict";

const { open } = require("../lib/db");
const { measure, formatMeasure } = require("./measure");

function help() {
	console.log(`apple-pi measure — finalize improvement outcomes (close the loop)

  (default)        measure every pending outcome (window 0)
  --window <ms>    skip outcomes whose proposal was applied within the last <ms>
  -h, --help       show this help

  DB path is $AGENT_DB, else ~/.pi/agent/agent.db.
  Writes only improvement_outcomes (after/delta/verdict/measured_at). before_json
  is preserved. Idempotent + window-safe — safe to schedule.`);
}

// parseWindowMs(args) -> { ok, ms }.
//   ok=true, ms=number          --window <ms> parsed (or absent → ms=0)
//   ok=false                    --window present but the value is missing or
//                                not a non-negative finite number
// Accepts both "--window 3600000" and "--window=3600000".
function parseWindowMs(args) {
	const i = args.indexOf("--window");
	if (i === -1) return { ok: true, ms: 0 };
	const next = args[i + 1];
	// "--window=<ms>" form: node never tokenizes '=', so a value glued with
	// '=' arrives as the same token; split it out here.
	if (next == null) return { ok: false };
	if (String(next).startsWith("--window=")) {
		const n = Number(String(next).slice("--window=".length));
		return Number.isFinite(n) && n >= 0 ? { ok: true, ms: n } : { ok: false };
	}
	// "--window <ms>" form: the next token is the value (must not look like a
	// flag — a missing value leaves --window dangling).
	if (String(next).startsWith("-")) return { ok: false };
	const n = Number(next);
	return Number.isFinite(n) && n >= 0 ? { ok: true, ms: n } : { ok: false };
}

// measureCmd(args) -> exit code.
//
// open → measure({windowMs}) → formatMeasure → close. The DB is closed in a
// finally so a mid-run throw never leaks the handle. A usage error on
// --window exits 2 before touching the DB; a measure() failure exits 1.
function measureCmd(args) {
	if (args.includes("-h") || args.includes("--help")) {
		help();
		return 0;
	}
	const parsed = parseWindowMs(args);
	if (!parsed.ok) {
		console.error("apple-pi measure: --window requires a non-negative integer (milliseconds), e.g. --window 3600000");
		return 2;
	}

	const db = open();
	try {
		const res = measure(db, { windowMs: parsed.ms });
		if (!res.ok) {
			console.error(`apple-pi measure: ${((res.errors || []).join("; ")) || "failed"}`);
			return 1;
		}
		console.log(formatMeasure(res));
		return 0;
	} finally {
		db.close();
	}
}

function run(args) {
	// `apple-pi measure` takes no subcommand — args are flags only.
	return measureCmd(Array.isArray(args) ? args : []);
}

module.exports = { run, measureCmd, help };
