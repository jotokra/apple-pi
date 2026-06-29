// sync/lib/consolidate.js — plan a device-branch consolidation (S-7).
//
// Folds another device's branch (device/<host>) into the current branch by
// classifying the three-dot diff (what the other branch CHANGED since the
// merge-base) and acting per bucket:
//   portable  → take (stage the other branch's version)
//   deviceLocal → skip (reconcile manually; never auto-overwrite)
//   secret/unknown → refuse (a secret in the diff = bug on the source device)
//
// Pure planning: planConsolidation() reads git + classifies; cli.js performs
// the staging + printing. Per the frozen decision (OQ1, 2026-06-29): the
// command STAGES portable changes and PRINTS the suggested commit/push — it
// does NOT commit, push, or auto-PR. The user reviews and runs the printed
// commands.

"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { classify, bucketOf } = require("./paths");

function git(dir, args) {
	const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
	return { status: r.status ?? 0, stdout: (r.stdout || "").trim() };
}

/** The merge-base of two refs (the divergence point), as a SHA. */
function mergeBase(dir, a, b) {
	return git(dir, ["merge-base", a, b]).stdout;
}

/** Three-dot diff: what `branch` changed since it diverged from `base`.
 *  Returns [{status, path}] where status is A(dded)/M(odified)/D(eleted)/R(enamed)/C(opied).
 *  Uses `base...branch` (three-dot) — NOT `base..branch` (two-dot, which shows
 *  total difference). The three-dot form is what you actually want to review. */
function changedSince(dir, base, branch) {
	const out = git(dir, ["diff", "--name-status", `${base}...${branch}`]);
	if (out.status !== 0) return [];
	const res = [];
	for (const line of out.stdout.split("\n").filter(Boolean)) {
		// name-status: "M\tpath" or "R100\told\tnew" (rename). Handle the common
		// A/M/D and the rename/copy by taking the LAST path column.
		const cols = line.split("\t");
		const status = cols[0];
		const file = cols[cols.length - 1];
		if (file) res.push({ status, path: file.split(path.sep).join("/") });
	}
	return res;
}

/** Plan the consolidation: classify each changed path. Returns
 *  { base, branch, portable, deviceLocal, secret, unknown } (each an array of
 *  {status, path}). `refused` = secret + unknown (the never-take set). */
function planConsolidation(dir, branch, base) {
	base = base || git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout || "HEAD";
	const c = classify(dir);
	const changes = changedSince(dir, base, branch);
	const groups = { base, branch, portable: [], deviceLocal: [], secret: [], unknown: [] };
	for (const ch of changes) {
		const b = bucketOf(ch.path, c);
		if (b === "portable") groups.portable.push(ch);
		else if (b === "deviceLocal") groups.deviceLocal.push(ch);
		else if (b === "secret") groups.secret.push(ch);
		else groups.unknown.push(ch);
	}
	groups.refused = [...groups.secret, ...groups.unknown];
	return groups;
}

module.exports = { git, mergeBase, changedSince, planConsolidation };
