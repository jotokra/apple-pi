// agentdb/kb/discover.test.js — REQ-M0-3
// findCards(root) -> sorted, absolute *.card.md paths under root, ignoring
// node_modules / .git / .index (build caches + VCS that must never index as
// cards).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { findCards } = require("./discover");

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
