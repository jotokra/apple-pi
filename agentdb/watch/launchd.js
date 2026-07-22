// agentdb/watch/launchd.js — watcher LaunchAgent + lazy reconcile (M7-3).
//
// SUPERPROMPT decision D4: the file watcher runs as a **launchd LaunchAgent**
// (`apple-pi kanban watch`), single-instance (pidfile). **PLUS lazy reconcile
// on every query** so it is correct even if the daemon is down. This module
// is BOTH halves of that contract:
//
//   (1) The plist-producing primitive (mirrors analysis/schedule.js):
//         buildArgs / renderPlist / installPath / statusOf / install.
//       Pure: no launchctl, no daemon spawn, no DB. The caller (a shell
//       dispatch or the operator) owns arming the schedule with launchctl.
//       The plist is a DAEMON shape — RunAtLoad=true + KeepAlive=true so
//       launchd starts the watcher on load and restarts it if it dies. It is
//       deliberately NOT a StartCalendarInterval job (this is a long-running
//       watcher, not a calendar-scheduled one-shot like `analyze`).
//
//   (2) The daemon runner + the lazy-reconcile gate:
//         runDaemon(opts)  — acquire the M7-2 pidfile, start the M7-1 watcher,
//                            install SIGINT/SIGTERM handlers (launchd sends
//                            SIGTERM on bootout), return a {stop} handle.
//                            A second runDaemon while a live PID holds the
//                            pidfile returns {alreadyRunning:true} so the
//                            LaunchAgent exits cleanly instead of arming a
//                            second fsevents watcher. stop() releases the
//                            pidfile AND closes the watcher — no orphan.
//         reconcileNow(db) — the QUERY-PATH gate: ensureCurrent() on every
//                            kb root + resume-ingest (ingestFile) on every
//                            session file. This is the "correct with NO
//                            daemon" guarantee — a card edited while the
//                            watcher is DOWN is visible on the next query.
//                            The daemon only lowers latency; it is never a
//                            correctness dependency.
//
// TIER ISOLATION: this module only ever CALLS the kb/ingest primitives (via
// watch.start / kb.ensureCurrent / ingest.ingestFile); it owns no SQL. kb_*
// is disposable (ensureCurrent reconciles it), sess_* is durable (ingestFile
// is append-only + idempotent, so resume-ingest never double-counts).
//
// ACCEPTANCE (REQ-M7-3): daemon down + edit a card -> reconcileNow (or any
// query path that calls ensureCurrent) -> the change is visible. start->stop
// leaves no orphan (pidfile released, watcher closed).
//
// Public API:
//   LABEL                       com.applepi.kanban.watch
//   buildArgs()                 -> ["kanban", "watch"]
//   renderPlist(opts)           -> string   pure daemon plist XML
//   installPath(opts)           -> string   <home>/Library/LaunchAgents/<label>.plist
//   statusOf(opts)              -> {installed, path, label, command}
//   install(opts)               -> {ok:true, path, label} | {ok:false, error}
//   pidfilePath(opts)           -> string   <piDir>/agent/kanban-watch.pid
//   runDaemon(opts)             -> {alreadyRunning:false, ready, handle, stop}
//                                  | {alreadyRunning:true, pid}
//   reconcileNow(db, opts)      -> {kbRoots, sessions, actions}
//
// opts (all optional, all override-able so the suite never touches the real
// HOME / piDir / DB): label, nodeBin, cli, home, piDir, logPath,
// db, projectsDir, sessionsDir, debounceMs, pidfile, installSignals, onError.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { start, discoverKbRoots } = require("../watch"); // resolves to ../watch.js
const { ensureCurrent } = require("../kb/index");
const { ingestFile } = require("../ingest/incremental");
const { piDir } = require("../lib/db");
const { acquirePidfile } = require("../lib/pidfile");

// LABEL — the LaunchAgent label. Mirrors the com.applepi.* namespace
// (autoresearch.* in analysis/schedule.js); this is the watcher sibling.
const LABEL = "com.applepi.kanban.watch";

// buildArgs() -> [string]. The argv appended after `node --no-warnings
// bin/apple-pi`. The daemon command is `kanban watch` — the long-running
// watcher entry point the LaunchAgent keeps alive.
function buildArgs() {
	return ["kanban", "watch"];
}

// resolveOpts(opts) -> normalized opts object with defaults filled in.
// Centralizes defaulting so the plist primitives + the daemon runner agree on
// the label, the CLI path, the home, the piDir, and the watch roots. Every
// override is a string/number check so the suite can point each at a tempdir.
function resolveOpts(opts = {}) {
	const o = opts && typeof opts === "object" ? opts : {};
	const pidHome = typeof o.piDir === "string" && o.piDir.length
		? o.piDir
		: piDir(); // lib/db.piDir() honors $PI_CODING_AGENT_DIR, else ~/.pi
	return {
		label: typeof o.label === "string" && o.label.length ? o.label : LABEL,
		nodeBin: typeof o.nodeBin === "string" && o.nodeBin.length ? o.nodeBin : process.execPath,
		cli: typeof o.cli === "string" && o.cli.length
			? o.cli
			: path.resolve(__dirname, "..", "..", "bin", "apple-pi"),
		home: typeof o.home === "string" && o.home.length ? o.home : os.homedir(),
		piDir: pidHome,
		logPath: typeof o.logPath === "string" && o.logPath.length ? o.logPath : null,
		// daemon-runner opts (ignored by the plist primitives):
		db: o.db,
		projectsDir: typeof o.projectsDir === "string" && o.projectsDir.length
			? o.projectsDir : path.join(os.homedir(), "Projects"),
		sessionsDir: typeof o.sessionsDir === "string" && o.sessionsDir.length
			? o.sessionsDir : path.join(pidHome, "sessions"),
		debounceMs: Number.isFinite(o.debounceMs) ? o.debounceMs : 150,
		pidfile: typeof o.pidfile === "string" && o.pidfile.length
			? o.pidfile : path.join(pidHome, "agent", "kanban-watch.pid"),
		// installSignals defaults TRUE: the production daemon MUST catch the
		// SIGTERM launchd sends on bootout so stop() runs (pidfile + watcher
		// released). Tests pass installSignals:false so the test runner owns
		// signal handling.
		installSignals: o.installSignals !== false,
		onError: typeof o.onError === "function" ? o.onError : (() => {}),
	};
}

// renderPlist(opts) -> string. Pure XML plist for the watcher LaunchAgent.
// DAEMON shape: RunAtLoad=true (start on load) + KeepAlive=true (restart on
// death) — launchd treats this as a long-running service. No
// StartCalendarInterval: this is not a scheduled one-shot. No FS writes here.
function renderPlist(opts = {}) {
	const o = resolveOpts(opts);
	const logPath = o.logPath || path.join(o.piDir, "agent", "kanban-watch.log");
	const argXml = buildArgs().map((a) => `\t\t<string>${a}</string>`).join("\n");

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${o.label}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${o.nodeBin}</string>
		<string>--no-warnings</string>
		<string>${o.cli}</string>
${argXml}
	</array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PI_CODING_AGENT_DIR</key><string>${o.piDir}</string>
	</dict>
	<key>StandardOutPath</key><string>${logPath}</string>
	<key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`;
}

// installPath(opts) -> absolute plist path under <home>/Library/LaunchAgents.
function installPath(opts = {}) {
	const o = resolveOpts(opts);
	return path.join(o.home, "Library", "LaunchAgents", `${o.label}.plist`);
}

// pidfilePath(opts) -> the pidfile the daemon guards. Default
// <piDir>/agent/kanban-watch.pid (same state dir as agent.db, lib/db.piDir()).
function pidfilePath(opts = {}) {
	return resolveOpts(opts).pidfile;
}

// statusOf(opts) -> {installed, path, label, command}. Pure read-only probe
// (one fs.existsSync). `command` echoes what the daemon runs so `schedule
// status` can show the operator exactly what the LaunchAgent arms.
function statusOf(opts = {}) {
	const o = resolveOpts(opts);
	const p = installPath(o);
	let installed = false;
	try { installed = fs.existsSync(p); } catch (_) { installed = false; }
	return {
		installed,
		path: p,
		label: o.label,
		command: [path.basename(o.nodeBin), "--no-warnings", "bin/apple-pi", ...buildArgs()],
	};
}

// install(opts) -> {ok:true, path, label} | {ok:false, error}. Writes the
// rendered plist (mkdir -p the LaunchAgents dir first). Never calls launchctl,
// never spawns the daemon — the caller owns arming the schedule. Idempotent:
// a re-install overwrites the existing plist in place.
function install(opts = {}) {
	const o = resolveOpts(opts);
	const p = installPath(o);
	try {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, renderPlist(o), { mode: 0o644 });
	} catch (e) {
		return { ok: false, error: `launchd.install: write failed (${e.message})` };
	}
	return { ok: true, path: p, label: o.label };
}

// runDaemon(opts) -> {alreadyRunning:false, ready, handle, stop}
//                |  {alreadyRunning:true, pid}
// The daemon entry the LaunchAgent (or an operator) invokes. Single-instance
// via the M7-2 pidfile: a second call while a live PID holds the lock returns
// {alreadyRunning:true} so the caller exits cleanly instead of arming a second
// fsevents watcher. On a fresh/stale/garbage pidfile it takes the lock, starts
// the M7-1 watcher, and installs SIGINT/SIGTERM handlers (launchd sends SIGTERM
// on bootout) that drain into stop(). stop() is idempotent and releases BOTH
// the pidfile AND the watcher — no orphan.
function runDaemon(opts = {}) {
	const o = resolveOpts(opts);

	// (1) single-instance guard (M7-2).
	const lock = acquirePidfile(o.pidfile);
	if (lock.alreadyRunning) {
		// A live watcher owns the lock: refuse, report who, and DO NOT arm a
		// second watcher. The caller (LaunchAgent / operator) turns this into a
		// clean "already running" exit. No handle, no stop — we own nothing.
		return { alreadyRunning: true, pid: lock.pid };
	}

	// (2) start the M7-1 watcher. The caller owns the db's lifecycle; we hold
	//     the same connection the primitives write to.
	const handle = start({
		db: o.db,
		projectsDir: o.projectsDir,
		sessionsDir: o.sessionsDir,
		debounceMs: o.debounceMs,
		onError: o.onError,
	});

	// (3) clean-shutdown drain. SIGINT/SIGTERM (launchd's bootout signal) -> a
	//     single idempotent stop(). stopped guards against a double-drain when
	//     both a signal and an explicit stop() race.
	let stopped = false;
	function onSignal() { void stop(); }
	if (o.installSignals) {
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);
	}

	async function stop() {
		if (stopped) return;
		stopped = true;
		// Remove our handlers first so a late signal during drain is a no-op.
		if (o.installSignals) {
			try { process.off("SIGINT", onSignal); } catch { /* best-effort */ }
			try { process.off("SIGTERM", onSignal); } catch { /* best-effort */ }
		}
		// Close the watcher (cancels the debounce timer + releases fsevents),
		// THEN release the pidfile. Order matters: the watcher must be dead
		// before we hand back the lock so a reclaiming start never races an
		// outgoing flush. Both are best-effort so a partial failure still
		// converges (no orphan, lock eventually reclaimed by a stale check).
		try { await handle.close(); } catch { /* best-effort */ }
		try { lock.release(); } catch { /* best-effort */ }
	}

	return { alreadyRunning: false, ready: handle.ready, handle, stop };
}

// reconcileNow(db, opts) -> {kbRoots, sessions, actions} — the LAZY reconcile
// gate for the query path. SUPERPROMPT §5.2: a query calls this before reading
// the mirror so kb_* is always correct with NO daemon. It runs:
//   - ensureCurrent(db, root) on every <projectsDir>/<proj>/.kanban root
//     (rebuild / incremental / noop — the kb primitive owns the decision tree)
//   - ingestFile(db, file) on every *.jsonl in the sessions dir (resume-ingest;
//     append-only + idempotent via prefix_hash, so a retry never double-counts)
// Both are best-effort / never throw: reconcileNow is on the query hot path,
// so a missing dir, an unreadable file, or one bad card must never break a
// read. Returns a summary for observability + tests.
function reconcileNow(db, opts = {}) {
	const o = resolveOpts(opts);

	// (1) kb roots -> ensureCurrent (the lazy gate; rebuild/index/noop decision
	//     lives in kb/index.js). discoverKbRoots is the same set watch.start
	//     arms, so the gate covers exactly what the daemon would.
	const roots = discoverKbRoots(o.projectsDir);
	const actions = [];
	for (const root of roots) {
		try {
			actions.push({ root, ...ensureCurrent(db, root) });
		} catch (e) {
			actions.push({ root, action: "error", error: e.message });
		}
	}

	// (2) session files -> resume-ingest. ingestFile is idempotent (prefix_hash
	//     dedup), so re-running it on an already-current file is a no-op and an
	//     appended tail is ingested append-only. A missing sessions dir yields
	//     no files (best-effort, like the rest of agentdb).
	let sessions = 0;
	let files = [];
	try {
		files = fs.readdirSync(o.sessionsDir, { withFileTypes: true })
			.filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
			.map((d) => path.join(o.sessionsDir, d.name));
	} catch { /* missing/unreadable sessions dir — nothing to resume */ }
	for (const f of files) {
		try { ingestFile(db, f); sessions++; } catch { /* best-effort: one bad file never breaks a query */ }
	}

	return { kbRoots: roots.length, sessions, actions };
}

module.exports = {
	LABEL,
	buildArgs,
	renderPlist,
	installPath,
	pidfilePath,
	statusOf,
	install,
	runDaemon,
	reconcileNow,
};
