// agentdb/kb/search.test.js — FTS5 full-text search tests.
//
// ROADMAP M3-3 acceptance gate:
//   - a body term ranks its card first
//   - absent term → empty
//   - FTS5 syntax chars in q do not raise (escaped via phrase-quoting)
//   - limit caps the result count
//   - empty q → []
//
// Test layout: abuse suite first (FTS5 syntax chars in q, empty inputs,
// bad limits), then happy path (term ranking, snippet highlighting,
// limit, absent term, ranking by relevance).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { search, escapeFtsPhrase, SNIPPET_BEFORE, SNIPPET_AFTER } = require("./search");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

function freshDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// insertCard(db, id, title, body) — minimal card + FTS5 row. The indexer
// (kb/index.js) normally does both atomically; for tests we inline it.
// kb_body_fts and kb_cards must share the same rowid (the implicit PK of
// the FTS table). We INSERT into kb_cards first (assigns a rowid), then
// INSERT into kb_body_fts with the same rowid.
function insertCard(db, id, title, body) {
	const file_hash = `hash-${id}-${Math.random().toString(36).slice(2,8)}`;
	const frontmatter = JSON.stringify({ id, title, status: "todo", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" });
	const ins = db.prepare(
		`INSERT INTO kb_cards (id, title, status, file_path, frontmatter_json, body, file_hash)
		 VALUES (?, ?, 'todo', ?, ?, ?, ?)`,
	);
	const info = ins.run(id, title, `/cards/${id}.card.md`, frontmatter, body, file_hash);
	// Insert into kb_body_fts with the SAME rowid as the kb_cards insert.
	db.prepare(`INSERT INTO kb_body_fts (rowid, title, body) VALUES (?, ?, ?)`).run(info.lastInsertRowid, title, body);
}

// =====================================================================
// ABUSE SUITE — must run first
// =====================================================================

test("abuse: empty q returns { ok: true, hits: [] }", () => {
	const db = freshDB();
	insertCard(db, "a", "A title", "Some body");
	const res = search("", db);
	assert.equal(res.ok, true);
	assert.deepEqual(res.hits, []);
});

test("abuse: whitespace-only q returns { ok: true, hits: [] }", () => {
	const db = freshDB();
	insertCard(db, "a", "A title", "Some body");
	const res = search("   \t  \n ", db);
	assert.equal(res.ok, true);
	assert.deepEqual(res.hits, []);
});

test("abuse: non-string q returns { ok: true, hits: [] }", () => {
	const db = freshDB();
	insertCard(db, "a", "A title", "Some body");
	for (const q of [null, undefined, 42, true, [], {}]) {
		const res = search(q, db);
		assert.equal(res.ok, true, `non-string q=${JSON.stringify(q)} must return ok:true, []`);
		assert.deepEqual(res.hits, []);
	}
});

test("abuse: FTS5 boolean operators in q do not raise (phrase-quoted = literal)", () => {
	const db = freshDB();
	insertCard(db, "a", "A title", "Some body with alpha text");
	// "AND", "OR", "NOT" are FTS5 boolean operators. Without escaping they'd
	// produce syntax errors. With phrase-quoting they become literal strings.
	const tests = ["alpha AND beta", "alpha OR beta", "alpha NOT beta", "alpha*", "alpha:beta"];
	for (const q of tests) {
		const res = search(q, db);
		assert.equal(res.ok, true, `q=${JSON.stringify(q)} must not raise`);
	}
});

test("abuse: double-quotes inside q are escaped by doubling", () => {
	const db = freshDB();
	insertCard(db, "a", 'Has a "quoted" phrase', 'body with "embedded" quote');
	const res = search('"quoted"', db);
	assert.equal(res.ok, true);
	// The escaped form becomes `"""quoted"""` which FTS5 parses as
	// literal `"quoted"` — matches the title.
	assert.ok(res.hits.length >= 1, `expected ≥1 hit, got ${res.hits.length}`);
});

test("abuse: bad opts.limit is rejected loudly", () => {
	const db = freshDB();
	insertCard(db, "a", "A", "alpha");
	const bad = [0, -1, 1.5, "10", null, true, []];
	for (const limit of bad) {
		const res = search("alpha", db, { limit });
		// null is "use default" (legal); the rest are rejected
		if (limit === null) {
			assert.equal(res.ok, true);
		} else {
			assert.equal(res.ok, false, `expected reject for limit=${JSON.stringify(limit)}`);
		}
	}
});

test("abuse: opts must be a plain object when provided (null/undefined = use default)", () => {
	const db = freshDB();
	insertCard(db, "a", "A", "alpha");
	// null and undefined mean "use defaults" — same convention as M3-1.
	for (const opts of [null, undefined]) {
		const res = search("alpha", db, opts);
		assert.equal(res.ok, true, `opts=${JSON.stringify(opts)} should fall back to defaults`);
	}
	// Strings, arrays, numbers are not opts-shaped — reject.
	for (const opts of [[], "string", 42]) {
		const res = search("alpha", db, opts);
		assert.equal(res.ok, false, `expected reject for opts=${JSON.stringify(opts)}`);
	}
});

test("abuse: very long q is fine (no upper bound; FTS5 handles arbitrarily long queries)", () => {
	const db = freshDB();
	insertCard(db, "a", "A", "alpha");
	const long = "alpha ".repeat(1000).trim();
	const res = search(long, db);
	assert.equal(res.ok, true);
});

test("escapeFtsPhrase: empty / non-string / whitespace-only returns empty", () => {
	assert.equal(escapeFtsPhrase(""), "");
	assert.equal(escapeFtsPhrase("   "), "");
	assert.equal(escapeFtsPhrase(null), "");
	assert.equal(escapeFtsPhrase(42), "");
	assert.equal(escapeFtsPhrase(undefined), "");
});

test("escapeFtsPhrase: literal value is wrapped in double-quotes", () => {
	assert.equal(escapeFtsPhrase("alpha"), '"alpha"');
	assert.equal(escapeFtsPhrase("  alpha  "), '"alpha"'); // trimmed
	assert.equal(escapeFtsPhrase("hello world"), '"hello world"');
});

test("escapeFtsPhrase: internal double-quotes are doubled", () => {
	assert.equal(escapeFtsPhrase('he said "hi"'), '"he said ""hi"""');
});

// =====================================================================
// HAPPY PATH
// =====================================================================

test("happy: a body term ranks its card first", () => {
	const db = freshDB();
	insertCard(db, "unrelated", "Unrelated card", "No relevant content here");
	insertCard(db, "relevant", "Alpha beta gamma", "This body contains alpha prominently");
	insertCard(db, "loose", "Tangent", "alpha appears once");
	const res = search("alpha", db);
	assert.equal(res.ok, true);
	assert.ok(res.hits.length >= 2, `expected ≥2 hits, got ${res.hits.length}`);

	// 'relevant' has alpha in both title AND body — should rank above 'loose'.
	const relevantIdx = res.hits.findIndex(h => h.id === "relevant");
	const looseIdx = res.hits.findIndex(h => h.id === "loose");
	assert.ok(relevantIdx !== -1 && looseIdx !== -1);
	assert.ok(relevantIdx < looseIdx, `expected 'relevant' (idx ${relevantIdx}) before 'loose' (idx ${looseIdx})`);
});

test("happy: absent term returns []", () => {
	const db = freshDB();
	insertCard(db, "a", "Apple", "Some apple content");
	insertCard(db, "b", "Banana", "Some banana content");
	const res = search("zebra", db);
	assert.equal(res.ok, true);
	assert.deepEqual(res.hits, []);
});

test("happy: hits expose id, title, snippet, rank", () => {
	const db = freshDB();
	insertCard(db, "a", "Alpha card", "Body with alpha word");
	const res = search("alpha", db);
	assert.equal(res.hits.length, 1);
	const h = res.hits[0];
	assert.ok("id" in h);
	assert.ok("title" in h);
	assert.ok("snippet" in h);
	assert.ok("rank" in h);
	assert.equal(h.id, "a");
	assert.equal(h.title, "Alpha card");
	assert.ok(typeof h.rank === "number");
});

test("happy: rank is positive (negated bm25; higher = better)", () => {
	const db = freshDB();
	insertCard(db, "best", "alpha alpha alpha", "alpha alpha body alpha");
	insertCard(db, "ok", "alpha", "alpha");
	const res = search("alpha", db);
	const best = res.hits.find(h => h.id === "best");
	const ok = res.hits.find(h => h.id === "ok");
	assert.ok(best.rank > 0);
	assert.ok(ok.rank > 0);
	assert.ok(best.rank > ok.rank, `best.rank (${best.rank}) should exceed ok.rank (${ok.rank})`);
});

test("happy: snippet highlights matched terms with <mark>", () => {
	const db = freshDB();
	insertCard(db, "a", "Title", "Body with alpha word and alpha again");
	const res = search("alpha", db);
	assert.equal(res.hits.length, 1);
	assert.ok(res.hits[0].snippet.includes(SNIPPET_BEFORE + "alpha" + SNIPPET_AFTER),
		`expected snippet to wrap 'alpha' in <mark>; got: ${res.hits[0].snippet}`);
});

test("happy: limit caps the result count", () => {
	const db = freshDB();
	for (let i = 0; i < 10; i++) insertCard(db, `c${i}`, `Card ${i}`, "alpha content here");
	const res = search("alpha", db, { limit: 3 });
	assert.equal(res.hits.length, 3);
});

test("happy: default limit is 10", () => {
	const db = freshDB();
	for (let i = 0; i < 15; i++) insertCard(db, `c${i}`, `Card ${i}`, "alpha content");
	const res = search("alpha", db);
	assert.equal(res.hits.length, 10, "default limit should be 10");
});

test("happy: search() joins kb_body_fts to kb_cards correctly", () => {
	const db = freshDB();
	// Two cards, both with 'alpha' in body but different titles.
	insertCard(db, "first", "First title", "alpha appears in body 1");
	insertCard(db, "second", "Second title", "alpha appears in body 2");
	const res = search("alpha", db);
	const ids = res.hits.map(h => h.id).sort();
	assert.deepEqual(ids, ["first", "second"], "both cards must be returned with their kb_cards.id");
});

test("happy: results are sorted by rank ASC (best first)", () => {
	const db = freshDB();
	insertCard(db, "lo", "alpha", "once");
	insertCard(db, "hi", "alpha alpha alpha alpha", "alpha alpha alpha alpha body");
	insertCard(db, "mid", "alpha alpha", "alpha body");
	const res = search("alpha", db);
	// Verify rank is monotonically decreasing.
	for (let i = 1; i < res.hits.length; i++) {
		assert.ok(res.hits[i-1].rank >= res.hits[i].rank,
			`rank not monotonically decreasing: hit ${i-1} rank ${res.hits[i-1].rank} < hit ${i} rank ${res.hits[i].rank}`);
	}
});

test("happy: phrase query matches a multi-word phrase literally", () => {
	const db = freshDB();
	insertCard(db, "exact", "Title", "This body contains hello world as a phrase");
	insertCard(db, "split", "Title", "This body contains world then hello elsewhere");
	const res = search("hello world", db);
	// Phrase match should prefer 'exact' over 'split' (which has the words but not adjacent).
	const ids = res.hits.map(h => h.id);
	assert.ok(ids.includes("exact"), `expected 'exact' in results, got ${ids.join(",")}`);
});

test("happy: search() works on an empty db (returns [])", () => {
	const db = freshDB();
	const res = search("anything", db);
	assert.equal(res.ok, true);
	assert.deepEqual(res.hits, []);
});