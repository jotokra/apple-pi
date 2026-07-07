// agentdb/kb/write.test.js — RED-BLUE abuse-case suite for the truth writer.
//
// ROADMAP M2-5 acceptance gate: "abuse paths rejected with no write; legal
// move diff is exactly status+updated_at lines." The first half of this
// file is the abuse suite — every reject path must:
//   1. return { ok: false, errors: [...] }
//   2. NOT touch the filesystem (no new files, no modifications to the
//      canonical fixture, no leftover .tmp/ directories).
//
// The second half is the happy path: legal transitions round-trip with
// a 2-line diff against the original; created_at and id stay untouched;
// setField preserves every byte except the changed line + updated_at.
//
// All tests use a fresh per-test tmp dir (mkdtempSync) so they're
// isolated and parallel-safe. The "before/after diff" tests capture the
// file content before and after the write, then assert byte-for-byte
// equality of every line EXCEPT the two known-changed lines.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { createCard, moveStatus, setField, resolveUnderRoot } = require("./write");
const { STATUS_ENUM } = require("./status");

// mkTmpRoot(prefix) -> string. Returns a fresh absolute path under
// os.tmpdir(); the caller must rmdirSync when done (cleanup() helper).
function mkTmpRoot(label) {
	const stamp = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
	const p = path.join(os.tmpdir(), `kb-write-test-${label}-${stamp}`);
	fs.mkdirSync(p, { recursive: true });
	return p;
}

// A canonical fixture card mirroring agentdb/test/fixtures/good.card.md's
// shape. Used as the baseline for "moveStatus diff == 2 lines" tests.
const FIXTURE_BODY = `# M2-5 acceptance

Some body content for the test.
`;
const FIXTURE_FRONT = `---
id: m2-5-fixture
title: M2-5 acceptance fixture
status: todo
priority: 5
project: apple-pi
assignee: worker
depends_on: []
tags: [m2, red-blue]
est_commits: 1
parallel_safe: true
created_at: 2026-07-03T00:00:00.000Z
updated_at: 2026-07-03T00:00:00.000Z
---
${FIXTURE_BODY}`;

// writeFixture(root, file) — writes FIXTURE_FRONT to <root>/<file>,
// creating parent dirs as needed. Returns the absolute path.
function writeFixture(root, file = "fixture.card.md") {
	const abs = path.join(root, file);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, FIXTURE_FRONT, "utf8");
	return abs;
}

// snapshotTree(root) -> Map<relPath, content>. Captures every regular
// file under root (including hidden .tmp/) for "no filesystem change"
// assertions.
function snapshotTree(root) {
	const out = new Map();
	function walk(dir) {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) out.set(path.relative(root, full), fs.readFileSync(full, "utf8"));
		}
	}
	walk(root);
	return out;
}

// diffLines(before, after) -> { added: string[], removed: string[] }
// Naive line-set diff (no context); sufficient for "exactly 2 lines
// changed" assertions where we already know the change shape.
function diffLines(before, after) {
	const b = before.split("\n");
	const a = after.split("\n");
	const bSet = new Set(b);
	const aSet = new Set(a);
	const removed = b.filter(l => !aSet.has(l));
	const added = a.filter(l => !bSet.has(l));
	return { added, removed };
}

// =====================================================================
// ABUSE SUITE — RED-BLUE THREAT MODEL — must run first.
// =====================================================================

test("abuse: '..' parent traversal is rejected with no file write", () => {
	const root = mkTmpRoot("parent-traversal");
	try {
		const realFixture = writeFixture(root, "subdir/fixture.card.md");
		const before = snapshotTree(root);

		const res = moveStatus({ root, file: "../escape.card.md", to: "in_progress" });

		assert.equal(res.ok, false, "expected reject");
		assert.ok(res.errors.length > 0, "expected at least one error");
		assert.match(res.errors.join(" "), /outside root|parent/i, "error must mention out-of-tree or parent traversal");

		const after = snapshotTree(root);
		assert.deepEqual([...after.entries()], [...before.entries()], "filesystem must be byte-identical (no write on reject)");
		assert.ok(!fs.existsSync(path.join(path.dirname(root), "escape.card.md")), "no file written at parent dir");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		try { fs.rmSync(path.join(path.dirname(root), "escape.card.md"), { force: true }); } catch (_) {}
	}
});

test("abuse: absolute path target is rejected with no file write", () => {
	const root = mkTmpRoot("absolute-path");
	try {
		const before = snapshotTree(root);

		const res = moveStatus({ root, file: "/tmp/not-our-card.md", to: "in_progress" });

		assert.equal(res.ok, false);
		assert.match(res.errors.join(" "), /outside root|absolute|\.card\.md/);

		const after = snapshotTree(root);
		assert.deepEqual([...after.entries()], [...before.entries()], "no file written anywhere");
		assert.ok(!fs.existsSync("/tmp/not-our-card.md"), "no file written at /tmp/");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		try { fs.unlinkSync("/tmp/not-our-card.md"); } catch (_) {}
	}
});

test("abuse: out-of-tree target (sibling dir) is rejected", () => {
	const root = mkTmpRoot("out-of-tree");
	const sibling = mkTmpRoot("sibling");
	try {
		const before = snapshotTree(root);
		const target = path.join(sibling, "steal.card.md");

		const res = moveStatus({ root, file: target, to: "in_progress" });

		assert.equal(res.ok, false);
		assert.match(res.errors.join(" "), /outside root/);

		const after = snapshotTree(root);
		assert.deepEqual([...after.entries()], [...before.entries()]);
		assert.ok(!fs.existsSync(target), "no file written at sibling");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(sibling, { recursive: true, force: true });
	}
});

test("abuse: non-.card.md extension is rejected with no file write", () => {
	const root = mkTmpRoot("wrong-ext");
	try {
		writeFixture(root, "card.txt"); // exists but wrong extension
		const before = snapshotTree(root);

		const res = moveStatus({ root, file: "card.txt", to: "in_progress" });

		assert.equal(res.ok, false);
		assert.match(res.errors.join(" "), /\.card\.md/);

		const after = snapshotTree(root);
		assert.deepEqual([...after.entries()], [...before.entries()], "no write to the wrong-extension file");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("abuse: symlink target outside root is rejected", () => {
	const root = mkTmpRoot("symlink-escape");
	const outside = mkTmpRoot("outside-target");
	try {
		const realOutside = path.join(outside, "real.card.md");
		fs.writeFileSync(realOutside, FIXTURE_FRONT, "utf8");
		const link = path.join(root, "evil.card.md");
		fs.symlinkSync(realOutside, link);

		const before = snapshotTree(root);
		const res = moveStatus({ root, file: "evil.card.md", to: "in_progress" });

		assert.equal(res.ok, false, "expected reject (symlink target outside root)");
		assert.match(res.errors.join(" "), /outside root|symlink/i);

		const after = snapshotTree(root);
		assert.deepEqual([...after.entries()], [...before.entries()], "no write to the symlinked outside file");
		// The original outside file must be unchanged.
		const after2 = fs.readFileSync(realOutside, "utf8");
		assert.equal(after2, FIXTURE_FRONT, "outside file untouched");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("abuse: illegal status transition (done → in_progress) is rejected with no write", () => {
	const root = mkTmpRoot("illegal-transition");
	try {
		// Build a card whose status IS 'done' so the transition is genuinely illegal.
		const fmText = FIXTURE_FRONT.replace(/^status: todo$/m, "status: done");
		fs.writeFileSync(path.join(root, "fixture.card.md"), fmText, "utf8");
		const before = fs.readFileSync(path.join(root, "fixture.card.md"), "utf8");

		const res = moveStatus({ root, file: "fixture.card.md", to: "in_progress" });
		assert.equal(res.ok, false, `expected reject for done -> in_progress, got ok: ${res.errors.join("; ")}`);
		assert.match(res.errors.join(" "), /illegal transition/);

		const after = fs.readFileSync(path.join(root, "fixture.card.md"), "utf8");
		assert.equal(after, before, "file unchanged on reject");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("abuse: invalid status string is rejected with no write", () => {
	const root = mkTmpRoot("invalid-status");
	try {
		const fixture = writeFixture(root);
		const before = fs.readFileSync(fixture, "utf8");

		const res = moveStatus({ root, file: "fixture.card.md", to: "frobnicated" });
		assert.equal(res.ok, false);
		assert.match(res.errors.join(" "), /STATUS_ENUM/);

		const after = fs.readFileSync(fixture, "utf8");
		assert.equal(after, before);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("abuse: setField on immutable id is rejected with no write", () => {
	const root = mkTmpRoot("set-id");
	try {
		const fixture = writeFixture(root);
		const before = fs.readFileSync(fixture, "utf8");

		const res = setField({ root, file: "fixture.card.md", field: "id", value: "renamed" });
		assert.equal(res.ok, false);
		assert.match(res.errors.join(" "), /id is immutable/);

		const after = fs.readFileSync(fixture, "utf8");
		assert.equal(after, before);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("abuse: setField on immutable created_at is rejected with no write", () => {
	const root = mkTmpRoot("set-created");
	try {
		const fixture = writeFixture(root);
		const before = fs.readFileSync(fixture, "utf8");

		const res = setField({ root, file: "fixture.card.md", field: "created_at", value: "2099-01-01T00:00:00.000Z" });
		assert.equal(res.ok, false);
		assert.match(res.errors.join(" "), /created_at is immutable/);

		const after = fs.readFileSync(fixture, "utf8");
		assert.equal(after, before);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("abuse: setField on 'status' is rejected (must use moveStatus)", () => {
	const root = mkTmpRoot("set-status");
	try {
		const fixture = writeFixture(root);
		const before = fs.readFileSync(fixture, "utf8");

		const res = setField({ root, file: "fixture.card.md", field: "status", value: "in_progress" });
		assert.equal(res.ok, false);
		assert.match(res.errors.join(" "), /use moveStatus/);

		const after = fs.readFileSync(fixture, "utf8");
		assert.equal(after, before);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("abuse: setField on unknown field is rejected with no write", () => {
	const root = mkTmpRoot("set-unknown");
	try {
		const fixture = writeFixture(root);
		const before = fs.readFileSync(fixture, "utf8");

		const res = setField({ root, file: "fixture.card.md", field: "blocks", value: ["x"] });
		assert.equal(res.ok, false);
		assert.match(res.errors.join(" "), /KNOWN_FIELDS|not in/);

		const after = fs.readFileSync(fixture, "utf8");
		assert.equal(after, before);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("abuse: setField with bad priority value is rejected with no write", () => {
	const root = mkTmpRoot("bad-priority");
	try {
		const fixture = writeFixture(root);
		const before = fs.readFileSync(fixture, "utf8");

		const res = setField({ root, file: "fixture.card.md", field: "priority", value: 99 });
		assert.equal(res.ok, false);
		assert.match(res.errors.join(" "), /priority|invalid/i);

		const after = fs.readFileSync(fixture, "utf8");
		assert.equal(after, before);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("abuse: null target file is rejected with no write", () => {
	const root = mkTmpRoot("null-target");
	try {
		const before = snapshotTree(root);
		const res = moveStatus({ root, file: null, to: "in_progress" });
		assert.equal(res.ok, false);
		const after = snapshotTree(root);
		assert.deepEqual([...after.entries()], [...before.entries()]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("abuse: missing target file is rejected (no silent create)", () => {
	const root = mkTmpRoot("missing-target");
	try {
		// Root is empty; no fixture exists.
		const res = moveStatus({ root, file: "does-not-exist.card.md", to: "in_progress" });
		assert.equal(res.ok, false);
		// The writer must NOT silently create the card on missing-target — that's a
		// separate write path (createCard). moveStatus is for mutating an
		// existing truth.
		assert.ok(!fs.existsSync(path.join(root, "does-not-exist.card.md")),
			"moveStatus must not silently create missing cards");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("abuse: createCard refuses to overwrite an existing id", () => {
	const root = mkTmpRoot("create-clobber");
	try {
		writeFixture(root, "m2-5-fixture.card.md"); // collides with FIXTURE id
		const before = fs.readFileSync(path.join(root, "m2-5-fixture.card.md"), "utf8");

		const res = createCard({
			root,
			dir: ".",
			card: { id: "m2-5-fixture", title: "overwrite attempt" },
		});
		assert.equal(res.ok, false);
		assert.match(res.errors.join(" "), /already exists/);

		const after = fs.readFileSync(path.join(root, "m2-5-fixture.card.md"), "utf8");
		assert.equal(after, before, "existing card must not be overwritten");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// =====================================================================
// HAPPY PATH — the canonical 2-line diff + round-trip preservation.
// =====================================================================

test("happy: moveStatus legal transition produces exactly 2-line diff (status + updated_at)", () => {
	const root = mkTmpRoot("legal-move");
	try {
		const fixture = writeFixture(root);
		const before = fs.readFileSync(fixture, "utf8");

		const res = moveStatus({ root, file: "fixture.card.md", to: "in_progress" });
		assert.equal(res.ok, true, `expected ok, got errors: ${res.errors.join("; ")}`);
		assert.equal(res.file, fixture);

		const after = fs.readFileSync(fixture, "utf8");
		const { added, removed } = diffLines(before, after);
		assert.equal(removed.length, 2, `expected 2 removed lines, got ${removed.length}: ${JSON.stringify(removed)}`);
		assert.equal(added.length, 2, `expected 2 added lines, got ${added.length}: ${JSON.stringify(added)}`);
		assert.ok(removed.some(l => /^status: todo/.test(l)), "removed must include old status line");
		assert.ok(added.some(l => /^status: in_progress/.test(l)), "added must include new status line");
		assert.ok(removed.some(l => /^updated_at: 2026-07-03T00:00:00\.000Z$/.test(l)), "removed must include old updated_at");
		assert.ok(added.some(l => /^updated_at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(l)), "added must include new updated_at (ISO8601 with ms + Z)");

		// Body must be byte-identical
		const beforeBody = before.split("---\n").slice(-1)[0];
		const afterBody = after.split("---\n").slice(-1)[0];
		assert.equal(afterBody, beforeBody, "body must be byte-identical after moveStatus");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("happy: moveStatus self-transition (todo → todo) is legal and re-stamps updated_at", () => {
	const root = mkTmpRoot("self-move");
	try {
		const fixture = writeFixture(root);
		const before = fs.readFileSync(fixture, "utf8");

		const res = moveStatus({ root, file: "fixture.card.md", to: "todo" });
		assert.equal(res.ok, true);

		const after = fs.readFileSync(fixture, "utf8");
		const { added, removed } = diffLines(before, after);
		assert.equal(removed.length, 1, "self-move changes only updated_at, not status");
		assert.equal(added.length, 1);
		assert.ok(added.some(l => /^updated_at: \d{4}-\d{2}-\d{2}T/.test(l)));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("happy: every legal transition round-trips with a 2-line diff", () => {
	const transitions = [
		["triage", "backlog"],
		["backlog", "todo"],
		["todo", "in_progress"],
		["todo", "blocked"],
		["in_progress", "review"],
		["in_progress", "blocked"],
		["blocked", "todo"],
		["blocked", "in_progress"],
		["blocked", "review"],
		["review", "done"],
		["review", "in_progress"],
		["review", "blocked"],
	];
	for (const [from, to] of transitions) {
		const root = mkTmpRoot(`legal-${from}-${to}`);
		try {
			// Build a card whose status is `from`.
			const fmText = FIXTURE_FRONT.replace(/^status: todo$/m, `status: ${from}`);
			fs.writeFileSync(path.join(root, "fixture.card.md"), fmText, "utf8");
			const before = fs.readFileSync(path.join(root, "fixture.card.md"), "utf8");

			const res = moveStatus({ root, file: "fixture.card.md", to });
			assert.equal(res.ok, true, `${from} → ${to} should be legal`);

			const after = fs.readFileSync(path.join(root, "fixture.card.md"), "utf8");
			const { added, removed } = diffLines(before, after);
			assert.equal(removed.length, 2, `${from} → ${to}: removed must be 2`);
			assert.equal(added.length, 2, `${from} → ${to}: added must be 2`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
});

test("happy: every illegal transition is rejected with no write", () => {
	const illegal = [
		["triage", "in_progress"], ["triage", "done"], ["triage", "review"],
		["backlog", "in_progress"], ["backlog", "done"],
		["todo", "triage"], ["todo", "backlog"], ["todo", "done"], ["todo", "review"],
		["in_progress", "triage"], ["in_progress", "backlog"], ["in_progress", "done"],
		["blocked", "triage"], ["blocked", "backlog"], ["blocked", "done"],
		["review", "triage"], ["review", "backlog"],
		["done", "triage"], ["done", "backlog"], ["done", "todo"], ["done", "in_progress"], ["done", "review"], ["done", "blocked"],
	];
	for (const [from, to] of illegal) {
		const root = mkTmpRoot(`illegal-${from}-${to}`);
		try {
			const fmText = FIXTURE_FRONT.replace(/^status: todo$/m, `status: ${from}`);
			fs.writeFileSync(path.join(root, "fixture.card.md"), fmText, "utf8");
			const before = fs.readFileSync(path.join(root, "fixture.card.md"), "utf8");

			const res = moveStatus({ root, file: "fixture.card.md", to });
			assert.equal(res.ok, false, `${from} → ${to} must be illegal`);

			const after = fs.readFileSync(path.join(root, "fixture.card.md"), "utf8");
			assert.equal(after, before, `${from} → ${to}: file must be byte-identical on reject`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
});

test("happy: setField updates one field + updated_at, body and other lines untouched", () => {
	const root = mkTmpRoot("set-happy");
	try {
		const fixture = writeFixture(root);
		const before = fs.readFileSync(fixture, "utf8");

		const res = setField({ root, file: "fixture.card.md", field: "priority", value: 7 });
		assert.equal(res.ok, true);

		const after = fs.readFileSync(fixture, "utf8");
		const { added, removed } = diffLines(before, after);
		assert.equal(removed.length, 2, "removed: old priority + old updated_at");
		assert.equal(added.length, 2, "added: new priority + new updated_at");
		assert.ok(removed.some(l => /^priority: 5$/.test(l)));
		assert.ok(added.some(l => /^priority: 7$/.test(l)));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("happy: createCard writes a valid file, then moveStatus works on it", () => {
	const root = mkTmpRoot("create-happy");
	try {
		const stamp = "2026-07-03T00:00:00.000Z";
		// createCard stamps its own created_at; we assert it parses to a valid object.
		const res = createCard({
			root,
			dir: ".",
			card: {
				id: "m2-5-test-card",
				title: "M2-5 smoke card",
				status: "triage",
				project: "apple-pi",
				tags: ["m2", "smoke"],
			},
		});
		assert.equal(res.ok, true, `createCard errors: ${res.errors.join("; ")}`);
		assert.ok(res.file.endsWith("m2-5-test-card.card.md"), "file path should end with the slug");

		// The created file must round-trip through moveStatus
		const moveRes = moveStatus({ root, file: "m2-5-test-card.card.md", to: "backlog" });
		assert.equal(moveRes.ok, true, `moveStatus errors: ${moveRes.errors.join("; ")}`);

		// The card must still be a valid frontmatter (re-parsing must validate clean).
		const { parseCardFile } = require("./parse");
		const { validateCard } = require("./schema-card");
		const parsed = parseCardFile(res.file);
		const v = validateCard(parsed.frontmatter);
		assert.equal(v.ok, true, `created card must validate: ${v.errors.join("; ")}`);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("happy: createCard in nested dir lands the file at root/dir/id.card.md", () => {
	const root = mkTmpRoot("create-nested");
	try {
		const res = createCard({
			root,
			dir: "Projects/apple-pi/.kanban/cards",
			card: { id: "nested-card", title: "Nested" },
		});
		assert.equal(res.ok, true);
		const expected = path.join(root, "Projects/apple-pi/.kanban/cards/nested-card.card.md");
		assert.equal(res.file, expected);
		assert.ok(fs.existsSync(expected), "file should exist at the nested path");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// =====================================================================
// resolveUnderRoot — direct unit tests (no fixture I/O)
// =====================================================================

test("resolveUnderRoot: rejects empty / null / non-string file", () => {
	const r = resolveUnderRoot({ root: "/tmp", file: "" });
	assert.ok(r.error);
	assert.match(r.error, /non-empty/);

	const r2 = resolveUnderRoot({ root: "/tmp", file: null });
	assert.ok(r2.error);

	const r3 = resolveUnderRoot({ root: "/tmp", file: 42 });
	assert.ok(r3.error);
});

test("resolveUnderRoot: rejects empty root", () => {
	const r = resolveUnderRoot({ root: "", file: "x.card.md" });
	assert.ok(r.error);
	assert.match(r.error, /root/);
});

test("resolveUnderRoot: rejects non-.card.md basename", () => {
	const r = resolveUnderRoot({ root: "/tmp", file: "x.txt" });
	assert.ok(r.error);
	assert.match(r.error, /\.card\.md/);
});

test("resolveUnderRoot: rejects non-existent file (cannot realpath)", () => {
	const r = resolveUnderRoot({ root: "/tmp", file: "/tmp/__kb-write-does-not-exist-12345.card.md" });
	assert.ok(r.error);
	assert.match(r.error, /does not exist|ENOENT|cannot resolve/);
});

test("resolveUnderRoot: accepts a real .card.md inside root", () => {
	const root = mkTmpRoot("resolve-accept");
	try {
		const fixture = writeFixture(root, "ok.card.md");
		const r = resolveUnderRoot({ root, file: fixture });
		assert.equal(r.error, undefined);
		assert.ok(r.abs.endsWith("ok.card.md"), `abs should end with the filename, got ${r.abs}`);
		// real is the symlink-resolved path; on macOS /var/folders → /private/var/folders.
		assert.ok(r.real.endsWith("ok.card.md"), `real should end with the filename, got ${r.real}`);
		assert.ok(r.real.startsWith(r.rootAbs), `real '${r.real}' must be under root '${r.rootAbs}'`);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});