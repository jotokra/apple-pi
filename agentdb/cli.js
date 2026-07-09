// agentdb/cli.js — `apple-pi kanban <subcommand>` dispatch.
//
//   apple-pi kanban index [--rebuild]                 reindex the kb_* mirror
//   apple-pi kanban list [filters] [--json]           list cards (M3-1 filters)
//   apple-pi kanban show <id> [--json]                single card (incl. body)
//   apple-pi kanban next [--json]                     WIP-aware (M0-2) + ready (M3-2)
//   apple-pi kanban graph [--json]                    edges + ready + cycles
//   apple-pi kanban new <id> [opts] [--json]          create a .card.md (M2-5 createCard)
//   apple-pi kanban move <id> <to-status> [--json]    transition a card (M2-5 moveStatus)
//
// M8-1 shipped `index` (--rebuild = full rebuild; default = ensureCurrent).
// M8-2 shipped the read commands: list/show/next/graph. M8-3 ships the TRUTH
// WRITERS: new/move. They wrap M2-5's createCard/moveStatus — which already
// enforce the red-blue contract (resolveUnderRoot path safety +
// legalTransition status rules) — so the CLI's job is argument plumbing,
// id->file resolution (via the mirror), error surfacing, and a post-write
// reconcile so `show`/`list` reflect the change immediately. The CLI offers
// NO path argument to the writer: `move` resolves the id ONLY from kb_cards
// (under-root by construction), and `new --dir` is contained by
// resolveUnderRoot. Later M8 cards fill in validate/improve. Mirrors
// vault/cli.js + sync/cli.js: CommonJS, run(args) entry, node: built-ins.
//
// The DB path is whatever lib/db.js resolves ($AGENT_DB, else ~/.pi/agent/agent.db)
// and the card root defaults to process.cwd() (override with --root) — so a
// test or an operator points a throwaway AGENT_DB + cwd at the work without ever
// touching the live DB. The tier-isolation contract (kb_* disposable; Tier B
// durable) is owned by kb/index.js's rebuild(); this CLI only dispatches + reports.
"use strict";

const path = require("node:path");
const { open } = require("./lib/db");
const { rebuild, ensureCurrent } = require("./kb/index");
const { list } = require("./kb/query");       // M3-1 filter queries
const { ready, edges, detectCycles } = require("./kb/graph");  // M3-2 graph
const { wipLimit } = require("./kb/status");  // M0-2 WIP limit

function help() {
	console.log(`apple-pi kanban — kb_* mirror CLI

  index [--rebuild]              reindex the kb_* mirror from disk
        --rebuild                DROP kb_* first, then reindex (full rebuild)
        (default)                ensureCurrent — lazy reconcile
        --root DIR               card root (default: current directory)

  list [filters] [--json]        list cards (M3-1 filters; AND-compose)
        --status|--project|--assignee|--parent <v>   exact-match filters
        --tag <t> (repeatable)                        ANY-of tag filter
        --priority <n> | --priority-min/--priority-max <n>   exact or range
        --json                  machine-readable rows

  show <id> [--json]             single card (incl. body); missing id exits 1

  next [--json]                  WIP-aware (M0-2) + ready (M3-2) recommendation
        at the KANBAN_WIP limit a ready card is HELD, not recommended

  graph [--json]                 edges (depends_on) + ready set + cycles

  new <id> [opts] [--json]       create a .card.md (M2-5 createCard)
        --title T --status S --priority N --project P --assignee A --parent X
        --tag T (repeatable) --dep D (repeatable) --body "..."
        --dir SUBDIR            card subdir under root (default: cards)
        path safety + schema enforced; rejects with NO file write

  move <id> <to-status> [--json] transition a card (M2-5 moveStatus)
        legal transitions only (SUPERPROMPT §5.1); diff is EXACTLY status +
        updated_at (2 lines); id resolved from the mirror (no path arg)

  Read commands lazily reconcile the mirror (ensureCurrent) before querying.
  DB path is $AGENT_DB, else ~/.pi/agent/agent.db.`);
}

// --- shared flag parser -------------------------------------------------
// parseOpts(args) -> { values, multi, bools, positionals }. value flags consume
// the next arg; multi flags accumulate; bool flags are presence-only; anything
// else is a positional. Unknown --flags are ignored (forward-compat).
const VALUE_FLAGS = new Set(["--root", "--status", "--project", "--assignee", "--priority", "--priority-min", "--priority-max", "--parent", "--title", "--dir", "--body"]);
const MULTI_FLAGS = new Set(["--tag", "--dep"]);
const BOOL_FLAGS = new Set(["--json"]);
function parseOpts(args) {
	const out = { values: {}, multi: {}, bools: {}, positionals: [] };
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (BOOL_FLAGS.has(a)) { out.bools[a] = true; continue; }
		if (VALUE_FLAGS.has(a) || MULTI_FLAGS.has(a)) {
			const v = args[i + 1];
			if (MULTI_FLAGS.has(a)) (out.multi[a] ??= []).push(v);
			else out.values[a] = v;
			i++; // consume the value
			continue;
		}
		if (a.startsWith("--")) continue; // unknown flag → ignore
		out.positionals.push(a);
	}
	return out;
}

// parsePriorityInt(s) -> number | string. Coerce a "<int>" string to a number
// so query.list's isInt check passes; anything else is returned as-is so the
// query layer rejects it loudly (defense in depth — the bind layer is primary).
function parsePriorityInt(s) {
	if (typeof s === "string" && /^-?\d+$/.test(s.trim())) return Number(s);
	return s;
}

// buildFilters(opts) -> the filters object query.list() expects. Only sets keys
// the caller actually passed (unknown keys are silently ignored by list()).
function buildFilters(opts) {
	const v = opts.values;
	const f = {};
	if (v["--status"]) f.status = v["--status"];
	if (v["--project"]) f.project = v["--project"];
	if (v["--parent"]) f.parent = v["--parent"];
	if (v["--assignee"] !== undefined) {
		const a = v["--assignee"];
		f.assignee = (a === "null" || a === "unassigned" || a === "") ? null : a;
	}
	const tags = opts.multi["--tag"] || [];
	if (tags.length) f.tag = tags.length === 1 ? tags[0] : tags;
	if (v["--priority"] !== undefined) {
		f.priority = parsePriorityInt(v["--priority"]);
	} else if (v["--priority-min"] !== undefined || v["--priority-max"] !== undefined) {
		f.priority = {
			min: v["--priority-min"] !== undefined ? parsePriorityInt(v["--priority-min"]) : null,
			max: v["--priority-max"] !== undefined ? parsePriorityInt(v["--priority-max"]) : null,
		};
	}
	return f;
}

function resolveRoot(opts) {
	return opts.values["--root"] || process.cwd();
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

// listCmd(args) -> exit code. Filters AND-compose via query.list (M3-1).
// --json prints the raw row array; human default is one line per card + count.
function listCmd(args) {
	const opts = parseOpts(args);
	const json = !!opts.bools["--json"];
	const root = resolveRoot(opts);
	const filters = buildFilters(opts);

	const db = open();
	try {
		ensureCurrent(db, root); // lazy reconcile — read path is correct with no manual index
		const res = list(db, filters);
		if (!res.ok) {
			for (const e of res.errors) console.error(e);
			return 1;
		}
		if (json) {
			process.stdout.write(JSON.stringify(res.rows, null, 2) + "\n");
			return 0;
		}
		const flagStr = formatFilterLine(filters);
		console.log(`apple-pi kanban list${flagStr}`);
		for (const r of res.rows) {
			const p = r.priority == null ? "-" : String(r.priority);
			const proj = r.project ?? "-";
			console.log(`  ${pad(r.id, 8)} ${pad(r.status, 13)} p${p}  ${pad(proj, 10)} ${r.title}`);
		}
		console.log(`  cards: ${res.rows.length}`);
		return 0;
	} finally {
		db.close();
	}
}

// showCmd(args) -> exit code. Single card by id (incl. body). Missing id exits 1.
function showCmd(args) {
	const opts = parseOpts(args);
	const json = !!opts.bools["--json"];
	const root = resolveRoot(opts);
	const id = opts.positionals[0];
	if (!id) {
		console.error("apple-pi kanban show: missing <id> (try 'apple-pi kanban help')");
		return 2;
	}
	const db = open();
	try {
		ensureCurrent(db, root);
		const row = db.prepare(
			"SELECT id, title, status, priority, project, assignee, parent, " +
			"tags_json, file_path, frontmatter_json, body, updated_at, file_hash " +
			"FROM kb_cards WHERE id = ?",
		).get(id);
		if (!row) {
			console.error(`apple-pi kanban show: card not found: ${id}`);
			return 1;
		}
		// forward deps (depends_on) from kb_deps
		const depRows = db.prepare("SELECT to_id FROM kb_deps WHERE from_id = ? ORDER BY to_id").all(id);
		const deps = depRows.map(r => r.to_id);
		let tags = [];
		try { const parsed = JSON.parse(row.tags_json); if (Array.isArray(parsed)) tags = parsed; } catch (_) {}
		if (json) {
			process.stdout.write(JSON.stringify({ ...row, tags, deps }, null, 2) + "\n");
			return 0;
		}
		const p = row.priority == null ? "-" : String(row.priority);
		console.log(`apple-pi kanban show ${id}`);
		console.log(`  id       : ${row.id}`);
		console.log(`  title    : ${row.title}`);
		console.log(`  status   : ${row.status}`);
		console.log(`  priority : ${p}`);
		console.log(`  project  : ${row.project ?? "-"}`);
		console.log(`  assignee : ${row.assignee ?? "-"}`);
		console.log(`  parent   : ${row.parent ?? "-"}`);
		console.log(`  tags     : [${tags.join(", ")}]`);
		console.log(`  deps     : [${deps.join(", ")}]`);
		console.log(`  file     : ${row.file_path}`);
		console.log(`  updated  : ${row.updated_at ?? "-"}`);
		console.log("  ---");
		console.log(row.body.trimEnd());
		return 0;
	} finally {
		db.close();
	}
}

// nextCmd(args) -> exit code. WIP-aware (M0-2) + ready (M3-2). ready() yields
// todo cards whose deps are all done; among those, the highest-priority is the
// recommendation. At/over the KANBAN_WIP limit a ready card is HELD (reported,
// not recommended) so the operator finishes an in_progress card first.
function nextCmd(args) {
	const opts = parseOpts(args);
	const json = !!opts.bools["--json"];
	const root = resolveRoot(opts);

	const db = open();
	try {
		ensureCurrent(db, root);
		const readyIds = ready(db);
		const limit = wipLimit();
		const wipRows = db.prepare(
			"SELECT id, title FROM kb_cards WHERE status = 'in_progress' ORDER BY id",
		).all();
		const wipCount = wipRows.length;
		const atLimit = wipCount >= limit;

		// Among ready ids, pick the highest-priority (priority DESC NULLS LAST,
		// id ASC) — the natural "what should I do next" ordering.
		let pick = null;
		if (readyIds.length) {
			const placeholders = readyIds.map(() => "?").join(",");
			pick = db.prepare(
				`SELECT id, title, priority, file_path FROM kb_cards
				 WHERE id IN (${placeholders})
				 ORDER BY priority DESC NULLS LAST, id ASC LIMIT 1`,
			).get(...readyIds);
		}

		const out = {
			wip: { count: wipCount, limit, atLimit },
			ready: readyIds.slice().sort(),
			inProgress: wipRows.map(r => r.id),
			next: (!atLimit && pick) ? pick.id : null,
			held: atLimit && !!pick,
			heldId: (atLimit && pick) ? pick.id : null,
		};
		if (json) {
			process.stdout.write(JSON.stringify(out, null, 2) + "\n");
			return 0;
		}

		console.log("apple-pi kanban next");
		console.log(`  wip  : ${wipCount}/${limit}`);
		if (atLimit) console.log("  at wip limit — finish an in_progress card before starting a new one");
		if (pick) {
			const pStr = pick.priority == null ? "-" : pick.priority;
			const label = atLimit ? "held" : "next";
			console.log(`  ${label} : ${pick.id}  ${pick.title}  p=${pStr}  ${pick.file_path}`);
		} else {
			console.log("  ready: (none)");
		}
		if (atLimit) {
			console.log("  in_progress:");
			for (const r of wipRows) console.log(`    ${r.id}  ${r.title}`);
		}
		return 0;
	} finally {
		db.close();
	}
}

// graphCmd(args) -> exit code. Edges (depends_on, forward) + ready set + cycles.
function graphCmd(args) {
	const opts = parseOpts(args);
	const json = !!opts.bools["--json"];
	const root = resolveRoot(opts);

	const db = open();
	try {
		ensureCurrent(db, root);
		const e = edges(db);
		const readyIds = ready(db).slice().sort();
		const cycles = detectCycles(db);
		if (json) {
			const nodes = db.prepare("SELECT id, status, priority FROM kb_cards ORDER BY id")
				.all().map(r => ({ id: r.id, status: r.status, priority: r.priority }));
			process.stdout.write(JSON.stringify({ nodes, edges: e, ready: readyIds, cycles }, null, 2) + "\n");
			return 0;
		}
		console.log("apple-pi kanban graph");
		console.log(`  edges: ${e.length}`);
		for (const ed of e) console.log(`    ${ed.from} -> ${ed.to}`);
		console.log(`  ready: ${readyIds.length ? readyIds.join(", ") : "(none)"}`);
		console.log(`  cycles: ${cycles.length ? cycles.length : "(none)"}`);
		for (const c of cycles) console.log(`    ${c.join(" -> ")}`);
		return 0;
	} finally {
		db.close();
	}
}

// newCmd(args) -> exit code. Wraps M2-5 createCard: writes a new .card.md
// at <root>/<dir>/<id>.card.md (dir defaults to "cards"), validates it (M1-3
// primitive), and reconciles the mirror so `show`/`list` see it immediately.
//
// RED-BLUE: every reject path (bad slug, bogus status, path-escaping --dir,
// duplicate id) comes back from createCard as { ok:false } with NO file write —
// resolveUnderRoot + the exists() check are the safety net; the CLI only
// surfaces the errors to stderr + a non-zero exit. --dir is contained by
// resolveUnderRoot, so the writer never escapes root.
function newCmd(args) {
	const opts = parseOpts(args);
	const json = !!opts.bools["--json"];
	const root = resolveRoot(opts);
	const id = opts.positionals[0];
	const dir = opts.values["--dir"] || "cards";

	if (!id) {
		console.error("apple-pi kanban new: missing <id> (try 'apple-pi kanban help')");
		return 2;
	}

	// Assemble the card spec from flags. createCard stamps created_at +
	// updated_at, defaults status to triage, and validates the frontmatter;
	// we only forward what the caller actually passed.
	const card = { id, parent: opts.values["--parent"] ?? "root" };
	if (opts.values["--title"] !== undefined) card.title = opts.values["--title"];
	if (opts.values["--status"] !== undefined) card.status = opts.values["--status"];
	if (opts.values["--priority"] !== undefined) card.priority = parsePriorityInt(opts.values["--priority"]);
	if (opts.values["--project"] !== undefined) card.project = opts.values["--project"];
	if (opts.values["--assignee"] !== undefined) card.assignee = opts.values["--assignee"];
	const tags = opts.multi["--tag"] || [];
	if (tags.length) card.tags = tags;
	const deps = opts.multi["--dep"] || [];
	if (deps.length) card.depends_on = deps;
	if (opts.values["--body"] !== undefined) card.body = opts.values["--body"];

	const { createCard } = require("./kb/write");
	const res = createCard({ root, dir, card });
	if (!res.ok) {
		for (const e of res.errors) console.error(`apple-pi kanban new: ${e}`);
		return 1;
	}
	const file = res.file;

	// validate the freshly-written card (the M1-3 primitive M8-5 will wrap).
	// createCard already ran validateCard internally, so a failure here is a
	// bug we want surfaced loudly, not a silently-bad card on disk.
	const { validateCardFile } = require("./kb/validate");
	const v = validateCardFile(file);
	if (!v.ok) {
		for (const e of v.errors) console.error(`apple-pi kanban new: ${e}`);
		return 1;
	}

	// reconcile so the next read sees the new card without a manual index.
	const db = open();
	try { ensureCurrent(db, root); } finally { db.close(); }

	const rel = path.relative(root, file);
	const title = card.title ?? id;
	const status = card.status ?? "triage";
	if (json) {
		process.stdout.write(JSON.stringify({ ok: true, id, title, status, file: rel }, null, 2) + "\n");
		return 0;
	}
	console.log("apple-pi kanban new");
	console.log(`  id     : ${id}`);
	console.log(`  title  : ${title}`);
	console.log(`  status : ${status}`);
	console.log(`  file   : ${rel}`);
	return 0;
}

// moveCmd(args) -> exit code. Wraps M2-5 moveStatus: transitions a card's
// status, preserving every other byte (the on-disk diff is EXACTLY status +
// updated_at — 2 lines).
//
// RED-BLUE: the id is resolved ONLY from kb_cards (after a lazy ensureCurrent),
// so the caller cannot steer the writer at an arbitrary file — the file_path
// came from findCards (under-root by construction). moveStatus then re-runs
// resolveUnderRoot (path safety) + legalTransition (status rules); any reject
// returns { ok:false } with NO file write, surfaced here as exit 1. The CLI
// accepts no path argument: `<id> <to-status>` only.
function moveCmd(args) {
	const opts = parseOpts(args);
	const json = !!opts.bools["--json"];
	const root = resolveRoot(opts);
	const id = opts.positionals[0];
	const to = opts.positionals[1];

	if (!id) {
		console.error("apple-pi kanban move: missing <id> <to-status> (try 'apple-pi kanban help')");
		return 2;
	}
	if (!to) {
		console.error("apple-pi kanban move: missing <to-status> (try 'apple-pi kanban help')");
		return 2;
	}

	// resolve id -> file via the mirror (lazy reconcile first). The mirror only
	// holds under-root cards, so this lookup cannot escape root.
	let fileAbs = null;
	let fromStatus = null;
	const db = open();
	try {
		ensureCurrent(db, root);
		const row = db.prepare("SELECT file_path, status FROM kb_cards WHERE id = ?").get(id);
		if (!row) {
			console.error(`apple-pi kanban move: no card with id '${id}'`);
			return 1;
		}
		fileAbs = row.file_path;
		fromStatus = row.status;
	} finally {
		db.close();
	}

	const fileRel = path.relative(root, fileAbs);
	const { moveStatus } = require("./kb/write");
	const res = moveStatus({ root, file: fileRel, to });
	if (!res.ok) {
		for (const e of res.errors) console.error(`apple-pi kanban move: ${e}`);
		return 1;
	}

	// reindex so the mirror reflects the new status for the next read.
	const db2 = open();
	try { ensureCurrent(db2, root); } finally { db2.close(); }

	if (json) {
		process.stdout.write(JSON.stringify({ ok: true, id, from: fromStatus, to, file: fileRel }, null, 2) + "\n");
		return 0;
	}
	console.log("apple-pi kanban move");
	console.log(`  id     : ${id}`);
	console.log(`  ${fromStatus} -> ${to}`);
	console.log(`  file   : ${fileRel}`);
	return 0;
}

// --- small render helpers ------------------------------------------------
function pad(s, n) {
	const str = s == null ? "" : String(s);
	return str.length >= n ? str : str + " ".repeat(n - str.length);
}

function formatFilterLine(filters) {
	const parts = [];
	if (filters.status) parts.push(`--status ${filters.status}`);
	if (filters.project) parts.push(`--project ${filters.project}`);
	if (filters.parent) parts.push(`--parent ${filters.parent}`);
	if (filters.assignee !== undefined) parts.push(`--assignee ${filters.assignee === null ? "null" : filters.assignee}`);
	if (filters.tag) {
		const t = Array.isArray(filters.tag) ? filters.tag : [filters.tag];
		for (const x of t) parts.push(`--tag ${x}`);
	}
	if (filters.priority) {
		if (typeof filters.priority === "number") parts.push(`--priority ${filters.priority}`);
		else parts.push(`--priority-min ${filters.priority.min ?? ""} --priority-max ${filters.priority.max ?? ""}`);
	}
	return parts.length ? " " + parts.join(" ") : "";
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
		case "list":
			return listCmd(rest);
		case "show":
			return showCmd(rest);
		case "next":
			return nextCmd(rest);
		case "graph":
			return graphCmd(rest);
		case "new":
			return newCmd(rest);
		case "move":
			return moveCmd(rest);
		default:
			console.error(`apple-pi kanban: unknown subcommand '${sub}' (try 'apple-pi kanban help')`);
			return 2;
	}
}

module.exports = {
	run, indexCmd, listCmd, showCmd, nextCmd, graphCmd, newCmd, moveCmd,
	// exported for tests; not part of the public API
	parseOpts, buildFilters, resolveRoot,
};
