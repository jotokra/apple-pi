// agentdb/pi/deprecation.test.js — M9-6 deprecated read-only alias shim.
//
// ROADMAP M9-6 (SUPERPROMPT §6 module map): kanban-bridge.ts (the OLD pi
// extension: kanban_list_cards / kanban_get_card / kanban_create_card) is
// deprecated in favor of the M9-1/2 tools (kanban_list / kanban_get /
// kanban_create). For ONE release the OLD tool names are kept as a READ-ONLY
// alias: the read names delegate to the new tools and log a deprecation
// notice; the writer (kanban_create_card) is intentionally NOT delegated —
// it answers with a { ok:false, deprecated:true } refusal pointing at
// kanban_create. After this release the whole shim is removed.
//
// REQ-M9-6: "alias still answers; deprecation notice logged."
//   - "alias still answers"  : kanban_list_cards / kanban_get_card return the
//                              SAME result as the M9-1 tools (delegation is
//                              faithful, including the old {status,limit}
//                              param shape being adapted to {filters,opts}).
//   - "deprecation logged"   : each call emits exactly one notice naming the
//                              old tool + its replacement.
//   - "read-only"            : kanban_create_card performs NO write.
//
// Test shape mirrors pi/list.test.js (seed + assert) + the injectable-logger
// convention (options.logger) used across the agentdb/pi tools (options.db).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const {
	notice,
	kanban_list_cards,
	kanban_get_card,
	kanban_create_card,
} = require("./deprecation");
const { kanban_list, kanban_get } = require("./list");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

// --- shared helpers (mirror pi/list.test.js) ---

function freshDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

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

function seed(db) {
	insertCard(db, { id: "a-todo", title: "A todo", status: "todo", project: "alpha", priority: 5, tags: ["m9"], assignee: "alice", body: "A body." });
	insertCard(db, { id: "b-todo", title: "B todo", status: "todo", project: "alpha", priority: 3, tags: ["m9"], assignee: "bob" });
	insertCard(db, { id: "c-progress", title: "C in progress", status: "in_progress", project: "alpha", priority: 7, tags: ["m9"], assignee: "alice" });
	insertCard(db, { id: "d-blocked", title: "D blocked", status: "blocked", project: "beta", priority: 2, tags: ["m9"], assignee: null });
	insertCard(db, { id: "e-done", title: "E done", status: "done", project: "beta", priority: 9, tags: ["m9"], assignee: "carol" });
	db.prepare("INSERT INTO kb_deps (from_id, to_id) VALUES (?,?)").run("c-progress", "a-todo");
}

const noop = () => {};
const sink = () => {
	const calls = [];
	calls.push = ((push) => (m) => { push.call(calls, m); })(Array.prototype.push);
	return calls;
};

// =====================================================================
// notice() — the reusable deprecation logger
// =====================================================================

test("notice logs exactly one line naming the old tool + its replacement", () => {
	const lines = [];
	notice("kanban_list_cards", "kanban_list", { logger: (m) => lines.push(m) });
	assert.equal(lines.length, 1, "exactly one notice per call");
	assert.match(lines[0], /kanban_list_cards/, "notice names the deprecated tool");
	assert.match(lines[0], /kanban_list/, "notice names the replacement");
	assert.match(lines[0], /deprecat/i, "notice says it is deprecated");
	assert.match(lines[0], /removed/i, "notice signals scheduled removal");
});

test("notice never throws even if the logger throws (logging must not break callers)", () => {
	assert.doesNotThrow(() =>
		notice("a", "b", { logger: () => { throw new Error("log sink down"); } }),
	);
});

test("notice defaults to console.warn when no logger is given", () => {
	const original = console.warn;
	let captured = null;
	console.warn = (m) => { captured = m; };
	try {
		notice("old_name", "new_name");
	} finally {
		console.warn = original;
	}
	assert.match(captured, /old_name/);
	assert.match(captured, /new_name/);
});

// =====================================================================
// kanban_list_cards — alias still answers + logs
// =====================================================================

test("kanban_list_cards still answers: returns the SAME result as kanban_list", () => {
	const db = freshDB();
	seed(db);
	const aliasRes = kanban_list_cards({ db, logger: noop });
	const directRes = kanban_list({ db });
	assert.equal(aliasRes.ok, true, "alias answers ok");
	assert.deepEqual(aliasRes, directRes, "alias delegates faithfully to kanban_list");
	assert.equal(aliasRes.rows.length, 5);
});

test("kanban_list_cards logs one deprecation notice per call", () => {
	const db = freshDB();
	seed(db);
	const lines = [];
	kanban_list_cards({ db, logger: (m) => lines.push(m) });
	assert.equal(lines.length, 1);
	assert.match(lines[0], /kanban_list_cards/);
	assert.match(lines[0], /kanban_list/);
});

test("kanban_list_cards adapts the OLD {status} param to the new {filters} shape", () => {
	const db = freshDB();
	seed(db);
	// OLD kanban-bridge took {status}; the alias must narrow, not silently no-op.
	const res = kanban_list_cards({ db, status: "todo", logger: noop });
	assert.equal(res.ok, true);
	assert.deepEqual(res.rows.map(r => r.id).sort(), ["a-todo", "b-todo"],
		"old status filter is honored via the new kanban_list filters");
});

test("kanban_list_cards adapts the OLD {limit} param to the new {opts} shape", () => {
	const db = freshDB();
	seed(db);
	const res = kanban_list_cards({ db, limit: 2, logger: noop });
	assert.equal(res.ok, true);
	assert.equal(res.rows.length, 2, "old limit is honored via the new kanban_list opts");
});

test("kanban_list_cards result is JSON-serializable (the pi harness round-trips it)", () => {
	const db = freshDB();
	seed(db);
	const res = kanban_list_cards({ db, logger: noop });
	const back = JSON.parse(JSON.stringify(res));
	assert.equal(back.ok, true);
	assert.equal(back.rows.length, 5);
});

// =====================================================================
// kanban_get_card — alias still answers + logs
// =====================================================================

test("kanban_get_card still answers: returns the SAME card as kanban_get", () => {
	const db = freshDB();
	seed(db);
	const aliasRes = kanban_get_card("c-progress", { db, logger: noop });
	const directRes = kanban_get("c-progress", { db });
	assert.equal(aliasRes.ok, true, "alias answers ok");
	assert.deepEqual(aliasRes, directRes, "alias delegates faithfully to kanban_get");
	assert.equal(aliasRes.card.id, "c-progress");
	assert.deepEqual(aliasRes.card.deps, ["a-todo"]);
});

test("kanban_get_card logs one deprecation notice per call", () => {
	const db = freshDB();
	seed(db);
	const lines = [];
	kanban_get_card("a-todo", { db, logger: (m) => lines.push(m) });
	assert.equal(lines.length, 1);
	assert.match(lines[0], /kanban_get_card/);
	assert.match(lines[0], /kanban_get/);
});

test("kanban_get_card on a missing id returns { ok:false } (no throw)", () => {
	const db = freshDB();
	seed(db);
	const res = kanban_get_card("nope", { db, logger: noop });
	assert.equal(res.ok, false);
	assert.ok(typeof res.error === "string" && res.error.length > 0);
});

// =====================================================================
// kanban_create_card — READ-ONLY: the writer is intentionally NOT aliased
// =====================================================================

test("kanban_create_card is read-only: answers with a deprecation refusal, performs NO write", () => {
	const db = freshDB();
	seed(db);
	const before = db.prepare("SELECT count(*) c FROM kb_cards").get().c;
	const res = kanban_create_card({
		title: "sneaky", body: "should not land", logger: noop, db,
	});
	// the read-only release refuses instead of delegating to kanban_create
	assert.equal(res.ok, false, "writer is not aliased in the read-only release");
	assert.equal(res.deprecated, true, "result is flagged deprecated");
	assert.match(res.error, /kanban_create/i, "refusal points at the replacement writer");
	// NO write occurred
	const after = db.prepare("SELECT count(*) c FROM kb_cards").get().c;
	assert.equal(after, before, "read-only alias performed no write");
});

test("kanban_create_card still logs a deprecation notice", () => {
	const lines = [];
	kanban_create_card({ title: "x", logger: (m) => lines.push(m) });
	assert.equal(lines.length, 1);
	assert.match(lines[0], /kanban_create_card/);
	assert.match(lines[0], /kanban_create/);
});

// =====================================================================
// RED-BLUE — logging must never break the alias
// =====================================================================

test("abuse: a throwing logger does not break kanban_list_cards (alias still answers)", () => {
	const db = freshDB();
	seed(db);
	const res = kanban_list_cards({
		db,
		logger: () => { throw new Error("log sink down"); },
	});
	assert.equal(res.ok, true, "alias answers even when the logger throws");
	assert.equal(res.rows.length, 5);
});

test("abuse: a throwing logger does not break kanban_create_card", () => {
	assert.doesNotThrow(() =>
		kanban_create_card({ logger: () => { throw new Error("log sink down"); } }),
	);
});
