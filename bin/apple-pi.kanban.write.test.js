// bin/apple-pi.kanban.write.test.js — REQ-M8-3
//
// `apple-pi kanban new/move` — the CLI truth writers over M2-5
// createCard/moveStatus. SPEC: wrappers around createCard/moveStatus; path
// safety + transition rules enforced (red-blue, by M2-5's resolveUnderRoot +
// legalTransition).
//
// ACCEPTANCE (REQ-M8-3): new -> validate -> show; move diff = 2 lines.
//
// This suite drives the REAL bin/apple-pi wrapper as a subprocess (the path a
// user hits), points AGENT_DB + cwd at throwaway paths, and asserts:
//   - new:     creates a valid .card.md at cards/<id>.card.md; the file passes
//              schema-card validation; `kanban show <id>` returns it (mirror
//              reconciled lazily); --json returns the created card
//   - new:     all optional fields (priority/project/assignee/parent/tags/
//              deps/body) round-trip through the file + the mirror
//   - new:     rejects cleanly with NO file write on: bad id slug, bogus
//              status, path-escaping --dir, duplicate id
//   - move:    legal transition exits 0 and the on-disk diff is EXACTLY 2
//              lines (status + updated_at); the mirror reflects the new status
//   - move:    illegal transition + bogus status + missing id all exit
//              non-zero with the file byte-identical (red-blue: no write on
//              reject); the id is resolved ONLY from the mirror (no path input)
//
// The write primitives' own abuse suite lives in agentdb/kb/write.test.js
// (M2-5); here we verify the CLI wiring: the wrapper forwards args, surfaces
// errors to stderr + exit code, reindexes so `show` reflects the write, and
// never offers a path-escape vector of its own.
//
// Verify: node --test bin/apple-pi.kanban.write.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { validateCardFile } = require("../agentdb/kb/validate");

const BIN = path.join(__dirname, "apple-pi");

// runKanban(sub, args, { cwd, env }) — spawn the real bin/apple-pi kanban <sub>.
// node --no-warnings suppresses the node:sqlite ExperimentalWarning so stderr
// stays clean for the "no error noise" + error-message assertions.
function runKanban(sub, args, { cwd, env }) {
	const r = spawnSync(process.execPath, ["--no-warnings", BIN, "kanban", sub, ...args], {
		cwd, env, encoding: "utf8",
	});
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function parseJson(stdout) { return JSON.parse(stdout); }

// freshRoot() -> { root, env }. A tmpdir + an isolated AGENT_DB. No cards
// seeded — `new` creates them. Each test gets its own root + DB so they're
// parallel-safe.
function freshRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-cli-write-"));
	const dbFile = path.join(root, "agent.db");
	return { root, env: { ...process.env, AGENT_DB: dbFile } };
}

// diffLines(before, after) -> { added, removed }. Naive line-set diff; exactly
// what "move diff = 2 lines" needs (we already know the change shape is
// status: + updated_at:). Mirrors agentdb/kb/write.test.js's helper.
function diffLines(before, after) {
	const b = before.split("\n");
	const a = after.split("\n");
	const aSet = new Set(a);
	const bSet = new Set(b);
	return {
		added:   a.filter(l => !bSet.has(l)),
		removed: b.filter(l => !aSet.has(l)),
	};
}

// ===========================================================================
// REQ-M8-3: `apple-pi kanban new` — create -> validate -> show
// ===========================================================================

test("apple-pi kanban new <id> --title: exits 0, writes cards/<id>.card.md, validates, shows (REQ-M8-3)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("new", ["alpha", "--title", "Alpha card"], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);

	const file = path.join(root, "cards", "alpha.card.md");
	assert.ok(fs.existsSync(file), `cards/alpha.card.md should exist; got:\n${r.stdout}`);

	// the file passes schema-card validation (the M1-3 primitive M8-5 will wrap)
	const v = validateCardFile(file);
	assert.ok(v.ok, `created card must validate; errors=\n${(v.errors || []).join("\n")}`);

	// the mirror reconciled lazily — `show` returns the new card
	const s = runKanban("show", ["alpha", "--json"], { cwd: root, env });
	assert.equal(s.status, 0, `show exits 0; stderr=\n${s.stderr}`);
	const card = parseJson(s.stdout);
	assert.equal(card.id, "alpha");
	assert.equal(card.title, "Alpha card");
	assert.equal(card.status, "triage", "new card defaults to status: triage");
});

test("apple-pi kanban new --json returns the created card (REQ-M8-3)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("new", ["beta", "--title", "Beta", "--json"], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	const out = parseJson(r.stdout);
	assert.equal(out.id, "beta");
	assert.equal(out.title, "Beta");
	assert.ok(String(out.file).endsWith(path.join("cards", "beta.card.md")), "file path points at cards/beta.card.md");
});

test("apple-pi kanban new: all optional fields round-trip through the file + mirror (REQ-M8-3)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("new", [
		"gamma", "--title", "Gamma",
		"--status", "todo",
		"--priority", "7",
		"--project", "apple-pi",
		"--assignee", "worker",
		"--parent", "root",
		"--tag", "m8", "--tag", "writer",
		"--dep", "alpha",
		"--body", "Gamma does the thing.",
	], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);

	const s = runKanban("show", ["gamma", "--json"], { cwd: root, env });
	assert.equal(s.status, 0);
	const card = parseJson(s.stdout);
	assert.equal(card.status, "todo");
	assert.equal(card.priority, 7);
	assert.equal(card.project, "apple-pi");
	assert.equal(card.assignee, "worker");
	assert.equal(card.parent, "root");
	assert.deepEqual(card.tags.sort(), ["m8", "writer"]);
	assert.deepEqual(card.deps, ["alpha"]);
	assert.ok(String(card.body).includes("Gamma does the thing."), "body round-trips");

	// schema-card validation must still pass with the full field set
	const v = validateCardFile(path.join(root, "cards", "gamma.card.md"));
	assert.ok(v.ok, `full-field card must validate; errors=\n${(v.errors || []).join("\n")}`);
});

test("apple-pi kanban new: --dir places the card in a subdirectory (REQ-M8-3)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("new", ["delta", "--title", "Delta", "--dir", "sub/cols"], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	const file = path.join(root, "sub", "cols", "delta.card.md");
	assert.ok(fs.existsSync(file), `card at --dir sub/cols; got:\n${r.stdout}`);
	// still discoverable + showable (discover walks the whole root)
	const s = runKanban("show", ["delta", "--json"], { cwd: root, env });
	assert.equal(s.status, 0);
	assert.equal(parseJson(s.stdout).id, "delta");
});

// ===========================================================================
// REQ-M8-3 red-blue: `new` rejects cleanly with NO file write
// ===========================================================================

test("apple-pi kanban new: bad id slug -> exit non-zero, no file (REQ-M8-3 red-blue)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("new", ["UPPER Bad", "--title", "X"], { cwd: root, env });
	assert.notEqual(r.status, 0, `bad slug must exit non-zero; got ${r.status}`);
	assert.match(r.stderr, /slug|id/i, "stderr should explain the bad id");
	assert.ok(!fs.existsSync(path.join(root, "cards")), "no cards/ dir created (nothing written)");
});

test("apple-pi kanban new: bogus status -> exit non-zero, no file (REQ-M8-3 red-blue)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("new", ["eps", "--title", "Eps", "--status", "wip"], { cwd: root, env });
	assert.notEqual(r.status, 0, `bogus status must exit non-zero; got ${r.status}`);
	assert.match(r.stderr, /wip|status|enum/i, "stderr should name the bad status");
	assert.ok(!fs.existsSync(path.join(root, "cards", "eps.card.md")), "no file written");
});

test("apple-pi kanban new: path-escaping --dir -> exit non-zero, no file anywhere (REQ-M8-3 red-blue)", () => {
	const { root, env } = freshRoot();
	const parent = path.dirname(root);
	const r = runKanban("new", ["zeta", "--title", "Zeta", "--dir", "../escape"], { cwd: root, env });
	assert.notEqual(r.status, 0, `--dir ../escape must exit non-zero; got ${r.status}`);
	assert.match(r.stderr, /outside root|escape|parent/i, "stderr should flag the escape");
	// nothing written inside root, and crucially nothing at the escaped target
	assert.ok(!fs.existsSync(path.join(root, "cards", "zeta.card.md")), "no file in root");
	assert.ok(!fs.existsSync(path.join(parent, "escape", "zeta.card.md")), "no file written outside root");
});

test("apple-pi kanban new: duplicate id -> exit non-zero, original unchanged (REQ-M8-3 red-blue)", () => {
	const { root, env } = freshRoot();
	const r1 = runKanban("new", ["eta", "--title", "Eta one"], { cwd: root, env });
	assert.equal(r1.status, 0, `first new exits 0; stderr=\n${r1.stderr}`);
	const before = fs.readFileSync(path.join(root, "cards", "eta.card.md"), "utf8");

	const r2 = runKanban("new", ["eta", "--title", "Eta two"], { cwd: root, env });
	assert.notEqual(r2.status, 0, `duplicate id must exit non-zero; got ${r2.status}`);
	assert.match(r2.stderr, /exist|already/i, "stderr should flag the duplicate");

	const after = fs.readFileSync(path.join(root, "cards", "eta.card.md"), "utf8");
	assert.equal(after, before, "original card must be byte-identical after the rejected duplicate");
});

// ===========================================================================
// REQ-M8-3: `apple-pi kanban move` — legal transition, diff = 2 lines
// ===========================================================================

test("apple-pi kanban move <id> <status>: legal transition, diff EXACTLY 2 lines (REQ-M8-3)", () => {
	const { root, env } = freshRoot();
	// create at todo; todo -> in_progress is a legal forward edge
	const c = runKanban("new", ["mv", "--title", "Move me", "--status", "todo"], { cwd: root, env });
	assert.equal(c.status, 0, `seed exits 0; stderr=\n${c.stderr}`);
	const file = path.join(root, "cards", "mv.card.md");
	const before = fs.readFileSync(file, "utf8");

	const r = runKanban("move", ["mv", "in_progress"], { cwd: root, env });
	assert.equal(r.status, 0, `move exits 0; stderr=\n${r.stderr}`);

	const after = fs.readFileSync(file, "utf8");
	const { added, removed } = diffLines(before, after);
	assert.equal(added.length, 2, `exactly 2 lines added (status + updated_at); got ${JSON.stringify(added)}`);
	assert.equal(removed.length, 2, `exactly 2 lines removed; got ${JSON.stringify(removed)}`);
	assert.ok(added.some(l => /^status:\s*in_progress\s*$/.test(l)), "added lines include the new status");
	assert.ok(added.some(l => /^updated_at:\s*\S+/.test(l)), "added lines include a restamped updated_at");
	assert.ok(removed.some(l => /^status:\s*todo\s*$/.test(l)), "removed lines include the old status");
});

test("apple-pi kanban move: mirror reflects the new status (show) (REQ-M8-3)", () => {
	const { root, env } = freshRoot();
	const c = runKanban("new", ["mv2", "--title", "Move me 2", "--status", "todo"], { cwd: root, env });
	assert.equal(c.status, 0);
	const r = runKanban("move", ["mv2", "in_progress"], { cwd: root, env });
	assert.equal(r.status, 0, `move exits 0; stderr=\n${r.stderr}`);
	const s = runKanban("show", ["mv2", "--json"], { cwd: root, env });
	assert.equal(s.status, 0);
	assert.equal(parseJson(s.stdout).status, "in_progress", "show must reflect the moved status");
});

test("apple-pi kanban move --json: reports id + new status (REQ-M8-3)", () => {
	const { root, env } = freshRoot();
	const c = runKanban("new", ["mv3", "--title", "Move me 3", "--status", "todo"], { cwd: root, env });
	assert.equal(c.status, 0);
	const r = runKanban("move", ["mv3", "in_progress", "--json"], { cwd: root, env });
	assert.equal(r.status, 0, `move --json exits 0; stderr=\n${r.stderr}`);
	const out = parseJson(r.stdout);
	assert.equal(out.id, "mv3");
	assert.equal(out.to, "in_progress");
	assert.equal(out.from, "todo");
});

// ===========================================================================
// REQ-M8-3 red-blue: `move` rejects with NO file write
// ===========================================================================

test("apple-pi kanban move: illegal transition -> exit non-zero, file byte-identical (REQ-M8-3 red-blue)", () => {
	const { root, env } = freshRoot();
	// todo -> done is NOT a legal edge (todo only goes to in_progress|blocked)
	const c = runKanban("new", ["bad", "--title", "Bad move", "--status", "todo"], { cwd: root, env });
	assert.equal(c.status, 0);
	const file = path.join(root, "cards", "bad.card.md");
	const before = fs.readFileSync(file, "utf8");

	const r = runKanban("move", ["bad", "done"], { cwd: root, env });
	assert.notEqual(r.status, 0, `illegal transition must exit non-zero; got ${r.status}`);
	assert.match(r.stderr, /illegal|transition|todo.*done|done/i, "stderr should flag the illegal transition");

	const after = fs.readFileSync(file, "utf8");
	assert.equal(after, before, "file must be byte-identical after the rejected move");
});

test("apple-pi kanban move: bogus target status -> exit non-zero, no write (REQ-M8-3 red-blue)", () => {
	const { root, env } = freshRoot();
	const c = runKanban("new", ["bad2", "--title", "Bad move 2", "--status", "todo"], { cwd: root, env });
	assert.equal(c.status, 0);
	const file = path.join(root, "cards", "bad2.card.md");
	const before = fs.readFileSync(file, "utf8");

	const r = runKanban("move", ["bad2", "finished"], { cwd: root, env });
	assert.notEqual(r.status, 0, `bogus status must exit non-zero; got ${r.status}`);
	assert.match(r.stderr, /finished|enum|status/i, "stderr should name the bogus status");

	const after = fs.readFileSync(file, "utf8");
	assert.equal(after, before, "no write after bogus-status reject");
});

test("apple-pi kanban move: missing id -> exit non-zero (REQ-M8-3 red-blue)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("move", ["ghost", "in_progress"], { cwd: root, env });
	assert.notEqual(r.status, 0, `missing id must exit non-zero; got ${r.status}`);
	assert.match(r.stderr, /ghost|not found|no card/i, "stderr should name the missing id");
});

test("apple-pi kanban move: missing target status -> exit non-zero (REQ-M8-3)", () => {
	const { root, env } = freshRoot();
	const c = runKanban("new", ["ns", "--title", "No status arg", "--status", "todo"], { cwd: root, env });
	assert.equal(c.status, 0);
	const r = runKanban("move", ["ns"], { cwd: root, env });
	assert.notEqual(r.status, 0, `missing target status must exit non-zero; got ${r.status}`);
});

test("apple-pi kanban move: resolves id ONLY from the mirror — no path arg accepted (REQ-M8-3 red-blue)", () => {
	const { root, env } = freshRoot();
	const c = runKanban("new", ["real", "--title", "Real", "--status", "todo"], { cwd: root, env });
	assert.equal(c.status, 0);
	// a relative path to the card is NOT a valid id (slug chars only); even if
	// it existed, the CLI must not let the caller steer the writer at an
	// arbitrary file — it resolves ids via kb_cards (under-root only).
	const r = runKanban("move", ["cards/real.card.md", "in_progress"], { cwd: root, env });
	assert.notEqual(r.status, 0, `a path-shaped 'id' must not resolve; got ${r.status}`);
	assert.match(r.stderr, /cards\/real\.card\.md|not found|no card/i, "stderr should treat the path as an unknown id");
	// the real card is untouched
	const after = fs.readFileSync(path.join(root, "cards", "real.card.md"), "utf8");
	assert.match(after, /^status:\s*todo/m, "real card untouched by the failed path-shaped move");
});
