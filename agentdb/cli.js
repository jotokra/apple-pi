// agentdb/cli.js — `apple-pi kanban <subcommand>` dispatch.
//
//   apple-pi kanban index [--rebuild]   reindex the kb_* mirror from disk
//
// M8-1 ships the `index` subcommand:
//   --rebuild   DROP kb_* first, then reindex from disk (full rebuild).
//   (default)   ensureCurrent — lazy reconcile (rebuild / incremental / noop).
//
// Later M8 cards fill in list/show/next/graph/new/move/validate. Mirrors
// vault/cli.js + sync/cli.js: CommonJS, run(args) entry, node: built-ins.
//
// The DB path is whatever lib/db.js resolves ($AGENT_DB, else ~/.pi/agent/agent.db)
// and the card root defaults to process.cwd() (override with --root) — so a
// test or an operator points a throwaway AGENT_DB + cwd at the work without ever
// touching the live DB. The tier-isolation contract (kb_* disposable; Tier B
// durable) is owned by kb/index.js's rebuild(); this CLI only dispatches + reports.
"use strict";

const { open } = require("./lib/db");
const { rebuild, ensureCurrent } = require("./kb/index");

function help() {
	console.log(`apple-pi kanban — kb_* mirror CLI

  index [--rebuild]   reindex the kb_* mirror from disk
        --rebuild     DROP kb_* first, then reindex (full rebuild)
        (default)     ensureCurrent — lazy reconcile (rebuild/incremental/noop)
        --root DIR    card root (default: current directory)

  DB path is $AGENT_DB, else ~/.pi/agent/agent.db.`);
}

// indexCmd(args) -> exit code. --rebuild = full rebuild; default = ensureCurrent.
// Prints a one-block summary including the kb_cards row count (ACCEPTANCE:
// "exit 0 + row count"). Skipped cards are reported but never fatal — the
// primitives are best-effort (mirrors the rest of agentdb/kb).
function indexCmd(args) {
	const rebuildFlag = args.includes("--rebuild");
	let root = process.cwd();
	const i = args.indexOf("--root");
	if (i >= 0 && args[i + 1]) root = args[i + 1];

	const db = open();
	try {
		const res = rebuildFlag ? rebuild(db, root) : ensureCurrent(db, root);
		const action = rebuildFlag ? "rebuild" : res.action;
		const count = db.prepare("SELECT count(*) c FROM kb_cards").get().c;

		console.log(`apple-pi kanban index: ${action}`);
		console.log(`  root   : ${root}`);
		console.log(`  cards  : ${count}`);
		if (rebuildFlag) {
			console.log(`  inserted : ${res.inserted}`);
			if (res.skipped && res.skipped.length) {
				console.log(`  skipped  : ${res.skipped.length}`);
				for (const s of res.skipped) for (const e of s.errors) console.log(`    ${e}`);
			}
		} else if (action === "incremental") {
			console.log(`  upserted : ${res.upserted}`);
			console.log(`  removed  : ${res.removed}`);
		}
		return 0;
	} finally {
		db.close();
	}
}

function run(args) {
	const [sub, ...rest] = args;
	switch (sub) {
		case undefined:
		case "-h":
		case "--help":
		case "help":
			return help();
		case "index":
			return indexCmd(rest);
		default:
			console.error(`apple-pi kanban: unknown subcommand '${sub}' (try 'apple-pi kanban help')`);
			return 2;
	}
}

module.exports = { run, indexCmd };
