// lifecycle/update-check.js — compare installed apple-pi / pivoice versions
// against the latest GitHub releases. READ-ONLY: never installs anything.
//
//   apple-pi update --check              human-readable diff (this module)
//   apple-pi update --check --json       machine-readable
//   (called by aggregate-week.js to append a 'source: release' section)
//
// Version source of truth: git tags. Local = `git describe --tags` in the
// apple-pi repo and the vendored pivoice; remote = GitHub releases/latest.
// Offline-safe: any fetch failure degrades to "unknown" with exit 0.

"use strict";

const { execSync } = require("node:child_process");
const { homedir } = require("node:os");
const path = require("node:path");

const REPOS = {
	"apple-pi": { owner: "jotokra", repo: "apple-pi", dir: path.join(homedir(), ".apple-pi") },
	// pivoice's source of truth is the standalone repo (~/pivoice); the vendored
	// ~/.pi/voice copy has no git history. Prefer ~/pivoice, fall back to bundle.
	pivoice: { owner: "jotokra", repo: "pivoice", dir: path.join(homedir(), "pivoice") },
};

// GitHub releases/latest as a tag, or null if unreachable / not found.
function latestRelease(owner, repo) {
	const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
	// Prefer `gh` if authenticated (avoids anonymous rate limits); fall back to curl.
	try {
		const { spawnSync } = require("node:child_process");
		const r = spawnSync("gh", ["api", url, "--jq", ".tag_name"], {
			encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"],
		});
		if (r.status === 0 && r.stdout) return r.stdout.trim() || null;
	} catch { /* gh missing */ }
	try {
		const out = execSync(
			`curl -fsSL --max-time 8 -H "Accept: application/vnd.github+json" ${url}`,
			{ encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] },
		);
		const j = JSON.parse(out);
		return (j && j.tag_name) || null;
	} catch { /* offline */ }
	return null;
}

// Local version from `git describe --tags` in dir, or "(untagged)".
function localVersion(dir) {
	try {
		const v = execSync("git describe --tags --always --dirty 2>/dev/null", {
			cwd: dir, encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return v || "(untagged)";
	} catch {
		return "(no git)";
	}
}

function checkAll() {
	const results = [];
	for (const [name, cfg] of Object.entries(REPOS)) {
		const local = localVersion(cfg.dir);
		const remote = latestRelease(cfg.owner, cfg.repo);
		let status;
		if (!remote) status = "unknown";
		else if (local.includes(remote) || local === remote) status = "current";
		else status = "behind";
		results.push({ name, local, remote, status });
	}
	return results;
}

function renderText(results) {
	const lines = ["apple-pi release check (read-only)", ""];
	for (const r of results) {
		const mark = r.status === "current" ? "✓" : r.status === "behind" ? "↑" : "?";
		const remote = r.remote || "unreachable";
		lines.push(`  ${mark} ${r.name.padEnd(9)} local ${r.local.padEnd(14)} latest ${remote}`);
	}
	lines.push("");
	const behind = results.filter((r) => r.status === "behind");
	if (behind.length) {
		lines.push("Updates available:");
		for (const r of behind) {
			const target = r.name === "pivoice" ? "--voice" : "--all";
			lines.push(`  • ${r.name}: ${r.local} → ${r.remote}  (apply: apple-pi update ${target})`);
		}
		lines.push("");
		lines.push("Note: apple-pi never auto-installs. Review, then run the command above.");
	} else if (results.every((r) => r.status === "current")) {
		lines.push("All current.");
	} else {
		lines.push("Couldn't reach GitHub for one or more repos — check network and try again.");
	}
	return lines.join("\n");
}

function main() {
	const args = process.argv.slice(2);
	const asJson = args.includes("--json");
	const results = checkAll();
	if (asJson) {
		process.stdout.write(JSON.stringify(results, null, 2) + "\n");
	} else {
		console.log(renderText(results));
	}
	// exit 0 always — "behind" is information, not an error. Offline is not an error.
	process.exit(0);
}

module.exports = { checkAll, renderText, latestRelease, localVersion, REPOS };
if (require.main === module) main();
