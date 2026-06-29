// sync/cli.js — `apple-pi sync <subcommand>` dispatch.
//
//   apple-pi sync init [--remote URL] [--no-push] [--name REPO] [--yes]
//       set up config sync on THIS device: git init, write .gitignore, install
//       the secret hook, create/link a private GitHub repo (via gh) or use
//       --remote URL, commit the portable set, push to main. Origin device.
//   apple-pi sync hook-run        run the pre-commit secret backstop (the git
//       hook shim calls this; you rarely invoke it directly)
//   apple-pi sync status          (S-4) unpushed portable changes + secret check
//   apple-pi sync push            (S-4) commit + push portable changes
//   apple-pi sync pull            (S-4) pull portable changes down
//   apple-pi sync doctor          (S-5) health: remote, hook, drift, history scan
//   apple-pi sync consolidate BR  (S-7) fold another device's branch in
//   apple-pi sync clone URL       (later) fresh device checkout
//
// Mirrors vault/cli.js: CommonJS, run(args) entry, node: built-ins.
// Card S-3 (init + hook-run + dispatch). Later cards fill the stubs.

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { piDir, classify } = require("./lib/paths");
const { runHookCli } = require("./lib/hookrun");
const repo = require("./lib/repo");

const EXTRA_TRACKED = ["README.md", "CONSOLIDATION.md"]; // init-created docs

function help() {
	console.log(`apple-pi sync — multi-device ~/.pi config sync

  init [--remote URL] [--no-push] [--name REPO] [--yes]
          set up sync on THIS device (origin → main): git init, .gitignore,
          secret hook, create/link a private GitHub repo (gh) or --remote,
          commit the portable set, push.
  hook-run   run the pre-commit secret backstop (the git hook calls this)
  status     what.s unpushed + secret check
  push       commit + push portable changes
  pull       pull portable changes
  doctor     health check (remote, hook, drift, full-history secret scan)
  consolidate BRANCH   fold another device's branch in (stage + print; no auto-PR)
  clone URL  (later) fresh-device checkout onto a device/<host> branch

Secrets never leave the device: auth.json, the vault, sessions, and the
browser profile are gitignored + hook-blocked. See CONSOLIDATION.md.`);
}

/** Prompt yes/no on the tty; --yes skips. */
function yorn(question, { yes = false } = {}) {
	if (yes) return true;
	process.stdout.write(question + " [y/N] ");
	const buf = Buffer.alloc(8);
	let n = 0;
	try {
		const fd = fs.openSync("/dev/stdin", "r");
		n = fs.readSync(fd, buf, 0, 8, null);
		fs.closeSync(fd);
	} catch { return false; }
	const ans = buf.toString("utf8", 0, n).trim().toLowerCase();
	return ans === "y" || ans === "yes";
}

function readLine(prompt) {
	process.stdout.write(prompt);
	let data = "";
	try {
		const fd = fs.openSync("/dev/stdin", "r");
		const b = Buffer.alloc(1024);
		const n = fs.readSync(fd, b, 0, 1024, null);
		fs.closeSync(fd);
		data = b.toString("utf8", 0, n);
	} catch {}
	return data.replace(/\r?\n$/, "");
}

function initCmd(args) {
	const dir = piDir();
	const opts = { remote: "", noPush: false, name: "apple-pi-config", yes: false };
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--remote") opts.remote = args[++i] || "";
		else if (a === "--no-push") opts.noPush = true;
		else if (a === "--name") opts.name = args[++i] || opts.name;
		else if (a === "--yes") opts.yes = true;
		else if (a === "-h" || a === "--help") { return help(), 0; }
	}

	if (!fs.existsSync(dir)) {
		console.error(`pi dir not found: ${dir}. Run 'pi' once first.`);
		return 1;
	}

	console.log(`apple-pi sync init — pi dir: ${dir}`);

	// 1. git init (idempotent) + device branch.
	repo.gitInit(dir);
	const branch = repo.deviceBranch(dir);
	console.log(`  branch: ${branch}`);

	// 2. install the secret hook.
	const hooksPath = repo.ensureHook(dir);
	console.log(`  hook:   ${hooksPath}/pre-commit (core.hooksPath set)`);

	// 3. write README + CONSOLIDATION (if absent), then the generated .gitignore.
	for (const f of EXTRA_TRACKED) {
		const p = path.join(dir, f);
		if (!fs.existsSync(p)) fs.writeFileSync(p, docStub(f));
	}
	repo.writeGitignore(dir, EXTRA_TRACKED);
	console.log("  .gitignore: generated (default-deny, portable allowlist)");

	// 4. pre-flight secret check BEFORE we commit anything.
	const prescan = runHookCheck(dir);
	if (prescan.blocked) {
		console.error("\n  !!! pre-flight secret scan blocked:");
		prescan.reasons.forEach((r) => console.error("      - " + r));
		console.error("  Resolve before init (these must not be committed). Aborting.");
		return 1;
	}

	// 5. remote: --remote URL wins; else gh create; else prompt.
	let url = opts.remote || repo.remoteUrl(dir);
	if (!url) {
		if (repo.hasGh()) {
			const owner = ghUser();
			const full = owner ? `${owner}/${opts.name}` : opts.name;
			if (yorn(`  Create private GitHub repo '${full}'?`, { yes: opts.yes })) {
				url = repo.createGhRepo(full, { isPrivate: true, description: "Synced ~/.pi config (apple-pi)." });
				if (!url) console.error("  gh repo create failed; continuing without remote.");
			}
		} else {
			url = readLine("  No gh / not authed. Paste a remote URL (or leave blank to skip): ");
		}
	}
	if (url) {
		repo.setRemote(dir, url);
		console.log(`  remote: ${url}`);
	} else {
		console.log("  remote: (none — add one later with 'apple-pi sync init --remote URL')");
	}

	// 6. write the portable settings extract, then commit the portable set.
	const profile = require("./lib/profile");
	profile.writePortableExtract(dir);
	const r = repo.commitAll(dir, initialCommitMsg());
	if (r.secretBlocked) {
		console.error("\n  !!! secret blocked at commit:");
		r.reasons.forEach((x) => console.error("      - " + x));
		return 1;
	}
	console.log(`  commit: ${r.committed ? "done" : "(nothing to commit / " + (r.stderr || "clean") + ")"}`);

	// 7. push (unless --no-push or no remote).
	if (!opts.noPush && url) {
		const p = repo.push(dir, branch);
		if (p.status === 0) console.log(`  push:  origin/${branch}`);
		else console.error(`  push FAILED: ${p.stderr || "(see above)"}`);
	} else if (opts.noPush) {
		console.log("  push:  skipped (--no-push)");
	}

	console.log("\n  ✓ sync initialized. 'apple-pi sync status' next.");
	return 0;
}

// Run the hook logic WITHOUT exiting — for pre-flight (returns reasons).
function runHookCheck(dir) {
	const { runHook } = require("./lib/hookrun");
	return runHook({ dir });
}

function ghUser() {
	const r = spawn("gh", ["api", "user", "--jq", ".login"]);
	return r.stdout.trim();
}
function spawn(cmd, a) {
	const { spawnSync } = require("node:child_process");
	const r = spawnSync(cmd, a, { encoding: "utf8", stdio: "pipe" });
	return { stdout: r.stdout || "", status: r.status };
}

function initialCommitMsg() {
	const host = os.hostname().split(".")[0] || "device";
	return `chore: initial sync from ${host}\n\nInitial portable config snapshot via 'apple-pi sync init'.`;
}

function docStub(which) {
	if (which === "README.md") {
		return "# ~/.pi config (apple-pi sync)\n\nSynced via `apple-pi sync`. See CONSOLIDATION.md for the merge model.\n";
	}
	return "# CONSOLIDATION.md\n\nFold other devices' branches into `main`. See `apple-pi sync consolidate`.\n";
}

// ---- status / push / pull (S-4) ----

function statusCmd() {
	const dir = piDir();
	if (!repo.isRepo(dir)) {
		console.log("sync: not initialized. Run 'apple-pi sync init'.");
		return 1;
	}
	const branch = repo.deviceBranch(dir);
	const remote = repo.remoteUrl(dir) || "(none)";
	const hookOk = repo.hookHealthy(dir);
	const dirty = repo.dirtyPortable(dir);
	const unpushed = repo.unpushedCount(dir, branch);
	const c = classify(dir);

	console.log(`apple-pi sync status — ${dir}`);
	console.log(`  branch: ${branch}`);
	console.log(`  remote: ${remote}`);
	console.log(`  hook:   ${hookOk ? "active (core.hooksPath)" : "NOT active — run 'apple-pi sync init' to reinstall"}`);
	console.log(`  portable changes uncommitted: ${dirty.length}${dirty.length ? " (" + dirty.slice(0, 5).join(", ") + (dirty.length > 5 ? ", …" : "") + ")" : ""}`);
	console.log(`  commits unpushed:            ${unpushed}`);
	// pre-flight secret check on the working tree (advisory).
	const { runHook } = require("./lib/hookrun");
	console.log(`  secret scan (staged):         ${(() => { const r = runHook({ dir }); return r.blocked ? "⚠ " + r.reasons.length + " secret(s) staged" : "clean"; })()}`);
	if (unpushed > 0 || dirty.length > 0) {
		console.log(`\n  → 'apple-pi sync push' to commit + push ${dirty.length ? "your " + dirty.length + " portable change(s)" : ""}${dirty.length && unpushed ? " and " : ""}${unpushed ? unpushed + " unpushed commit(s)" : ""}.`);
	} else {
		console.log("\n  ✓ in sync.");
	}
	return 0;
}

function pushCmd(args) {
	const dir = piDir();
	if (!repo.isRepo(dir)) { console.error("sync: not initialized. Run 'apple-pi sync init'."); return 1; }
	const message = pickFlag(args, "--message", "-m") || `chore(sync): portable update from ${os.hostname().split(".")[0]}`;
	const branch = repo.deviceBranch(dir);
	if (!repo.remoteUrl(dir)) { console.error("sync: no remote set. Run 'apple-pi sync init --remote URL'."); return 1; }

	// S-6: refresh the portable extract from settings.json BEFORE computing
	// dirty. If settings.json's portable fields changed, this writes
	// settings.portable.json so it shows as a dirty portable path.
	const profile = require("./lib/profile");
	profile.writePortableExtract(dir);

	const dirty = repo.dirtyPortable(dir);
	const unpushed = repo.unpushedCount(dir, branch);

	// ALWAYS pre-flight the secret scan — even on a clean tree, a force-staged
	// secret must not slip through the "nothing to push" exit (S-4.3).
	const { runHook } = require("./lib/hookrun");
	const prescan = runHook({ dir });
	if (prescan.blocked) {
		console.error("sync push: BLOCKED — secret in the staged set:");
		prescan.reasons.forEach((x) => console.error("  - " + x));
		return 1;
	}

	if (!dirty.length && !unpushed) { console.log("sync: nothing to push (clean, in sync)."); return 0; }

	let committed = false;
	if (dirty.length) {
		// refresh .gitignore in case the classification changed (new path added)
		repo.writeGitignore(dir, EXTRA_TRACKED);
		const r = repo.commitAll(dir, message);
		if (r.secretBlocked) {
			console.error("sync push: BLOCKED — secret in the staged set:");
			r.reasons.forEach((x) => console.error("  - " + x));
			return 1;
		}
		committed = r.committed;
		console.log(`  committed: ${committed ? dirty.length + " portable change(s)" : "(nothing staged)"}`);
	}
	const p = repo.push(dir, branch);
	if (p.status === 0) { console.log(`  pushed: origin/${branch}`); return 0; }
	console.error(`  push FAILED: ${p.stderr || "(see above)"}`);
	return 1;
}

function pullCmd(args) {
	const dir = piDir();
	if (!repo.isRepo(dir)) { console.error("sync: not initialized. Run 'apple-pi sync init'."); return 1; }
	if (!repo.remoteUrl(dir)) { console.error("sync: no remote set."); return 1; }
	const branch = repo.deviceBranch(dir);
	repo.fetch(dir);
	const unpushed = repo.unpushedCount(dir, branch);
	if (unpushed > 0) {
		console.error(`sync: ${unpushed} local commit(s) not pushed — push first (pull would diverge).`);
		return 1;
	}
	const r = repo.pull(dir, branch);
	if (r.status === 0) {
		// S-6: merge the just-pulled portable extract into local settings.json,
		// preserving device-specific fields (sessionDir, shellPath, model, …).
		const profile = require("./lib/profile");
		const m = profile.applyPortableMerge(dir);
		console.log(`  pulled: origin/${branch} (up to date or fast-forwarded)${m.changed ? " + merged portable settings" : ""}`);
		return 0;
	}
	console.error(`  pull FAILED: ${r.stderr || "(see above)"}`);
	console.error("  (if this is a non-ff history, reconcile via 'apple-pi sync consolidate' instead.)");
	return 1;
}

/** Pull a `--flag value` (or `-f value`) from args; returns value or "". */
function pickFlag(args, ...names) {
	for (let i = 0; i < args.length; i++) {
		if (names.includes(args[i])) return args[i + 1] || "";
	}
	return "";
}

// ---- doctor (S-5): health + full-history secret scan ----
function doctorCmd() {
	const dir = piDir();
	const c = classify(dir);
	const checks = [];
	const warn = (msg) => checks.push({ level: "WARN", msg });
	const ok = (msg) => checks.push({ level: "OK", msg });
	const bad = (msg) => checks.push({ level: "FAIL", msg });

	console.log(`apple-pi sync doctor — ${dir}\n`);

	// 1. repo initialized?
	if (repo.isRepo(dir)) ok(`git repo initialized (branch ${repo.deviceBranch(dir)})`);
	else { bad("not a git repo — run 'apple-pi sync init'."); return report(checks); }

	// 2. remote set?
	const remote = repo.remoteUrl(dir);
	remote ? ok(`remote set: ${remote}`) : warn("no remote — push/pull disabled. Run 'apple-pi sync init --remote URL'.");

	// 3. hook active?
	repo.hookHealthy(dir) ? ok("secret hook active (core.hooksPath=.githooks)") : warn("hook NOT active — run 'apple-pi sync init' to reinstall.");

	// 4. classification drift: does the committed .gitignore match a fresh generate?
	const fs = require("node:fs");
	const { generate } = require("./lib/gitignore");
	const fresh = generate(c, EXTRA_TRACKED);
	const committed = fs.existsSync(path.join(dir, ".gitignore")) ? fs.readFileSync(path.join(dir, ".gitignore"), "utf8") : "";
	if (committed === fresh) ok(".gitignore matches current classification (no drift)");
	else warn(".gitignore drifts from current classification — re-run 'apple-pi sync init' (or 'sync push') to regenerate.");

	// 5. device-local files tracked (they should be — reconcile, not exclude)?
	const head = repo.git(dir, ["ls-tree", "-r", "--name-only", "HEAD"]).stdout.split("\n");
	const missingLocal = [];
	for (const p of c.deviceLocal) {
		const rel = p.replace(/\/\*\*$/, "");
		if (!head.includes(rel)) missingLocal.push(rel);
	}
	if (missingLocal.length) warn(`device-local not in HEAD (won't sync): ${missingLocal.join(", ")}`);
	else ok("device-local files tracked (committed, reconcile per-device)");

	// 6. THE DEEP CHECK: full-git-history secret scan.
	console.log("  scanning full git history for leaked key shapes…");
	const { scanHistory } = require("./lib/hookrun");
	const findings = scanHistory(dir);
	if (findings.length === 0) ok("no provider key shapes in git history");
	else {
		bad(`${findings.length} potential key-shape finding(s) in git history:`);
		for (const f of findings.slice(0, 20)) {
			console.error(`    ${f.file}:${f.line} (${f.sha.slice(0, 8)})  ${f.match.slice(0, 60)}`);
		}
		console.error("    If any is a real key: rotate it now, then `git filter-repo` / BFG to purge history.");
	}

	return report(checks);
}

function report(checks) {
	const fails = checks.filter((c) => c.level === "FAIL").length;
	const warns = checks.filter((c) => c.level === "WARN").length;
	for (const c of checks) console.log(`  [${c.level}] ${c.msg}`);
	console.log(`\n${fails ? `${fails} FAIL` : "all checks passed"}${warns ? `, ${warns} WARN` : ""}.`);
	return fails ? 1 : 0;
}

// ---- consolidate (S-7): fold a device branch in (stage + print) ----
function consolidateCmd(args) {
	const dir = piDir();
	if (!repo.isRepo(dir)) { console.error("sync: not initialized. Run 'apple-pi sync init'."); return 1; }
	const branch = args.find((a) => !a.startsWith("-"));
	if (!branch) { console.error("usage: apple-pi sync consolidate <branch>  (e.g. origin/device/phone)"); return 2; }
	if (!repo.remoteUrl(dir)) { console.error("sync: no remote set."); return 1; }

	// Fetch so the branch ref is current, then plan.
	repo.fetch(dir);
	const con = require("./lib/consolidate");
	const here = repo.deviceBranch(dir);
	const plan = con.planConsolidation(dir, branch, here);

	console.log(`apple-pi sync consolidate — ${branch} → ${here}`);
	console.log(`  merge-base: ${con.mergeBase(dir, here, branch).slice(0, 8)}`);
	console.log(`  changes since divergence: ${plan.portable.length + plan.deviceLocal.length + plan.refused.length}\n`);

	if (plan.refused.length) {
		// A secret or unknown path in the diff = the source device has a broken
		// gitignore or force-committed a secret. Do NOT take anything; report.
		console.error("  REFUSED — these must not merge (secret or unclassified):");
		for (const r of plan.refused) console.error(`    [${r.status}] ${r.path}`);
		console.error("\n  A secret here means the source device's .gitignore is stale or a secret was force-added. Fix it there first.");
		return 1;
	}

	if (!plan.portable.length) {
		console.log("  No portable changes to take.");
		if (plan.deviceLocal.length) {
			console.log("\n  Device-local files differ (reconcile manually, do NOT overwrite):"  );
			for (const d of plan.deviceLocal) console.log(`    [${d.status}] ${d.path}`);
		}
		return 0;
	}

	// Stage each portable change from the other branch's version.
	const staged = [];
	for (const p of plan.portable) {
		if (p.status === "D") {
			repo.git(dir, ["rm", "--", p.path]);
			staged.push(`-D ${p.path}`);
		} else {
			repo.git(dir, ["checkout", branch, "--", p.path]);
			staged.push(`-${p.status} ${p.path}`);
		}
	}

	console.log("  STAGED (portable, from " + branch + "):");
	for (const s of staged) console.log("    " + s);
	if (plan.deviceLocal.length) {
		console.log("\n  SKIPPED (device-local — reconcile manually if the insight is portable):");
		for (const d of plan.deviceLocal) console.log(`    [${d.status}] ${d.path}`);
	}

	// Per the frozen decision (OQ1): stage + print. Do NOT commit/push/PR.
	console.log("\n  Review with:  git diff --cached");
	console.log("  Then commit:  git commit -m \"chore(consolidate): fold " + branch + " into " + here + "\"");
	console.log("  Then push:    git push");
	console.log("\n  (sync consolidate stages only — it does not commit or push. Review first.)");
	return 0;
}

// ---- stubs filled by later cards ----
function notYet(cmd) {
	console.error(`'apple-pi sync ${cmd}' ships in a later card (see the config-sync feature spec).`);
	return 1;
}

function run(args) {
	const [cmd, ...rest] = args;
	switch (cmd) {
		case undefined:
		case "-h":
		case "--help":
		case "help":
			return help(), 0;
		case "init":     return initCmd(rest);
		case "hook-run": return runHookCli();
		case "status":   return statusCmd();
		case "push":     return pushCmd(rest);
		case "pull":     return pullCmd(rest);
		case "doctor":   return doctorCmd();
		case "consolidate": return consolidateCmd(rest);
		case "clone":
			return notYet(cmd);
		default:
			console.error(`unknown sync command: ${cmd} (try 'apple-pi sync help')`);
			return 2;
	}
}

module.exports = { run };
