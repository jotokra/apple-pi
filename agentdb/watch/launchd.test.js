// agentdb/watch/launchd.test.js — REQ-M7-3
//
// `agentdb/watch/launchd.js` is the M7-3 layer: the watcher LaunchAgent (D4)
// + the lazy-reconcile guarantee. Two independent surfaces, both asserted:
//
//   (1) LaunchAgent plist primitive (mirrors analysis/schedule.js):
//       buildArgs / renderPlist / installPath / statusOf / install. Pure —
//       no launchctl, no daemon spawn. The plist is a DAEMON shape
//       (KeepAlive + RunAtLoad, NOT StartCalendarInterval) so launchd keeps
//       `apple-pi kanban watch` alive; install writes exactly one plist
//       under <home>/Library/LaunchAgents and never escapes to the real ~.
//
//   (2) Daemon runner + lazy reconcile:
//       runDaemon(opts) — acquire the M7-2 pidfile, start the M7-1 watcher,
//                        install SIGINT/SIGTERM handlers, return a {stop}
//                        handle. A second runDaemon while a live PID holds
//                        the pidfile returns {alreadyRunning:true} (clean
//                        "already running" exit — no second watcher).
//       reconcileNow(db) — the QUERY-PATH gate: ensureCurrent on every kb
//                          root + resume-ingest on every session file. This
//                          is "correct with NO daemon": a card edited while
//                          the watcher is DOWN is visible on the next query.
//
// ACCEPTANCE (REQ-M7-3): daemon down + edit a card -> next query still sees
// the change (lazy reconcile). start->stop leaves no orphan.
//
// Verify: node --test agentdb/watch/launchd.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");

const { rebuild } = require("../kb/index");
const launchd = require("./launchd");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

// CARD(id, title, status, deps) -> a valid .card.md body. Same template the
// kb/ + watch/ suites use so this stays consistent with the library tests.
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
// Mirrors watch/integration.test.js: reconcileNow + runDaemon hold the same
// connection the test polls, and chokidar watches real files on disk.
function fileDB(file) {
	const db = new DatabaseSync(file);
	db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// waitFor(fn, {timeout, interval}) — poll fn() (truthy = pass) until timeout.
// Mirrors the watch/ suites: the latency budget is ~300 ms; we poll every
// 25 ms with a 3 s CI ceiling so a loaded runner still passes while a broken
// path fails fast.
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

// daemonPlistOk(text) — a DAEMON LaunchAgent plist must be XML, carry a Label,
// a ProgramArguments, KeepAlive (launchd restarts on death) + RunAtLoad (start
// on load), and must NOT carry StartCalendarInterval (this is a long-running
// daemon, not a calendar-scheduled job like analyze).
function daemonPlistOk(text) {
	if (typeof text !== "string" || text.length === 0) return false;
	if (!text.includes("<?xml")) return false;
	if (!text.includes("<plist")) return false;
	if (!text.includes("<dict>")) return false;
	if (!/<key>Label<\/key>\s*<string>[^<]+<\/string>/.test(text)) return false;
	if (!/<key>ProgramArguments<\/key>/.test(text)) return false;
	if (!/<key>KeepAlive<\/key>/.test(text)) return false;
	if (!/<key>RunAtLoad<\/key>\s*<true\/>/.test(text)) return false;
	if (/<key>StartCalendarInterval<\/key>/.test(text)) return false;
	return true;
}

// freshHome() — a tempdir that stands in for $HOME so install() writes its
// plist somewhere disposable. Caller owns cleanup. (Mirrors schedule.test.js.)
function freshHome() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "launchd-m73-"));
}

// ===========================================================================
// ABUSE SUITE — must run first
// ===========================================================================

test("abuse: launchd module exports the primitive + daemon surface", () => {
	for (const fn of [
		"LABEL", "buildArgs", "renderPlist", "installPath", "statusOf", "install",
		"runDaemon", "reconcileNow", "pidfilePath",
	]) {
		assert.notEqual(launchd[fn], undefined, `launchd.${fn} must be exported`);
	}
	assert.equal(typeof launchd.buildArgs, "function");
	assert.equal(typeof launchd.renderPlist, "function");
	assert.equal(typeof launchd.installPath, "function");
	assert.equal(typeof launchd.statusOf, "function");
	assert.equal(typeof launchd.install, "function");
	assert.equal(typeof launchd.runDaemon, "function");
	assert.equal(typeof launchd.reconcileNow, "function");
});

// ===========================================================================
// (1) LaunchAgent plist primitive — DAEMON shape (not a calendar schedule)
// ===========================================================================

test("buildArgs() wires the daemon command `kanban watch` (REQ-M7-3)", () => {
	const args = launchd.buildArgs();
	assert.ok(Array.isArray(args) && args.length >= 2, "buildArgs returns the argv tail");
	assert.equal(args[0], "kanban", "first token is the command group");
	assert.equal(args[1], "watch", "second token is the daemon subcommand");
});

test("renderPlist() with no opts yields a well-shaped DAEMON plist (REQ-M7-3)", () => {
	const text = launchd.renderPlist();
	assert.ok(daemonPlistOk(text), `default plist should be a well-shaped daemon plist; got:\n${text}`);
	// ProgramArguments wires the daemon command tail.
	assert.ok(/<string>kanban<\/string>/.test(text), "plist wires the `kanban` group");
	assert.ok(/<string>watch<\/string>/.test(text), "plist wires the `watch` daemon subcommand");
	// KeepAlive=true so launchd restarts the watcher if it dies (the daemon contract).
	assert.ok(/<key>KeepAlive<\/key>\s*<true\/>/.test(text), "KeepAlive must be true (launchd keeps the daemon alive)");
});

test("REQ-M7-3: installPath() resolves under <home>/Library/LaunchAgents with the label", () => {
	const home = freshHome();
	try {
		const p = launchd.installPath({ home });
		assert.equal(p, path.join(home, "Library", "LaunchAgents", `${launchd.LABEL}.plist`));
		assert.equal(path.extname(p), ".plist");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("REQ-M7-3: statusOf() reports not-installed before install, installed after", () => {
	const home = freshHome();
	try {
		const before = launchd.statusOf({ home });
		assert.equal(before.installed, false, "nothing installed yet");
		assert.equal(before.label, launchd.LABEL);
		assert.equal(before.path, launchd.installPath({ home }));
		assert.ok(before.command.join(" ").includes("watch"), "status command names the watch daemon");

		const res = launchd.install({ home });
		assert.equal(res.ok, true, `install should succeed; got ${JSON.stringify(res)}`);
		assert.equal(res.path, launchd.installPath({ home }));

		const after = launchd.statusOf({ home });
		assert.equal(after.installed, true, "install created the LaunchAgent");

		// The on-disk plist is a well-shaped daemon plist.
		const onDisk = fs.readFileSync(after.path, "utf8");
		assert.ok(daemonPlistOk(onDisk), "installed plist is a well-shaped daemon plist");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("REQ-M7-3: install() is idempotent (re-install does not throw)", () => {
	const home = freshHome();
	try {
		const r1 = launchd.install({ home });
		assert.equal(r1.ok, true);
		const r2 = launchd.install({ home });
		assert.equal(r2.ok, true, "second install must succeed (overwrite)");
		const files = fs.readdirSync(path.join(home, "Library", "LaunchAgents"));
		assert.equal(files.length, 1, "exactly one LaunchAgent plist after re-install");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("REQ-M7-3: install() writes only inside <home>/Library/LaunchAgents (no escape)", () => {
	const home = freshHome();
	try {
		launchd.install({ home });
		const agentsEntries = fs.readdirSync(path.join(home, "Library", "LaunchAgents"));
		assert.deepEqual(agentsEntries, [`${launchd.LABEL}.plist`]);
		// The tempdir install must resolve to the tempdir path, NOT the real home.
		const realPath = path.join(os.homedir(), "Library", "LaunchAgents", `${launchd.LABEL}.plist`);
		assert.notEqual(launchd.installPath({ home }), realPath, "tempdir install must not resolve to the real home");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

// ===========================================================================
// (2a) LAZY RECONCILE — daemon DOWN + edit a card -> next query sees it
// ===========================================================================
//
// This is the load-bearing ACCEPTANCE case. The watcher is NEVER started.
// A card is edited on disk (the truth tier). reconcileNow() is the query-path
// gate (ensureCurrent on every kb root + resume-ingest on sessions): it must
// make the edit visible with NO daemon running. This is "correct with no
// daemon" — the daemon is an optimization (lower latency), not a correctness
// dependency.

test("REQ-M7-3: daemon DOWN + edit a card -> reconcileNow -> query sees the change (lazy reconcile)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "launchd-lazy-"));
	const { kbRoot, aFile } = setupProject(root);
	const sessionsDir = path.join(root, "sessions");
	fs.mkdirSync(sessionsDir, { recursive: true });

	const db = fileDB(path.join(root, "agent.db"));
	try {
		rebuild(db, kbRoot); // seed: card 'a' indexed (the daemon is NOT running)
		assert.equal(db.prepare("SELECT title FROM kb_cards WHERE id='a'").get().title, "Card A");

		// EDIT the truth file on disk — no watcher is alive to see it.
		fs.writeFileSync(aFile, CARD("a", "Card A EDITED OFFLINE", "todo"), "utf8");
		// The kb_* mirror is now STALE: it still holds the old title.
		assert.equal(
			db.prepare("SELECT title FROM kb_cards WHERE id='a'").get().title,
			"Card A",
			"the mirror is stale immediately after an unobserved edit",
		);

		// The query-path gate: reconcileNow brings the mirror current with NO daemon.
		const res = launchd.reconcileNow(db, { projectsDir: root, sessionsDir });
		assert.ok(res.kbRoots >= 1, "reconcileNow saw at least one kb root");
		assert.equal(
			db.prepare("SELECT title FROM kb_cards WHERE id='a'").get().title,
			"Card A EDITED OFFLINE",
			"reconcileNow (ensureCurrent) must surface the daemon-down edit on the next query",
		);

		// A second reconcileNow over an already-current mirror is a no-op (converged).
		const res2 = launchd.reconcileNow(db, { projectsDir: root, sessionsDir });
		assert.equal(res2.actions[0] && res2.actions[0].action, "noop",
			"a second reconcileNow over a current mirror is a no-op");
	} finally {
		db.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("REQ-M7-3: reconcileNow is best-effort on a missing projects dir (no throw)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "launchd-empty-"));
	const db = fileDB(path.join(root, "agent.db"));
	try {
		// A projects dir that does not exist + a missing sessions dir must NOT
		// throw — reconcileNow is called on every query path, so it must degrade
		// gracefully (best-effort, like the rest of agentdb).
		const res = launchd.reconcileNow(db, {
			projectsDir: path.join(root, "nope"),
			sessionsDir: path.join(root, "no-sessions"),
		});
		assert.equal(res.kbRoots, 0, "no kb roots under a missing projects dir");
		assert.equal(res.sessions, 0, "no session files ingested");
	} finally {
		db.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// ===========================================================================
// (2b) START -> STOP leaves NO ORPHAN (pidfile released, watcher genuinely dead)
// ===========================================================================

test("REQ-M7-3: start -> stop releases the pidfile and closes the watcher (no orphan)", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "launchd-nofollow-"));
	const { kbRoot, aFile } = setupProject(root);
	const sessionsDir = path.join(root, "sessions");
	fs.mkdirSync(sessionsDir, { recursive: true });
	const pidfile = path.join(root, "watch.pid");

	const db = fileDB(path.join(root, "agent.db"));
	rebuild(db, kbRoot); // seed: card 'a' indexed

	const handle = launchd.runDaemon({
		db, projectsDir: root, sessionsDir, pidfile, debounceMs: 100,
		installSignals: false, // the test runner owns signal handling
	});
	try {
		assert.equal(handle.alreadyRunning, false, "the first runDaemon should start (no prior holder)");
		await handle.ready; // don't edit until fsevents is armed

		// PROVE the watcher is live: an edit reindexes within the latency budget.
		fs.writeFileSync(aFile, CARD("a", "v1 ALIVE", "todo"), "utf8");
		const saw = await waitFor(
			() => db.prepare("SELECT title FROM kb_cards WHERE id='a'").get().title === "v1 ALIVE",
		);
		assert.equal(saw, true, "the watcher must reindex while running");
	} finally {
		// STOP — must release the pidfile AND close the watcher.
		await handle.stop();
	}

	// (a) the pidfile is GONE (released) — a fresh acquire / start would succeed.
	assert.equal(fs.existsSync(pidfile), false, "stop() must release the pidfile");

	// (b) the chokidar watcher is CLOSED (no orphan fsevents handle).
	assert.equal(handle.handle.watcher.closed, true, "stop() must close the chokidar watcher");

	// (c) the strongest no-orphan proof: an edit AFTER stop does NOT reindex.
	// If a second watcher (orphan) were still alive, "v2" would land in kb_cards.
	fs.writeFileSync(aFile, CARD("a", "v2 AFTER STOP", "todo"), "utf8");
	await sleep(450); // well past the 100 ms debounce window
	assert.equal(
		db.prepare("SELECT title FROM kb_cards WHERE id='a'").get().title,
		"v1 ALIVE",
		"no orphan watcher may reindex after stop()",
	);

	db.close();
	fs.rmSync(root, { recursive: true, force: true });
});

test("REQ-M7-3: a second runDaemon while one is live reports already-running (no second watcher)", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "launchd-twostart-"));
	const { kbRoot } = setupProject(root);
	const sessionsDir = path.join(root, "sessions");
	fs.mkdirSync(sessionsDir, { recursive: true });
	const pidfile = path.join(root, "watch.pid");

	const db = fileDB(path.join(root, "agent.db"));
	rebuild(db, kbRoot);

	const first = launchd.runDaemon({
		db, projectsDir: root, sessionsDir, pidfile, debounceMs: 100,
		installSignals: false,
	});
	try {
		assert.equal(first.alreadyRunning, false, "first runDaemon starts");
		assert.equal(fs.existsSync(pidfile), true, "the pidfile is held while the daemon runs");

		// A SECOND start while the first is live must NOT arm a second watcher:
		// it reports already-running so the LaunchAgent / operator exits cleanly.
		const second = launchd.runDaemon({
			db, projectsDir: root, sessionsDir, pidfile, debounceMs: 100,
			installSignals: false,
		});
		assert.equal(second.alreadyRunning, true, "a second start while live must report already-running");
		assert.equal(second.pid, process.pid, "already-running reports the live holder's PID");
		assert.equal(second.handle, undefined, "an already-running result arms NO watcher");
	} finally {
		await first.stop();
	}

	// After stop the lock is free again — a fresh start succeeds (pidfile reclaimed).
	const third = launchd.runDaemon({
		db, projectsDir: root, sessionsDir, pidfile, debounceMs: 100,
		installSignals: false,
	});
	try {
		assert.equal(third.alreadyRunning, false, "after stop a fresh start reclaims the pidfile");
	} finally {
		await third.stop();
	}

	db.close();
	fs.rmSync(root, { recursive: true, force: true });
});
