// agentdb/analysis/schedule.test.js — scheduled autonomous analyze (M6-5).
//
// ROADMAP M6-5 acceptance gate (REQ-M6-5):
//   schedule install creates the LaunchAgent; analyze runs unattended;
//   no apply ever fires from the schedule.
//
// This suite drives agentdb/analysis/schedule.js's pure primitives
// (buildArgs / renderPlist / installPath / statusOf / install) directly.
// Every FS-touching case points `home` at a throwaway tempdir so the real
// ~/Library/LaunchAgents is never mutated by the test run.
//
// The headline assertion is the HARD GATE: the scheduled job runs analyze
// (read-only on the world) and NEVER emits apply/propose/reject — those
// stay manual/gated. The red-blue cases grep the rendered plist + argv
// case-insensitively for each gated verb.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const sched = require("./schedule");

// freshHome() — a tempdir that stands in for $HOME so install() writes its
// plist somewhere disposable. Caller owns cleanup.
function freshHome() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "sched-m65-"));
}

// plistIsReadable(text) — a LaunchAgent plist must be XML-parseable, so a
// malformed hand-rolled string never lands in ~/Library/LaunchAgents. Uses
// node's built-in DOM-free parser via the `xml` package not being available,
// so we settle for the structural invariants launchd itself checks: the
// <plist>/<dict> envelope, a <Label>, a <ProgramArguments>, and a
// StartCalendarInterval with an Hour.
function plistShapeOk(text) {
	if (typeof text !== "string" || text.length === 0) return false;
	if (!text.includes("<?xml")) return false;
	if (!text.includes("<plist")) return false;
	if (!text.includes("<dict>")) return false;
	if (!/<key>Label<\/key>\s*<string>[^<]+<\/string>/.test(text)) return false;
	if (!/<key>ProgramArguments<\/key>/.test(text)) return false;
	if (!/<key>StartCalendarInterval<\/key>/.test(text)) return false;
	if (!/<key>Hour<\/key>\s*<integer>\d+<\/integer>/.test(text)) return false;
	return true;
}

// The gated verbs — the manual/gated side of the loop. NONE of these may
// ever appear in anything the schedule emits (REQ-M6-5 hard gate).
const GATED_VERBS = ["apply", "propose", "reject"];

// =====================================================================
// ABUSE SUITE — must run first
// =====================================================================

test("abuse: schedule module exports the primitive surface", () => {
	for (const fn of ["buildArgs", "renderPlist", "installPath", "statusOf", "install", "LABEL"]) {
		assert.notEqual(sched[fn], undefined, `schedule.${fn} must be exported`);
	}
	assert.equal(typeof sched.buildArgs, "function");
	assert.equal(typeof sched.renderPlist, "function");
	assert.equal(typeof sched.installPath, "function");
	assert.equal(typeof sched.statusOf, "function");
	assert.equal(typeof sched.install, "function");
});

test("abuse: renderPlist() with no opts still yields a well-shaped plist", () => {
	const text = sched.renderPlist();
	assert.ok(plistShapeOk(text), `default plist should be well-shaped; got:\n${text}`);
});

// =====================================================================
// REQ-M6-5 — HARD GATE: no gated verb ever fires from the schedule
// =====================================================================

test("REQ-M6-5 hard gate: buildArgs() contains analyze and NO gated verb", () => {
	const args = sched.buildArgs();
	assert.ok(Array.isArray(args) && args.length > 0, "buildArgs returns a non-empty argv tail");
	assert.ok(args.includes("analyze"), `buildArgs must include 'analyze'; got ${JSON.stringify(args)}`);
	for (const v of GATED_VERBS) {
		assert.ok(!args.some((a) => String(a).toLowerCase() === v),
			`buildArgs must never include '${v}'; got ${JSON.stringify(args)}`);
	}
});

test("REQ-M6-5 hard gate: rendered plist contains analyze and NO gated verb (case-insensitive)", () => {
	const text = sched.renderPlist();
	const lower = text.toLowerCase();
	assert.ok(lower.includes("analyze"), "plist must reference analyze");
	for (const v of GATED_VERBS) {
		// 'apply'/'propose'/'reject' as standalone argv tokens are what would
		// actually fire the gated side. We assert the token never appears as
		// <string>apply</string> etc. — the verb as a scheduled command.
		assert.ok(!new RegExp(`<string>\\s*${v}\\s*</string>`, "i").test(text),
			`plist must never schedule '${v}' as a <string> arg; grep hit in:\n${text}`);
	}
});

// =====================================================================
// REQ-M6-5 — analyze runs unattended (scheduled, not load-triggered)
// =====================================================================

test("REQ-M6-5: analyze is wired to run unattended on a calendar schedule", () => {
	const text = sched.renderPlist();
	assert.ok(/<key>StartCalendarInterval<\/key>/.test(text),
		"plist must carry a StartCalendarInterval so analyze fires on its own");
	// RunAtLoad=false — the job fires on the schedule, not on every load.
	// (Matches lifecycle/schedule.sh's existing autoresearch agents.)
	assert.ok(/<key>RunAtLoad<\/key>\s*<false\/>/.test(text),
		"RunAtLoad must be false so analyze only fires on schedule; got:\n" + text);
	// ProgramArguments must list `analyze` as one of the CLI subcommands.
	assert.ok(/<string>analyze<\/string>/.test(text),
		"ProgramArguments must include <string>analyze</string>");
});

test("REQ-M6-5: hour/minute overrides land in the rendered plist", () => {
	const text = sched.renderPlist({ hour: 3, minute: 15 });
	assert.ok(/<key>Hour<\/key>\s*<integer>3<\/integer>/.test(text), "hour override present");
	assert.ok(/<key>Minute<\/key>\s*<integer>15<\/integer>/.test(text), "minute override present");
	// The gated verbs still do not appear even with overrides.
	for (const v of GATED_VERBS) {
		assert.ok(!new RegExp(`<string>\\s*${v}\\s*</string>`, "i").test(text),
			`overrides must not sneak in '${v}'`);
	}
});

// =====================================================================
// REQ-M6-5 — schedule install creates the LaunchAgent
// =====================================================================

test("REQ-M6-5: installPath() resolves under <home>/Library/LaunchAgents with the label", () => {
	const home = freshHome();
	try {
		const p = sched.installPath({ home });
		assert.equal(p, path.join(home, "Library", "LaunchAgents", `${sched.LABEL}.plist`));
		assert.equal(path.extname(p), ".plist");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("REQ-M6-5: statusOf() reports not-installed before install, installed after", () => {
	const home = freshHome();
	try {
		const before = sched.statusOf({ home });
		assert.equal(before.installed, false, "nothing installed yet");
		assert.equal(before.label, sched.LABEL);
		assert.equal(before.path, sched.installPath({ home }));
		assert.ok(before.command.join(" ").includes("analyze"), "status command names analyze");
		assert.ok(!GATED_VERBS.some((v) => before.command.join(" ").toLowerCase().includes(v)),
			"status command must not name a gated verb");

		const res = sched.install({ home });
		assert.equal(res.ok, true, `install should succeed; got ${JSON.stringify(res)}`);
		assert.equal(res.path, sched.installPath({ home }));

		const after = sched.statusOf({ home });
		assert.equal(after.installed, true, "install created the LaunchAgent");

		// The on-disk plist is well-shaped and obeys the hard gate.
		const onDisk = fs.readFileSync(after.path, "utf8");
		assert.ok(plistShapeOk(onDisk), "installed plist is well-shaped");
		assert.ok(onDisk.toLowerCase().includes("analyze"), "installed plist references analyze");
		for (const v of GATED_VERBS) {
			assert.ok(!new RegExp(`<string>\\s*${v}\\s*</string>`, "i").test(onDisk),
				`installed plist must never schedule '${v}'`);
		}
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("REQ-M6-5: install() is idempotent (re-install does not throw)", () => {
	const home = freshHome();
	try {
		const r1 = sched.install({ home });
		assert.equal(r1.ok, true);
		const r2 = sched.install({ home });
		assert.equal(r2.ok, true, "second install must succeed (overwrite)");
		// Still exactly one plist at the path.
		const files = fs.readdirSync(path.join(home, "Library", "LaunchAgents"));
		assert.equal(files.length, 1, "exactly one LaunchAgent plist after re-install");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("REQ-M6-5: install() writes only inside <home>/Library/LaunchAgents (no escape)", () => {
	const home = freshHome();
	try {
		sched.install({ home });
		const agentsDir = path.join(home, "Library", "LaunchAgents");
		const agentsEntries = fs.readdirSync(agentsDir);
		assert.deepEqual(agentsEntries, [`${sched.LABEL}.plist`]);

		// No plist leaked to the real ~/Library/LaunchAgents via this call —
		// the tempdir was the only home it knew about.
		const realPath = path.join(require("node:os").homedir(), "Library", "LaunchAgents", `${sched.LABEL}.plist`);
		// (We can't assert the real one doesn't exist in absolute terms — the
		// operator may have installed it for real — but the tempdir install
		// must resolve to the tempdir path, NOT the real path.)
		const writtenTo = sched.installPath({ home });
		assert.notEqual(writtenTo, realPath, "tempdir install must not resolve to the real home");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
