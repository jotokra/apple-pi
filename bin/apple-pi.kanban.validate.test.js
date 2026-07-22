// bin/apple-pi.kanban.validate.test.js — REQ-M8-5
//
// `apple-pi kanban validate [--project] [--root] [--json]` — the CLI surface
// over the M1-3 validate primitive (agentdb/kb/validate.js). SPEC: CLI wrapper
// around validate.js. Exit 1 + report on invalid; clean -> 0.
//
// ACCEPTANCE (REQ-M8-5): exit 1 + report on invalid; clean -> 0.
//
// This suite drives the REAL bin/apple-pi wrapper as a subprocess (the path a
// user hits), points cwd / --root at throwaway trees, and asserts:
//   - clean tree  -> exit 0, no error noise
//   - empty tree (no cards) -> exit 0 (vacuously valid)
//   - tree with a bad card -> exit 1, stderr reports the file:line error
//   - --root DIR validates the tree at DIR (not cwd)
//   - --project P scopes validation to cards whose frontmatter project == P
//     (a bad card in a DIFFERENT project is ignored)
//   - --json returns { ok, cards[] } (errors ride inside the card objects)
//   - `kanban help` lists validate
//
// validate.js's own primitive suite lives in agentdb/kb/validate.test.js
// (M1-3); here we verify the CLI wiring: dispatch, exit code, stderr report,
// the --root/--project scopes. validate is mirror-independent — it reads
// .card.md straight from disk, so it needs no AGENT_DB and works pre-index.
//
// Verify: node --test bin/apple-pi.kanban.validate.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const BIN = path.join(__dirname, "apple-pi");

// CARD(id, opts) -> a .card.md body. opts: status/project/priority/etc.
// `status: ...` lives on line 4, so a `status: wip` violation is tagged :4:.
function CARD(id, opts = {}) {
	const o = {
		title: opts.title ?? `Card ${id.toUpperCase()}`,
		status: opts.status ?? "todo",
		priority: opts.priority ?? 5,
		project: opts.project ?? "apple-pi",
		assignee: opts.assignee ?? "alice",
		tags: opts.tags ?? ["m8"],
		deps: opts.deps ?? [],
	};
	const depsYaml = "[" + o.deps.join(", ") + "]";
	const tagsYaml = "[" + o.tags.join(", ") + "]";
	return [
		"---",
		`id: ${id}`,
		`title: ${o.title}`,
		`status: ${o.status}`,
		`priority: ${o.priority}`,
		`project: ${o.project}`,
		`assignee: ${o.assignee}`,
		"parent: root",
		`depends_on: ${depsYaml}`,
		`tags: ${tagsYaml}`,
		"created_at: 2026-07-02T22:00:00Z",
		"updated_at: 2026-07-02T22:00:00Z",
		"---",
		"",
		`# ${o.title}`,
		"",
		`Body for card ${id}.`,
		"",
	].join("\n");
}

// makeTree(root, layout) — write {path, content} entries under root.
function makeTree(root, layout) {
	for (const e of layout) {
		const p = path.join(root, e.path);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, e.content ?? "", "utf8");
	}
}

// freshRoot() -> a fresh tmpdir (no cards seeded).
function freshRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "kb-cli-validate-"));
}

// runKanban(sub, args, { cwd, env }) — spawn the real bin/apple-pi kanban <sub>.
// node --no-warnings suppresses the node:sqlite ExperimentalWarning so stderr
// stays clean for the error-message assertions.
function runKanban(sub, args, { cwd, env }) {
	const r = spawnSync(process.execPath, ["--no-warnings", BIN, "kanban", sub, ...args], {
		cwd, env, encoding: "utf8",
	});
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ===========================================================================
// REQ-M8-5: clean -> exit 0; invalid -> exit 1 + file:line report
// ===========================================================================

test("apple-pi kanban validate: clean tree exits 0 with no error noise (REQ-M8-5)", () => {
	const root = freshRoot();
	makeTree(root, [
		{ path: "cards/a.card.md", content: CARD("a") },
		{ path: "cards/b.card.md", content: CARD("b") },
		// a non-card file must not be validated or crash
		{ path: "roadmap.md", content: "not a card" },
	]);
	const r = runKanban("validate", [], { cwd: root, env: process.env });
	assert.equal(r.status, 0, `clean tree -> exit 0; stderr=\n${r.stderr}`);
	assert.equal(r.stderr, "", "clean tree must produce no stderr noise");
	assert.match(r.stdout, /cards\s*:\s*2/, `should report 2 cards; got:\n${r.stdout}`);
});

test("apple-pi kanban validate: empty tree (no cards) exits 0 (vacuously valid) (REQ-M8-5)", () => {
	const root = freshRoot();
	makeTree(root, [{ path: "roadmap.md", content: "no cards here" }]);
	const r = runKanban("validate", [], { cwd: root, env: process.env });
	assert.equal(r.status, 0, `empty tree -> exit 0; stderr=\n${r.stderr}`);
});

test("apple-pi kanban validate: invalid card -> exit 1 + file:line report on stderr (REQ-M8-5)", () => {
	const root = freshRoot();
	makeTree(root, [
		{ path: "cards/good.card.md", content: CARD("good") },
		{ path: "cards/bad.card.md", content: CARD("bad", { status: "wip" }) },
	]);
	const r = runKanban("validate", [], { cwd: root, env: process.env });
	assert.equal(r.status, 1, `invalid card -> exit 1; got ${r.status}`);
	const badPath = path.join(root, "cards", "bad.card.md");
	assert.ok(r.stderr.includes(badPath), `stderr should name the bad file; got:\n${r.stderr}`);
	assert.ok(r.stderr.includes("status"), `stderr should report the status error; got:\n${r.stderr}`);
	// `status: wip` lives on line 4 of bad.card.md -> the error must carry :4:
	assert.ok(/:4:/.test(r.stderr), `stderr should carry the :4: line tag; got:\n${r.stderr}`);
	// the GOOD card must NOT be reported
	const goodPath = path.join(root, "cards", "good.card.md");
	assert.ok(!r.stderr.includes(goodPath), `good card should not be reported; stderr=\n${r.stderr}`);
});

// ===========================================================================
// REQ-M8-5: --root DIR scopes validation to the tree at DIR
// ===========================================================================

test("apple-pi kanban validate --root DIR: validates the tree at DIR, not cwd (REQ-M8-5)", () => {
	const cwd = freshRoot();           // cwd has NO cards (clean)
	const root = path.join(cwd, "workspace");
	makeTree(root, [{ path: "cards/bad.card.md", content: CARD("bad", { status: "wip" }) }]);
	const r = runKanban("validate", ["--root", root], { cwd, env: process.env });
	assert.equal(r.status, 1, `bad card under --root -> exit 1; got ${r.status}`);
	const badPath = path.join(root, "cards", "bad.card.md");
	assert.ok(r.stderr.includes(badPath), `stderr should name the bad file under --root; got:\n${r.stderr}`);
});

test("apple-pi kanban validate --root DIR: clean tree under --root exits 0 (REQ-M8-5)", () => {
	const cwd = freshRoot();
	const root = path.join(cwd, "workspace");
	makeTree(root, [{ path: "cards/a.card.md", content: CARD("a") }]);
	const r = runKanban("validate", ["--root", root], { cwd, env: process.env });
	assert.equal(r.status, 0, `clean tree under --root -> exit 0; stderr=\n${r.stderr}`);
});

// ===========================================================================
// REQ-M8-5: --project P scopes validation to cards whose project == P
// ===========================================================================

test("apple-pi kanban validate --project P: clean P-cards -> exit 0, bad other-project card ignored (REQ-M8-5)", () => {
	const root = freshRoot();
	makeTree(root, [
		{ path: "cards/a.card.md", content: CARD("a", { project: "apple-pi" }) },
		// a BAD card in a DIFFERENT project — must be ignored by --project apple-pi
		{ path: "cards/x.card.md", content: CARD("x", { project: "other", status: "wip" }) },
	]);
	const r = runKanban("validate", ["--project", "apple-pi"], { cwd: root, env: process.env });
	assert.equal(r.status, 0, `--project apple-pi sees only clean cards -> exit 0; stderr=\n${r.stderr}`);
	const xPath = path.join(root, "cards", "x.card.md");
	assert.ok(!r.stderr.includes(xPath), "other-project bad card must be ignored");
});

test("apple-pi kanban validate --project P: a bad card IN P -> exit 1 + report (REQ-M8-5)", () => {
	const root = freshRoot();
	makeTree(root, [
		{ path: "cards/good.card.md", content: CARD("good", { project: "apple-pi" }) },
		{ path: "cards/bad.card.md", content: CARD("bad", { project: "apple-pi", status: "wip" }) },
		// a bad card in ANOTHER project — must be ignored
		{ path: "cards/other.card.md", content: CARD("other", { project: "zzz", status: "wip" }) },
	]);
	const r = runKanban("validate", ["--project", "apple-pi"], { cwd: root, env: process.env });
	assert.equal(r.status, 1, `bad card in apple-pi -> exit 1; got ${r.status}`);
	const badPath = path.join(root, "cards", "bad.card.md");
	assert.ok(r.stderr.includes(badPath), `stderr should name the bad apple-pi card; got:\n${r.stderr}`);
	const otherPath = path.join(root, "cards", "other.card.md");
	assert.ok(!r.stderr.includes(otherPath), "zzz-project bad card must be ignored");
});

test("apple-pi kanban validate --project P: P with no cards -> exit 0 (vacuous) (REQ-M8-5)", () => {
	const root = freshRoot();
	makeTree(root, [
		{ path: "cards/a.card.md", content: CARD("a", { project: "apple-pi" }) },
	]);
	// no cards match project 'ghost'
	const r = runKanban("validate", ["--project", "ghost"], { cwd: root, env: process.env });
	assert.equal(r.status, 0, `--project with no matching cards -> exit 0 (vacuous); stderr=\n${r.stderr}`);
});

// ===========================================================================
// REQ-M8-5: --json machine-readable output
// ===========================================================================

test("apple-pi kanban validate --json: clean tree -> { ok: true } exit 0 (REQ-M8-5)", () => {
	const root = freshRoot();
	makeTree(root, [{ path: "cards/a.card.md", content: CARD("a") }]);
	const r = runKanban("validate", ["--json"], { cwd: root, env: process.env });
	assert.equal(r.status, 0, `clean -> exit 0; stderr=\n${r.stderr}`);
	const out = JSON.parse(r.stdout);
	assert.equal(out.ok, true);
	assert.equal(out.cards.length, 1);
	assert.equal(out.cards[0].ok, true);
	assert.deepEqual(out.cards[0].errors, []);
});

test("apple-pi kanban validate --json: invalid -> exit 1 + { ok: false } with errors (REQ-M8-5)", () => {
	const root = freshRoot();
	makeTree(root, [{ path: "cards/bad.card.md", content: CARD("bad", { status: "wip" }) }]);
	const r = runKanban("validate", ["--json"], { cwd: root, env: process.env });
	assert.equal(r.status, 1, `invalid -> exit 1; got ${r.status}`);
	const out = JSON.parse(r.stdout);
	assert.equal(out.ok, false);
	assert.equal(out.cards.length, 1);
	const c = out.cards[0];
	assert.equal(c.ok, false);
	assert.ok(c.errors.length > 0, "card errors must be present");
	// compare by suffix — on macOS process.cwd() is the realpath (/private/var/...)
	// while the test's root is the symlink form (/var/...). Mirrors the write test.
	assert.ok(c.file.endsWith(path.join("cards", "bad.card.md")), `file should be cards/bad.card.md; got ${c.file}`);
	assert.ok(/:4:/.test(c.errors[0]), `error should carry :4: line tag; got ${c.errors[0]}`);
});

// ===========================================================================
// REQ-M8-5: discoverability — `kanban help` lists validate
// ===========================================================================

test("apple-pi kanban help lists validate (REQ-M8-5)", () => {
	const r = runKanban("help", [], { cwd: process.cwd(), env: process.env });
	assert.equal(r.status, 0);
	assert.match(r.stdout, /\bvalidate\b/, `help should mention validate; got:\n${r.stdout}`);
});
