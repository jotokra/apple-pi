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
  status     (S-4) what's unpushed + secret check
  push       (S-4) commit + push portable changes
  pull       (S-4) pull portable changes
  doctor     (S-5) health check (remote, hook, drift, history secret scan)
  consolidate BRANCH  (S-7) fold another device's branch into main
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

	// 6. commit the portable set.
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

// ---- stubs filled by later cards (S-4..S-7) ----
function notYet(cmd) {
	console.error(`'apple-pi sync ${cmd}' ships in a later card (see .docs/decisions/2026-06-28-config-sync-feature.md).`);
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
		case "status":
		case "push":
		case "pull":
		case "doctor":
		case "consolidate":
		case "clone":
			return notYet(cmd);
		default:
			console.error(`unknown sync command: ${cmd} (try 'apple-pi sync help')`);
			return 2;
	}
}

module.exports = { run };
