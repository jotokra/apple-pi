// agentdb/kb/validate.test.js — REQ-M1-3
// validate.js stitches parse.js (M1-1) + schema-card.js (M0-1) and tags every
// violation with file:line, so a human or agent can jump straight at the fix.
//   validateCardFile(path) -> { ok, errors[] }   errors are "file:line: msg"
//   validateTree(root)     -> { ok, cards: [{file, ok, errors}] }
// A CLI helper (`require.main === module` block) exits non-zero on any bad card.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { validateCardFile, validateTree } = require("./validate");

// Resolve fixtures relative to THIS file so the suite passes regardless of cwd
// (the VERIFY hook runs `node --test agentdb/kb/validate.test.js` from the repo root).
const FIX = path.resolve(__dirname, "../test/fixtures");
const VALIDATE_JS = path.resolve(__dirname, "validate.js");

// Minimal valid card content (the §5.1 required set). Used to build clean trees.
const GOOD_CARD = [
	"---",
	"id: clean-sample",
	"title: A clean card",
	"status: todo",
	"project: apple-pi",
	"parent: root",
	"depends_on: []",
	"created_at: 2026-07-02T22:00:00Z",
	"updated_at: 2026-07-02T22:00:00Z",
	"---",
	"# Body",
	"",
].join("\n");

// build a throwaway tree under a fresh tmpdir
function makeTree(root, layout) {
	for (const e of layout) {
		const p = path.join(root, e.path);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, e.content ?? "", "utf8");
	}
}

// --- validateCardFile -------------------------------------------------------

test("validateCardFile returns { ok, errors[] } and accepts the good fixture (REQ-M1-3)", () => {
	const r = validateCardFile(path.join(FIX, "good.card.md"));
	assert.equal(r.ok, true, JSON.stringify(r.errors));
	assert.deepEqual(r.errors, []);
});

test("validateCardFile reports the bad-status fixture precisely with file:line (REQ-M1-3)", () => {
	const file = path.join(FIX, "bad-status.card.md");
	const r = validateCardFile(file);
	assert.equal(r.ok, false);
	// exactly the status violation, and it carries file:line
	assert.ok(r.errors.length > 0, "expected at least one error");
	const statusErr = r.errors.find(e => e.includes("status") && e.includes("wip"));
	assert.ok(statusErr, `no status error in ${JSON.stringify(r.errors)}`);
	// `status: wip` lives on line 4 of bad-status.card.md; the error must name
	// both the file and that line so a human/agent can jump straight at it.
	assert.ok(statusErr.includes(file), `error missing file: ${statusErr}`);
	assert.ok(/:4:/.test(statusErr), `error missing :4: line tag: ${statusErr}`);
});

test("validateCardFile tags every error with the file path (REQ-M1-3)", () => {
	const file = path.join(FIX, "bad-status.card.md");
	const r = validateCardFile(file);
	assert.ok(r.errors.length > 0);
	assert.ok(r.errors.every(e => e.startsWith(file + ":")), `errors not all tagged with file: ${JSON.stringify(r.errors)}`);
});

test("validateCardFile points a missing-required-field error at the frontmatter (REQ-M1-3)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-missing-"));
	const file = path.join(dir, "no-title.card.md");
	// valid card MINUS the title line -> schema rejects "title is required"
	fs.writeFileSync(file, [
		"---",
		"id: no-title",
		"status: todo",
		"project: apple-pi",
		"parent: root",
		"created_at: 2026-07-02T22:00:00Z",
		"updated_at: 2026-07-02T22:00:00Z",
		"---",
		"",
	].join("\n"), "utf8");
	const r = validateCardFile(file);
	assert.equal(r.ok, false);
	const titleErr = r.errors.find(e => e.includes("title"));
	assert.ok(titleErr, `no title error in ${JSON.stringify(r.errors)}`);
	assert.ok(titleErr.startsWith(file + ":"), `error missing file: ${titleErr}`);
});

// --- validateTree -----------------------------------------------------------

test("validateTree returns ok=true for a clean one-card tree (REQ-M1-3)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "validate-clean-"));
	makeTree(root, [{ path: "cards/clean.card.md", content: GOOD_CARD }]);
	const r = validateTree(root);
	assert.equal(r.ok, true, JSON.stringify(r.cards));
	assert.equal(r.cards.length, 1);
	assert.equal(r.cards[0].ok, true);
});

test("validateTree returns ok=false and pinpoints the one bad card in a mixed tree (REQ-M1-3)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "validate-mixed-"));
	const goodPath = path.join(root, "cards/clean.card.md");
	const badPath = path.join(root, "cards/bad.card.md");
	makeTree(root, [
		{ path: "cards/clean.card.md", content: GOOD_CARD },
		{ path: "cards/bad.card.md", content: GOOD_CARD.replace("status: todo", "status: wip") },
		// non-card files are not validated
		{ path: "roadmap.md", content: "not a card" },
	]);
	const r = validateTree(root);
	assert.equal(r.ok, false);
	assert.equal(r.cards.length, 2, "both discovered cards are reported");
	const bad = r.cards.find(c => c.file === badPath);
	const good = r.cards.find(c => c.file === goodPath);
	assert.ok(bad, "bad card present in results");
	assert.ok(good, "good card present in results");
	assert.equal(good.ok, true);
	assert.equal(bad.ok, false);
	const statusErr = bad.errors.find(e => e.includes("status") && e.includes("wip"));
	assert.ok(statusErr, `bad card missing status error: ${JSON.stringify(bad.errors)}`);
	assert.ok(statusErr.includes(badPath), `error missing file: ${statusErr}`);
	assert.ok(/:4:/.test(statusErr), `error missing :4: line tag: ${statusErr}`);
});

test("validateTree returns ok=true for a tree with no cards (vacuous)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "validate-empty-"));
	makeTree(root, [{ path: "roadmap.md", content: "no cards here" }]);
	const r = validateTree(root);
	assert.equal(r.ok, true);
	assert.deepEqual(r.cards, []);
});

// --- CLI helper (exit code) -------------------------------------------------

test("CLI helper exits 1 on a tree with a bad card and prints the file:line error (REQ-M1-3)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "validate-cli-bad-"));
	makeTree(root, [
		{ path: "cards/bad.card.md", content: GOOD_CARD.replace("status: todo", "status: wip") },
	]);
	const res = spawnSync(process.execPath, [VALIDATE_JS, root], { encoding: "utf8" });
	assert.equal(res.status, 1, `expected exit 1, got ${res.status}\nstdout:${res.stdout}\nstderr:${res.stderr}`);
	const out = res.stdout + res.stderr;
	const badPath = path.join(root, "cards/bad.card.md");
	assert.ok(out.includes(badPath), `output missing file path:\n${out}`);
	assert.ok(out.includes("status") && out.includes("wip"), `output missing status error:\n${out}`);
	assert.ok(/:4:/.test(out), `output missing :4: line tag:\n${out}`);
});

test("CLI helper exits 0 on a clean tree (REQ-M1-3)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "validate-cli-clean-"));
	makeTree(root, [{ path: "cards/clean.card.md", content: GOOD_CARD }]);
	const res = spawnSync(process.execPath, [VALIDATE_JS, root], { encoding: "utf8" });
	assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstdout:${res.stdout}\nstderr:${res.stderr}`);
});
