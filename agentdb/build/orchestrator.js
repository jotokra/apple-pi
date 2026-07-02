#!/usr/bin/env node
// agentdb/build/orchestrator.js — autonomous TDD build loop.
//
// Model: deterministic JUDGE (this script) + agent WORKER (pi -a -p) + hard gates.
//   - picks next task whose deps are all done (critical-path order = tasks.json order)
//   - spawns a fresh-context worker with a focused TDD prompt
//   - RE-RUNS the task's `verify` itself and believes only that exit code
//   - green -> orchestrator commits (clean, even if worker forgot) -> regression gate
//   - red  -> feed failure back, retry (cap 3) -> else blocked + HALT
//   - resumable (progress.json), single-instance (lockfile), cron-safe (--max-tasks N)
//
// Usage:
//   node agentdb/build/orchestrator.js --dry-run            # show next task + prompt + verify, no spawn
//   node agentdb/build/orchestrator.js --once               # one task then exit
//   node agentdb/build/orchestrator.js --max-tasks 5        # up to 5 then exit (for cron)
//   node agentdb/build/orchestrator.js                      # loop until none pending or HALT
//   node agentdb/build/orchestrator.js --module M0          # restrict to a module
//
// Halts (exits non-zero, leaves progress intact) on: retry-cap exceeded, regression,
// or a needs_review task going green (waits for human). Cron should run --max-tasks N
// and let it pick up next batch.

"use strict";
const { spawnSync, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Recursively list *.test.js under a dir (Node's `--test <dir>` does NOT scan a
// directory — it treats the arg as a file. We must pass explicit files.)
function findTestFiles(dir) {
	const out = [];
	if (!fs.existsSync(dir)) return out;
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...findTestFiles(p));
		else if (/\.test\.js$/.test(e.name)) out.push(p);
	}
	return out.sort();
}
// Parse node:test TAP summary for the fail count (# fail N).
function failCount(tap) { const m = String(tap).match(/^# fail\s+(\d+)/m); return m ? parseInt(m[1], 10) : 0; }

const WT = process.cwd();                                   // run from the worktree root
const BUILD = path.join(WT, "agentdb", "build");
const TASKS = JSON.parse(fs.readFileSync(path.join(BUILD, "tasks.json"), "utf8")).tasks;
const PROGRESS_F = path.join(BUILD, "progress.json");
const LOGS = path.join(BUILD, "logs");
const LOCK = path.join(BUILD, ".orchestrator.lock");
fs.mkdirSync(LOGS, { recursive: true });

const argv = Object.fromEntries(process.argv.slice(2).reduce((a, f, i, arr) => {
	if (f.startsWith("--")) { const k = f.replace(/^--/, ""); arr[i + 1] && !arr[i + 1].startsWith("--") ? a.push([k, arr[++i]]) : a.push([k, true]); }
	return a;
}, []));
const MAX = argv.once ? 1 : (argv["max-tasks"] ? parseInt(argv["max-tasks"], 10) : Infinity);
const DRY = !!argv["dry-run"];
const ONLY_MODULE = argv.module;
const RETRY_CAP = 3;

// --- single instance ---
if (fs.existsSync(LOCK)) { console.error(`orchestrator: already running (lockfile ${LOCK}). Delete it if stale.`); process.exit(2); }
fs.writeFileSync(LOCK, String(process.pid));
const release = () => { try { fs.unlinkSync(LOCK); } catch {} };
process.on("exit", release); process.on("SIGINT", () => { release(); process.exit(130); }); process.on("SIGTERM", () => { release(); process.exit(143); });

// --- progress ---
function loadProgress() { try { return JSON.parse(fs.readFileSync(PROGRESS_F, "utf8")); } catch { return {}; } }
function saveProgress(p) { fs.writeFileSync(PROGRESS_F, JSON.stringify(p, null, 2) + "\n"); }
let progress = loadProgress();
TASKS.forEach(t => { if (!progress[t.id]) progress[t.id] = { status: "pending", attempts: 0, last_error: null, sha: null }; });
saveProgress(progress);

const done = id => progress[id] && progress[id].status === "done";
function nextTask() {
	return TASKS.find(t =>
		progress[t.id].status === "pending" &&
		(!ONLY_MODULE || t.module === ONLY_MODULE) &&
		(t.depends_on || []).every(done));
}

// --- worker prompt (fresh context per task; self-contained) ---
function workerPrompt(t) {
	return [
		`You are implementing ONE atomic task in the apple-pi agent-DB + kanban project. Work tree: ${WT} (branch feat/agent-kanban).`,
		``,
		`TASK ${t.id}: ${t.title}`,
		`SPEC: ${t.spec}`,
		`ACCEPTANCE: ${t.req}`,
		`VERIFY (the judge runs this; exit 0 = pass): ${t.verify}`,
		`FILES (hints): ${(t.files || []).join(", ")}`,
		``,
		`STANDING RULES:`,
		`- Read .docs/features/kanban/SUPERPROMPT.md section 3 (decisions D1-D10) and the task's ROADMAP block before coding.`,
		`- TDD: write/extend the test that the VERIFY command runs FIRST, run it red, then implement the minimum to pass.`,
		`- Zero new runtime deps (node:sqlite + node:test + node:fs/crypto only). chokidar only where a task explicitly needs it.`,
		`- Do NOT commit. Do NOT edit files outside ${WT}. Stop as soon as the VERIFY command passes.`,
		`- Keep the change minimal and atomic. Match existing code style.`,
	].join("\n");
}

function run(cmd) {
	const r = spawnSync(cmd, { shell: true, cwd: WT, encoding: "utf8" });
	return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
function regenDashboard() {
	const byMod = {};
	TASKS.forEach(t => { (byMod[t.module] = byMod[t.module] || []).push(t); });
	const icon = s => s === "done" ? "✅" : s === "blocked" ? "🛑" : s === "doing" ? "🟡" : "⬜";
	let md = `# BUILD — apple-pi agent DB + kanban (auto-regenerated)\n\n_Autonomous TDD loop. Judge = orchestrator.js. Truth = ROADMAP.md + git log._\n\n`;
	for (const m of Object.keys(byMod)) {
		const ts = byMod[m];
		const ndone = ts.filter(t => progress[t.id].status === "done").length;
		md += `## ${m} (${ndone}/${ts.length})\n`;
		for (const t of ts) {
			const p = progress[t.id];
			md += `- ${icon(p.status)} **${t.id}** ${t.title}` + (p.status === "blocked" ? ` — 🛑 BLOCKED: ${p.last_error || ""}` : "") + (p.sha ? ` [${p.sha.slice(0,7)}]` : "") + "\n";
		}
		md += "\n";
	}
	const blocked = TASKS.filter(t => progress[t.id].status === "blocked");
	if (blocked.length) md += `## ⚠️ Blocked (needs human)\n` + blocked.map(t => `- ${t.id}: ${progress[t.id].last_error || ""}`).join("\n") + "\n";
	fs.writeFileSync(path.join(BUILD, "BUILD.md"), md);
}

// --- main loop ---
let processed = 0;
(async () => {
	regenDashboard();
	if (DRY) {
		const t = nextTask();
		if (!t) { console.log("dry-run: no pending unblocked task"); process.exit(0); }
		console.log("=== DRY RUN ===");
		console.log("NEXT TASK:", t.id, t.title);
		console.log("VERIFY    :", t.verify);
		console.log("WOULD SPAWN: pi -a -p \"<prompt>\"  (cwd=" + WT + ")");
		console.log("PROMPT:\n" + workerPrompt(t));
		process.exit(0);
	}
	while (processed < MAX) {
		const t = nextTask();
		if (!t) { console.log(`orchestrator: no pending unblocked task. Done.`); break; }
		if (t.needs_review && progress[t.id].attempts === 0) {
			console.log(`\n🛑 HALT: task ${t.id} is needs_review — implement, then a human runs: node agentdb/build/orchestrator.js --module ${t.module}`); break;
		}
		const att = ++progress[t.id].attempts; progress[t.id].status = "doing"; progress[t.id].last_error = null; saveProgress(progress);
		console.log(`\n▶ ${t.id} (attempt ${att}/${RETRY_CAP}) — ${t.title}`);

		const prompt = att === 1 ? workerPrompt(t)
			: workerPrompt(t) + `\n\nPREVIOUS ATTEMPT FAILED. Verify output was:\n\n${(progress[t.id].last_error || "").slice(0, 4000)}\n\nFix the cause and make VERIFY pass.`;
		const logf = path.join(LOGS, `${t.id}.${att}.log`);
		fs.writeFileSync(logf, `=== ${t.id} attempt ${att} ===\n`);
		const w = spawnSync("pi", ["-a", "-p", prompt], { cwd: WT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		fs.appendFileSync(logf, w.stdout || ""); fs.appendFileSync(logf, w.stderr || "");
		if (w.status !== 0) fs.appendFileSync(logf, `\n[worker exited ${w.status}]\n`);

		const v = run(t.verify);
		fs.appendFileSync(logf, `\n=== verify (${t.verify}) exit=${v.code} ===\n${v.out.slice(0, 8000)}\n`);
		if (v.code === 0) {
			// regression gate: EVERY *.test.js under agentdb must stay green
			const testFiles = findTestFiles(path.join(WT, "agentdb"));
			let regFail = false, regOut = "";
			if (testFiles.length === 0) { regOut = "(no test files yet — regression skipped)"; }
			else {
				const reg = run("node --test " + testFiles.map(f => `"${f}"`).join(" "));
				regOut = reg.out;
				regFail = reg.code !== 0 || failCount(reg.out) > 0 || /^not ok /m.test(reg.out);
			}
			fs.appendFileSync(logf, `\n=== regression (node --test <all agentdb *.test.js: ${testFiles.length}>) ===\n${regOut.slice(-4000)}\n`);
			if (regFail) {
				progress[t.id].status = "blocked"; progress[t.id].last_error = "REGRESSION: full suite red after this task:\n" + regOut.slice(-2000);
				saveProgress(progress); regenDashboard();
				console.error(`🛑 HALT: ${t.id} passed its own verify but broke the regression suite. See ${logf}`); process.exit(1);
			}
			// commit (judge commits, not worker)
			execSync("git add -A", { cwd: WT, stdio: "pipe" });
			let sha = null;
			try { const cr = spawnSync("git", ["commit", "-q", "-m", `${t.commit}\n\n[autonomous TDD · ${t.id} · verify green · attempt ${att}]`], { cwd: WT, encoding: "utf8" });
				if (cr.status === 0) sha = execSync("git rev-parse --short HEAD", { cwd: WT, encoding: "utf8" }).trim();
				else sha = "(no changes — already committed?)"; }
			catch (e) { sha = "(commit error: " + e.message + ")"; }
			progress[t.id].status = "done"; progress[t.id].sha = sha; progress[t.id].last_error = null;
			saveProgress(progress); regenDashboard();
			console.log(`✅ ${t.id} done — ${sha}`);
			processed++;
		} else {
			progress[t.id].last_error = v.out; progress[t.id].status = "pending"; saveProgress(progress); regenDashboard();
			if (att >= RETRY_CAP) {
				progress[t.id].status = "blocked"; saveProgress(progress); regenDashboard();
				console.error(`🛑 HALT: ${t.id} failed ${RETRY_CAP} attempts. Blocked. See ${logf}`); process.exit(1);
			}
			console.log(`✗ ${t.id} verify red (attempt ${att}); retrying with failure feedback...`);
		}
	}
	regenDashboard();
	console.log(`\norchestrator: processed ${processed} task(s). See agentdb/build/BUILD.md.`);
})();
