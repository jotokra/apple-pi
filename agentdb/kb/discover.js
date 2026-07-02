// agentdb/kb/discover.js — card discovery: which *.card.md files live where.
//
// LAYOUT (the workspace convention we discover against — SUPERPROMPT §5.1):
//   Projects/<proj>/.kanban/
//     ├─ roadmap.md            ← parent board (status, dep graph, per-card summary)
//     ├─ cards/*.card.md       ← one file per card; filename (minus .card.md) = card id
//     └─ topics/<slug>.md      ← optional deep-dive design notes
//
// M0-3 ships the local walker: findCards(root) returns every *.card.md under
// `root`, sorted + absolute, descending into subdirs but pruning
// node_modules / .git / .index (build caches + VCS that must never index as
// cards). M1-2 widens this to a workspace-wide inventory (~/Projects/*/.kanban
//  + KANBAN_ROOTS), so callers should keep this primitive pure + local.
// Hand-rolled, zero deps (D3) — mirrors the rest of agentdb/kb.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Directory/file basenames we never descend into. Matched by basename so it
// works at any depth and tolerates a worktree-style `.git` file (this repo's
// own `.git` is a file, not a dir).
const PRUNE = new Set(["node_modules", ".git", ".index"]);

// findCards(root) -> string[] — sorted, absolute *.card.md paths under root.
// A missing/unreadable root yields [] (discover is best-effort: a transiently
// absent dir must not crash a caller mid-walk).
function findCards(root) {
	const out = [];
	walk(path.resolve(root), out);
	out.sort();
	return out;
}

function walk(dir, out) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return; // missing/unreadable dir -> nothing to discover here
	}
	for (const ent of entries) {
		if (PRUNE.has(ent.name)) continue;
		const full = path.join(dir, ent.name);
		if (ent.isDirectory()) walk(full, out);
		else if (ent.isFile() && ent.name.endsWith(".card.md")) out.push(full);
	}
}

module.exports = { findCards, PRUNE };
