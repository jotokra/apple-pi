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
// cards). M1-2 widens this to a workspace-wide inventory — findCardsWorkspace
// walks <parent>/*/.kanban/cards/ (+ process.env.KANBAN_ROOTS extras) and keeps
// findCards as the pure local primitive it composes. Hand-rolled, zero deps
// (D3) — mirrors the rest of agentdb/kb.
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

// findCardsWorkspace(parents) -> string[] — workspace-wide card inventory.
// For each dir in `parents`, discovers immediate-child project dirs and scans
// `<child>/.kanban/cards/` for *.card.md (the SUPERPROMPT §5.1 layout:
// Projects/<proj>/.kanban/cards/*.card.md). Augmented by
// process.env.KANBAN_ROOTS — path.delimiter-separated extra PROJECT dirs scanned
// the same way — so a caller can pull in projects that live outside the passed
// parents. Every source's hits are concatenated, then deduped by absolute path
// and sorted; the dedup matters because a KANBAN_ROOTS entry can name a project
// the parent glob already reached. Missing/unreadable parents and missing
// `.kanban/cards/` dirs contribute nothing (best-effort, like findCards).
// `parents` defaults to [] — the agent layer wires ~/Projects at the call site,
// keeping this primitive pure + testable. Zero deps (D3).
function findCardsWorkspace(parents = []) {
	const cards = [];
	// (a) each parent: glob immediate-child project dirs, scan their cards/
	for (const parent of parents) {
		const abs = path.resolve(parent);
		let entries;
		try {
			entries = fs.readdirSync(abs, { withFileTypes: true });
		} catch {
			continue; // missing/unreadable parent -> nothing to discover here
		}
		for (const ent of entries) {
			if (!ent.isDirectory()) continue;
			for (const card of findCards(path.join(abs, ent.name, ".kanban", "cards"))) {
				cards.push(card);
			}
		}
	}
	// (b) KANBAN_ROOTS extras: explicit project dirs, scanned the same way
	const extras = process.env.KANBAN_ROOTS;
	if (extras) {
		for (const raw of extras.split(path.delimiter)) {
			const dir = raw.trim();
			if (!dir) continue;
			for (const card of findCards(path.join(path.resolve(dir), ".kanban", "cards"))) {
				cards.push(card);
			}
		}
	}
	// (c) dedupe by absolute path + sort
	return [...new Set(cards)].sort();
}

module.exports = { findCards, findCardsWorkspace, PRUNE };
