#!/usr/bin/env node
// lifecycle/apply-update.js — REVIEW GATE for self-improvement (Card C, L3).
//
// Nothing applies to settings.json until the user explicitly says yes.
//
//   apple-pi review                 → print the latest proposed brief + the
//                                      concrete diff it WOULD make; write nothing.
//   apple-pi apply --dry --latest   → same, from the CLI verb form.
//   apple-pi apply --latest         → apply the latest proposal's changes to
//                                      settings.json, mark it 'applied', write audit.
//   apple-pi reject --latest        → mark the latest proposal 'rejected'.
//
// Only proposals with a concrete 'setting' (not '(persona:…)' / '(review:…)'
// placeholders) touch the file. Persona/review proposals are surfaced for the
// user to act on manually.

"use strict";
const { readFileSync, writeFileSync } = require("node:fs");
const { open, isoNow, piDir } = require("./lib/db");

function settingsPath() { return `${piDir()}/agent/settings.json`; }
function readSettings() {
	try { return JSON.parse(readFileSync(settingsPath(), "utf8")); }
	catch { return {}; }
}

// latestProposal() — the most recent proposal, preferring 'proposed'.
function latestProposal(db) {
	const row = db.prepare(`SELECT * FROM proposals WHERE status='proposed' ORDER BY id DESC LIMIT 1`).get();
	if (row) return { row, why: "latest 'proposed'" };
	const any = db.prepare(`SELECT * FROM proposals ORDER BY id DESC LIMIT 1`).get();
	return any ? { row: any, why: `latest (status=${any.status})` } : null;
}

function parseProposals(row) {
	try { return JSON.parse(row.changes_json || "[]"); } catch { return []; }
}

// Split proposals into (a) concrete settings we can write, (b) persona/review
// notes the user acts on manually.
function partition(proposals) {
	const applyable = [];
	const notes = [];
	for (const p of proposals) {
		if (typeof p.setting === "string" && p.setting.startsWith("(")) notes.push(p);
		else applyable.push(p);
	}
	return { applyable, notes };
}

function getPath(obj, dotted) {
	const parts = dotted.split(".");
	let v = obj;
	for (const x of parts) v = v && v[x];
	return v;
}
function setPath(obj, dotted, value) {
	const parts = dotted.split(".");
	let v = obj;
	for (let i = 0; i < parts.length - 1; i++) v = v[parts[i]] || (v[parts[i]] = {});
	v[parts[parts.length - 1]] = value;
}

function renderDiff(proposals, settings) {
	const { applyable, notes } = partition(proposals);
	const lines = [];
	if (proposals.length === 0) {
		lines.push("No proposals to review.");
		return lines.join("\n");
	}
	lines.push(`## Applyable config changes (${applyable.length})`);
	if (applyable.length === 0) lines.push("  (none — only manual notes this week)");
	for (const p of applyable) {
		const current = getPath(settings, p.setting);
		const unchanged = JSON.stringify(current) === JSON.stringify(p.from);
		lines.push(`- ${unchanged ? "✓" : "⚠ current differs!"} \`${p.setting}\`: ${JSON.stringify(p.from)} → ${JSON.stringify(p.to)}  [${p.severity}]`);
		lines.push(`    current value: ${JSON.stringify(current)}`);
		lines.push(`    ${p.rationale}`);
	}
	if (notes.length) {
		lines.push("");
		lines.push(`## Manual notes (${notes.length}) — for you to act on, not auto-applied`);
		for (const p of notes) lines.push(`- [${p.severity}] \`${p.setting}\`: ${p.from} → ${p.to} — ${p.rationale}`);
	}
	return lines.join("\n");
}

function main() {
	const verb = process.argv[2] || "review"; // review | apply | reject
	const latest = process.argv.includes("--latest");
	const dry = process.argv.includes("--dry");
	const yes = process.argv.includes("--yes");
	const db = open("rw");
	const got = latestProposal(db);
	if (!got) {
		console.log("apply-update: no proposals yet. Run aggregate-week first.");
		db.close(); return;
	}
	const { row, why } = got;
	const proposals = parseProposals(row);
	const settings = readSettings();

	console.log(`proposal #${row.id} (${why}) — week ${row.week_start}..${row.week_end} — status=${row.status}`);
	console.log(row.summary);
	console.log(`brief: ${row.brief_path}`);
	console.log("");
	console.log(renderDiff(proposals, settings));

	if (verb === "review") {
		console.log("");
		console.log("To apply: apple-pi apply --latest [--yes]   (writes settings.json + marks 'applied')");
		console.log("To reject: apple-pi reject --latest");
		db.close(); return;
	}

	if (verb === "reject") {
		db.prepare(`UPDATE proposals SET status='rejected' WHERE id=?`).run(row.id);
		console.log(`\nrejected proposal #${row.id}.`);
		db.close(); return;
	}

	if (verb !== "apply") {
		console.error(`unknown verb '${verb}'. Use review | apply | reject.`);
		db.close(); process.exit(2);
	}

	if (row.status !== "proposed") {
		console.log(`\nproposal #${row.id} is already '${row.status}' — nothing to apply. (Find a fresh one via aggregate-week.)`);
		db.close(); return;
	}

	if (dry) {
		console.log("\n--dry: no changes written.");
		db.close(); return;
	}

	if (!yes) {
		console.log("\nRefusing to apply without --yes. Re-run: apple-pi apply --latest --yes");
		db.close(); process.exit(1);
	}

	// APPLY. Write only the applyable proposals; record what actually changed.
	const { applyable } = partition(proposals);
	const next = JSON.parse(JSON.stringify(settings)); // deep copy
	const audit = [];
	for (const p of applyable) {
		const before = getPath(next, p.setting);
		setPath(next, p.setting, p.to);
		audit.push({ setting: p.setting, before, after: p.to });
	}
	writeFileSync(settingsPath(), JSON.stringify(next, null, 2) + "\n");
	db.prepare(`UPDATE proposals SET status='applied', applied_at=?, audit=? WHERE id=?`)
		.run(isoNow(), JSON.stringify(audit), row.id);
	console.log(`\napplied ${audit.length} change(s) to ${settingsPath()}:`);
	for (const a of audit) console.log(`  ${a.setting}: ${JSON.stringify(a.before)} → ${JSON.stringify(a.after)}`);
	console.log(`marked proposal #${row.id} 'applied'.`);
	db.close();
}

main();
