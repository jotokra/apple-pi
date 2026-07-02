#!/usr/bin/env node
// autobuild/orchestrator.js — autonomous TDD builder for apple-pi.
//
// GOAL: full autonomy. Arm it once (a task queue + a worker + a regression
// command) and it drives a project to completion, committing one tested task
// at a time, halting ONLY on a real problem (a task that can't go green after
// RETRY_CAP attempts, a regression, or a needs_review task). Resumable, so it
// picks up where it left off across runs — pair with `schedule.sh` for a
// launchd job that runs unattended batches to completion.
//
// MODEL: deterministic JUDGE (this script) + agent WORKER + hard gates.
//   1. pick next task whose depends_on are all done (queue order = priority)
//   2. spawn a fresh-context worker with a focused TDD prompt
//   3. RE-RUN the task's `verify` ourselves and believe only that exit code
//   4. green -> orchestrator commits -> regression gate -> BUILD.md -> next
//      red   -> feed the failure back, retry (cap) -> else blocked + HALT
//
// It is GENERIC and PROJECT-AGNOSTIC. Nothing here knows about kanban or any
// particular repo. Configure via env (all optional):
//   AUTOBUILD_TASKS       tasks file          (default ./autobuild.tasks.json)
//   AUTOBUILD_STATE       state dir           (default ./.autobuild)
//   AUTOBUILD_WORKER      worker shell cmd    (default: pi, see WORKER below)
//   AUTOBUILD_REGRESSION  regression command  (default: "" = skip gate)
//   AUTOBUILD_RETRY_CAP   retry cap per task  (default 3)
//
// Usage:
//   node autobuild/orchestrator.js --dry-run          # show next task + prompt + verify
//   node autobuild/orchestrator.js --once             # one task, then exit
//   node autobuild/orchestrator.js --max-tasks 5      # up to 5 (for cron batches)
//   node autobuild/orchestrator.js                    # loop until done / HALT
//   node autobuild/orchestrator.js --module M0        # restrict to a module tag
//
// Task schema (in the tasks file, array under "tasks"):
//   { id, title, spec, req, verify (shell, cwd=project root, exit0=pass),
//     commit (msg), depends_on:[ids], needs_review:bool, module:tag }
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const WT = process.cwd();
const TASKS_F = process.env.AUTOBUILD_TASKS || path.join(WT, "autobuild.tasks.json");
const STATE = process.env.AUTOBUILD_STATE || path.join(WT, ".autobuild");
const LOGS = path.join(STATE, "logs");
const PROGRESS_F = path.join(STATE, "progress.json");
const LOCK = path.join(STATE, ".lock");
const RETRY_CAP = parseInt(process.env.AUTOBUILD_RETRY_CAP || "3", 10);
const REGRESSION = process.env.AUTOBUILD_REGRESSION || ""; // "" = skip
// Default worker: pi non-interactive, approve project files, prompt from file.
// Override AUTOBUILD_WORKER to use a different agent OR a fake worker in tests.
const WORKER = process.env.AUTOBUILD_WORKER || `pi -a -p "$(cat \"$AUTOBUILD_PROMPT_FILE\")"`;
fs.mkdirSync(LOGS, { recursive: true });

// --- args ---
const A = process.argv.slice(2);
const flag = k => A.includes("--" + k);
const val = k => { const i = A.indexOf("--" + k); return i >= 0 ? A[i + 1] : undefined; };
const MAX = flag("once") ? 1 : (val("max-tasks") ? parseInt(val("max-tasks"), 10) : Infinity);
const DRY = flag("dry-run");
const ONLY = val("module");

// --- single instance ---
if (fs.existsSync(LOCK)) { console.error(`autobuild: already running (lockfile ${LOCK}). Delete if stale.`); process.exit(2); }
fs.writeFileSync(LOCK, String(process.pid));
const release = () => { try { fs.unlinkSync(LOCK); } catch {} };
process.on("exit", release); process.on("SIGINT", () => { release(); process.exit(130); }); process.on("SIGTERM", () => { release(); process.exit(143); });

// --- session-capture DB (initialized at the START of the process) ---
// Captures EVERY agent + subagent session produced during the run into a durable
// SQLite store (the seed of apple-pi's unified agent DB) for future analysis.
// Non-fatal: a capture error is logged, never breaks the build.
const S = require("./sessions");
let SDB = null, RUN_ID = null;
try {
	SDB = S.initDb();
	const _r = S.startRun(SDB, { cwd: WT, tasks_file: TASKS_F, orchestrator_session: process.env.HERMES_SESSION_ID || process.env.PI_SESSION_ID || null });
	RUN_ID = _r.id;
	console.log(`autobuild: session DB ${S.DB_PATH} (run #${RUN_ID}) — capturing all agent/subagent sessions; metadata budget ${(_r.budget / 1e9).toFixed(1)} GB (30% of ${(_r.avail / 1e9).toFixed(1)} GB avail)`);
} catch (e) { console.error(`autobuild: session capture DISABLED (non-fatal): ${e.message}`); }
const endRunFinally = () => { try { if (SDB && RUN_ID != null) S.endRun(SDB, RUN_ID); } catch {} };
process.on("exit", endRunFinally); // every exit path (normal, signal, HALT) records the run end

// --- tasks + progress ---
if (!fs.existsSync(TASKS_F)) { console.error(`autobuild: tasks file not found: ${TASKS_F}`); release(); process.exit(2); }
const TASKS = JSON.parse(fs.readFileSync(TASKS_F, "utf8")).tasks;
const loadP = () => { try { return JSON.parse(fs.readFileSync(PROGRESS_F, "utf8")); } catch { return {}; } };
const saveP = p => fs.writeFileSync(PROGRESS_F, JSON.stringify(p, null, 2) + "\n");
let progress = loadP();
TASKS.forEach(t => { if (!progress[t.id]) progress[t.id] = { status: "pending", attempts: 0, last_error: null, sha: null }; });
saveP(progress);
const done = id => progress[id] && progress[id].status === "done";
const nextTask = () => TASKS.find(t =>
	progress[t.id].status === "pending" && (!ONLY || t.module === ONLY) && (t.depends_on || []).every(done));

// --- worker prompt (fresh context; self-contained) ---
function prompt(t) {
	return [
		`You are implementing ONE atomic task in a software project. Work tree: ${WT}.`,
		``,
		`TASK ${t.id}${t.module ? " (" + t.module + ")" : ""}: ${t.title}`,
		`SPEC: ${t.spec}`,
		`ACCEPTANCE: ${t.req || "(see spec)"}`,
		`VERIFY (the judge runs this after you finish; exit 0 = pass): ${t.verify}`,
		``,
		`STANDING RULES:`,
		`- Read the project's AGENTS.md / README + the task spec before coding.`,
		`- TDD: write/extend the test the VERIFY command runs FIRST, run it red, then implement the minimum to pass.`,
		`- Do NOT commit. Do NOT edit files outside ${WT}. Stop as soon as VERIFY passes.`,
		`- Keep the change minimal and atomic; match existing style; no surprising dependencies.`,
	].join("\n");
}

function run(cmd, env) {
	const r = spawnSync(cmd, { shell: true, cwd: WT, encoding: "utf8", env: { ...process.env, ...(env || {}) }, maxBuffer: 64 * 1024 * 1024 });
	return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
function regenDashboard() {
	const byM = {}; TASKS.forEach(t => (byM[t.module || "main"] = byM[t.module || "main"] || []).push(t));
	const ic = s => s === "done" ? "✅" : s === "blocked" ? "🛑" : s === "doing" ? "🟡" : "⬜";
	let md = `# AUTOBUILD — autonomous TDD builder (auto-regenerated)\n\n_Judge = orchestrator.js. Truth = tasks file + git log. Full autonomy; halts only on block/regression/review._\n\n`;
	for (const m of Object.keys(byM)) {
		const ts = byM[m], nd = ts.filter(t => progress[t.id].status === "done").length;
		md += `## ${m} (${nd}/${ts.length})\n`;
		for (const t of ts) { const p = progress[t.id]; md += `- ${ic(p.status)} **${t.id}** ${t.title}${p.status === "blocked" ? " — 🛑 " + (p.last_error || "") : ""}${p.sha ? ` [${p.sha.slice(0, 7)}]` : ""}\n`; }
		md += "\n";
	}
	const blocked = TASKS.filter(t => progress[t.id].status === "blocked");
	if (blocked.length) md += `## ⚠️ Blocked (needs human)\n` + blocked.map(t => `- ${t.id}: ${(progress[t.id].last_error || "").slice(0, 200)}`).join("\n") + "\n";
	fs.writeFileSync(path.join(STATE, "BUILD.md"), md);
}

// --- main loop ---
let processed = 0;
regenDashboard();
if (DRY) {
	const t = nextTask();
	if (!t) { console.log("dry-run: no pending unblocked task — all done or waiting on deps."); process.exit(0); }
	console.log("=== DRY RUN ===\nNEXT TASK:", t.id, "—", t.title, "\nVERIFY    :", t.verify, "\nWORKER    :", WORKER, "\n--- PROMPT ---\n" + prompt(t));
	process.exit(0);
}
while (processed < MAX) {
	const t = nextTask();
	if (!t) { console.log("autobuild: no pending unblocked task. Done."); break; }
	if (t.needs_review && progress[t.id].attempts === 0) {
		console.log(`\n🛑 HALT (needs_review): ${t.id} — implement, then re-run to judge it.`); break;
	}
	const att = ++progress[t.id].attempts; progress[t.id].status = "doing"; progress[t.id].last_error = null; saveP(progress);
	console.log(`\n▶ ${t.id} (attempt ${att}/${RETRY_CAP}) — ${t.title}`);

	const promptF = path.join(LOGS, `${t.id}.${att}.prompt`);
	fs.writeFileSync(promptF, att === 1 ? prompt(t) : prompt(t) + `\n\nPREVIOUS ATTEMPT FAILED. Verify output:\n\n${(progress[t.id].last_error || "").slice(0, 4000)}\n\nFix it so VERIFY passes.`);
	const logf = path.join(LOGS, `${t.id}.${att}.log`);
	fs.writeFileSync(logf, `=== ${t.id} attempt ${att} ===\n`);
	const _sessBefore = SDB ? S.snapshotSessions() : null;
	const _wStart = Date.now();
	let _workerId = null;
	if (SDB) { try { _workerId = S.recordWorker(SDB, RUN_ID, { task_id: t.id, attempt: att, worker_cmd: WORKER }); } catch (e) { fs.appendFileSync(logf, `\n[session record failed: ${e.message}]\n`); } }
	const w = run(WORKER, { AUTOBUILD_PROMPT_FILE: promptF, AUTOBUILD_TASK_ID: t.id, AUTOBUILD_VERIFY: t.verify });
	fs.appendFileSync(logf, w.out); if (w.code !== 0) fs.appendFileSync(logf, `\n[worker exited ${w.code}]\n`);
	// capture EVERY session the worker (+ any subagents it spawned) produced during that spawn
	if (SDB && _workerId) { try {
		const cap = S.captureNewSessions(SDB, RUN_ID, _workerId, _sessBefore);
		if (cap.length) fs.appendFileSync(logf, `\n[captured ${cap.length} session(s): ${cap.map(c => c.session_id.slice(0, 8) + "(" + c.events + "ev)").join(", ")}]\n`);
	} catch (e) {
		fs.appendFileSync(logf, `\n[session capture error: ${e.message}]\n`);
		if (e.code === "BUDGET") { console.error(`🛑 HALT: ${e.message}`); regenDashboard(); process.exit(1); }
	} }

	const v = run(t.verify);
	fs.appendFileSync(logf, `\n=== verify (${t.verify}) exit=${v.code} ===\n${v.out.slice(0, 8000)}\n`);
	if (v.code !== 0) {
		if (SDB && _workerId) { try { S.finalizeWorker(SDB, _workerId, { duration_ms: Date.now() - _wStart, verify_cmd: t.verify, verify_exit: v.code, status: "red", committed_sha: null }); } catch {} }
		progress[t.id].last_error = v.out; progress[t.id].status = "pending"; saveP(progress); regenDashboard();
		if (att >= RETRY_CAP) {
			progress[t.id].status = "blocked"; saveP(progress); regenDashboard();
			console.error(`🛑 HALT: ${t.id} failed ${RETRY_CAP} attempts — blocked. See ${logf}`); process.exit(1);
		}
		console.log(`✗ ${t.id} verify red (attempt ${att}); retrying with failure feedback…`);
		continue;
	}
	// green → regression gate
	let regFail = false, regOut = "";
	if (REGRESSION) {
		const reg = run(REGRESSION); regOut = reg.out; regFail = reg.code !== 0;
		fs.appendFileSync(logf, `\n=== regression (${REGRESSION}) exit=${reg.code} ===\n${regOut.slice(-4000)}\n`);
	}
	if (regFail) {
		progress[t.id].status = "blocked"; progress[t.id].last_error = "REGRESSION red after this task:\n" + regOut.slice(-2000);
		saveP(progress); regenDashboard();
		console.error(`🛑 HALT: ${t.id} passed verify but broke regression. See ${logf}`); process.exit(1);
	}
	// commit (judge commits, not worker)
	run("git add -A");
	let sha = null;
	const cr = spawnSync("git", ["commit", "-q", "-m", `${t.commit}\n\n[autobuild · ${t.id} · verify green · attempt ${att}]`], { cwd: WT, encoding: "utf8" });
	sha = cr.status === 0 ? spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: WT, encoding: "utf8" }).stdout.trim() : "(no changes / commit skipped)";
	if (SDB && _workerId) { try { S.finalizeWorker(SDB, _workerId, { duration_ms: Date.now() - _wStart, verify_cmd: t.verify, verify_exit: v.code, status: "green", committed_sha: sha }); } catch {} }
	progress[t.id].status = "done"; progress[t.id].sha = sha; progress[t.id].last_error = null;
	saveP(progress); regenDashboard();
	console.log(`✅ ${t.id} done — ${sha}`);
	processed++;
}
regenDashboard();
console.log(`\nautobuild: processed ${processed} task(s). Dashboard: ${path.join(STATE, "BUILD.md")}`);
