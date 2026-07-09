// agentdb/watch/integration.test.js — REQ-M7-1
//
// `agentdb/watch.js` is the chokidar file watcher (M7-1). It watches BOTH
// truth roots and routes each change to the right reindex primitive:
//   ~/Projects/*/.kanban/  -> kb incremental reindex  (kb/index.js index())
//   ~/.pi/sessions/        -> session append-only ingest (ingest/incremental.js)
// with a 150 ms debounce so a burst of edits (a save that fires add+change,
// or several cards touched at once) coalesces into one reindex pass.
//
// ACCEPTANCE (REQ-M7-1): editing a card updates kb_* within ~300 ms; a new
// session line ingests within ~300 ms. The 300 ms is the latency budget
// (debounce 150 ms + fsevents delivery); the tests poll the DERIVED mirror
// (kb_cards / sess_events) — the black-box a user/agent queries — with a
// generous CI-safe timeout, and assert the debounce coalesces a same-tick
// burst into exactly one reindex call.
//
// Verify: node --test agentdb/watch/integration.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");

const { rebuild, index } = require("../kb/index");
const { ingestFile } = require("../ingest/incremental");
const { start } = require("../watch"); // resolves to ../watch.js (file beats dir/ in Node's resolver)

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

// CARD(id, title, status, deps) -> a valid .card.md body. Same template the
// kb/ suites use so the watcher tests stay consistent with the library tests.
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

// sessionLine(opts) -> one JSONL line shaped like a pi session event (same
// helper shape the ingest/ suites use).
function sessionLine(opts) {
	return JSON.stringify(Object.assign({ timestamp: "2026-01-01T00:00:00.000Z" }, opts));
}

// buildJSONL({session_id, n, startTs, intervalMs}) -> an n-line session JSONL
// string (1 "session" event + n-1 messages), newline-terminated.
function buildJSONL({ session_id = "sess-X", n = 5, startTs = "2026-01-01T00:00:00.000Z", intervalMs = 1000 }) {
	const lines = [sessionLine({ type: "session", id: session_id, timestamp: startTs, cwd: "/x" })];
	for (let i = 1; i < n; i++) {
		const ts = new Date(new Date(startTs).getTime() + i * intervalMs).toISOString();
		lines.push(sessionLine({ type: "message", role: i % 2 === 0 ? "user" : "assistant", timestamp: ts, content: `msg ${i}` }));
	}
	return lines.join("\n") + "\n";
}

// fileDB(path) — a real on-disk SQLite DB (NOT :memory:) with the canonical
// schema applied. The watcher holds the same connection the test polls, and
// chokidar watches real files on disk, so a file-backed DB mirrors production.
function fileDB(file) {
	const db = new DatabaseSync(file);
	db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// waitFor(fn, {timeout, interval}) — poll fn() (truthy = pass) until timeout.
// The ACCEPTANCE latency is ~300 ms; we poll every 25 ms. The ceiling is
// 8 s (not 3 s) because the full regression runs every test file in ONE node
// process (`find ... -exec node --test {} +`), so fsevents delivery + the
// debounce timer contend with 470+ other tests for the event loop — under that
// load a real fsevents callback for a new file can land well past 3 s. A higher
// ceiling cannot mask a real bug (a broken watcher never satisfies the poll);
// it only stops a loaded runner from false-failing. See operator pass
// 2026-07-09 (this flake halted M7-2/M8-4/M8-6/M9-2/M9-3/M9-4/M9-5).
async function waitFor(fn, { timeout = 8000, interval = 25 } = {}) {
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
// REQ-M7-1: editing a card updates kb_* within ~300 ms
// ===========================================================================

test("editing a card reindexes kb_* within the latency budget (REQ-M7-1)", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-kb-"));
	const { kbRoot, aFile } = setupProject(root);
	const sessionsDir = path.join(root, "sessions");
	fs.mkdirSync(sessionsDir, { recursive: true });

	const db = fileDB(path.join(root, "agent.db"));
	rebuild(db, kbRoot); // seed: card 'a' indexed
	assert.equal(db.prepare("SELECT title FROM kb_cards WHERE id='a'").get().title, "Card A");

	const handle = start({ db, projectsDir: root, sessionsDir, debounceMs: 150 });
	try {
		await handle.ready; // don't edit until fsevents is armed (pre-ready events are dropped)
		// EDIT the card — the watcher must reindex it into kb_cards.
		fs.writeFileSync(aFile, CARD("a", "Card A EDITED", "todo"), "utf8");

		const saw = await waitFor(
			() => db.prepare("SELECT title FROM kb_cards WHERE id='a'").get().title === "Card A EDITED",
		);
		assert.equal(saw, true, "kb_cards.title should reflect the edit within the latency budget");
	} finally {
		await handle.close();
		db.close();
	}
});

// ===========================================================================
// REQ-M7-1: a new session line ingests within ~300 ms
// ===========================================================================

test("appending a session line ingests it within the latency budget (REQ-M7-1)", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-sess-"));
	const sessionsDir = path.join(root, "sessions");
	fs.mkdirSync(sessionsDir, { recursive: true });
	const sFile = path.join(sessionsDir, "s.jsonl");
	fs.writeFileSync(sFile, buildJSONL({ session_id: "sess-X", n: 5 }), "utf8");

	const db = fileDB(path.join(root, "agent.db"));
	ingestFile(db, sFile); // seed: 5 events
	assert.equal(db.prepare("SELECT count(*) c FROM sess_events WHERE session_id='sess-X'").get().c, 5);

	// an empty projects dir so the watcher has no kb roots to watch (proves the
	// session path works independently of the kb path)
	const handle = start({ db, projectsDir: path.join(root, "projects"), sessionsDir, debounceMs: 150 });
	try {
		await handle.ready; // don't edit until fsevents is armed (pre-ready events are dropped)
		// APPEND one new line — the watcher must ingest it (append-only).
		fs.appendFileSync(
			sFile,
			sessionLine({ type: "message", role: "user", timestamp: "2026-01-01T00:00:30.000Z", content: "appended" }) + "\n",
			"utf8",
		);

		const saw = await waitFor(
			() => db.prepare("SELECT count(*) c FROM sess_events WHERE session_id='sess-X'").get().c === 6,
		);
		assert.equal(saw, true, "sess_events should grow from 5 to 6 after the appended line");
	} finally {
		await handle.close();
		db.close();
	}
});

// ===========================================================================
// REQ-M7-1: the 150 ms debounce coalesces a same-tick burst into ONE reindex
// ===========================================================================

test("a burst of rapid edits is debounced into a single reindex (REQ-M7-1)", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-debounce-"));
	const { kbRoot, aFile } = setupProject(root);
	const sessionsDir = path.join(root, "sessions");
	fs.mkdirSync(sessionsDir, { recursive: true });

	const db = fileDB(path.join(root, "agent.db"));
	rebuild(db, kbRoot);

	// counting seams: wrap the real primitives so we can assert how many times
	// the watcher invoked them (debounce => fewer calls than edits).
	let kbCalls = 0;
	const handle = start({
		db,
		projectsDir: root,
		sessionsDir,
		debounceMs: 200,
		indexFn: (d, r) => { kbCalls++; return index(d, r); },
	});
	try {
		await handle.ready; // don't edit until fsevents is armed (pre-ready events are dropped)
		// three edits in the SAME tick — all within the debounce window
		fs.writeFileSync(aFile, CARD("a", "v1", "todo"), "utf8");
		fs.writeFileSync(aFile, CARD("a", "v2", "todo"), "utf8");
		fs.writeFileSync(aFile, CARD("a", "v3", "todo"), "utf8");

		// immediately: the debounce timer is still pending -> nothing flushed yet
		await sleep(20);
		assert.equal(kbCalls, 0, "no reindex should run while the debounce window is still open");

		// after the debounce window: exactly one coalesced reindex, last-write wins
		await sleep(450);
		assert.equal(kbCalls, 1, `expected exactly 1 debounced reindex, got ${kbCalls}`);
		assert.equal(
			db.prepare("SELECT title FROM kb_cards WHERE id='a'").get().title,
			"v3",
			"the coalesced reindex should reflect the final edit",
		);
	} finally {
		await handle.close();
		db.close();
	}
});

// ===========================================================================
// A NEW card file (not just an edit) is picked up — chokidar 'add' event
// ===========================================================================

test("creating a new card file is reindexed into kb_* (REQ-M7-1)", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-add-"));
	const { kbRoot } = setupProject(root);
	const sessionsDir = path.join(root, "sessions");
	fs.mkdirSync(sessionsDir, { recursive: true });

	const db = fileDB(path.join(root, "agent.db"));
	rebuild(db, kbRoot);
	assert.equal(db.prepare("SELECT count(*) c FROM kb_cards").get().c, 1); // just 'a'

	const handle = start({ db, projectsDir: root, sessionsDir, debounceMs: 150 });
	try {
		await handle.ready; // don't edit until fsevents is armed (pre-ready events are dropped)
		fs.writeFileSync(path.join(kbRoot, "cards", "b.card.md"), CARD("b", "Card B", "in_progress", "[a]"), "utf8");

		const saw = await waitFor(() => db.prepare("SELECT count(*) c FROM kb_cards").get().c === 2);
		assert.equal(saw, true, "a newly-created card file should be indexed");
		assert.equal(
			db.prepare("SELECT id FROM kb_cards ORDER BY id").all().map(r => r.id).join(","),
			"a,b",
		);
	} finally {
		await handle.close();
		db.close();
	}
});
