// agentdb/kb/discover.test.js — REQ-M0-3
// findCards(root) -> sorted, absolute *.card.md paths under root, ignoring
// node_modules / .git / .index (build caches + VCS that must never index as
// cards).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { findCards, findCardsWorkspace } = require("./discover");

// build a throwaway tree under a fresh tmpdir
function makeTree(root, layout) {
	for (const e of layout) {
		const p = path.join(root, e.path);
		if (e.type === "dir") fs.mkdirSync(p, { recursive: true });
		else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, e.content ?? "", "utf8"); }
	}
}

test("findCards discovers every .card.md under a fixture tree (REQ-M0-3)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "discover-"));
	makeTree(root, [
		{ type: "file", path: "a.card.md", content: "x" },
		{ type: "file", path: "cards/b.card.md", content: "x" },
		{ type: "file", path: "deep/nested/c.card.md", content: "x" },
		// non-card files are ignored (roadmap.md, notes, etc.)
		{ type: "file", path: "roadmap.md", content: "x" },
		{ type: "file", path: "topics/design.md", content: "x" },
		{ type: "file", path: "notes.txt", content: "x" },
		// ignored dirs never descend, even if they hold .card.md
		{ type: "dir", path: "node_modules/lib" },
		{ type: "file", path: "node_modules/lib/x.card.md", content: "x" },
		{ type: "dir", path: ".git/objects" },
		{ type: "file", path: ".git/y.card.md", content: "x" },
		{ type: "dir", path: "proj/.kanban/.index" },
		{ type: "file", path: "proj/.kanban/.index/z.card.md", content: "x" },
	]);
	const got = findCards(root);
	const expected = ["a.card.md", "cards/b.card.md", "deep/nested/c.card.md"]
		.map(rel => path.resolve(root, rel)).sort();
	assert.deepEqual(got, expected);
});

test("ignores node_modules / .git / .index at any depth (REQ-M0-3)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "discover-ignore-"));
	makeTree(root, [
		{ type: "file", path: "keep.card.md", content: "x" },
		{ type: "dir", path: "a/node_modules" },
		{ type: "file", path: "a/node_modules/nm.card.md", content: "x" },
		{ type: "dir", path: "a/b/.git" },
		{ type: "file", path: "a/b/.git/git.card.md", content: "x" },
		{ type: "dir", path: "a/b/.index" },
		{ type: "file", path: "a/b/.index/idx.card.md", content: "x" },
	]);
	const got = findCards(root);
	assert.deepEqual(got, [path.resolve(root, "keep.card.md")]);
});

test("returns sorted absolute paths", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "discover-sort-"));
	makeTree(root, [
		{ type: "file", path: "zebra.card.md" },
		{ type: "file", path: "alpha.card.md" },
		{ type: "file", path: "mid/delta.card.md" },
	]);
	const got = findCards(root);
	assert.deepEqual(got, [...got].sort(), "result is not sorted");
	assert.ok(got.every(p => path.isAbsolute(p)), "result contains non-absolute paths");
});

test("finds the repo's own fixtures (real layout)", () => {
	const got = findCards("agentdb/test/fixtures");
	assert.deepEqual(
		got.map(p => path.basename(p)).sort(),
		["bad-status.card.md", "good.card.md"],
	);
});

test("returns [] for a missing root (graceful, no throw)", () => {
	const got = findCards(path.join(os.tmpdir(), "discover-definitely-not-here-xyz"));
	assert.deepEqual(got, []);
});

// --- M1-2: workspace-wide discovery ----------------------------------------
// findCardsWorkspace(parents) walks <parent>/*/.kanban/cards/ (the §5.1 layout)
// + process.env.KANBAN_ROOTS extras, dedupes by absolute path, sorts.

// run `fn` with KANBAN_ROOTS set to `val`, restoring the prior env after.
function withKanbanRoots(val, fn) {
	const prev = process.env.KANBAN_ROOTS;
	process.env.KANBAN_ROOTS = val;
	try { return fn(); }
	finally {
		if (prev === undefined) delete process.env.KANBAN_ROOTS;
		else process.env.KANBAN_ROOTS = prev;
	}
}

test("findCardsWorkspace inventories <parent>/*/.kanban/cards/ across a 2-project tree (REQ-M1-2)", () => {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
	makeTree(ws, [
		// alpha: two real cards, plus decoys that must NOT count
		{ type: "file", path: "alpha/.kanban/cards/a1.card.md", content: "x" },
		{ type: "file", path: "alpha/.kanban/cards/a2.card.md", content: "x" },
		{ type: "file", path: "alpha/.kanban/roadmap.md", content: "x" },  // board, not a card
		{ type: "file", path: "alpha/extra.card.md", content: "x" },     // not under .kanban/cards
		// beta: one card
		{ type: "file", path: "beta/.kanban/cards/b1.card.md", content: "x" },
		// gamma: no .kanban at all -> contributes nothing
		{ type: "file", path: "gamma/orphan.card.md", content: "x" },
	]);
	const got = findCardsWorkspace([ws]);
	const expected = [
		"alpha/.kanban/cards/a1.card.md",
		"alpha/.kanban/cards/a2.card.md",
		"beta/.kanban/cards/b1.card.md",
	].map(rel => path.resolve(ws, rel)).sort();
	assert.equal(got.length, 3, "only real cards under */.kanban/cards/ should count");
	assert.deepEqual(got, expected, "right count AND sorted order");
});

test("findCardsWorkspace dedupes when KANBAN_ROOTS re-points at a discovered project (REQ-M1-2)", () => {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-dedup-"));
	makeTree(ws, [
		{ type: "file", path: "alpha/.kanban/cards/a1.card.md", content: "x" },
		{ type: "file", path: "alpha/.kanban/cards/a2.card.md", content: "x" },
		{ type: "file", path: "beta/.kanban/cards/b1.card.md", content: "x" },
	]);
	// alpha is already reached via the parent glob; pointing KANBAN_ROOTS at it
	// must NOT double-count its cards.
	withKanbanRoots(path.join(ws, "alpha"), () => {
		const got = findCardsWorkspace([ws]);
		assert.equal(got.length, 3, "alpha's cards must be deduped, not counted twice");
		const expected = [
			"alpha/.kanban/cards/a1.card.md",
			"alpha/.kanban/cards/a2.card.md",
			"beta/.kanban/cards/b1.card.md",
		].map(rel => path.resolve(ws, rel)).sort();
		assert.deepEqual(got, expected);
	});
});

test("KANBAN_ROOTS pulls in projects outside the passed parents (REQ-M1-2)", () => {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-env-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ws-env-out-"));
	makeTree(ws, [
		{ type: "file", path: "alpha/.kanban/cards/a1.card.md", content: "x" },
	]);
	// `outside` is a PROJECT root (its own .kanban/cards is scanned), not a parent.
	makeTree(outside, [
		{ type: "file", path: ".kanban/cards/e1.card.md", content: "x" },
	]);
	withKanbanRoots(outside, () => {
		const got = findCardsWorkspace([ws]);
		assert.deepEqual(got, [
			path.resolve(ws, "alpha/.kanban/cards/a1.card.md"),
			path.resolve(outside, ".kanban/cards/e1.card.md"),
		].sort());
	});
});

test("findCardsWorkspace handles multiple parents + missing roots gracefully (REQ-M1-2)", () => {
	const p1 = fs.mkdtempSync(path.join(os.tmpdir(), "ws-p1-"));
	const p2 = fs.mkdtempSync(path.join(os.tmpdir(), "ws-p2-"));
	makeTree(p1, [{ type: "file", path: "one/.kanban/cards/c1.card.md", content: "x" }]);
	makeTree(p2, [{ type: "file", path: "two/.kanban/cards/c2.card.md", content: "x" }]);
	const got = findCardsWorkspace([p1, p2, path.join(os.tmpdir(), "nope-not-here-xyz")]);
	assert.deepEqual(got, [
		path.resolve(p1, "one/.kanban/cards/c1.card.md"),
		path.resolve(p2, "two/.kanban/cards/c2.card.md"),
	].sort());
	assert.deepEqual(findCardsWorkspace([]), [], "no parents -> no cards");
});
