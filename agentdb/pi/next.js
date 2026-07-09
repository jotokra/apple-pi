// agentdb/pi/next.js — pi agent tools kanban_next / kanban_graph (M9-3).
//
// ROADMAP M9-3 (SUPERPROMPT §6 module map): the testable JS core of the pi
// agent tools that replace kanban-bridge.ts — the SCHEDULING side.
//
//   kanban_next(options?) -> { ok, wip, ready, inProgress, next, held, heldId }
//     WIP-aware + ready-aware recommendation. Computes the WIP state (count of
//     in_progress cards vs the KANBAN_WIP limit — M0-2 / D5 default 3) and the
//     ready set (todo cards whose depends_on are all done — M3-2). Among the
//     ready cards it picks the highest-priority (priority DESC NULLS LAST, id
//     ASC) as `next` — BUT only when UNDER the WIP limit. At/over the limit the
//     pick is HELD: reported via held/heldId, NOT recommended as next, so the
//     operator finishes an in_progress card first. This is the exact M8-2 CLI
//     `kanban next` contract (agentdb/cli.js nextCmd), surfaced as a tool.
//
//   kanban_graph(options?) -> { ok, ready, blockedBy }
//     the agent-actionable projection: the ready set + blockedBy, a map of
//     each card to the EXISTING depends_on deps that are not yet done (the
//     "why can't I start X" answer). MIRRORs ready()'s rule that a MISSING dep
//     card (no kb_cards row) is non-blocking — dangling deps never appear in
//     blockedBy (being absent is not the same as being undone). A card with no
//     unmet deps has no entry in blockedBy (a ready card has no blockers).
//
// BOTH tools run in two modes (mirrors pi/list.js):
//   (a) injected `db` (options.db) — used by tests + composition; the caller
//       owns the connection and its freshness, so NO open/close and NO
//       ensureCurrent reconcile runs. This keeps unit tests hermetic.
//   (b) no injected db — the real "pi harness" path: open() the unified
//       agent.db, run ensureCurrent() (lazy reconcile — the read path is
//       correct with no manual index, M2-4), then close in a finally.
//
// Best-effort, no-throw (mirrors kb/graph.js + pi/list.js): the SQL this layer
// fires (the WIP count + the priority pick) is wrapped so a prepare/exec error
// returns { ok:false, error } rather than throwing. The kb/graph primitives it
// composes (ready / edges / statusMap) are themselves no-throw. Bad input (a
// non-object options) is tolerated by the destructuring default.
//
// RED-BLUE: this layer adds ONE user-shaped value to SQL — the priority pick's
// IN (...) list, populated from `ready(db)` (ids read from kb_cards, NOT from
// the caller). Every id there is a bound ? parameter; nothing is concatenated.
// The only caller-supplied value reaching the engine is the AGENT_DB path
// (lib/db.open), which is process-controlled, not tool-argument-controlled. So
// the injection surface is exactly M3-1's surface — no new string-concatenation
// is introduced here.

"use strict";

const { open } = require("../lib/db");
const { ensureCurrent } = require("../kb");
const { ready, edges, statusMap } = require("../kb/graph"); // M3-2 graph primitives
const { wipLimit } = require("../kb/status");               // M0-2 WIP limit

// runNext(db) — the WIP+ready-aware recommendation, computed on an open db.
// Best-effort: SQL it fires is wrapped; kb/graph primitives are no-throw.
function runNext(db) {
	const limit = wipLimit();

	// WIP state — count + ids of in_progress cards (ORDER BY id for stable JSON).
	let inProgress = [];
	let wipCount = 0;
	try {
		const wipRows = db.prepare(
			"SELECT id FROM kb_cards WHERE status = 'in_progress' ORDER BY id",
		).all();
		inProgress = wipRows.map(r => r.id);
		wipCount = inProgress.length;
	} catch (e) {
		return { ok: false, error: `kanban_next: WIP query failed (${e.message})` };
	}
	const atLimit = wipCount >= limit;

	// ready set (M3-2): todo cards whose depends_on are all done (or absent).
	// Sorted for deterministic JSON.
	const readyIds = ready(db).slice().sort();

	// Among ready ids, pick the highest-priority (priority DESC NULLS LAST,
	// id ASC) — the natural "what should I do next" ordering. The IN-list is
	// populated from kb_cards ids (NOT caller input); all bound as parameters.
	let pick = null;
	if (readyIds.length) {
		try {
			const placeholders = readyIds.map(() => "?").join(",");
			pick = db.prepare(
				`SELECT id FROM kb_cards
				 WHERE id IN (${placeholders})
				 ORDER BY priority DESC NULLS LAST, id ASC LIMIT 1`,
			).get(...readyIds);
		} catch (e) {
			return { ok: false, error: `kanban_next: pick query failed (${e.message})` };
		}
	}

	return {
		ok: true,
		wip: { count: wipCount, limit, atLimit },
		ready: readyIds,
		inProgress,
		// the recommendation: a ready pick exists AND we are under the WIP limit.
		// at/over the limit the pick is HELD (held/heldId surface it) — not next.
		next: (!atLimit && pick) ? pick.id : null,
		held: atLimit && !!pick,
		heldId: (atLimit && pick) ? pick.id : null,
	};
}

// runGraph(db) — the ready + blockedBy projection, computed on an open db.
// Pure composition of M3-2 no-throw primitives; never throws.
function runGraph(db) {
	const readyIds = ready(db).slice().sort();
	const status = statusMap(db); // { [id]: status } — absent = not indexed

	// forward edges grouped by from: { [from_id]: [to_id, ...] }
	const fwd = {};
	for (const e of edges(db)) {
		if (!fwd[e.from]) fwd[e.from] = [];
		fwd[e.from].push(e.to);
	}

	// blockedBy: for each card, its EXISTING forward deps that are not 'done'.
	// Missing deps (no kb_cards row) are non-blocking — mirrors ready()'s rule.
	const blockedBy = {};
	for (const id of Object.keys(status)) {
		const deps = fwd[id] || [];
		const blockers = deps
			.filter(d => status[d] !== undefined && status[d] !== "done")
			.slice().sort();
		if (blockers.length > 0) blockedBy[id] = blockers;
	}

	return { ok: true, ready: readyIds, blockedBy };
}

// kanban_next(options?) -> { ok, wip, ready, inProgress, next, held, heldId }
//   options.db   : inject an open DatabaseSync (skips open/close + reconcile)
//   options.root : root for ensureCurrent (default process.cwd())
function kanban_next({ db: injectedDb, root = process.cwd() } = {}) {
	if (injectedDb) return runNext(injectedDb);
	const db = open();
	try {
		ensureCurrent(db, root); // lazy reconcile — correct with no manual index
		return runNext(db);
	} finally {
		db.close();
	}
}

// kanban_graph(options?) -> { ok, ready, blockedBy }
//   options.db   : inject an open DatabaseSync (skips open/close + reconcile)
//   options.root : root for ensureCurrent (default process.cwd())
function kanban_graph({ db: injectedDb, root = process.cwd() } = {}) {
	if (injectedDb) return runGraph(injectedDb);
	const db = open();
	try {
		ensureCurrent(db, root);
		return runGraph(db);
	} finally {
		db.close();
	}
}

module.exports = { kanban_next, kanban_graph };
