// agentdb/analysis/schedule.js — scheduled autonomous analyze (M6-5).
//
// ROADMAP M6-5: extends lifecycle/schedule.sh's autoresearch jobs with a
// periodic analyze LaunchAgent. `apple-pi analyze` is the autonomous,
// read-only detectors pass — it only mutates analysis_runs +
// analysis_findings (REQ-M5-4), so it is safe to run unattended: no LLM,
// no network, no config writes. That is the one job this module schedules.
//
// HARD GATE (REQ-M6-5): the scheduled command is `analyze` ONLY. propose /
// apply / reject stay manual / gated (D9) — this module NEVER emits an
// `apply`, `propose`, or `reject` token in any argv or plist it produces.
// The red-blue suite greps the rendered plist + the args list
// case-insensitively for each gated verb and asserts the absence.
//
// API:
//   buildArgs()        -> [string]   argv appended after `node --no-warnings
//                                   bin/apple-pi`. analyze only — never a
//                                   gated verb.
//   renderPlist(opts)  -> string     pure XML plist for the LaunchAgent.
//                                   No FS, no launchctl — testable directly.
//   installPath(opts)  -> string     <home>/Library/LaunchAgents/<label>.plist.
//   statusOf(opts)     -> {installed, path, label, command}   read-only check.
//   install(opts)      -> {ok:true, path, label} | {ok:false, error}
//                                   writes the plist (mode 0o644).
//
// opts (all optional, all override-able so the suite never touches the real
// HOME): label, nodeBin, cli, hour, minute, home, piDir, logPath.
//
// This module is the plist-producing primitive. The actual `launchctl load`
// (the side effect that arms the schedule) is owned by the caller — the
// shell dispatch in lifecycle/schedule.sh loads the plist after install()
// writes it. Keeping the load out of install() means the test can exercise
// the whole REQ-M6-5 contract (analyze wired, gated verbs absent, file
// created in the right place) with zero launchctl / daemon side effects.
//
// RED-BLUE CONTRACT (REQ-M6-5):
//   - No gated verb (apply/propose/reject) ever appears in buildArgs(),
//     renderPlist(), or the installed plist. The suite greps each.
//   - install() only writes ONE plist (mode 0o644) under <home>/Library/
//     LaunchAgents — it never runs launchctl, never touches the DB, never
//     spawns the CLI. A thousand test runs leave nothing behind outside
//     the tempdir they were pointed at.
//   - analyze is read-only on the world (REQ-M5-4); scheduling it cannot
//     mutate sess_*/kb_*/config even if the job fires a thousand times.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// LABEL — the LaunchAgent label. Mirrors the com.applepi.autoresearch.*
// namespace lifecycle/schedule.sh already uses for the daily collect +
// weekly aggregate agents; this is the analyze sibling.
const LABEL = "com.applepi.autoresearch.analyze";

// The gated verbs — the manual/gated side of the loop. Kept as a constant
// so the red-blue contract is grep-able from one place. buildArgs() NEVER
// returns any of these; renderPlist() never writes any of these.
const GATED_VERBS = ["apply", "propose", "reject"];

// buildArgs() -> [string]. The argv appended after `node --no-warnings
// bin/apple-pi`. analyze ONLY — the read-only detectors pass. (measure
// finalizes pending outcome verdicts once it has a top-level CLI; until
// then analyze is the unattended job. Either way, no gated verb lands.)
function buildArgs() {
	return ["analyze"];
}

// resolveOpts(opts) -> normalized opts object with defaults filled in.
// Centralizes defaulting so renderPlist / installPath / statusOf / install
// all agree on the label, the CLI path, the schedule time, and the home.
function resolveOpts(opts = {}) {
	const o = opts && typeof opts === "object" ? opts : {};
	return {
		label: typeof o.label === "string" && o.label.length ? o.label : LABEL,
		nodeBin: typeof o.nodeBin === "string" && o.nodeBin.length ? o.nodeBin : process.execPath,
		cli: typeof o.cli === "string" && o.cli.length
			? o.cli
			: path.resolve(__dirname, "..", "..", "bin", "apple-pi"),
		hour: Number.isFinite(o.hour) ? o.hour : 6,
		minute: Number.isFinite(o.minute) ? o.minute : 30,
		home: typeof o.home === "string" && o.home.length ? o.home : os.homedir(),
		piDir: typeof o.piDir === "string" && o.piDir.length
			? o.piDir
			: (process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi")),
		logPath: typeof o.logPath === "string" && o.logPath.length ? o.logPath : null,
	};
}

// renderPlist(opts) -> string. Pure XML plist for the analyze LaunchAgent.
// Structured to mirror lifecycle/schedule.sh's autoresearch agents (same
// keys, same shape) so launchd treats it identically. No FS writes here.
function renderPlist(opts = {}) {
	const o = resolveOpts(opts);
	const logPath = o.logPath || path.join(o.piDir, "agent", "autoresearch-analyze.log");
	const args = buildArgs();
	// The hard gate, enforced structurally: buildArgs() is the ONLY source
	// of the post-CLI argv, and it returns ['analyze']. A gated verb can
	// only land here if buildArgs() returned one — which the suite asserts
	// it never does.
	const argXml = args.map((a) => `\t\t<string>${a}</string>`).join("\n");

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
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key><integer>${o.hour}</integer>
		<key>Minute</key><integer>${o.minute}</integer>
	</dict>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PI_CODING_AGENT_DIR</key><string>${o.piDir}</string>
	</dict>
	<key>StandardOutPath</key><string>${logPath}</string>
	<key>StandardErrorPath</key><string>${logPath}</string>
	<key>RunAtLoad</key><false/>
</dict>
</plist>
`;
}

// installPath(opts) -> absolute plist path under <home>/Library/LaunchAgents.
function installPath(opts = {}) {
	const o = resolveOpts(opts);
	return path.join(o.home, "Library", "LaunchAgents", `${o.label}.plist`);
}

// statusOf(opts) -> {installed, path, label, command}. Pure read-only probe
// (one fs.existsSync). `command` is a human-readable echo of what the agent
// runs — analyze only — so `schedule status` can show the operator exactly
// what the job does (and, via the test, prove no gated verb is wired in).
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
// rendered plist (mkdir -p the LaunchAgents dir first). Never calls
// launchctl, never spawns the CLI — the caller owns arming the schedule.
// Idempotent: a re-install overwrites the existing plist in place.
function install(opts = {}) {
	const o = resolveOpts(opts);
	const p = installPath(o);
	try {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, renderPlist(o), { mode: 0o644 });
	} catch (e) {
		return { ok: false, error: `schedule.install: write failed (${e.message})` };
	}
	return { ok: true, path: p, label: o.label };
}

module.exports = {
	LABEL,
	GATED_VERBS,
	buildArgs,
	renderPlist,
	installPath,
	statusOf,
	install,
};
