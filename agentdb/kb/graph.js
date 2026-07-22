// agentdb/kb/graph.js — Tier-A dependency graph (M3-2).
//
// ROADMAP M3-2: (1) edges(db) -> [{from,to}], (2) ready(db) -> ids whose
// status is 'todo' AND all depends_on ids are 'done' (or absent),
// (3) detectCycles(db) -> string[] of cycle-paths (e.g. ['A','B','C','A']) —
// REPORT, never throw; (4) blockedBy(id, db) -> ids that block this card
// (reverse edge lookup); (5) blocks(id, db) -> ids this card blocks
// (forward edges). Pure functions, no I/O outside the db argument.
//
// Data source: kb_deps (from_id, to_id) — forward direction only; the
// "blocks" direction is derived (D6). STATUS is read from kb_cards (a card
// is "done" iff its status column == 'done'; absent cards with no row in
// kb_cards are treated as "not yet indexed" and treated as a non-blocker
// for ready() purposes — being absent is not the same as being undone).
//
// RED-BLUE CONTRACT: detectCycles MUST report, not throw — a corrupt kb
// (a user-created cycle in depends_on) is a real-world possibility and
// crashing the caller hides the symptom. Similarly, ready() / blockedBy()
// / blocks() must never throw on a malformed graph; they return [].
"use strict";

// edges(db) -> [{ from, to }] — every forward edge in kb_deps, in insertion
// order. Returns a fresh array of plain objects (caller may mutate).
// Each row is normalized to a plain { from, to } object — node:sqlite
// returns null-prototype objects which are ===-incompatible with our tests'
// expected literals.
function edges(db) {
	try {
		const rows = db.prepare("SELECT from_id, to_id FROM kb_deps").all();
		return rows.map(r => ({ from: r.from_id, to: r.to_id }));
	} catch (_) {
		return [];
	}
}

// statusMap(db) -> { [id]: status_string }
// Reads the status column for every card in kb_cards. Absent cards get no
// entry (the consumer treats absence as "not yet indexed" — different from
// "in some other status").
function statusMap(db) {
	try {
		const rows = db.prepare("SELECT id, status FROM kb_cards").all();
		const out = {};
		for (const r of rows) out[r.id] = r.status;
		return out;
	} catch (_) {
		return {};
	}
}

// blockedBy(id, db) -> [id] — ids whose forward edges point AT id
// (i.e. cards that depend on id and would block id from being 'done' first).
// Reverse lookup via the SELECT … WHERE to_id = ? form.
function blockedBy(id, db) {
	try {
		const rows = db.prepare("SELECT from_id FROM kb_deps WHERE to_id = ?").all(id);
		return rows.map(r => r.from_id);
	} catch (_) {
		return [];
	}
}

// blocks(id, db) -> [id] — ids that id depends on (forward edges).
function blocks(id, db) {
	try {
		const rows = db.prepare("SELECT to_id FROM kb_deps WHERE from_id = ?").all(id);
		return rows.map(r => r.to_id);
	} catch (_) {
		return [];
	}
}

// ready(db) -> [id] — ids whose status is 'todo' AND all depends_on ids are
// 'done' (or absent from the kb). Cards in any other status (in_progress,
// review, blocked, etc.) are NOT ready. Absent deps (the dep card has no
// row in kb_cards yet) are treated as "not blocking" — a missing dep is
// better than an undone dep. Same goes for deps whose status is *anything
// other than* 'done': in_progress / review / blocked / triage / backlog /
// etc. all block.
//
// Important: ready() considers EVERY 'todo' card in kb_cards, including
// those with no outgoing edges in kb_deps. A card with no depends_on is
// trivially ready (its deps list is empty). The iteration is driven by
// kb_cards (the universe of cards), not by kb_deps (the universe of edges).
function ready(db) {
	const status = statusMap(db);
	if (Object.keys(status).length === 0) return [];

	// Build forward-edge list grouped by from_id: { [from]: [to, ...] }
	const fwd = {};
	try {
		const rows = db.prepare("SELECT from_id, to_id FROM kb_deps").all();
		for (const r of rows) {
			if (!fwd[r.from_id]) fwd[r.from_id] = [];
			fwd[r.from_id].push(r.to_id);
		}
	} catch (_) { /* malformed graph → no deps; ready = every todo */ }

	const out = [];
	for (const id of Object.keys(status)) {
		if (status[id] !== "todo") continue; // only todo is ready
		const deps = fwd[id] || [];
		// Every dep must be either (a) absent from kb_cards entirely OR
		// (b) status === 'done'. Anything else (in_progress, review,
		// blocked, etc.) is a blocker.
		const allDone = deps.every(toId => status[toId] === undefined || status[toId] === "done");
		if (allDone) out.push(id);
	}
	// Stable sort by id for deterministic output (callers render lists).
	out.sort();
	return out;
}

// detectCycles(db) -> [[id, id, …, id], …]
// Returns each cycle as an array of ids starting and ending with the same
// id (e.g. ['A','B','C','A']). An empty array means the graph is a DAG.
// Self-loops (A→A) appear as ['A','A']. Two-cycles (A↔B) appear as both
// ['A','B','A'] and ['B','A','B'] — we de-duplicate by canonicalizing on
// the lexicographically smallest rotation.
//
// Algorithm: classic DFS coloring. WHITE = unvisited, GRAY = on current
// path (a back-edge to GRAY = cycle), BLACK = fully explored. Each GRAY→GRAY
// edge produces one cycle path.
//
// RED-BLUE: the function never throws. A malformed graph (a row in kb_deps
// referring to a non-existent id, etc.) is silently ignored — the consumer
// treats it as "this edge has nothing on the other end" and continues.
function detectCycles(db) {
	const all = edges(db);
	// Adjacency map for forward traversal.
	const adj = {};
	for (const e of all) {
		if (!adj[e.from]) adj[e.from] = [];
		adj[e.from].push(e.to);
	}

	const WHITE = 0, GRAY = 1, BLACK = 2;
	const color = {};
	const cycles = []; // each entry: [start, ..., back-to-start]

	function dfs(node, path) {
		color[node] = GRAY;
		path.push(node);
		const neighbours = adj[node] || [];
		for (const next of neighbours) {
			const c = color[next];
			if (c === undefined) {
				dfs(next, path);
			} else if (c === GRAY) {
				// Back-edge: extract the cycle from `path`
				const idx = path.indexOf(next);
				if (idx !== -1) {
					const cycle = path.slice(idx).concat(next);
					cycles.push(cycle);
				}
			}
			// BLACK: already fully explored; ignore (no cycle through it on this path)
		}
		path.pop();
		color[node] = BLACK;
	}

	for (const node of Object.keys(adj)) {
		if (color[node] === undefined) dfs(node, []);
	}

	// De-duplicate cycles by canonical rotation (smallest id first).
	const seen = new Set();
	const unique = [];
	for (const c of cycles) {
		// Rotate so the smallest id is first.
		let minIdx = 0;
		for (let i = 1; i < c.length - 1; i++) { // c.length-1 to skip the trailing duplicate
			if (c[i] < c[minIdx]) minIdx = i;
		}
		const rotated = c.slice(minIdx, c.length - 1).concat(c.slice(0, minIdx), c[minIdx]);
		const key = rotated.join("→");
		if (!seen.has(key)) {
			seen.add(key);
			unique.push(rotated);
		}
	}
	return unique;
}

module.exports = {
	edges,
	ready,
	detectCycles,
	blockedBy,
	blocks,
	// Exported for tests; not part of the public API.
	statusMap,
};