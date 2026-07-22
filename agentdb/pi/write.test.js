// agentdb/pi/write.test.js — pi agent tools kanban_create / kanban_move (M9-2).
//
// ROADMAP M9-2 acceptance gate (REQ-M9-2): "same path-safety as M2-5; file
// created + reindexed." These are the testable JS core of the WRITE-side pi
// tools; the pi extension (.ts harness binding) is a thin wrapper over this
// module (M9-6).
//
// What "file created + reindexed" means, concretely:
//   - kanban_create wraps M2-5 createCard (full path-safety inherited via
//     delegation) and, AFTER a successful truth write, reindexes the kb_*
//     mirror so the next kanban_list / kanban_get sees the new card with NO
//     manual rebuild.
//   - kanban_move wraps M2-5 moveStatus (same path-safety + the M0-2
//     transition map) and reindexes so the new status is reflected in the
//     mirror immediately.
//   - both are best-effort/no-throw: { ok:false, errors } on bad input /
//     illegal path / illegal transition, never an exception. NO reindex runs
//     when the write was rejected (no spurious mirror churn).
//   - both work in TWO modes (mirrors pi/list.js): (a) an injected db (tests /
//     composition — caller owns the connection + freshness), and (b) opening
//     their OWN connection via lib/db.open() (the real "pi harness" path).
//
// Test shape mirrors kb/write.test.js (mkdtemp fixture tree + RED-BLUE abuse
// suite) + pi/list.test.js (the injected-db vs opens-own-db two-mode pattern).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { kanban_create, kanban_move } = require("./write");
const { kanban_get, kanban_list } = require("./list");
const { index, ensureCurrent } = require("../kb");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

// --- shared helpers (mirror kb/write.test.js + pi/list.test.js) ---

// freshDB() — in-memory kb with the canonical schema applied (empty mirror).
function freshDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// mkTmpRoot(label) -> fresh absolute dir under os.tmpdir().
function mkTmpRoot(label) {
	const stamp = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
	const p = path.join(os.tmpdir(), `pi-write-test-${label}-${stamp}`);
	fs.mkdirSync(p, { recursive: true });
	return p;
}

// CARD_HEAD(id, title, status, deps) -> a .card.md body that parses cleanly
// through M1-1 (same template as pi/list.test.js). `deps` is a YAML inline
// array literal like "[]" or "[a, b]".
function CARD_HEAD(id, title, status, deps = "[]") {
	return [
		"---",
		`id: ${id}`,
		`title: ${title}`,
		`status: ${status}`,
		"project: apple-pi",
		"parent: root",
		`depends_on: ${deps}`,
		"created_at: 2026-07-02T22:00:00.000Z",
		"updated_at: 2026-07-02T22:00:00.000Z",
		"---",
		"",
		`# ${title}`,
		"",
		"Body text.",
		"",
	].join("\n");
}

// writeCard(root, file, id, title, status) -> abs path. Writes a real .card.md
// fixture under <root>/<file>; creates parent dirs.
function writeCard(root, file, id, title, status) {
	const abs = path.join(root, file);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, CARD_HEAD(id, title, status), "utf8");
	return abs;
}

// mirrorCount(db) -> int. Row count of kb_cards (handy for "no spurious churn").
function mirrorCount(db) {
	return db.prepare("SELECT count(*) c FROM kb_cards").get().c;
}

// =====================================================================
// kanban_create — injected-db happy path: file created + reindexed
// =====================================================================

test("kanban_create writes the .card.md AND reindexes the mirror (injected db)", () => {
	const root = mkTmpRoot("create-happy");
	const db = freshDB();
	try {
		assert.equal(mirrorCount(db), 0, "mirror starts empty");

		const res = kanban_create({
			root,
			dir: ".",
			card: {
				id: "new-card", title: "New card", status: "triage",
				project: "apple-pi", tags: ["m9"], body: "# New card\n\nInitial description.",
			},
			db,
		});

		// truth was written
		assert.equal(res.ok, true, `expected ok, got: ${JSON.stringify(res.errors || [])}`);
		assert.equal(res.file, path.join(root, "new-card.card.md"));
		assert.ok(fs.existsSync(res.file), ".card.md file created on disk");

		// reindex happened — the mirror now has the row, readable via kanban_get
		// (which does NOT reconcile on an injected db, so this proves reindex ran)
		assert.equal(res.reindexed, true, "reindexed flag set on success");
		assert.equal(mirrorCount(db), 1, "mirror has exactly the one new card");

		const got = kanban_get("new-card", { db });
		assert.equal(got.ok, true, "kanban_get sees the freshly-reindexed card");
		assert.equal(got.card.title, "New card");
		assert.equal(got.card.status, "triage");
		assert.deepEqual(got.card.tags, ["m9"]);
		assert.ok(got.card.body.includes("# New card"), "body indexed from disk");
		assert.ok(got.card.body.includes("Initial description."), "full body round-tripped through create + index");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("kanban_create in a nested dir lands the file + indexes it under that path", () => {
	const root = mkTmpRoot("create-nested");
	const db = freshDB();
	try {
		const res = kanban_create({
			root,
			dir: "Projects/apple-pi/.kanban/cards",
			card: { id: "nested", title: "Nested", status: "backlog" },
			db,
		});
		assert.equal(res.ok, true);
		const expected = path.join(root, "Projects/apple-pi/.kanban/cards/nested.card.md");
		assert.equal(res.file, expected);
		assert.ok(fs.existsSync(expected));

		// the mirror's file_path is the absolute path discover walked
		const got = kanban_get("nested", { db });
		assert.equal(got.ok, true);
		assert.equal(got.card.file_path, expected);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("kanban_create reindex is visible to kanban_list too (no manual rebuild)", () => {
	const root = mkTmpRoot("create-list-visible");
	const db = freshDB();
	try {
		// seed one pre-existing card on disk + in the mirror
		writeCard(root, "existing.card.md", "existing", "Existing", "todo");
		ensureCurrent(db, root);
		assert.equal(mirrorCount(db), 1);

		const res = kanban_create({
			root,
			dir: ".",
			card: { id: "added", title: "Added", status: "triage" },
			db,
		});
		assert.equal(res.ok, true);

		// kanban_list (injected db, no reconcile) now returns BOTH cards
		const list = kanban_list({ db });
		assert.equal(list.ok, true);
		assert.deepEqual(list.rows.map(r => r.id).sort(), ["added", "existing"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("kanban_create result is JSON-serializable (the pi harness round-trips it)", () => {
	const root = mkTmpRoot("create-json");
	const db = freshDB();
	try {
		const res = kanban_create({
			root, dir: ".", card: { id: "j", title: "J", status: "triage" }, db,
		});
		const json = JSON.stringify(res);
		const back = JSON.parse(json);
		assert.equal(back.ok, true);
		assert.equal(back.file, res.file);
		assert.equal(back.reindexed, true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// =====================================================================
// kanban_create — RED-BLUE abuse: same path-safety as M2-5, no write, no churn
// =====================================================================

test("abuse: kanban_create '..' parent traversal is rejected, no file + no mirror write", () => {
	const root = mkTmpRoot("create-parent-traversal");
	const db = freshDB();
	try {
		const beforeFiles = fs.readdirSync(root);
		const res = kanban_create({
			root,
			dir: "../escape",
			card: { id: "evil", title: "Evil", status: "triage" },
			db,
		});
		assert.equal(res.ok, false);
		assert.ok(res.errors.length > 0);
		assert.match(res.errors.join(" "), /outside root/i);
		// no file anywhere
		assert.ok(!fs.existsSync(path.join(root, "evil.card.md")));
		assert.ok(!fs.existsSync(path.join(path.dirname(root), "escape", "evil.card.md")));
		// no spurious reindex — mirror still empty, reindexed flag absent/false
		assert.equal(mirrorCount(db), 0);
		assert.equal(res.reindexed, false, "no reindex on rejected write");
		// tree unchanged
		assert.deepEqual(fs.readdirSync(root), beforeFiles);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		try { fs.rmSync(path.join(path.dirname(root), "escape"), { recursive: true, force: true }); } catch (_) {}
	}
});

test("abuse: kanban_create absolute dir is rejected, no file + no mirror write", () => {
	const root = mkTmpRoot("create-absolute");
	const db = freshDB();
	try {
		const res = kanban_create({
			root,
			dir: "/tmp",
			card: { id: "abs", title: "Abs", status: "triage" },
			db,
		});
		assert.equal(res.ok, false);
		assert.match(res.errors.join(" "), /outside root/);
		assert.ok(!fs.existsSync("/tmp/abs.card.md"));
		assert.equal(mirrorCount(db), 0);
		assert.equal(res.reindexed, false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		try { fs.unlinkSync("/tmp/abs.card.md"); } catch (_) {}
	}
});

test("abuse: kanban_create invalid id (not a slug) is rejected, no file + no mirror write", () => {
	const root = mkTmpRoot("create-bad-id");
	const db = freshDB();
	try {
		const res = kanban_create({
			root, dir: ".", card: { id: "../etc/passwd", title: "x", status: "triage" }, db,
		});
		assert.equal(res.ok, false);
		assert.match(res.errors.join(" "), /slug/i);
		assert.equal(mirrorCount(db), 0);
		assert.equal(res.reindexed, false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("abuse: kanban_create missing card object is rejected (no throw)", () => {
	const root = mkTmpRoot("create-no-card");
	const db = freshDB();
	try {
		const res = kanban_create({ root, dir: ".", db });
		assert.equal(res.ok, false);
		assert.ok(res.errors.length > 0);
		assert.equal(mirrorCount(db), 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("abuse: kanban_create refuses to clobber an existing card (no overwrite, no mirror change)", () => {
	const root = mkTmpRoot("create-clobber");
	const db = freshDB();
	try {
		writeCard(root, "dup.card.md", "dup", "Dup", "todo");
		ensureCurrent(db, root);
		const before = fs.readFileSync(path.join(root, "dup.card.md"), "utf8");

		const res = kanban_create({
			root, dir: ".", card: { id: "dup", title: "overwrite attempt" }, db,
		});
		assert.equal(res.ok, false);
		assert.match(res.errors.join(" "), /already exists/);

		const after = fs.readFileSync(path.join(root, "dup.card.md"), "utf8");
		assert.equal(after, before, "existing file byte-identical");
		assert.equal(mirrorCount(db), 1, "mirror unchanged");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// =====================================================================
// kanban_create — opens-OWN-db path (the real "pi harness" path)
// =====================================================================

test("kanban_create with NO injected db opens AGENT_DB, writes, reindexes", () => {
	const root = mkTmpRoot("create-own-db");
	const tmpDb = path.join(os.tmpdir(), `pi-create-db-${process.pid}-${Date.now()}.sqlite`);
	process.env.AGENT_DB = tmpDb;
	try {
		const res = kanban_create({
			root, dir: ".", card: { id: "solo", title: "Solo", status: "triage" },
		});
		assert.equal(res.ok, true, `expected ok, got: ${JSON.stringify(res.errors || [])}`);
		assert.ok(fs.existsSync(path.join(root, "solo.card.md")), "file written");
		assert.equal(res.reindexed, true);
		assert.ok(fs.existsSync(tmpDb), "AGENT_DB file created by open()");

		// a fresh kanban_list reopens AGENT_DB (ensureCurrent no-op, just indexed)
		// and sees the new card — proves the reindex persisted to disk
		const list = kanban_list({ root });
		assert.equal(list.ok, true);
		assert.deepEqual(list.rows.map(r => r.id), ["solo"]);
		assert.equal(list.rows[0].title, "Solo");
	} finally {
		delete process.env.AGENT_DB;
		try { fs.unlinkSync(tmpDb); } catch (_) {}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// =====================================================================
// kanban_move — injected-db happy path: status moved + reindexed
// =====================================================================

test("kanban_move updates status on disk AND reindexes the mirror (injected db)", () => {
	const root = mkTmpRoot("move-happy");
	const db = freshDB();
	try {
		writeCard(root, "card.card.md", "card", "Card", "todo");
		ensureCurrent(db, root); // build the mirror from disk
		assert.equal(mirrorCount(db), 1);

		const res = kanban_move({ root, file: "card.card.md", to: "in_progress", db });
		assert.equal(res.ok, true, `expected ok, got: ${JSON.stringify(res.errors || [])}`);
		assert.equal(res.file, path.join(root, "card.card.md"));
		assert.equal(res.reindexed, true);

		// mirror reflects the new status (kanban_get on injected db = no reconcile)
		const got = kanban_get("card", { db });
		assert.equal(got.ok, true);
		assert.equal(got.card.status, "in_progress", "mirror status updated by reindex");

		// the move diff on disk is exactly status + updated_at (M2-5 contract)
		const after = fs.readFileSync(path.join(root, "card.card.md"), "utf8");
		assert.match(after, /^status: in_progress$/m);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("kanban_move reindex is visible to kanban_list filtering", () => {
	const root = mkTmpRoot("move-list-visible");
	const db = freshDB();
	try {
		writeCard(root, "card.card.md", "card", "Card", "todo");
		ensureCurrent(db, root);

		const res = kanban_move({ root, file: "card.card.md", to: "blocked", db });
		assert.equal(res.ok, true);

		// kanban_list with status filter sees the new status
		const blocked = kanban_list({ db, filters: { status: "blocked" } });
		assert.equal(blocked.ok, true);
		assert.deepEqual(blocked.rows.map(r => r.id), ["card"]);

		const todos = kanban_list({ db, filters: { status: "todo" } });
		assert.equal(todos.ok, true);
		assert.equal(todos.rows.length, 0, "old status no longer matches");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("kanban_move self-transition (todo -> todo) re-stamps + reindexes", () => {
	const root = mkTmpRoot("move-self");
	const db = freshDB();
	try {
		writeCard(root, "card.card.md", "card", "Card", "todo");
		ensureCurrent(db, root);

		const res = kanban_move({ root, file: "card.card.md", to: "todo", db });
		assert.equal(res.ok, true);
		assert.equal(res.reindexed, true);

		const got = kanban_get("card", { db });
		assert.equal(got.card.status, "todo");
		// updated_at advanced past the fixture's frozen stamp
		assert.notEqual(got.card.updated_at, "2026-07-02T22:00:00.000Z");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// =====================================================================
// kanban_move — RED-BLUE abuse: same path-safety + transition map as M2-5
// =====================================================================

test("abuse: kanban_move '..' parent traversal rejected, no file + no mirror change", () => {
	const root = mkTmpRoot("move-parent-traversal");
	const db = freshDB();
	try {
		writeCard(root, "real.card.md", "real", "Real", "todo");
		ensureCurrent(db, root);
		const before = fs.readFileSync(path.join(root, "real.card.md"), "utf8");
		const beforeStatus = kanban_get("real", { db }).card.status;

		const res = kanban_move({ root, file: "../escape.card.md", to: "in_progress", db });
		assert.equal(res.ok, false);
		assert.match(res.errors.join(" "), /outside root|parent/i);

		// file + mirror untouched
		assert.equal(fs.readFileSync(path.join(root, "real.card.md"), "utf8"), before);
		assert.equal(kanban_get("real", { db }).card.status, beforeStatus);
		assert.equal(res.reindexed, false, "no reindex on rejected move");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		try { fs.unlinkSync(path.join(path.dirname(root), "escape.card.md")); } catch (_) {}
	}
});

test("abuse: kanban_move non-.card.md target rejected, no write", () => {
	const root = mkTmpRoot("move-wrong-ext");
	const db = freshDB();
	try {
		fs.writeFileSync(path.join(root, "notes.txt"), "not a card");
		const res = kanban_move({ root, file: "notes.txt", to: "in_progress", db });
		assert.equal(res.ok, false);
		assert.match(res.errors.join(" "), /\.card\.md/);
		assert.equal(fs.readFileSync(path.join(root, "notes.txt"), "utf8"), "not a card");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("abuse: kanban_move illegal transition (done -> in_progress) rejected, no write", () => {
	const root = mkTmpRoot("move-illegal");
	const db = freshDB();
	try {
		fs.writeFileSync(path.join(root, "card.card.md"), CARD_HEAD("card", "Card", "done"), "utf8");
		ensureCurrent(db, root);
		const before = fs.readFileSync(path.join(root, "card.card.md"), "utf8");

		const res = kanban_move({ root, file: "card.card.md", to: "in_progress", db });
		assert.equal(res.ok, false);
		assert.match(res.errors.join(" "), /illegal transition/);
		assert.equal(fs.readFileSync(path.join(root, "card.card.md"), "utf8"), before);
		assert.equal(res.reindexed, false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("abuse: kanban_move invalid status string rejected, no write", () => {
	const root = mkTmpRoot("move-bad-status");
	const db = freshDB();
	try {
		writeCard(root, "card.card.md", "card", "Card", "todo");
		ensureCurrent(db, root);
		const before = fs.readFileSync(path.join(root, "card.card.md"), "utf8");

		const res = kanban_move({ root, file: "card.card.md", to: "frobnicated", db });
		assert.equal(res.ok, false);
		assert.match(res.errors.join(" "), /STATUS_ENUM/);
		assert.equal(fs.readFileSync(path.join(root, "card.card.md"), "utf8"), before);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("abuse: kanban_move missing target rejected (no silent create)", () => {
	const root = mkTmpRoot("move-missing");
	const db = freshDB();
	try {
		const res = kanban_move({ root, file: "nope.card.md", to: "in_progress", db });
		assert.equal(res.ok, false);
		assert.ok(!fs.existsSync(path.join(root, "nope.card.md")), "no silent create");
		assert.equal(res.reindexed, false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// =====================================================================
// kanban_move — opens-OWN-db path
// =====================================================================

test("kanban_move with NO injected db opens AGENT_DB, moves, reindexes", () => {
	const root = mkTmpRoot("move-own-db");
	const tmpDb = path.join(os.tmpdir(), `pi-move-db-${process.pid}-${Date.now()}.sqlite`);
	process.env.AGENT_DB = tmpDb;
	try {
		// seed a real card on disk first
		writeCard(root, "card.card.md", "card", "Card", "todo");

		const res = kanban_move({ root, file: "card.card.md", to: "in_progress" });
		assert.equal(res.ok, true, `expected ok, got: ${JSON.stringify(res.errors || [])}`);
		assert.equal(res.reindexed, true);

		// a fresh kanban_get reopens AGENT_DB (ensureCurrent no-op) + sees new status
		const got = kanban_get("card", { root });
		assert.equal(got.ok, true);
		assert.equal(got.card.status, "in_progress");
	} finally {
		delete process.env.AGENT_DB;
		try { fs.unlinkSync(tmpDb); } catch (_) {}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// =====================================================================
// RED-BLUE — injection payloads in card fields are inert (bound writes)
// =====================================================================

test("abuse: SQL/shell payloads in card fields are written literally (no eval)", () => {
	const root = mkTmpRoot("inject-fields");
	const db = freshDB();
	try {
		// title + assignee accept arbitrary strings; payloads land as inert data.
		// (project is SLUG_RE-validated by schema-card, so it can't carry a payload —
		// that gate is itself a defense; exercise the free-string fields here.)
		const res = kanban_create({
			root,
			dir: ".",
			card: {
				id: "inject",
				title: "x'; DROP TABLE kb_cards;--",
				status: "triage",
				assignee: "$(rm -rf /)",
			},
			db,
		});
		assert.equal(res.ok, true, "payloads are just string values, written literally");
		assert.equal(mirrorCount(db), 1, "kb_cards intact (no DROP executed)");

		const got = kanban_get("inject", { db });
		assert.equal(got.ok, true);
		assert.equal(got.card.title, "x'; DROP TABLE kb_cards;--", "payload stored verbatim");
		assert.equal(got.card.assignee, "$(rm -rf /)", "shell payload stored verbatim, no eval");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
