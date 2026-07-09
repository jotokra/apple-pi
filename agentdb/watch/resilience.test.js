// agentdb/watch/resilience.test.js — REQ-M7-2
//
// Single-instance + partial-write resilience for the watcher (M7-2). Two
// independent guarantees, both asserted here:
//
//   (1) Pidfile guard (one watcher). acquirePidfile() is the single-instance
//       primitive D4 calls for ("single-instance (pidfile)"). A second acquire
//       while a live PID holds the lock reports { alreadyRunning: true, pid }
//       — the daemon (M7-3) turns that into a clean "already running" exit; a
//       stale pidfile (dead/garbage PID) is reclaimed, never fatal; release
//       frees the lock so the next start succeeds.
//
//   (2) Partial-write resilience (one bad card never stalls the watcher).
//       A truncated save of card 'b' is SKIPPED (the parser degrades, the
//       validator rejects, index() reports + drops stale rows — it NEVER
//       throws) and the watcher SURVIVES: a sibling card 'a' edited in the
//       same burst still reindexes within the latency budget, onError is NOT
//       raised (a skip is a normal result, not a crash), and once 'b' is
//       written valid again it reindexes on the next tick.
//
// ACCEPTANCE (REQ-M7-2): second start exits cleanly ("already running");
// truncated save is skipped, watcher survives.
//
// Verify: node --test agentdb/watch/resilience.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");

const { rebuild } = require("../kb/index");
const { start } = require("../watch"); // resolves to ../watch.js (file beats dir/ in Node's resolver)
const { acquirePidfile } = require("../lib/pidfile");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

// CARD(id, title, status, deps) -> a valid .card.md body. Same template the
// kb/ + watch/integration suites use so this stays consistent with the library.
function CARD(id, title, status, deps = "[]") {
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

// fileDB(path) — a real on-disk SQLite DB with the canonical schema applied.
// Mirrors watch/integration.test.js: the watcher holds the same connection the
// test polls, and chokidar watches real files on disk.
function fileDB(file) {
	const db = new DatabaseSync(file);
	db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// waitFor(fn, {timeout, interval}) — poll fn() (truthy = pass) until timeout.
// Generous CI-safe ceiling (the latency budget is ~300 ms; a loaded runner
// still passes while a broken watcher fails fast). Mirrors integration suite.
async function waitFor(fn, { timeout = 3000, interval = 25 } = {}) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try { if (fn()) return true; } catch { /* poll again */ }
		await sleep(interval);
	}
	return false;
}

// setupProject(root, projName) -> { kbRoot, aFile }. Creates the SUPERPROMPT
// §5.1 layout <root>/<proj>/.kanban/cards/ and seeds one card 'a'.
function setupProject(root, projName = "projA") {
	const kbRoot = path.join(root, projName, ".kanban");
	const aFile = path.join(kbRoot, "cards", "a.card.md");
	fs.mkdirSync(path.dirname(aFile), { recursive: true });
	fs.writeFileSync(aFile, CARD("a", "Card A", "todo"), "utf8");
	return { kbRoot, aFile };
}

// ===========================================================================
// (1) Pidfile guard — single-instance (REQ-M7-2)
// ===========================================================================

test("acquirePidfile: first acquire succeeds; a second live acquire reports already-running (REQ-M7-2)", () => {
	const pidfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pid-")), "watch.pid");

	const a = acquirePidfile(pidfile);
	assert.equal(a.alreadyRunning, false, "the first acquire should succeed (no prior holder)");
	assert.equal(typeof a.release, "function", "a successful acquire returns a release() handle");
	assert.equal(
		fs.readFileSync(pidfile, "utf8").trim(),
		String(process.pid),
		"the pidfile should hold our PID after a successful acquire",
	);

	// A second start while the first holder is still live must NOT take the lock:
	// it reports already-running so the daemon (M7-3) can exit cleanly. (In
	// production the holder is a different process; here the same test process
	// stands in for it — what matters is "a live PID holds the pidfile".)
	const b = acquirePidfile(pidfile);
	assert.equal(b.alreadyRunning, true, "a second acquire while the lock is held must report already-running");
	assert.equal(b.pid, process.pid, "already-running reports the live holder's PID");
	assert.equal(b.release, undefined, "an already-running result offers no release (we don't own the lock)");

	a.release();
	// After release the lock is free again — a fresh start succeeds.
	const c = acquirePidfile(pidfile);
	assert.equal(c.alreadyRunning, false, "after release the lock is free for a new start");
	c.release();
});

test("acquirePidfile: a stale pidfile (dead PID) is reclaimed, not fatal (REQ-M7-2)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pid-stale-"));
	const pidfile = path.join(dir, "watch.pid");
	// Plant a stale pidfile pointing at a PID far past any real OS pid range —
	// certainly dead. A crashed prior run leaves exactly this behind; the next
	// start must reclaim the lock rather than refuse forever.
	fs.writeFileSync(pidfile, "99999999", "utf8");

	const a = acquirePidfile(pidfile);
	assert.equal(a.alreadyRunning, false, "a stale (dead-PID) pidfile must be reclaimed");
	assert.equal(fs.readFileSync(pidfile, "utf8").trim(), String(process.pid), "the reclaimed pidfile holds OUR pid");
	a.release();
});

test("acquirePidfile: a garbage / unparseable pidfile is reclaimed, not fatal (REQ-M7-2)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pid-garbage-"));
	const pidfile = path.join(dir, "watch.pid");
	// A pidfile corrupted by a partial write (the very fault mode this milestone
	// hardens against) must not block a start.
	fs.writeFileSync(pidfile, "not-a-number\n", "utf8");

	const a = acquirePidfile(pidfile);
	assert.equal(a.alreadyRunning, false, "a garbage pidfile must not block a start");
	a.release();
});

test("acquirePidfile: release only removes the lock while it still holds our PID (REQ-M7-2)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pid-release-"));
	const pidfile = path.join(dir, "watch.pid");

	const a = acquirePidfile(pidfile);
	// Simulate another process having reclaimed + taken the lock after ours died:
	// overwrite the pidfile with a different (live: our own) holder's PID is not
	// possible in-process, so instead simulate "the pidfile no longer holds our
	// pid" by overwriting it. release() must NOT delete a lock it no longer owns.
	fs.writeFileSync(pidfile, "12345", "utf8");
	a.release();
	assert.equal(
		fs.readFileSync(pidfile, "utf8").trim(),
		"12345",
		"release() must not clobber a pidfile it no longer owns",
	);
	fs.unlinkSync(pidfile);
});

// ===========================================================================
// (2) Partial-write resilience — one bad card never stalls the watcher
// ===========================================================================

test("a truncated save is skipped and the watcher survives (REQ-M7-2)", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-resilience-"));
	const { kbRoot, aFile } = setupProject(root); // card 'a' (good)
	const bFile = path.join(kbRoot, "cards", "b.card.md");
	fs.writeFileSync(bFile, CARD("b", "Card B", "todo"), "utf8"); // card 'b' (good)
	const sessionsDir = path.join(root, "sessions");
	fs.mkdirSync(sessionsDir, { recursive: true });

	const db = fileDB(path.join(root, "agent.db"));
	rebuild(db, kbRoot); // seed: both 'a' and 'b' indexed
	assert.equal(db.prepare("SELECT count(*) c FROM kb_cards").get().c, 2);

	let errors = 0;
	const handle = start({
		db, projectsDir: root, sessionsDir, debounceMs: 150,
		onError: () => { errors++; }, // a SKIP must NOT surface here (only a throw would)
	});
	try {
		await handle.ready; // don't edit until fsevents is armed (pre-ready events are dropped)

		// TRUNCATE card 'b' mid-save: a partial frontmatter with NO closing '---'
		// fence. The parser degrades (opening fence, no closer -> frontmatter
		// 'id: b', body '') and the validator rejects it (no title/status/...),
		// so index() SKIPS it + drops its stale mirror rows. It never throws.
		fs.writeFileSync(bFile, "---\nid: b\nti", "utf8");
		// EDIT the sibling card 'a' in the SAME burst. If the bad card 'b' could
		// stall the watcher, 'a' would never reindex. It must.
		fs.writeFileSync(aFile, CARD("a", "Card A EDITED", "todo"), "utf8");

		const saw = await waitFor(
			() => db.prepare("SELECT title FROM kb_cards WHERE id='a'").get().title === "Card A EDITED",
		);
		assert.equal(saw, true, "the sibling card 'a' must still reindex despite the truncated 'b' — the watcher survived");

		// The truncated 'b' was skipped: no valid mirror row right now (index()
		// drops stale rows on a validate-fail so a later valid write re-upserts).
		assert.equal(
			db.prepare("SELECT count(*) c FROM kb_cards WHERE id='b'").get().c, 0,
			"the truncated card 'b' should be skipped (no mirror row while it's partial)",
		);
		assert.equal(errors, 0, "a skipped card must NOT raise a watcher error — it is a normal best-effort result");

		// RETRY next tick: write 'b' valid again -> the watcher reindexes it back.
		// (Its kb_meta was dropped, so index() now sees it as new and upserts it.)
		fs.writeFileSync(bFile, CARD("b", "Card B FIXED", "todo"), "utf8");
		const sawB = await waitFor(() => {
			const r = db.prepare("SELECT title FROM kb_cards WHERE id='b'").get();
			return r && r.title === "Card B FIXED";
		});
		assert.equal(sawB, true, "once the truncated card is written valid again, it reindexes on the next tick");
		assert.equal(errors, 0, "still no watcher errors after the recover");
	} finally {
		await handle.close();
		db.close();
	}
});
