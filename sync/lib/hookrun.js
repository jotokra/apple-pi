// sync/lib/hookrun.js — the pre-commit secret backstop.
//
// Invoked by the git hook (sync/hook/pre-commit shim → `apple-pi sync
// hook-run`). Runs with CWD = the pi dir (= git repo root). It:
//   1. classifies paths via paths.classify() (the single authority),
//   2. refuses any staged path that lands in the `secret` bucket,
//   3. scans staged TEXT blobs for real provider key shapes,
//   4. leaves a clean exit (0) when nothing secret is staged.
//
// Cross-platform Node (no shell). The shim is one line; all logic lives here
// so the classification can't drift from paths.js.
//
// Card S-2 (library); wired to the CLI in S-3.

"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { classify, bucketOf } = require("./paths");

// Real provider key shapes (order: Anthropic, GitHub, AWS, xAI, Google AI).
// Key SHAPES only — not words like "token"/"secret", which are legitimate
// field names all over skills/docs.
const KEY_SHAPES =
	"sk-[A-Za-z0-9_-]{20,}|" +
	"gh[opsur]_[A-Za-z0-9]{36,}|" +
	"AKIA[0-9A-Z]{16}|" +
	"xai-[A-Za-z0-9]{40,}|" +
	"AIza[0-9A-Za-z_-]{35}";

/** Run git in `dir` (defaults to CWD); return trimmed stdout. */
function git(args, dir, opts = {}) {
	const r = spawnSync("git", dir ? ["-C", dir, ...args] : args, { encoding: "utf8", ...opts });
	return { status: r.status ?? 0, stdout: (r.stdout || "").trim() };
}

/** Staged files (added/copied/modified — not deleted), relative paths. */
function stagedFiles(dir) {
	const out = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"], dir);
	if (out.status !== 0) return [];
	return out.stdout ? out.stdout.split("\n") : [];
}

/** Fetch a staged blob's content from the index ([] if binary/missing). */
function stagedContent(dir, file) {
	const args = ["grep", "--cached", "-I", "--line-number", "-E", "-e", KEY_SHAPES, "--", file];
	const r = spawnSync("git", dir ? ["-C", dir, ...args] : args, { encoding: "utf8" });
	if (r.status === 0 && r.stdout) {
		// filter out comment/doc lines (false-positive hygiene)
		return r.stdout
			.split("\n")
			.filter(Boolean)
			.filter((l) => !/^[^:]+:[0-9]+:\s*(\/\/|#|\*|<!--)/.test(l));
	}
	return [];
}

/**
 * Run the hook. Returns { blocked: boolean, reasons: string[] }.
 * @param {object} [opts]
 * @param {string} [opts.dir] — pi dir (defaults to CWD)
 */
function runHook(opts = {}) {
	const dir = opts.dir || process.cwd();
	const c = classify(dir);
	const reasons = [];

	for (const file of stagedFiles(dir)) {
		const rel = file.split(path.sep).join("/");

		// (a) secret-by-path.
		if (bucketOf(rel, c) === "secret") {
			reasons.push(`secret path staged: ${rel} (auth/vault/sessions/browser-profile)`);
			continue;
		}

		// (b) secret-by-content (real key shape, not comments).
		const hits = stagedContent(dir, file);
		if (hits.length) {
			reasons.push(`provider key shape in staged content: ${rel} (${hits.length} hit${hits.length === 1 ? "" : "s"})`);
		}
	}

	return { blocked: reasons.length > 0, reasons };
}

/** CLI entry: print reasons to stderr, exit non-zero if blocked. Used by the
 *  `apple-pi sync hook-run` command (S-3). The git hook fires with GIT_DIR
 *  set, so resolve the actual repo root from git — NOT process.cwd()
 *  (which is the apple-pi install dir when invoked via the wrapper). */
function runHookCli() {
	const { spawnSync } = require("node:child_process");
	const toplevel = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout;
	const dir = (toplevel || "").trim() || process.cwd();
	const { blocked, reasons } = runHook({ dir });
	if (blocked) {
		console.error("pre-commit: BLOCKED — refusing commit (secret staged).");
		for (const r of reasons) console.error("  - " + r);
		console.error("Unstage the secret, or if it's a real key: rotate it. Run `apple-pi sync doctor` for a full check.");
		process.exit(1);
	}
	process.exit(0);
}

/** Scan ALL blobs in full git history (every commit, not just HEAD) for real
 *  provider key shapes. Returns findings: [{sha, file, line, match}].
 *  This is the deep check the pre-commit hook CAN'T do — the hook only fires on
 *  new commits, so a secret committed before the hook existed (or force-pushed
 *  around it) is invisible to it. doctor runs this. Comments/doc lines are
 *  skipped (false-positive hygiene), matching stagedContent(). */
function scanHistory(dir) {
	const { execSync } = require("node:child_process");
	// List every blob ever, with its first-seen path. `git rev-list --all --objects`
	// gives `<sha> <path>`; `cat-file --batch` would be the streaming way, but for
	// a config repo (<10k blobs typically) a per-blob grep is fine and simpler.
	let objects;
	try {
		objects = execSync("git rev-list --all --objects", { cwd: dir, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
	} catch { return []; }
	const findings = [];
	const seen = new Set();
	for (const line of objects.split("\n")) {
		if (!line.trim()) continue;
		const sp = line.indexOf(" ");
		const sha = line.slice(0, sp);
		const file = line.slice(sp + 1);
		if (!file || seen.has(sha)) continue; // skip commits-without-path + dup blobs
		seen.add(sha);
		// grep the blob content for key shapes; skip comment/doc lines.
		const r = spawnSync("git", ["-C", dir, "grep", "-I", "--line-number", "-E", "-e", KEY_SHAPES, sha], { encoding: "utf8" });
		if (r.status === 0 && r.stdout) {
			for (const l of r.stdout.split("\n").filter(Boolean)) {
				// git grep on a blob outputs `<sha>:<line>:<content>` (no path, since we
				// grepped the blob directly). Reconstruct a readable line.
				const m = l.match(/^([^:]+):([0-9]+):(.*)$/);
				if (!m) continue;
				const [, blobSha, lineno, content] = m;
				if (/^\s*(\/\/|#|\*|<!--)/.test(content)) continue; // comment/doc
				findings.push({ sha, file, line: lineno, match: content.trim() });
			}
		}
	}
	return findings;
}

module.exports = { runHook, runHookCli, scanHistory, KEY_SHAPES };
