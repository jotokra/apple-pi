// agentdb/kb/incremental.test.js — REQ-M2-3
//
// index(db, root) is the INCREMENTAL reindexer: it compares each *.card.md
// against kb_meta (mtime fast-path + file_hash authoritative) and touches ONLY
// changed/new cards + deletes rows for removed files, leaving everything else
// byte-for-byte in place. This is what makes a reindex O(changed files), not
// O(all files) — and what distinguishes it from rebuild() (M2-2), which DROPs +
// recreates the whole kb_* tier.
//
// The contract under test (ACCEPTANCE: "incremental touches only changed/
// removed cards"):
//   - touch one card's CONTENT  -> only that card's kb_cards row is rewritten;
//     every other card's rowid is stable (no DELETE+REPLACE happened to it).
//   - delete a card's FILE       -> its kb_cards row, kb_deps edges, kb_meta row
//     and kb_body_fts entry are all gone; siblings untouched.
//   - rewrite a card with SAME content (mtime drifts, hash identical) -> the
//     kb_cards row is NOT rewritten (rowid stable); only kb_meta.mtime refreshes.
//   - deps refresh: a card whose depends_on changed rewrites only its own edges.
//
// Verify: node --test agentdb/kb/incremental.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { rebuild, index } = require("./index");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

// CARD_HEAD(id, title, status, deps) -> a .card.md body. Same template the
// rebuild suite uses so the two stay consistent.
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

// freshDB() — in-memory DB with the canonical kb_* schema applied. index()
// owns only the kb_* tier, so no Tier-B canary is needed here (unlike the
// rebuild suite, which must prove it DROPs nothing outside kb_*).
function freshDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// cardRowids(db) -> { id: rowid }. rowid is the INSERT OR REPLACE canary: an
// untouched card keeps its rowid; a rewritten one gets a fresh rowid.
function cardRowids(db) {
	const out = {};
	for (const r of db.prepare("SELECT rowid, id FROM kb_cards").all()) out[r.id] = r.rowid;
	return out;
}

// bumpMtime(file, offsetSec) — set a file's mtime to now+offset so the mtime
// fast-path deterministically sees a change (real edits move mtime; tests must
// too, or sub-ms rounding can make a changed file look mtime-equal).
function bumpMtime(file, offsetSec = 30) {
	const t = (Date.now() / 1000) + offsetSec;
	fs.utimesSync(file, t, t);
}

function hashOf(file) {
	return crypto.createHash("sha256").update(fs.readFileSync(file, "utf8"), "utf8").digest("hex");
}

// --- a tree used by several tests: a, b(depends a), c ----------------------

function seedABC(root) {
	makeTree(root, [
		{ path: "cards/a.card.md", content: CARD_HEAD("a", "Card A", "todo") },
		{ path: "cards/b.card.md", content: CARD_HEAD("b", "Card B", "in_progress", "[a]") },
		{ path: "cards/c.card.md", content: CARD_HEAD("c", "Card C", "review") },
	]);
}

// ===========================================================================
// touch one card's CONTENT -> only its row changes; siblings untouched
// ===========================================================================

test("touching one card's content rewrites ONLY that card (REQ-M2-3)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-inc-touch-"));
	seedABC(root);
	const db = freshDB();
	rebuild(db, root);

	const before = cardRowids(db);
	const hashBbefore = db.prepare("SELECT file_hash FROM kb_cards WHERE id='b'").get().file_hash;

	// change card B's content + bump its mtime (a real edit moves both)
	const bFile = path.join(root, "cards/b.card.md");
	fs.writeFileSync(bFile, CARD_HEAD("b", "Card B EDITED", "in_progress", "[a]"), "utf8");
	bumpMtime(bFile);

	const r = index(db, root);

	// B was the one changed card -> exactly one upsert, nothing removed
	assert.equal(r.upserted, 1, `expected 1 upsert; got ${JSON.stringify(r)}`);
	assert.equal(r.removed, 0);
	assert.equal(r.ok, true);

	// B's row actually changed (new title + new hash)
	const bRow = db.prepare("SELECT title, file_hash FROM kb_cards WHERE id='b'").get();
	assert.equal(bRow.title, "Card B EDITED");
	assert.notEqual(bRow.file_hash, hashBbefore);
	assert.equal(bRow.file_hash, hashOf(bFile));
	// B's meta caught up to the new hash
	assert.equal(
		db.prepare("SELECT file_hash FROM kb_meta WHERE file_path=?").get(bFile).file_hash,
		hashOf(bFile),
	);

	// A and C were NOT rewritten: same rowid, same hash as before
	const after = cardRowids(db);
	assert.equal(after.a, before.a, "untouched card A must keep its rowid (not rewritten)");
	assert.equal(after.c, before.c, "untouched card C must keep its rowid (not rewritten)");
	assert.equal(
		db.prepare("SELECT file_hash FROM kb_cards WHERE id='a'").get().file_hash,
		hashOf(path.join(root, "cards/a.card.md")),
	);
});

// ===========================================================================
// delete a card's FILE -> its row + edges + meta + FTS entry gone; siblings ok
// ===========================================================================

test("deleting a card file removes its row, deps edges, meta, and FTS entry (REQ-M2-3)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-inc-del-"));
	seedABC(root);
	const db = freshDB();
	rebuild(db, root);
	const before = cardRowids(db);

	// B depends on A -> there is a (b -> a) edge that must vanish with B
	assert.equal(
		db.prepare("SELECT count(*) c FROM kb_deps WHERE from_id='b'").get().c,
		1,
		"precondition: b has a forward dep edge",
	);

	fs.unlinkSync(path.join(root, "cards/b.card.md"));

	const r = index(db, root);
	assert.equal(r.removed, 1, `expected 1 removed; got ${JSON.stringify(r)}`);
	assert.equal(r.upserted, 0);

	// B is gone from every kb_* table
	assert.equal(db.prepare("SELECT count(*) c FROM kb_cards WHERE id='b'").get().c, 0);
	assert.equal(db.prepare("SELECT count(*) c FROM kb_deps WHERE from_id='b'").get().c, 0, "b's forward edges must be gone");
	assert.equal(db.prepare("SELECT count(*) c FROM kb_meta WHERE file_path LIKE '%/b.card.md'").get().c, 0);
	assert.equal(
		db.prepare("SELECT count(*) c FROM kb_body_fts WHERE title='Card B'").get().c,
		0,
		"b's FTS entry must be gone",
	);

	// A and C are untouched (rowid-stable) and the surviving edge set is exactly
	// what it should be with B gone: no edges (a, c depend on nothing).
	const after = cardRowids(db);
	assert.equal(after.a, before.a, "sibling A untouched");
	assert.equal(after.c, before.c, "sibling C untouched");
	assert.equal(db.prepare("SELECT count(*) c FROM kb_deps").get().c, 0);
});

// ===========================================================================
// mtime drift with IDENTICAL content -> card row NOT rewritten; meta refreshed
// ===========================================================================

test("same content + new mtime does NOT rewrite the card row (only kb_meta.mtime) (REQ-M2-3)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-inc-mtime-"));
	makeTree(root, [{ path: "cards/a.card.md", content: CARD_HEAD("a", "Card A", "todo") }]);
	const db = freshDB();
	rebuild(db, root);

	const rowidBefore = cardRowids(db).a;
	const hashBefore = db.prepare("SELECT file_hash FROM kb_cards WHERE id='a'").get().file_hash;

	// rewrite the IDENTICAL bytes + bump mtime (e.g. an editor that touched the
	// file without changing it)
	const aFile = path.join(root, "cards/a.card.md");
	fs.writeFileSync(aFile, CARD_HEAD("a", "Card A", "todo"), "utf8");
	bumpMtime(aFile, 60);

	const r = index(db, root);
	assert.equal(r.upserted, 0, "no content change -> no card upsert");
	assert.equal(r.removed, 0);

	// the card row was NOT rewritten (same rowid, same hash)
	assert.equal(cardRowids(db).a, rowidBefore, "rowid must be stable when content is unchanged");
	assert.equal(
		db.prepare("SELECT file_hash FROM kb_cards WHERE id='a'").get().file_hash,
		hashBefore,
		"hash must be unchanged",
	);
	// but kb_meta.mtime caught up to the new mtime (so the next run short-circuits)
	const newStat = fs.statSync(aFile).mtimeMs;
	assert.equal(
		db.prepare("SELECT mtime FROM kb_meta WHERE file_path=?").get(aFile).mtime,
		newStat,
		"kb_meta.mtime should refresh even when content is unchanged",
	);
});

// ===========================================================================
// deps refresh: a card whose depends_on changed rewrites only its own edges
// ===========================================================================

test("changing a card's depends_on refreshes only that card's edges (REQ-M2-3)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-inc-deps-"));
	seedABC(root);
	const db = freshDB();
	rebuild(db, root);
	// B depends on A
	const depsBefore = db.prepare("SELECT from_id,to_id FROM kb_deps ORDER BY from_id,to_id")
		.all().map(r => ({ from_id: r.from_id, to_id: r.to_id }));
	assert.deepEqual(depsBefore, [{ from_id: "b", to_id: "a" }]);
	const before = cardRowids(db);

	// re-point B at C instead of A
	const bFile = path.join(root, "cards/b.card.md");
	fs.writeFileSync(bFile, CARD_HEAD("b", "Card B", "in_progress", "[c]"), "utf8");
	bumpMtime(bFile);

	index(db, root);

	// the only edge is now (b -> c); the old (b -> a) is gone
	const depsAfter = db.prepare("SELECT from_id,to_id FROM kb_deps ORDER BY from_id,to_id")
		.all().map(r => ({ from_id: r.from_id, to_id: r.to_id }));
	assert.deepEqual(depsAfter, [{ from_id: "b", to_id: "c" }]);

	// A and C rows untouched
	const after = cardRowids(db);
	assert.equal(after.a, before.a);
	assert.equal(after.c, before.c);
});

// ===========================================================================
// adding a NEW card indexes it; existing cards untouched
// ===========================================================================

test("adding a new card indexes it without disturbing existing rows (REQ-M2-3)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-inc-add-"));
	makeTree(root, [
		{ path: "cards/a.card.md", content: CARD_HEAD("a", "Card A", "todo") },
		{ path: "cards/b.card.md", content: CARD_HEAD("b", "Card B", "todo", "[a]") },
	]);
	const db = freshDB();
	rebuild(db, root);
	const before = cardRowids(db);

	// first incremental pass over an unchanged tree is a no-op
	const r0 = index(db, root);
	assert.equal(r0.upserted, 0);
	assert.equal(r0.removed, 0);
	assert.deepEqual(cardRowids(db), before, "no-op pass must not rewrite any row");

	// add card C (depends on B) + reindex
	const cFile = path.join(root, "cards/c.card.md");
	fs.writeFileSync(cFile, CARD_HEAD("c", "Card C", "review", "[b]"), "utf8");

	const r = index(db, root);
	assert.equal(r.upserted, 1);
	assert.equal(r.removed, 0);

	assert.deepEqual(
		db.prepare("SELECT id FROM kb_cards ORDER BY id").all().map(x => x.id),
		["a", "b", "c"],
	);
	// the new edge (c -> b) is present; the existing (b -> a) survived
	const deps = db.prepare("SELECT from_id,to_id FROM kb_deps ORDER BY from_id,to_id")
		.all().map(r => ({ from_id: r.from_id, to_id: r.to_id }));
	assert.deepEqual(deps, [{ from_id: "b", to_id: "a" }, { from_id: "c", to_id: "b" }]);

	// A and B untouched
	const after = cardRowids(db);
	assert.equal(after.a, before.a);
	assert.equal(after.b, before.b);
});

// ===========================================================================
// a card that becomes INVALID is dropped from the mirror (mirrors rebuild)
// ===========================================================================

test("a card edited to an invalid status is dropped from the mirror + reported (REQ-M2-3)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-inc-invalid-"));
	seedABC(root);
	const db = freshDB();
	rebuild(db, root);
	const before = cardRowids(db);

	// edit B to an invalid status (not in the enum)
	const bFile = path.join(root, "cards/b.card.md");
	fs.writeFileSync(bFile, CARD_HEAD("b", "Card B", "wip", "[a]"), "utf8");
	bumpMtime(bFile);

	const r = index(db, root);
	assert.equal(r.ok, false, "ok=false because B no longer validates");
	assert.equal(r.skipped.length, 1);
	assert.equal(r.skipped[0].file, bFile);

	// B is gone from the mirror (same as a full rebuild would leave it)
	assert.equal(db.prepare("SELECT count(*) c FROM kb_cards WHERE id='b'").get().c, 0);
	assert.equal(db.prepare("SELECT count(*) c FROM kb_deps WHERE from_id='b'").get().c, 0);

	// A and C untouched
	const after = cardRowids(db);
	assert.equal(after.a, before.a);
	assert.equal(after.c, before.c);
});
