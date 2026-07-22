// agentdb/pi/next.test.js — pi agent tools kanban_next / kanban_graph (M9-3).
//
// ROADMAP M9-3 acceptance gate (REQ-M9-3): "next is WIP+ready-aware." These
// are the testable JS core of the pi tools; the pi extension (.ts harness
// binding) is a thin wrapper over this module (M9-6).
//
// What "WIP+ready-aware" means, concretely:
//   - kanban_next recomputes the WIP state (count of in_progress cards vs the
//     KANBAN_WIP limit, M0-2 / D5 default 3) and the ready set (todo cards
//     whose depends_on are all done, M3-2). It recommends the highest-priority
//     ready card ONLY when under the WIP limit. At/over the limit the ready
//     pick is HELD (reported via heldId, NOT recommended as next) so the
//     operator finishes an in_progress card first — the exact M8-2 CLI contract.
//   - kanban_graph returns the agent-actionable projection: the ready set +
//     blockedBy, a map of each card to the EXISTING depends_on deps that are
//     not yet done (the "why can't I start X" answer; mirrors ready()'s rule
//     that a missing dep card is non-blocking, so dangling deps never appear).
//   - both paths are best-effort/no-throw: { ok:false, error } on a failure,
//     never an exception. both work in TWO modes (mirrors pi/list.js): (a) an
//     injected db (tests / composition — caller owns the connection +
//     freshness, no open/close, no reconcile), and (b) opening their OWN
//     connection via lib/db.open() + lazy ensureCurrent reconcile (the real
//     "pi harness" path — correct with no manual index).
//
// Test shape mirrors kb/graph.test.js (ready / blockedBy semantics) +
// pi/list.test.js (the injected-db vs opens-own-db two-mode pattern).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { kanban_next, kanban_graph } = require("./next");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

// --- shared helpers (mirror pi/list.test.js) ---

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

// addDep(db, from, to) — insert one (from_id, to_id) forward edge into kb_deps.
// from depends_on to (D6: forward-only; blocks is derived).
function addDep(db, from, to) {
	db.prepare("INSERT OR IGNORE INTO kb_deps (from_id, to_id) VALUES (?, ?)").run(from, to);
}

// seedNext(db) — a graph that exercises every branch of kanban_next/graph:
//   a-done   done         p=9   (a completed high-priority card; dep target)
//   b-todo   todo         p=5   depends_on a-done  -> READY (dep done)
//   c-todo   todo         p=7   depends_on b-todo  -> NOT ready (b not done); blockedBy=[b-todo]
//   d-todo   todo         p=3   (no deps)          -> READY
//   e-prog   in_progress  p=8   (WIP)
//   f-prog   in_progress  p=1   (WIP)
// Default WIP limit 3 -> in_progress count 2 < 3 -> UNDER limit.
function seedNext(db) {
	insertCard(db, { id: "a-done", title: "A done", status: "done", priority: 9 });
	insertCard(db, { id: "b-todo", title: "B todo", status: "todo", priority: 5 });
	insertCard(db, { id: "c-todo", title: "C todo", status: "todo", priority: 7 });
	insertCard(db, { id: "d-todo", title: "D todo", status: "todo", priority: 3 });
	insertCard(db, { id: "e-prog", title: "E in progress", status: "in_progress", priority: 8 });
	insertCard(db, { id: "f-prog", title: "F in progress", status: "in_progress", priority: 1 });
	addDep(db, "b-todo", "a-done"); // b depends on a (done) -> b ready
	addDep(db, "c-todo", "b-todo"); // c depends on b (todo) -> c NOT ready
}

// CARD_HEAD(id, title, status, deps) -> a .card.md body for the opens-own-db
// fixture path (same template as pi/list.test.js so the fixture parses cleanly).
function CARD_HEAD(id, title, status, priority, deps = "[]") {
	return [
		"---",
		`id: ${id}`,
		`title: ${title}`,
		`status: ${status}`,
		`priority: ${priority}`,
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
// kanban_next — injected-db, UNDER the WIP limit (the happy recommendation)
// =====================================================================

test("kanban_next under the WIP limit recommends the highest-priority ready card", () => {
	const db = freshDB();
	seedNext(db);
	const res = kanban_next({ db });
	assert.equal(res.ok, true);

	// WIP state: 2 in_progress, default limit 3, NOT at limit.
	assert.deepEqual(res.wip, { count: 2, limit: 3, atLimit: false });

	// ready set = {b-todo, d-todo} sorted; inProgress = {e-prog, f-prog} sorted.
	assert.deepEqual(res.ready, ["b-todo", "d-todo"]);
	assert.deepEqual(res.inProgress, ["e-prog", "f-prog"]);

	// b-todo (p=5) outranks d-todo (p=3) by priority DESC -> recommended.
	assert.equal(res.next, "b-todo");
	assert.equal(res.held, false, "under the limit -> nothing is held");
	assert.equal(res.heldId, null);
});

test("kanban_next result is JSON-serializable (the pi harness round-trips it)", () => {
	const db = freshDB();
	seedNext(db);
	const res = kanban_next({ db });
	const json = JSON.stringify(res);
	const back = JSON.parse(json);
	assert.equal(back.ok, true);
	assert.equal(back.next, "b-todo");
	assert.deepEqual(back.wip, { count: 2, limit: 3, atLimit: false });
});

test("kanban_next respects KANBAN_WIP env override (tighter limit -> atLimit)", () => {
	const db = freshDB();
	seedNext(db);
	const prev = process.env.KANBAN_WIP;
	process.env.KANBAN_WIP = "2"; // 2 in_progress == limit -> AT limit
	try {
		const res = kanban_next({ db });
		assert.equal(res.ok, true);
		assert.deepEqual(res.wip, { count: 2, limit: 2, atLimit: true },
			"KANBAN_WIP=2 + 2 in_progress -> at limit");
		// at the limit the ready pick is HELD, not recommended.
		assert.equal(res.next, null, "at limit -> next is null (held)");
		assert.equal(res.held, true, "a ready card exists but is held by WIP");
		assert.equal(res.heldId, "b-todo", "the would-be pick is reported as heldId");
		// the ready + in_progress sets are still surfaced so the operator can act.
		assert.deepEqual(res.ready, ["b-todo", "d-todo"]);
		assert.deepEqual(res.inProgress, ["e-prog", "f-prog"]);
	} finally {
		if (prev === undefined) delete process.env.KANBAN_WIP; else process.env.KANBAN_WIP = prev;
	}
});

test("kanban_next KANBAN_WIP override LARGER -> comfortably under limit", () => {
	const db = freshDB();
	seedNext(db);
	const prev = process.env.KANBAN_WIP;
	process.env.KANBAN_WIP = "5";
	try {
		const res = kanban_next({ db });
		assert.equal(res.ok, true);
		assert.deepEqual(res.wip, { count: 2, limit: 5, atLimit: false });
		assert.equal(res.next, "b-todo");
		assert.equal(res.held, false);
	} finally {
		if (prev === undefined) delete process.env.KANBAN_WIP; else process.env.KANBAN_WIP = prev;
	}
});

test("kanban_next with no ready cards -> next null, held false", () => {
	const db = freshDB();
	// two todo cards in a dep cycle: each depends on a not-done card -> neither
	// ready, and there are no done leaves / deps-free todos to be ready instead.
	insertCard(db, { id: "a-todo", title: "A todo", status: "todo", priority: 5 });
	insertCard(db, { id: "b-todo", title: "B todo", status: "todo", priority: 7 });
	addDep(db, "a-todo", "b-todo"); // a depends on b (todo, not done) -> a NOT ready
	addDep(db, "b-todo", "a-todo"); // b depends on a (todo, not done) -> b NOT ready
	const res = kanban_next({ db });
	assert.equal(res.ok, true);
	assert.deepEqual(res.ready, [], "no card is ready");
	assert.equal(res.next, null);
	assert.equal(res.held, false, "nothing ready -> nothing to hold");
	assert.equal(res.heldId, null);
});

test("kanban_next pick orders ready by priority DESC NULLS LAST then id ASC", () => {
	const db = freshDB();
	// three independent ready todos with mixed priorities incl. a null.
	insertCard(db, { id: "p-null", title: "null pri", status: "todo", priority: null });
	insertCard(db, { id: "p-2", title: "pri 2", status: "todo", priority: 2 });
	insertCard(db, { id: "p-9", title: "pri 9", status: "todo", priority: 9 });
	const res = kanban_next({ db });
	assert.equal(res.ok, true);
	assert.equal(res.next, "p-9", "highest priority wins");
	// bump the top out -> next is p-2 (null sinks below numbered).
	db.prepare("UPDATE kb_cards SET status='done' WHERE id='p-9'").run();
	const res2 = kanban_next({ db });
	assert.equal(res2.next, "p-2", "null-priority sinks below numbered priorities");
});

// =====================================================================
// kanban_next — opens-OWN-db path (the real "pi harness" path)
// =====================================================================

test("kanban_next with NO injected db opens AGENT_DB, reconciles, recommends", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-next-root-"));
	makeTree(root, [
		// under WIP limit (no in_progress), one ready todo -> the pick.
		{ path: "cards/a.card.md", content: CARD_HEAD("a", "Card A", "done", 9) },
		{ path: "cards/b.card.md", content: CARD_HEAD("b", "Card B", "todo", 5, "[a]") },
		{ path: "cards/c.card.md", content: CARD_HEAD("c", "Card C", "todo", 3, "[b]") },
	]);
	const tmpDb = path.join(os.tmpdir(), `pi-next-db-${process.pid}-${Date.now()}.sqlite`);
	process.env.AGENT_DB = tmpDb;
	try {
		const res = kanban_next({ root });
		assert.equal(res.ok, true, "opens-own-db path must succeed");
		// no in_progress -> under default limit 3.
		assert.deepEqual(res.wip, { count: 0, limit: 3, atLimit: false });
		// b's dep a is done -> b ready; c's dep b is todo -> c NOT ready.
		assert.deepEqual(res.ready, ["b"]);
		assert.equal(res.next, "b", "b is the only ready card -> the pick");
		assert.equal(res.held, false);
		assert.ok(fs.existsSync(tmpDb), "AGENT_DB file was created by open()");
	} finally {
		delete process.env.AGENT_DB;
		try { fs.unlinkSync(tmpDb); } catch (_) {}
		try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
	}
});

// =====================================================================
// kanban_graph — ready + blockedBy projection
// =====================================================================

test("kanban_graph returns the ready set + a blockedBy map of unmet deps", () => {
	const db = freshDB();
	seedNext(db);
	const res = kanban_graph({ db });
	assert.equal(res.ok, true);

	// ready = todo cards whose deps are all done: {b-todo, d-todo}.
	assert.deepEqual(res.ready, ["b-todo", "d-todo"]);

	// blockedBy: only cards with an EXISTING, not-done dep appear. c-todo
	// depends on b-todo (todo, not done) -> blocked. b-todo depends on a-done
	// (done) -> NOT blocked. d-todo / e-prog / f-prog have no deps -> not blocked.
	assert.deepEqual(res.blockedBy, { "c-todo": ["b-todo"] });
});

test("kanban_graph result is JSON-serializable", () => {
	const db = freshDB();
	seedNext(db);
	const res = kanban_graph({ db });
	const json = JSON.stringify(res);
	const back = JSON.parse(json);
	assert.equal(back.ok, true);
	assert.deepEqual(back.ready, ["b-todo", "d-todo"]);
	assert.deepEqual(back.blockedBy, { "c-todo": ["b-todo"] });
});

test("kanban_graph blockedBy lists are sorted + only non-done EXISTING deps (dangling is non-blocking)", () => {
	const db = freshDB();
	// x-todo depends on two not-done cards (sorted) + one DANGLING dep (no row).
	insertCard(db, { id: "x-todo", title: "X", status: "todo", priority: 1 });
	insertCard(db, { id: "m-block", title: "M", status: "blocked", priority: 1 });
	insertCard(db, { id: "n-prog", title: "N", status: "in_progress", priority: 1 });
	insertCard(db, { id: "z-done", title: "Z", status: "done", priority: 1 });
	addDep(db, "x-todo", "z-done"); // done -> NOT a blocker
	addDep(db, "x-todo", "n-prog"); // in_progress -> blocker
	addDep(db, "x-todo", "m-block"); // blocked -> blocker
	addDep(db, "x-todo", "ghost"); // DANGLING (no kb_cards row) -> non-blocking (mirrors ready())
	const res = kanban_graph({ db });
	assert.equal(res.ok, true);
	// x-todo has unmet deps -> NOT ready (ghost + z-done are non-blocking; m/n block).
	assert.ok(!res.ready.includes("x-todo"));
	assert.deepEqual(res.blockedBy, { "x-todo": ["m-block", "n-prog"] },
		"sorted; z-done dropped (done); ghost dropped (dangling/non-blocking)");
});

test("kanban_graph on an empty kb -> ready [], blockedBy {}", () => {
	const db = freshDB();
	const res = kanban_graph({ db });
	assert.equal(res.ok, true);
	assert.deepEqual(res.ready, []);
	assert.deepEqual(res.blockedBy, {});
});

test("kanban_graph on a DAG with no unmet deps -> ready non-empty, blockedBy {}", () => {
	const db = freshDB();
	insertCard(db, { id: "a", title: "A", status: "done", priority: 1 });
	insertCard(db, { id: "b", title: "B", status: "todo", priority: 1 });
	addDep(db, "b", "a"); // b depends on a (done) -> b ready, no blocker
	const res = kanban_graph({ db });
	assert.equal(res.ok, true);
	assert.deepEqual(res.ready, ["b"]);
	assert.deepEqual(res.blockedBy, {}, "b's only dep is done -> no blockers");
});

// =====================================================================
// kanban_graph — opens-OWN-db path
// =====================================================================

test("kanban_graph with NO injected db opens AGENT_DB + reconciles + projects", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-graph-root-"));
	makeTree(root, [
		{ path: "cards/a.card.md", content: CARD_HEAD("a", "Card A", "done", 9) },
		{ path: "cards/b.card.md", content: CARD_HEAD("b", "Card B", "todo", 5, "[a]") },
		{ path: "cards/c.card.md", content: CARD_HEAD("c", "Card C", "todo", 3, "[b]") },
	]);
	const tmpDb = path.join(os.tmpdir(), `pi-graph-db-${process.pid}-${Date.now()}.sqlite`);
	process.env.AGENT_DB = tmpDb;
	try {
		const res = kanban_graph({ root });
		assert.equal(res.ok, true);
		// b's dep a is done -> b ready; c's dep b is todo -> c blocked by b.
		assert.deepEqual(res.ready, ["b"]);
		assert.deepEqual(res.blockedBy, { "c": ["b"] });
	} finally {
		delete process.env.AGENT_DB;
		try { fs.unlinkSync(tmpDb); } catch (_) {}
		try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
	}
});

// =====================================================================
// best-effort / no-throw
// =====================================================================

test("kanban_next on a db with no cards at all -> ok:true, next null, empty sets", () => {
	const db = freshDB();
	const res = kanban_next({ db });
	assert.equal(res.ok, true);
	assert.deepEqual(res.wip, { count: 0, limit: 3, atLimit: false });
	assert.deepEqual(res.ready, []);
	assert.deepEqual(res.inProgress, []);
	assert.equal(res.next, null);
	assert.equal(res.held, false);
});
