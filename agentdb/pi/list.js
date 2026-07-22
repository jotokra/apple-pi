// agentdb/pi/list.js — pi agent tools kanban_list / kanban_get (M9-1).
//
// ROADMAP M9-1 (SUPERPROMPT §6 module map): the testable JS core of the pi
// agent tools that replace kanban-bridge.ts. These two are the READ side —
// thin wrappers over the kb_* mirror:
//
//   kanban_list(filters?, opts?)  -> { ok, rows } | { ok:false, errors }
//     delegates to M3-1 kb/query.list() — returns the list-view row shape
//     ({id,title,status,priority,project,assignee,parent,tags,file_path,
//     updated_at}); tags parsed; NO body (callers that need the body use
//     kanban_get).
//
//   kanban_get(id)                -> { ok, card } | { ok:false, error }
//     the per-card fetch — SELECT by id INCLUDING body + forward deps +
//     parsed tags + parsed frontmatter (clean nested JSON; the *_json column
//     names are dropped from the output).
//
// BOTH tools run in two modes:
//   (a) injected `db` (options.db) — used by tests + composition; the caller
//       owns the connection and its freshness, so NO open/close and NO
//       ensureCurrent reconcile runs. This keeps unit tests hermetic.
//   (b) no injected db — the real "pi harness" path: open() the unified
//       agent.db, run ensureCurrent() (lazy reconcile — the read path is
//       correct with no manual index, M2-4), then close in a finally.
//
// Best-effort, no-throw (mirrors kb/query.js): bad input or a missing card
// returns { ok:false, ... } rather than throwing. The pi extension
// (config/extensions/kanban.ts, M9-6) is a thin binding over these.
//
// RED-BLUE: this layer adds NO SQL of its own except a single fixed-string
// SELECT (kanban_get) with a bound id; all filtering goes through M3-1's
// bind-layer defense. So the injection surface is exactly M3-1's surface —
// no new string-concatenation is introduced here.

"use strict";

const { open } = require("../lib/db");
const { ensureCurrent } = require("../kb");
const { list } = require("../kb/query");

// kanban_list(options?) -> { ok, rows } | { ok:false, errors }
//   options.db      : inject an open DatabaseSync (skips open/close + reconcile)
//   options.filters : forwarded to kb/query.list() — {status,project,assignee,
//                     tag,priority,parent}; unknown keys silently ignored
//   options.opts    : forwarded to kb/query.list() — {limit,orderBy,orderDir}
//   options.root    : root for ensureCurrent (default process.cwd())
function kanban_list({ db: injectedDb, filters, opts, root = process.cwd() } = {}) {
	if (injectedDb) {
		// caller owns the connection + freshness — pure delegation
		return list(injectedDb, filters || {}, opts || {});
	}
	const db = open();
	try {
		ensureCurrent(db, root); // lazy reconcile — correct with no manual index
		return list(db, filters || {}, opts || {});
	} finally {
		db.close();
	}
}

// kanban_get(id, options?) -> { ok, card } | { ok:false, error }
//   id              : card slug (non-empty string); anything else is rejected
//                     before SQL is fired
//   options.db      : inject an open DatabaseSync (skips open/close + reconcile)
//   options.root    : root for ensureCurrent (default process.cwd())
//
// Returns the full card row + parsed `tags` (array), `deps` (array of forward
// dependency ids), and `frontmatter` (parsed object). The raw tags_json /
// frontmatter_json column names are dropped from the output for clean JSON.
function kanban_get(id, { db: injectedDb, root = process.cwd() } = {}) {
	if (typeof id !== "string" || id.length === 0) {
		return { ok: false, error: "kanban_get: id must be a non-empty string" };
	}

	const fetch = (db) => {
		// Fixed SQL string + bound id — no user input is concatenated. The only
		// value reaching the engine is `id` as a bind parameter.
		const row = db.prepare(
			"SELECT id, title, status, priority, project, assignee, parent, " +
			"tags_json, file_path, frontmatter_json, body, updated_at, file_hash " +
			"FROM kb_cards WHERE id = ?",
		).get(id);
		if (!row) return { ok: false, error: `kanban_get: card not found: ${id}` };

		// forward deps (depends_on) from kb_deps — ORDER BY for stable JSON
		const depRows = db.prepare(
			"SELECT to_id FROM kb_deps WHERE from_id = ? ORDER BY to_id",
		).all(id);
		const deps = depRows.map(r => r.to_id);

		// parse tags_json -> array (best-effort; malformed -> [])
		let tags = [];
		try {
			const parsed = JSON.parse(row.tags_json);
			if (Array.isArray(parsed)) tags = parsed;
		} catch (_) { /* keep [] */ }

		// parse frontmatter_json -> object (best-effort; malformed -> null)
		let frontmatter = null;
		try { frontmatter = JSON.parse(row.frontmatter_json); } catch (_) { /* keep null */ }

		// drop the raw *_json columns; expose parsed nested fields instead
		const { tags_json, frontmatter_json, ...rest } = row;
		return { ok: true, card: { ...rest, tags, deps, frontmatter } };
	};

	if (injectedDb) return fetch(injectedDb);
	const db = open();
	try {
		ensureCurrent(db, root);
		return fetch(db);
	} finally {
		db.close();
	}
}

module.exports = { kanban_list, kanban_get };
