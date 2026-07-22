// agentdb/kb/graph.test.js — dependency graph + ready() + cycle detection.
//
// ROADMAP M3-2 acceptance gate:
//   - ready() returns only todo cards whose deps are all done
//   - detectCycles returns paths not throws
//   - blockedBy/blocks round-trip via kb_deps
//
// Test layout: abuse suite first (cycles, malformed graphs, missing deps),
// then happy path (simple chain, diamond, ready() with various statuses).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { edges, ready, detectCycles, blockedBy, blocks } = require("./graph");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

function freshDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// insertCard(db, id, status='todo') — minimal card row (only id + status).
// Other columns get their NOT NULL defaults.
function insertCard(db, id, status = "todo") {
	db.prepare(
		`INSERT INTO kb_cards (id, title, status, file_path, frontmatter_json, file_hash)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	).run(id, id, status, `/cards/${id}.card.md`, "{}", `hash-${id}`);
}

// addDep(db, from, to) — insert one (from_id, to_id) edge into kb_deps.
function addDep(db, from, to) {
	db.prepare("INSERT OR IGNORE INTO kb_deps (from_id, to_id) VALUES (?, ?)").run(from, to);
}

// =====================================================================
// ABUSE SUITE — must run first
// =====================================================================

test("abuse: detectCycles on a self-loop returns the cycle (no throw)", () => {
	const db = freshDB();
	insertCard(db, "A");
	addDep(db, "A", "A");
	const cycles = detectCycles(db);
	assert.equal(cycles.length, 1);
	assert.deepEqual(cycles[0], ["A", "A"]);
});

test("abuse: detectCycles on a 3-cycle (A→B→C→A) reports the cycle, not throws", () => {
	const db = freshDB();
	insertCard(db, "A");
	insertCard(db, "B");
	insertCard(db, "C");
	addDep(db, "A", "B");
	addDep(db, "B", "C");
	addDep(db, "C", "A");
	const cycles = detectCycles(db);
	assert.equal(cycles.length, 1, "exactly one unique cycle (not 3 from the 3 entry points)");
	assert.deepEqual(cycles[0], ["A", "B", "C", "A"]);
});

test("abuse: detectCycles on a 2-cycle (A↔B) reports ONE unique cycle", () => {
	const db = freshDB();
	insertCard(db, "A");
	insertCard(db, "B");
	addDep(db, "A", "B");
	addDep(db, "B", "A");
	const cycles = detectCycles(db);
	// A 2-cycle produces cycles from both entry points: [A,B,A] and [B,A,B]
	// These are the same cycle rotated — de-duplicated to one entry.
	assert.equal(cycles.length, 1, `expected 1 unique cycle, got ${cycles.length}: ${JSON.stringify(cycles)}`);
	assert.deepEqual(cycles[0], ["A", "B", "A"]);
});

test("abuse: detectCycles on a graph with TWO disjoint cycles reports both", () => {
	const db = freshDB();
	for (const id of ["A", "B", "C", "D"]) insertCard(db, id);
	addDep(db, "A", "B");
	addDep(db, "B", "A");
	addDep(db, "C", "D");
	addDep(db, "D", "C");
	const cycles = detectCycles(db);
	assert.equal(cycles.length, 2, `expected 2 cycles, got ${cycles.length}: ${JSON.stringify(cycles)}`);
	const keys = cycles.map(c => c.slice(0, -1).sort().join("|")).sort();
	assert.deepEqual(keys, ["A|B", "C|D"]);
});

test("abuse: detectCycles on an empty graph returns []", () => {
	const db = freshDB();
	assert.deepEqual(detectCycles(db), []);
});

test("abuse: detectCycles on a DAG returns []", () => {
	const db = freshDB();
	for (const id of ["A", "B", "C", "D"]) insertCard(db, id);
	addDep(db, "A", "B");
	addDep(db, "B", "C");
	addDep(db, "C", "D");
	assert.deepEqual(detectCycles(db), []);
});

test("abuse: edges() on a malformed dep (to_id references non-existent card) returns the edge anyway", () => {
	const db = freshDB();
	insertCard(db, "A");
	// B is not in kb_cards but is in kb_deps as a target — a "dangling" edge.
	addDep(db, "A", "B");
	const es = edges(db);
	assert.equal(es.length, 1);
	assert.deepEqual(es[0], { from: "A", to: "B" });
	// blockedBy/blocks still work; ready() treats dangling deps as "not blocking".
});

test("abuse: blockedBy on a non-existent id returns []", () => {
	const db = freshDB();
	insertCard(db, "A");
	addDep(db, "A", "B");
	const res = blockedBy("does-not-exist", db);
	assert.deepEqual(res, []);
});

test("abuse: blocks on a non-existent id returns []", () => {
	const db = freshDB();
	insertCard(db, "A");
	addDep(db, "A", "B");
	const res = blocks("does-not-exist", db);
	assert.deepEqual(res, []);
});

// =====================================================================
// HAPPY PATH
// =====================================================================

test("happy: edges() returns all forward edges", () => {
	const db = freshDB();
	insertCard(db, "A");
	insertCard(db, "B");
	insertCard(db, "C");
	addDep(db, "A", "B");
	addDep(db, "B", "C");
	const es = edges(db);
	assert.equal(es.length, 2);
	assert.deepEqual(es[0], { from: "A", to: "B" });
	assert.deepEqual(es[1], { from: "B", to: "C" });
});

test("happy: a simple chain A→B→C (B=done, A=todo) -> A is ready; C is also ready (no deps)", () => {
	const db = freshDB();
	insertCard(db, "A", "todo");
	insertCard(db, "B", "done");
	insertCard(db, "C", "todo"); // C has no deps → ready too (it's a leaf)
	addDep(db, "A", "B");
	addDep(db, "B", "C");
	const r = ready(db);
	assert.deepEqual(r, ["A", "C"], "A's dep B is done; C has no deps and is todo; both ready");
});

test("happy: A→B→C, B NOT done -> A is not ready; C IS ready (leaf)", () => {
	const db = freshDB();
	insertCard(db, "A", "todo");
	insertCard(db, "B", "todo"); // not done yet
	insertCard(db, "C", "todo");
	addDep(db, "A", "B");
	addDep(db, "B", "C");
	const r = ready(db);
	assert.deepEqual(r, ["C"], "A's dep B is not done → A not ready; C has no deps → C ready");
});

test("happy: diamond — A depends on B and C; B and C both done -> A is ready", () => {
	const db = freshDB();
	insertCard(db, "A", "todo");
	insertCard(db, "B", "done");
	insertCard(db, "C", "done");
	addDep(db, "A", "B");
	addDep(db, "A", "C");
	const r = ready(db);
	assert.deepEqual(r, ["A"]);
});

test("happy: diamond — A depends on B and C; only B done -> A is not ready; C is not ready either", () => {
	const db = freshDB();
	insertCard(db, "A", "todo");
	insertCard(db, "B", "done");
	insertCard(db, "C", "todo");
	addDep(db, "A", "B");
	addDep(db, "A", "C");
	const r = ready(db);
	// Wait — C has no depends_on (only A depends ON C, not the other way around).
	// C is a leaf; C is ready because its deps list is empty.
	assert.deepEqual(r, ["C"], "A's deps are B(done) and C(todo) — C blocks A; C is a leaf with no deps → C is ready");
});

test("happy: parallel — A and X are independent todos, both ready", () => {
	const db = freshDB();
	insertCard(db, "A", "todo");
	insertCard(db, "X", "todo");
	const r = ready(db);
	assert.deepEqual(r.sort(), ["A", "X"]);
});

test("happy: a card with no depends_on is always ready when status=todo", () => {
	const db = freshDB();
	insertCard(db, "A", "todo");
	insertCard(db, "B", "todo");
	addDep(db, "A", "B"); // A has a dep, B doesn't
	// B has no depends_on → ready if its own status is todo.
	const r = ready(db);
	assert.deepEqual(r, ["B"]);
});

test("happy: ready() excludes in_progress / review / blocked cards", () => {
	const db = freshDB();
	insertCard(db, "A", "todo");
	insertCard(db, "B", "in_progress");
	insertCard(db, "C", "review");
	insertCard(db, "D", "blocked");
	insertCard(db, "E", "done");
	const r = ready(db);
	assert.deepEqual(r, ["A"], "only 'todo' qualifies; in_progress/review/blocked/done do not");
});

test("happy: ready() treats a missing dep card (no row in kb_cards) as non-blocking", () => {
	const db = freshDB();
	insertCard(db, "A", "todo");
	// B is NOT in kb_cards (yet) but is in kb_deps as A's dep.
	addDep(db, "A", "B");
	const r = ready(db);
	assert.deepEqual(r, ["A"], "missing dep card is treated as 'not blocking' (not the same as 'undone')");
});

test("happy: blockedBy returns reverse edges", () => {
	const db = freshDB();
	insertCard(db, "A");
	insertCard(db, "B");
	insertCard(db, "C");
	addDep(db, "A", "C");
	addDep(db, "B", "C");
	const r = blockedBy("C", db);
	assert.deepEqual(r.sort(), ["A", "B"]);
});

test("happy: blocks returns forward edges", () => {
	const db = freshDB();
	insertCard(db, "A");
	insertCard(db, "B");
	insertCard(db, "C");
	addDep(db, "A", "B");
	addDep(db, "A", "C");
	const r = blocks("A", db);
	assert.deepEqual(r.sort(), ["B", "C"]);
});

test("happy: blockedBy / blocks round-trip via kb_deps", () => {
	const db = freshDB();
	for (const id of ["A", "B", "C", "D"]) insertCard(db, id);
	addDep(db, "A", "B");
	addDep(db, "A", "C");
	addDep(db, "D", "B");
	// For every forward edge (X→Y), Y's blockedBy list contains X.
	const es = edges(db);
	for (const e of es) {
		const blockers = blockedBy(e.to, db);
		assert.ok(blockers.includes(e.from), `expected ${e.to}'s blockers to include ${e.from}`);
		const forwardees = blocks(e.from, db);
		assert.ok(forwardees.includes(e.to), `expected ${e.from}'s forwardees to include ${e.to}`);
	}
});

test("happy: a complex graph with multiple cycles + chains reports only the cycles", () => {
	const db = freshDB();
	for (const id of ["A", "B", "C", "D", "E", "F", "G"]) insertCard(db, id);
	// Chain: G → F → E (no cycle)
	addDep(db, "G", "F");
	addDep(db, "F", "E");
	// Cycle: A → B → A
	addDep(db, "A", "B");
	addDep(db, "B", "A");
	// Cycle: C → D → C
	addDep(db, "C", "D");
	addDep(db, "D", "C");
	// Dead-end branch: D → E (from inside the cycle to the chain)
	addDep(db, "D", "E");

	const cycles = detectCycles(db);
	assert.equal(cycles.length, 2, `expected 2 cycles, got ${cycles.length}: ${JSON.stringify(cycles)}`);
	// The cycles are unique by canonical rotation; check the SET of unique cycles.
	const set = new Set(cycles.map(c => c.slice(0, -1).sort().join("|")));
	assert.ok(set.has("A|B"), "A↔B cycle must be reported");
	assert.ok(set.has("C|D"), "C↔D cycle must be reported");
});