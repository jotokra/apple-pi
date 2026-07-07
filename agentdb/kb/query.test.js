// agentdb/kb/query.test.js — RED-BLUE abuse suite + happy path for kb_cards
// filter queries (M3-1).
//
// ROADMAP M3-1 acceptance gate:
//   - filters AND-compose correctly
//   - SQL-injection attempts are treated as literal values (no exec, no error)
//   - range priority works
//   - unknown keys ignored (forward-compat)
//   - no rows leak across projects
//
// The abuse suite runs FIRST: any test that touches a SQL-injection attempt
// asserts the query returns the literal value AS DATA, not as SQL. The query
// layer uses ? placeholders + bind() exclusively; we verify this end-to-end
// by inserting known rows, sending a malicious filter, and asserting the
// malicious filter either (a) matched nothing because no row has that
// literal value, or (b) returned ZERO rows from the legitimate set.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { list } = require("./query");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

// freshDB() — in-memory kb with schema applied. Same pattern as schema.test.js.
function freshDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// insertCard(db, fields) — direct insert into kb_cards (skipping the rebuild
// path for speed). Sets file_hash to a unique value per row so we don't
// violate the PRIMARY KEY (id) constraint; file_path is required.
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
		f.file_hash || `hash-${f.id}-${Math.random().toString(36).slice(2,8)}`,
	);
}

// seed(db) — insert a representative fixture: 5 cards across 2 projects,
// 3 statuses, mix of priorities/tags/assignees. Only d-blocked has
// assignee:null so the "assignee:null matches" happy-path test is unambiguous.
function seed(db) {
	insertCard(db, { id: "a-todo", title: "A todo", status: "todo", project: "alpha", priority: 5, tags: ["m3", "ready"], assignee: "alice" });
	insertCard(db, { id: "b-todo", title: "B todo", status: "todo", project: "alpha", priority: 3, tags: ["m3"], assignee: "bob" });
	insertCard(db, { id: "c-progress", title: "C in progress", status: "in_progress", project: "alpha", priority: 7, tags: ["m3", "urgent"], assignee: "alice" });
	insertCard(db, { id: "d-blocked", title: "D blocked", status: "blocked", project: "beta", priority: 2, tags: ["m3"], assignee: null });
	insertCard(db, { id: "e-done", title: "E done", status: "done", project: "beta", priority: 9, tags: ["m3", "shipped"], assignee: "carol" });
}

// =====================================================================
// ABUSE SUITE — RED-BLUE — must run first
// =====================================================================

test("abuse: SQL injection via project filter is treated as literal value", () => {
	const db = freshDB();
	seed(db);
	// The classic 'OR 1=1 injection. If this were string-concatenated into the
	// SQL, it would dump every row. With bind(), it's just a literal string
	// that doesn't match any project column → 0 rows.
	const res = list(db, { project: "' OR '1'='1" });
	assert.equal(res.ok, true, "the query must not throw — the value is a string");
	assert.equal(res.rows.length, 0, "no row should match the literal injection as a project");
});

test("abuse: SQL injection via status filter with DROP attempt is rejected (any layer)", () => {
	const db = freshDB();
	seed(db);
	const malicious = "todo'; DROP TABLE kb_cards;--";
	const res = list(db, { status: malicious });
	// Two layers of defense:
	//   1. status must be in STATUS_ENUM (string not in the enum is rejected here)
	//   2. node:sqlite refuses to prepare multi-statement SQL (catches anything
	//      that slips past layer 1)
	// Either is a successful defense — the injection never reaches the table.
	assert.equal(res.ok, false, "the malicious status must be rejected (enum or prepare-time)");
	assert.ok(res.errors.length > 0, "expected at least one error message");

	// The table must STILL exist and be untouched (the most important assertion).
	const stillThere = db.prepare("SELECT COUNT(*) as n FROM kb_cards").get();
	assert.equal(stillThere.n, 5, "kb_cards must still have all 5 rows after injection attempt");
});

test("abuse: UNION SELECT injection via filter is rejected (any layer)", () => {
	const db = freshDB();
	seed(db);
	const malicious = "todo' UNION SELECT id,id,id,id,id,id,id,'[]',id,'','','','x' FROM kb_cards--";
	const res = list(db, { status: malicious });
	assert.equal(res.ok, false, "the malicious status must be rejected");
	assert.ok(res.errors.length > 0);

	const stillThere = db.prepare("SELECT COUNT(*) as n FROM kb_cards").get();
	assert.equal(stillThere.n, 5);
});

test("abuse: project filter accepts injection-shaped strings as literal values (no enum defense for project)", () => {
	const db = freshDB();
	seed(db);
	// Project has no enum whitelist — only string-length check. So this must
	// reach the SQL prepare layer, where node:sqlite rejects multi-statement
	// SQL. The successful defense is "prepare fails" — verify that.
	const malicious = "alpha' OR '1'='1";
	const res = list(db, { project: malicious });
	// Prepare fails because the injected SQL contains single-quotes that are
	// bound as a parameter — but the multi-statement `'; DROP` form would
	// be rejected. Single-quote-within-string is legal SQL, just won't match.
	// In this case, the literal value is bound and no row matches.
	assert.equal(res.ok, true, "single-statement literal is bound as a parameter");
	assert.equal(res.rows.length, 0);

	// The table is untouched.
	const stillThere = db.prepare("SELECT COUNT(*) as n FROM kb_cards").get();
	assert.equal(stillThere.n, 5);
});

test("abuse: non-string values for string filters are rejected loudly", () => {
	const db = freshDB();
	seed(db);
	const cases = [
		{ status: 42 },
		{ status: true },
		{ status: { nested: "object" } },
		{ project: ["array", "of", "strings"] },
		{ project: "" },
		{ assignee: "" },
		{ parent: 7 },
	];
	for (const f of cases) {
		const res = list(db, f);
		assert.equal(res.ok, false, `expected reject for ${JSON.stringify(f)}`);
		assert.ok(res.errors.length > 0);
	}
});

test("abuse: bad priority values are rejected loudly (no silent coercion)", () => {
	const db = freshDB();
	seed(db);
	const bad = [
		{ priority: -1 },
		{ priority: 10 },
		{ priority: 3.14 },
		{ priority: "high" },
		{ priority: { min: "5" } },
		{ priority: { min: 5, max: 3 } },  // min > max
		{ priority: { min: -1 } },
		{ priority: { max: 100 } },
	];
	for (const f of bad) {
		const res = list(db, f);
		assert.equal(res.ok, false, `expected reject for priority=${JSON.stringify(f.priority)}`);
	}
});

test("abuse: bad tag values are rejected loudly", () => {
	const db = freshDB();
	seed(db);
	const bad = [
		{ tag: "" },
		{ tag: [123] },
		{ tag: ["ok", 42] },
		{ tag: [null] },
		{ tag: { object: true } },
	];
	for (const f of bad) {
		const res = list(db, f);
		assert.equal(res.ok, false, `expected reject for tag=${JSON.stringify(f.tag)}`);
	}
});

test("abuse: unknown filter keys are silently ignored (forward-compat)", () => {
	const db = freshDB();
	seed(db);
	const res = list(db, {
		status: "todo",
		unknown_key: "ignored",
		another_new_filter: { fancy: true },
		sql_injection_attempt: "'; DROP TABLE kb_cards;--",
	});
	assert.equal(res.ok, true);
	assert.equal(res.rows.length, 2, "the legitimate status:todo filter must still work despite unknown keys");
});

test("abuse: opts.orderBy injection is rejected (whitelist enforced)", () => {
	const db = freshDB();
	seed(db);
	const bad = [
		{ orderBy: "id; DROP TABLE kb_cards;--" },
		{ orderBy: "*" },
		{ orderBy: "" },
		{ orderBy: 42 },
		{ orderBy: "frontmatter_json" },  // exists but not whitelisted
	];
	for (const o of bad) {
		const res = list(db, {}, o);
		assert.equal(res.ok, false, `expected reject for orderBy=${JSON.stringify(o.orderBy)}`);
	}
});

test("abuse: opts.orderDir must be 'ASC' or 'DESC' when provided (null = use default)", () => {
	const db = freshDB();
	seed(db);
	// null is "use default" — legal, not a rejection. Only string values
	// outside the whitelist are rejected.
	const bad = ["asc", "desc", "ASC; DROP TABLE kb_cards", "", 42];
	for (const d of bad) {
		const res = list(db, {}, { orderDir: d });
		assert.equal(res.ok, false, `expected reject for orderDir=${JSON.stringify(d)}`);
	}
	// null = "no override" → uses default ("DESC").
	const ok1 = list(db, {}, { orderDir: null });
	assert.equal(ok1.ok, true);
	// undefined = not present → also uses default.
	const ok2 = list(db, {}, {});
	assert.equal(ok2.ok, true);
});

test("abuse: opts.limit must be a positive integer", () => {
	const db = freshDB();
	seed(db);
	const bad = [0, -1, 1.5, "10", null, true];
	for (const l of bad) {
		const res = list(db, {}, { limit: l });
		// null means "no limit" (legal); the rest are rejected.
		if (l === null) {
			assert.equal(res.ok, true);
		} else {
			assert.equal(res.ok, false, `expected reject for limit=${JSON.stringify(l)}`);
		}
	}
});

test("abuse: filters and opts must be plain objects (not arrays, not null)", () => {
	const db = freshDB();
	seed(db);
	assert.equal(list(db, null).ok, false);
	assert.equal(list(db, []).ok, false);
	assert.equal(list(db, "string").ok, false);
	assert.equal(list(db, {}, null).ok, false);
	assert.equal(list(db, {}, []).ok, false);
	assert.equal(list(db, {}, "string").ok, false);
});

// =====================================================================
// HAPPY PATH — round-trip + AND-compose + ordering + range
// =====================================================================

test("happy: empty filters return every card", () => {
	const db = freshDB();
	seed(db);
	const res = list(db);
	assert.equal(res.ok, true);
	assert.equal(res.rows.length, 5);
	// Default ordering: priority DESC NULLS LAST, id ASC.
	// 9 (e), 7 (c), 5 (a), 3 (b), 2 (d).
	assert.deepEqual(res.rows.map(r => r.id), ["e-done", "c-progress", "a-todo", "b-todo", "d-blocked"]);
});

test("happy: status filter narrows correctly", () => {
	const db = freshDB();
	seed(db);
	const res = list(db, { status: "todo" });
	assert.equal(res.ok, true);
	assert.equal(res.rows.length, 2);
	assert.deepEqual(res.rows.map(r => r.id).sort(), ["a-todo", "b-todo"]);
});

test("happy: project filter narrows correctly", () => {
	const db = freshDB();
	seed(db);
	const alpha = list(db, { project: "alpha" });
	assert.equal(alpha.rows.length, 3);
	assert.ok(alpha.rows.every(r => r.project === "alpha"));
	const beta = list(db, { project: "beta" });
	assert.equal(beta.rows.length, 2);
	assert.ok(beta.rows.every(r => r.project === "beta"));
});

test("happy: assignee filter narrows correctly", () => {
	const db = freshDB();
	seed(db);
	const alice = list(db, { assignee: "alice" });
	assert.equal(alice.rows.length, 2);
	assert.ok(alice.rows.every(r => r.assignee === "alice"));
});

test("happy: assignee: null matches cards with no assignee", () => {
	const db = freshDB();
	seed(db);
	const res = list(db, { assignee: null });
	assert.equal(res.ok, true);
	assert.equal(res.rows.length, 1);
	assert.equal(res.rows[0].id, "d-blocked");
});

test("happy: tag filter matches ANY-of", () => {
	const db = freshDB();
	seed(db);
	const urgent = list(db, { tag: "urgent" });
	assert.equal(urgent.rows.length, 1);
	assert.equal(urgent.rows[0].id, "c-progress");

	const tags = list(db, { tag: ["ready", "shipped"] });
	assert.equal(tags.rows.length, 2);
	assert.deepEqual(tags.rows.map(r => r.id).sort(), ["a-todo", "e-done"]);
});

test("happy: priority exact match", () => {
	const db = freshDB();
	seed(db);
	const res = list(db, { priority: 5 });
	assert.equal(res.rows.length, 1);
	assert.equal(res.rows[0].id, "a-todo");
});

test("happy: priority range {min,max} both inclusive", () => {
	const db = freshDB();
	seed(db);
	// 3 <= priority <= 7 → b-todo (3), a-todo (5), c-progress (7).
	const res = list(db, { priority: { min: 3, max: 7 } });
	assert.equal(res.rows.length, 3);
	assert.deepEqual(res.rows.map(r => r.id).sort(), ["a-todo", "b-todo", "c-progress"]);
});

test("happy: priority range with only min (no max)", () => {
	const db = freshDB();
	seed(db);
	// priority >= 5 → a-todo (5), c-progress (7), e-done (9).
	const res = list(db, { priority: { min: 5 } });
	assert.equal(res.rows.length, 3);
	assert.deepEqual(res.rows.map(r => r.id).sort(), ["a-todo", "c-progress", "e-done"]);
});

test("happy: priority range with only max (no min)", () => {
	const db = freshDB();
	seed(db);
	// priority <= 3 → b-todo (3), d-blocked (2).
	const res = list(db, { priority: { max: 3 } });
	assert.equal(res.rows.length, 2);
	assert.deepEqual(res.rows.map(r => r.id).sort(), ["b-todo", "d-blocked"]);
});

test("happy: filters AND-compose (status AND project AND tag)", () => {
	const db = freshDB();
	seed(db);
	const res = list(db, { status: "todo", project: "alpha", tag: ["m3", "ready"] });
	assert.equal(res.rows.length, 2);
	assert.deepEqual(res.rows.map(r => r.id).sort(), ["a-todo", "b-todo"]);

	// Narrow further: status=todo AND project=alpha AND tag=ready → only a-todo
	const res2 = list(db, { status: "todo", project: "alpha", tag: "ready" });
	assert.equal(res2.rows.length, 1);
	assert.equal(res2.rows[0].id, "a-todo");
});

test("happy: rows expose the right columns (no frontmatter_json, no body, no file_hash)", () => {
	const db = freshDB();
	seed(db);
	const res = list(db, { id: "a-todo" }, {});  // shouldn't match (id is not a filter); use status
	const r2 = list(db, { status: "todo" });
	const card = r2.rows[0];
	assert.ok("id" in card);
	assert.ok("title" in card);
	assert.ok("status" in card);
	assert.ok("priority" in card);
	assert.ok("project" in card);
	assert.ok("assignee" in card);
	assert.ok("parent" in card);
	assert.ok("tags" in card, "tags must be hydrated to an array");
	assert.ok(Array.isArray(card.tags));
	assert.ok("file_path" in card);
	assert.ok("updated_at" in card);
	// Must NOT expose the raw JSON blob or the file body (the kb is an INDEX,
	// not the truth — the truth is the .card.md file).
	assert.ok(!("frontmatter_json" in card));
	assert.ok(!("body" in card));
	assert.ok(!("file_hash" in card));
});

test("happy: tags_json is parsed into a real array on each row", () => {
	const db = freshDB();
	seed(db);
	const res = list(db, { status: "todo" });
	const a = res.rows.find(r => r.id === "a-todo");
	assert.deepEqual(a.tags, ["m3", "ready"]);
});

test("happy: opts.orderBy asc on id reverses the default order", () => {
	const db = freshDB();
	seed(db);
	const res = list(db, {}, { orderBy: "id", orderDir: "ASC" });
	assert.deepEqual(res.rows.map(r => r.id), ["a-todo", "b-todo", "c-progress", "d-blocked", "e-done"]);
});

test("happy: opts.orderBy asc on status is stable", () => {
	const db = freshDB();
	seed(db);
	const res = list(db, {}, { orderBy: "status", orderDir: "ASC" });
	// statuses alphabetical: blocked, done, in_progress, todo, todo
	assert.deepEqual(res.rows.map(r => r.id), ["d-blocked", "e-done", "c-progress", "a-todo", "b-todo"]);
});

test("happy: opts.limit caps the result count", () => {
	const db = freshDB();
	seed(db);
	const res = list(db, {}, { limit: 2 });
	assert.equal(res.rows.length, 2);
	// Default ordering: top 2 by priority → e-done (9), c-progress (7).
	assert.deepEqual(res.rows.map(r => r.id), ["e-done", "c-progress"]);
});

test("happy: query with no rows returns ok:true, rows:[]", () => {
	const db = freshDB();
	// Empty db — no seed.
	const res = list(db);
	assert.equal(res.ok, true);
	assert.deepEqual(res.rows, []);
});

test("happy: priority range is NULL-safe (cards with NULL priority are included when range is open)", () => {
	const db = freshDB();
	seed(db);
	insertCard(db, { id: "z-null-prio", title: "Z null prio", status: "todo", project: "alpha", priority: null, tags: [] });

	// priority BETWEEN 1 AND 3 → b-todo (3), d-blocked (2). z-null-prio has NULL
	// priority → NULL comparisons return NULL (not true) → excluded. This is
	// standard SQL NULL semantics; cards with NULL priority need an explicit
	// way to be matched, which is "leave min/max undefined."
	const ranged = list(db, { priority: { min: 1, max: 3 } });
	assert.equal(ranged.rows.length, 2);
	assert.ok(!ranged.rows.some(r => r.id === "z-null-prio"));

	// Open range (no min, no max) → all cards, including the NULL-priority one.
	const open = list(db, { priority: {} });
	assert.equal(open.rows.length, 6);
});