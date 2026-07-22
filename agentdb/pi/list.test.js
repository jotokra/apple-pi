// agentdb/pi/list.test.js — pi agent tools kanban_list / kanban_get (M9-1).
//
// ROADMAP M9-1 acceptance gate (REQ-M9-1): "pi harness returns correct JSON
// from kb_*." These are the testable JS core of the pi tools; the pi extension
// (.ts harness binding) is a thin wrapper over this module (M9-6).
//
// What "correct JSON" means here, concretely:
//   - kanban_list delegates to M3-1 kb/query.list() and returns the SAME row
//     shape ({id,title,status,priority,project,assignee,parent,tags,file_path,
//     updated_at}), with tags parsed to an array (no leaking tags_json string).
//   - kanban_get returns one card by id INCLUDING body + deps (the per-card
//     fetch contract — the show path, not the list path), with tags + full
//     frontmatter parsed into clean nested JSON.
//   - both paths are best-effort/no-throw: { ok:false, errors|error } on bad
//     input or a missing card, never an exception.
//   - both paths work in TWO modes: (a) an injected db (tests / composition),
//     and (b) opening their OWN connection via lib/db.open() + lazy
//     ensureCurrent reconcile (the real "pi harness" path — correct with no
//     manual index).
//
// Test shape mirrors kb/query.test.js (seed + assert) + kb/ensure.test.js
// (mkdtemp fixture tree for the opens-own-db reconcile path).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { kanban_list, kanban_get } = require("./list");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

// --- shared helpers (mirror kb/query.test.js + kb/ensure.test.js) ---

// freshDB() — in-memory kb with the canonical schema applied.
function freshDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// insertCard(db, fields) — direct insert into kb_cards (skips rebuild for speed).
function insertCard(db, f) {
	db.prepare(
		`INSERT INTO kb_cards (id, title, status, priority, project, assignee, parent,
		   tags_json, file_path, frontmatter_json, body, updated_at, file_hash)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		f.id, f.title, f.status,
		f.priority ?? null, f.project ?? null, f.assignee ?? null, f.parent ?? null,
		JSON.stringify(f.tags ?? []),
		f.file_path || `/cards/${f.id}.card.md`,
		JSON.stringify(f.frontmatter || { id: f.id, title: f.title, status: f.status, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }),
		f.body || "",
		f.updated_at || "2026-01-01T00:00:00.000Z",
		f.file_hash || `hash-${f.id}-${Math.random().toString(36).slice(2, 8)}`,
	);
}

// seed(db) — 5 cards across 2 projects, 3 statuses, mix of priorities/tags.
function seed(db) {
	insertCard(db, { id: "a-todo", title: "A todo", status: "todo", project: "alpha", priority: 5, tags: ["m9", "ready"], assignee: "alice", body: "A body." });
	insertCard(db, { id: "b-todo", title: "B todo", status: "todo", project: "alpha", priority: 3, tags: ["m9"], assignee: "bob" });
	insertCard(db, { id: "c-progress", title: "C in progress", status: "in_progress", project: "alpha", priority: 7, tags: ["m9", "urgent"], assignee: "alice" });
	insertCard(db, { id: "d-blocked", title: "D blocked", status: "blocked", project: "beta", priority: 2, tags: ["m9"], assignee: null });
	insertCard(db, { id: "e-done", title: "E done", status: "done", project: "beta", priority: 9, tags: ["m9", "shipped"], assignee: "carol" });
	// one forward dep edge: c-progress depends_on a-todo (exercises kanban_get deps)
	db.prepare("INSERT INTO kb_deps (from_id, to_id) VALUES (?,?)").run("c-progress", "a-todo");
}

// CARD_HEAD(id, title, status, deps) -> a .card.md body (same template as
// kb/ensure.test.js so the fixture parses cleanly through M1-1).
function CARD_HEAD(id, title, status, deps = "[]") {
	return [
		"---",
		`id: ${id}`,
		`title: ${title}`,
		`status: ${status}`,
		"project: apple-pi",
		"parent: root",
		`depends_on: ${deps}`,
		"created_at: 2026-07-02T22:00:00Z",
		"updated_at: 2026-07-02T22:00:00Z",
		"---",
		"",
		`# ${title}`,
		"",
		"Body text.",
		"",
	].join("\n");
}

function makeTree(root, layout) {
	for (const e of layout) {
		const p = path.join(root, e.path);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, e.content ?? "", "utf8");
	}
}

// =====================================================================
// kanban_list — injected-db happy path
// =====================================================================

test("kanban_list with injected db returns all seeded rows in the M3-1 shape", () => {
	const db = freshDB();
	seed(db);
	const res = kanban_list({ db });
	assert.equal(res.ok, true);
	assert.equal(res.rows.length, 5, "all 5 seeded cards returned");

	// default order is priority DESC NULLS LAST, id ASC — verify the top row
	const ids = res.rows.map(r => r.id);
	assert.deepEqual(ids, ["e-done", "c-progress", "a-todo", "b-todo", "d-blocked"],
		"default order is priority DESC then id ASC");

	// row shape: the M3-1 list() contract (no body, no *_json string leaks)
	const top = res.rows[0];
	assert.deepEqual(
		Object.keys(top).sort(),
		["assignee", "file_path", "id", "parent", "priority", "project", "status", "tags", "title", "updated_at"],
		"list row has exactly the M3-1 columns",
	);
	assert.ok(Array.isArray(top.tags), "tags parsed to an array (not a JSON string)");
	assert.deepEqual(top.tags, ["m9", "shipped"]);
	assert.equal(typeof top.id, "string");
	assert.equal(top.id, "e-done");
});

test("kanban_list result is JSON-serializable (the pi harness round-trips it)", () => {
	const db = freshDB();
	seed(db);
	const res = kanban_list({ db });
	// must not throw — agents ship this verbatim as tool result text
	const json = JSON.stringify(res);
	const back = JSON.parse(json);
	assert.equal(back.ok, true);
	assert.equal(back.rows.length, 5);
});

test("kanban_list forwards filters to M3-1 list() — status narrows", () => {
	const db = freshDB();
	seed(db);
	const res = kanban_list({ db, filters: { status: "todo" } });
	assert.equal(res.ok, true);
	assert.deepEqual(res.rows.map(r => r.id).sort(), ["a-todo", "b-todo"]);
});

test("kanban_list forwards opts — priority range + limit", () => {
	const db = freshDB();
	seed(db);
	const res = kanban_list({ db, filters: { priority: { min: 5 } }, opts: { limit: 2 } });
	assert.equal(res.ok, true);
	assert.equal(res.rows.length, 2, "limit honored");
	assert.deepEqual(res.rows.map(r => r.id), ["e-done", "c-progress"],
		"priority>=5 ordered DESC, capped at 2");
});

test("kanban_list bad filter -> { ok:false, errors } (no throw, no SQL fired)", () => {
	const db = freshDB();
	seed(db);
	const res = kanban_list({ db, filters: { status: "nope" } });
	assert.equal(res.ok, false);
	assert.ok(res.errors.length > 0);
});

// =====================================================================
// kanban_list — opens-OWN-db path (the real "pi harness" path)
// =====================================================================

test("kanban_list with NO injected db opens AGENT_DB, reconciles, returns cards", () => {
	// fixture tree of real .card.md files
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-list-root-"));
	makeTree(root, [
		{ path: "cards/a.card.md", content: CARD_HEAD("a", "Card A", "todo") },
		{ path: "cards/b.card.md", content: CARD_HEAD("b", "Card B", "in_progress", "[a]") },
	]);
	// point lib/db.open() at a fresh temp file (NOT the live ~/.pi/agent/agent.db)
	const tmpDb = path.join(os.tmpdir(), `pi-list-db-${process.pid}-${Date.now()}.sqlite`);
	process.env.AGENT_DB = tmpDb;
	try {
		const res = kanban_list({ root });
		assert.equal(res.ok, true, "opens-own-db path must succeed");
		assert.deepEqual(
			res.rows.map(r => r.id).sort(),
			["a", "b"],
			"both fixture cards returned after lazy ensureCurrent reconcile",
		);
		// the temp DB now exists on disk (open() created it)
		assert.ok(fs.existsSync(tmpDb), "AGENT_DB file was created by open()");

		// a SECOND call reuses the now-current mirror (ensureCurrent no-op) — same answer
		const res2 = kanban_list({ root });
		assert.equal(res2.ok, true);
		assert.deepEqual(res2.rows.map(r => r.id).sort(), ["a", "b"]);
	} finally {
		delete process.env.AGENT_DB;
		try { fs.unlinkSync(tmpDb); } catch (_) {}
		try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
	}
});

// =====================================================================
// kanban_get — injected-db happy + missing + bad-id
// =====================================================================

test("kanban_get returns one card WITH body + deps + parsed tags/frontmatter", () => {
	const db = freshDB();
	seed(db);
	const res = kanban_get("c-progress", { db });
	assert.equal(res.ok, true);
	const c = res.card;
	assert.equal(c.id, "c-progress");
	assert.equal(c.title, "C in progress");
	assert.equal(c.status, "in_progress");
	assert.equal(c.project, "alpha");
	// the per-card fetch contract: body is present (list omits it; get includes it)
	assert.equal(c.body, "");
	// deps: c-progress depends_on a-todo (seeded edge)
	assert.deepEqual(c.deps, ["a-todo"]);
	// tags parsed to array, no tags_json leak
	assert.ok(Array.isArray(c.tags));
	assert.deepEqual(c.tags, ["m9", "urgent"]);
	assert.ok(!("tags_json" in c), "no raw tags_json column in output");
	assert.ok(!("frontmatter_json" in c), "no raw frontmatter_json column in output");
	// frontmatter parsed into a nested object
	assert.equal(typeof c.frontmatter, "object");
	assert.equal(c.frontmatter.id, "c-progress");
});

test("kanban_get card with a real body returns the body text", () => {
	const db = freshDB();
	seed(db); // a-todo has body "A body."
	const res = kanban_get("a-todo", { db });
	assert.equal(res.ok, true);
	assert.equal(res.card.body, "A body.");
});

test("kanban_get result is JSON-serializable", () => {
	const db = freshDB();
	seed(db);
	const res = kanban_get("c-progress", { db });
	const json = JSON.stringify(res);
	const back = JSON.parse(json);
	assert.equal(back.ok, true);
	assert.equal(back.card.id, "c-progress");
	assert.deepEqual(back.card.deps, ["a-todo"]);
});

test("kanban_get missing id -> { ok:false, error } (no throw)", () => {
	const db = freshDB();
	seed(db);
	const res = kanban_get("does-not-exist", { db });
	assert.equal(res.ok, false);
	assert.ok(typeof res.error === "string" && res.error.length > 0);
});

test("kanban_get rejects non-string / empty id without touching SQL", () => {
	const db = freshDB();
	seed(db);
	for (const bad of ["", null, undefined, 42, { x: 1 }]) {
		const res = kanban_get(bad, { db });
		assert.equal(res.ok, false, `id=${JSON.stringify(bad)} must be rejected`);
		assert.ok(res.error, `id=${JSON.stringify(bad)} must carry an error message`);
	}
	// nothing was read — all 5 rows still intact
	assert.equal(db.prepare("SELECT count(*) c FROM kb_cards").get().c, 5);
});

// =====================================================================
// kanban_get — opens-OWN-db path
// =====================================================================

test("kanban_get with NO injected db opens AGENT_DB + reconciles + fetches the card", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-get-root-"));
	makeTree(root, [
		{ path: "cards/a.card.md", content: CARD_HEAD("a", "Card A", "todo") },
		{ path: "cards/b.card.md", content: CARD_HEAD("b", "Card B", "in_progress", "[a]") },
	]);
	const tmpDb = path.join(os.tmpdir(), `pi-get-db-${process.pid}-${Date.now()}.sqlite`);
	process.env.AGENT_DB = tmpDb;
	try {
		const res = kanban_get("b", { root });
		assert.equal(res.ok, true);
		assert.equal(res.card.id, "b");
		assert.equal(res.card.title, "Card B");
		assert.deepEqual(res.card.deps, ["a"], "b depends_on a -> dep edge present");
		assert.ok(res.card.body.includes("Body text."), "body fetched from disk via the mirror");
	} finally {
		delete process.env.AGENT_DB;
		try { fs.unlinkSync(tmpDb); } catch (_) {}
		try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
	}
});

// =====================================================================
// RED-BLUE — the pi tools inherit M3-1's bind-layer injection defense
// =====================================================================

test("abuse: SQL injection via kanban_list filter is treated as a literal value", () => {
	const db = freshDB();
	seed(db);
	const res = kanban_list({ db, filters: { project: "' OR '1'='1" } });
	assert.equal(res.ok, true, "value reaches SQL as a bound parameter, not concatenated");
	assert.equal(res.rows.length, 0, "no row matches the literal injection string");
	// table untouched
	assert.equal(db.prepare("SELECT count(*) c FROM kb_cards").get().c, 5);
});

test("abuse: kanban_get id with injection payload is bound (no table dropped)", () => {
	const db = freshDB();
	seed(db);
	// a DROP payload as an id: bound as a literal string -> matches nothing -> not found
	const res = kanban_get("x'; DROP TABLE kb_cards;--", { db });
	assert.equal(res.ok, false, "injection id matches no card -> not found");
	assert.equal(db.prepare("SELECT count(*) c FROM kb_cards").get().c, 5,
		"kb_cards still intact (no DROP executed)");
});
