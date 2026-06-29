// sync/lib/repo.js — git + gh primitives for config sync.
//
// All git/gh interaction lives here so cli.js reads as the flow. The hook
// shim (sync/hook/pre-commit) is copied into <piDir>/.githooks/ and
// core.hooksPath pointed at it — that dir is gitignored (regenerable infra).
//
// Card S-3. See .docs/decisions/2026-06-28-config-sync-feature.md.

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { classify } = require("./paths");
const { generate } = require("./gitignore");
const { runHook } = require("./hookrun");

const HOOK_DIR = ".githooks";           // relative to pi dir; gitignored
const HOOK_SOURCE = path.join(__dirname, "..", "hook", "pre-commit");

/** Run git in dir; returns {status, stdout, stderr}. */
function git(dir, args) {
	const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
	return { status: r.status ?? 0, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

/** Is `gh` installed AND authed? */
function hasGh() {
	const which = spawnSync("gh", ["auth", "status"], { encoding: "utf8", stdio: "pipe" });
	return which.status === 0;
}

/** Is <dir> already a git repo? */
function isRepo(dir) {
	return git(dir, ["rev-parse", "--is-inside-work-tree"]).status === 0;
}

/** git init (idempotent) + main as default branch. */
function gitInit(dir) {
	if (!isRepo(dir)) {
		git(dir, ["init", "-q", "-b", "main"]);
	}
	return isRepo(dir);
}

/** Current git branch, or "main" if none checked out / not a repo.
 *  init always lands on `main` (origin device); clone (later) switches to
 *  `device/<hostname>` for leaf devices. */
function deviceBranch(dir) {
	const r = git(dir, ["branch", "--show-current"]);
	return r.stdout || "main";
}

/** Install the secret-leak hook: copy shim → <dir>/.githooks/pre-commit,
 *  chmod +x, set core.hooksPath. Idempotent. Returns the hooksPath set. */
function ensureHook(dir) {
	const hookDir = path.join(dir, HOOK_DIR);
	fs.mkdirSync(hookDir, { recursive: true });
	const dst = path.join(hookDir, "pre-commit");
	fs.copyFileSync(HOOK_SOURCE, dst);
	fs.chmodSync(dst, 0o755);
	git(dir, ["config", "core.hooksPath", HOOK_DIR]);
	return HOOK_DIR;
}

/** Is the hook installed (hooksPath set + shim present + executable)? */
function hookHealthy(dir) {
	const hp = git(dir, ["config", "--get", "core.hooksPath"]).stdout;
	if (hp !== HOOK_DIR) return false;
	const shim = path.join(dir, HOOK_DIR, "pre-commit");
	try {
		if (!fs.existsSync(shim)) return false;
		if (!(fs.statSync(shim).mode & 0o111)) return false;
	} catch { return false; }
	return true;
}

/** Write the generated .gitignore (+ extra allowlisted paths). */
function writeGitignore(dir, extra = []) {
	const gi = generate(classify(dir), extra);
	fs.writeFileSync(path.join(dir, ".gitignore"), gi);
}

/** Stage everything (scoped by .gitignore), verify no secrets via the hook,
 *  commit. Returns {committed, secretBlocked, reasons}. */
function commitAll(dir, message) {
	git(dir, ["add", "-A"]);
	const { blocked, reasons } = runHook({ dir });
	if (blocked) return { committed: false, secretBlocked: true, reasons };
	const r = git(dir, ["commit", "-q", "-m", message]);
	return { committed: r.status === 0, secretBlocked: false, reasons: [], status: r.status, stderr: r.stderr };
}

/** Current remote origin URL, or "" if none. */
function remoteUrl(dir) {
	return git(dir, ["config", "--get", "remote.origin.url"]).stdout;
}

/** Add/set the origin remote (idempotent). */
function setRemote(dir, url) {
	if (remoteUrl(dir)) git(dir, ["remote", "set-url", "origin", url]);
	else git(dir, ["remote", "add", "origin", url]);
}

/** Create a private GitHub repo via gh, return its URL (or "" on failure). */
function createGhRepo(name, { isPrivate = true, description = "" } = {}) {
	const args = ["repo", "create", name, isPrivate ? "--private" : "--public"];
	if (description) args.push("--description", description);
	const r = spawnSync("gh", args, { encoding: "utf8", stdio: "pipe" });
	if (r.status !== 0) return "";
	// gh prints the new repo URL to stdout.
	const m = (r.stdout + "").match(/https?:\/\/\S+/);
	return m ? m[0] : "";
}

/** `git push -u origin <branch>`. Returns {status, stderr}. */
function push(dir, branch) {
	const r = git(dir, ["push", "-u", "origin", branch]);
	return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

module.exports = {
	git, hasGh, isRepo, gitInit, deviceBranch,
	ensureHook, hookHealthy, writeGitignore, commitAll,
	remoteUrl, setRemote, createGhRepo, push,
	HOOK_DIR,
};
