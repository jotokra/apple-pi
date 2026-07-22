// agentdb/lib/pidfile.js — single-instance pidfile guard for the watcher (M7-2).
//
// SUPERPROMPT decision D4: the file watcher runs as a single instance
// ("single-instance (pidfile)"). This module IS that guard — a tiny, hand-rolled,
// zero-dep (D3) advisory lock keyed on a PID file. The daemon layer (M7-3,
// `apple-pi kanban watch` LaunchAgent) calls acquirePidfile() before start();
// a second invocation that finds a LIVE holder reports { alreadyRunning: true }
// so the daemon can exit cleanly with an "already running" message instead of
// arming a second fsevents watcher.
//
// Resilience (the M7-2 theme, applied to the lock itself):
//   - A STALE pidfile (the prior run crashed / was killed without release) holds
//     a PID that is no longer alive -> reclaimed, never fatal. A watcher that
//     refused to start forever after one crash would be worse than no guard.
//   - A GARBAGE / partially-written pidfile (the exact fault mode this milestone
//     hardens against in card files) is reclaimed too — best-effort, like kb/.
//   - The PID is written via temp-file + rename (atomic on POSIX) so the pidfile
//     itself is never left half-written.
//   - release() only removes the pidfile while it STILL holds OUR pid, so a
//     release after our holder died + another process reclaimed never clobbers
//     the new owner's lock.
//
// Liveness check: process.kill(pid, 0). Signal 0 is a no-op delivery probe —
// it throws ESRCH if no such process exists, EPERM if it exists but is not ours
// (treated as alive: some other user's process holds that pid). No throw => alive.
//
// API: acquirePidfile(file) -> result
//   { alreadyRunning: false, release(): void }  — we took the lock
//   { alreadyRunning: true,  pid: number }       — a live holder owns it; do
//                                                  NOT call release (we don't
//                                                  own it); the daemon exits
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// isAlive(pid) -> bool. process.kill(pid, 0) is the standard liveness probe.
function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// ESRCH: no such process -> dead. EPERM: exists but not signalable by us
		// -> treat as alive (don't steal a lock held under a pid we can't probe).
		return e && e.code === "EPERM";
	}
}

// writePidAtomic(file, pid) — temp-file + rename so the pidfile is never
// observed half-written (rename is atomic on POSIX; the same resilience we
// demand of card writes applies to the lock file). Creates the parent dir so a
// first-ever run (no ~/.pi/agent/ state yet) works without a separate mkdir.
function writePidAtomic(file, pid) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp.${pid}`;
	fs.writeFileSync(tmp, String(pid), "utf8");
	fs.renameSync(tmp, file);
}

// acquirePidfile(file) -> { alreadyRunning:false, release } | { alreadyRunning:true, pid }
function acquirePidfile(file) {
	let heldBy = null;
	try {
		const raw = fs.readFileSync(file, "utf8").trim();
		const pid = Number.parseInt(raw, 10);
		// A garbage / partially-written pidfile yields NaN -> treat as no holder
		// and reclaim below (best-effort, like the rest of agentdb).
		if (Number.isInteger(pid) && isAlive(pid)) heldBy = pid;
	} catch {
		// no pidfile at all (first run) OR unreadable -> nothing holds it.
	}

	if (heldBy !== null) {
		// A live watcher owns the lock: refuse, and report who. The caller (M7-3
		// daemon) turns this into a clean "already running" exit. release is
		// intentionally absent — we do NOT own the lock and must not free it.
		return { alreadyRunning: true, pid: heldBy };
	}

	// No live holder (first run, stale pidfile, or garbage) -> take the lock.
	writePidAtomic(file, process.pid);
	const mine = process.pid;
	return {
		alreadyRunning: false,
		// release() — free the lock. Only unlinks while the pidfile STILL holds
		// OUR pid, so a release after our holder died (and another process
		// reclaimed the lock) never deletes the new owner's pidfile. Best-effort:
		// a missing file (already cleaned up) is a no-op.
		release() {
			try {
				const cur = fs.readFileSync(file, "utf8").trim();
				if (Number.parseInt(cur, 10) === mine) fs.unlinkSync(file);
			} catch { /* already gone — nothing to release */ }
		},
	};
}

module.exports = { acquirePidfile, isAlive };
