// bin/apple-pi.kanban.list.test.js — REQ-M8-2
//
// `apple-pi kanban list/show/next/graph` — the CLI surface over the kb_*
// mirror. SPEC: list = M3-1 filters; show = M3-1 single-card; next =
// WIP-aware (M0-2) + ready (M3-2); graph = ready + deps.
//
// ACCEPTANCE (REQ-M8-2): filters narrow; next is WIP-aware + ready.
//
// This suite drives the REAL bin/apple-pi wrapper as a subprocess (the path a
// user hits), points AGENT_DB + cwd at throwaway paths, and asserts:
//   - list:   filters (status/project/assignee/tag/priority) AND-compose
//   - show:   single card (incl. body); missing id exits non-zero
//   - next:   ready + priority selection, dep-blocked excluded; WIP-aware
//             (under limit recommends; at KANBAN_WIP limit holds + flags)
//   - graph:  edges (deps) + ready set + cycles
//
// The read commands lazily reconcile the mirror (ensureCurrent) — so a fresh
// tree + `kanban list` works with no prior `kanban index`. The fixture tree is
// shared by all tests (one layout); each test gets its own tmpdir + DB.
//
// Verify: node --test bin/apple-pi.kanban.list.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const BIN = path.join(__dirname, "apple-pi");

// CARD(id, {title,status,priority,assignee,tags,deps}) -> a .card.md body.
// deps is rendered as a YAML inline array; tags likewise.
function CARD(id, opts = {}) {
	const o = {
		title: opts.title ?? `Card ${id.toUpperCase()}`,
		status: opts.status ?? "todo",
		priority: opts.priority ?? 5,
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
		"project: apple-pi",
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

// The shared fixture. 6 cards across statuses; exercises deps + priorities +
// WIP count + assignees + tags.
//   a : todo   p5  deps=[]      -> READY (lowest-priority ready)
//   b : todo   p8  deps=[c]     -> READY (c is done) — highest-priority ready
//   c : done   p5  deps=[]      -> the satisfied dep of b
//   d : todo   p9  deps=[e]     -> NOT READY (e is in_progress) — highest prio
//                                  but dep-blocked, so NOT next
//   e : in_progress p5          -> WIP
//   f : in_progress p3          -> WIP
// ready() = {a, b}; WIP count = 2 (e, f); default WIP limit = 3.
function makeTree(root) {
	const cards = [
		{ id: "a", status: "todo", priority: 5, assignee: "alice", tags: ["m8", "ready"], deps: [] },
		{ id: "b", status: "todo", priority: 8, assignee: "bob", tags: ["m8"], deps: ["c"] },
		{ id: "c", status: "done", priority: 5, assignee: "alice", tags: ["m8"], deps: [] },
		{ id: "d", status: "todo", priority: 9, assignee: "bob", tags: ["m8"], deps: ["e"] },
		{ id: "e", status: "in_progress", priority: 5, assignee: "alice", tags: ["m8"], deps: [] },
		{ id: "f", status: "in_progress", priority: 3, assignee: "bob", tags: ["m8"], deps: [] },
	];
	for (const c of cards) {
		fs.mkdirSync(path.join(root, "cards"), { recursive: true });
		fs.writeFileSync(path.join(root, "cards", `${c.id}.card.md`), CARD(c.id, c), "utf8");
	}
}

// freshRoot() -> { root, env } — a tmpdir with the fixture + an isolated DB.
function freshRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-cli-list-"));
	const dbFile = path.join(root, "agent.db");
	makeTree(root);
	return { root, env: { ...process.env, AGENT_DB: dbFile } };
}

// runKanban(sub, args, { cwd, env }) — spawn the real bin/apple-pi kanban <sub>.
function runKanban(sub, args, { cwd, env }) {
	const r = spawnSync(process.execPath, ["--no-warnings", BIN, "kanban", sub, ...args], {
		cwd, env, encoding: "utf8",
	});
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// parseJson(stdout) — the --json payloads are a single JSON document; tolerate
// any trailing newline. node:sqlite returns null-prototype objects so we map.
function parseJson(stdout) {
	return JSON.parse(stdout);
}

// ===========================================================================
// REQ-M8-2: `apple-pi kanban list` — filters AND-compose
// ===========================================================================

test("apple-pi kanban list (no filters) exits 0 and reports all cards (REQ-M8-2)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("list", [], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	assert.match(r.stdout, /cards\s*:\s*6/, `should report 6 cards; got:\n${r.stdout}`);
});

test("apple-pi kanban list --json returns the full row set (6) (REQ-M8-2)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("list", ["--json"], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	const rows = parseJson(r.stdout);
	const ids = rows.map(x => x.id).sort();
	assert.deepEqual(ids, ["a", "b", "c", "d", "e", "f"]);
});

test("apple-pi kanban list --status narrows by status (REQ-M8-2)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("list", ["--status", "todo", "--json"], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	const ids = parseJson(r.stdout).map(x => x.id).sort();
	assert.deepEqual(ids, ["a", "b", "d"], `--status todo -> {a,b,d}; got ${ids}`);
});

test("apple-pi kanban list --project narrows by project (REQ-M8-2)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("list", ["--project", "apple-pi", "--json"], { cwd: root, env });
	assert.equal(r.status, 0);
	assert.equal(parseJson(r.stdout).length, 6);
});

test("apple-pi kanban list --status + --priority AND-compose (REQ-M8-2)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("list", ["--status", "todo", "--priority", "8", "--json"], { cwd: root, env });
	assert.equal(r.status, 0);
	const ids = parseJson(r.stdout).map(x => x.id);
	assert.deepEqual(ids, ["b"], `todo+p8 -> {b}; got ${ids}`);
});

test("apple-pi kanban list --assignee narrows by assignee (REQ-M8-2)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("list", ["--assignee", "alice", "--json"], { cwd: root, env });
	assert.equal(r.status, 0);
	const ids = parseJson(r.stdout).map(x => x.id).sort();
	assert.deepEqual(ids, ["a", "c", "e"], `alice -> {a,c,e}; got ${ids}`);
});

test("apple-pi kanban list --tag narrows by tag (REQ-M8-2)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("list", ["--tag", "ready", "--json"], { cwd: root, env });
	assert.equal(r.status, 0);
	const ids = parseJson(r.stdout).map(x => x.id);
	assert.deepEqual(ids, ["a"], `tag ready -> {a}; got ${ids}`);
});

test("apple-pi kanban list default ordering: priority DESC, id ASC (REQ-M8-2)", () => {
	const { root, env } = freshRoot();
	// all cards: priority order desc = d(9),b(8), then p5 = a,c,e, then f(3)
	const r = runKanban("list", ["--json"], { cwd: root, env });
	assert.equal(r.status, 0);
	const ids = parseJson(r.stdout).map(x => x.id);
	assert.deepEqual(ids, ["d", "b", "a", "c", "e", "f"], `priority DESC,id ASC; got ${ids}`);
});

// ===========================================================================
// REQ-M8-2: `apple-pi kanban show <id>` — single card (incl. body)
// ===========================================================================

test("apple-pi kanban show <id> --json returns the single card incl. body (REQ-M8-2)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("show", ["a", "--json"], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	const card = parseJson(r.stdout);
	assert.equal(card.id, "a");
	assert.equal(card.title, "Card A");
	assert.equal(card.status, "todo");
	assert.ok(String(card.body).includes("Body for card a"), "body must be present");
});

test("apple-pi kanban show <id> human output includes id/title/body (REQ-M8-2)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("show", ["b"], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	assert.match(r.stdout, /id\s*:\s*b/, `should print id; got:\n${r.stdout}`);
	assert.match(r.stdout, /title\s*:\s*Card B/);
	assert.match(r.stdout, /Body for card b/);
});

test("apple-pi kanban show <missing> exits non-zero with an error (REQ-M8-2)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("show", ["nope"], { cwd: root, env });
	assert.notEqual(r.status, 0, `missing id must exit non-zero; got ${r.status}`);
	assert.match(r.stderr, /nope/, "stderr should name the missing id");
});

// ===========================================================================
// REQ-M8-2: `apple-pi kanban next` — WIP-aware (M0-2) + ready (M3-2)
// ===========================================================================

test("apple-pi kanban next: under WIP limit, recommends the highest-priority READY card (REQ-M8-2)", () => {
	const { root, env } = freshRoot();
	// WIP = 2 (e,f), default limit 3 -> under. ready = {a,b}. b has p8 > a's p5.
	// d (p9) is dep-blocked (e is in_progress) so it is NOT next.
	const r = runKanban("next", ["--json"], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	const out = parseJson(r.stdout);
	assert.deepEqual(out.ready.sort(), ["a", "b"], "ready = {a,b}");
	assert.equal(out.next, "b", "next = b (highest-priority ready; d is dep-blocked)");
	assert.equal(out.held, false, "under WIP limit -> not held");
	assert.equal(out.wip.count, 2);
	assert.equal(out.wip.limit, 3);
	assert.equal(out.wip.atLimit, false);
});

test("apple-pi kanban next: dep-blocked card is excluded from ready even at top priority (REQ-M8-2)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("next", ["--json"], { cwd: root, env });
	assert.equal(r.status, 0);
	const out = parseJson(r.stdout);
	assert.ok(!out.ready.includes("d"), "d depends on in_progress e -> not ready");
	assert.notEqual(out.next, "d", "d must never be next while its dep is in_progress");
});

test("apple-pi kanban next: at KANBAN_WIP limit -> HELD, not recommended (REQ-M8-2 WIP-aware)", () => {
	const { root, env } = freshRoot();
	// KANBAN_WIP=2 -> WIP 2/2 -> at limit. The would-be-next (b) is HELD, not
	// recommended: out.next === null, out.held === true, out.heldId === 'b'.
	const r = runKanban("next", ["--json"], { cwd: root, env: { ...env, KANBAN_WIP: "2" } });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	const out = parseJson(r.stdout);
	assert.equal(out.wip.count, 2);
	assert.equal(out.wip.limit, 2);
	assert.equal(out.wip.atLimit, true, "2/2 is at limit");
	assert.equal(out.held, true, "at limit + ready exists -> held");
	assert.equal(out.next, null, "at limit -> no recommendation (next suppressed)");
	assert.equal(out.heldId, "b", "the would-be-next is held");
});

test("apple-pi kanban next: human output says 'at wip limit' when held (REQ-M8-2 WIP-aware)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("next", [], { cwd: root, env: { ...env, KANBAN_WIP: "2" } });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	assert.match(r.stdout, /wip\s*:\s*2\/2/, `wip line 2/2; got:\n${r.stdout}`);
	assert.match(r.stdout, /at wip limit/i, "human output must flag the limit");
});

test("apple-pi kanban next: human output recommends 'b' when under limit (REQ-M8-2)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("next", [], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	assert.match(r.stdout, /next\s*:\s*b/, `next: b; got:\n${r.stdout}`);
});

// ===========================================================================
// REQ-M8-2: `apple-pi kanban graph` — edges (deps) + ready + cycles
// ===========================================================================

test("apple-pi kanban graph --json: edges from depends_on + ready set (REQ-M8-2)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("graph", ["--json"], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	const out = parseJson(r.stdout);
	// forward edges: b->c and d->e (only cards WITH deps contribute edges)
	const edgeKey = e => `${e.from}->${e.to}`;
	const edgeKeys = out.edges.map(edgeKey).sort();
	assert.deepEqual(edgeKeys, ["b->c", "d->e"], `edges = {b->c, d->e}; got ${edgeKeys}`);
	assert.deepEqual(out.ready.sort(), ["a", "b"], "ready = {a,b}");
	assert.deepEqual(out.cycles, [], "no cycles in this DAG");
});

test("apple-pi kanban graph: human output lists edges + ready (REQ-M8-2)", () => {
	const { root, env } = freshRoot();
	const r = runKanban("graph", [], { cwd: root, env });
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	assert.match(r.stdout, /b\s*->\s*c/, `edge b->c; got:\n${r.stdout}`);
	assert.match(r.stdout, /d\s*->\s*e/);
	assert.match(r.stdout, /ready/i);
});
