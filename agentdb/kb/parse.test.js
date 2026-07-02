// agentdb/kb/parse.test.js — REQ-M1-1
// Hand-rolled frontmatter+body parser for .card.md (SUPERPROMPT §5.1 subset).
// Zero deps (decision D3). parseCardFile(path) -> { file, frontmatter, body }.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { parseCardFile } = require("./parse");
const { validateCard } = require("./schema-card");

// Resolve fixtures relative to THIS file so the suite passes regardless of cwd
// (the VERIFY hook runs `node --test agentdb/kb/parse.test.js` from the repo root).
const FIX = path.resolve(__dirname, "../test/fixtures");

// The EXACT frontmatter object schema-card's validateCard accepts for the good
// fixture. Deep-equal is the REQ-M1-1 contract: the parser must yield this
// object verbatim — scalars as JS scalars (priority number, parallel_safe
// boolean), arrays as JS arrays (depends_on [], tags [sample, fixture]).
const EXPECTED_GOOD = {
	id: "good-sample",
	title: "A well-formed sample card",
	status: "todo",
	priority: 3,
	project: "apple-pi",
	assignee: "coder",
	parent: "root",
	depends_on: [],
	tags: ["sample", "fixture"],
	est_commits: 2,
	parallel_safe: true,
	created_at: "2026-07-02T22:00:00Z",
	updated_at: "2026-07-02T22:00:00Z",
};

test("parseCardFile returns { file, frontmatter, body }", () => {
	const p = path.join(FIX, "good.card.md");
	const got = parseCardFile(p);
	assert.equal(got.file, p, "file echoes the path argument");
	assert.equal(typeof got.frontmatter, "object");
	assert.ok(got.frontmatter !== null && !Array.isArray(got.frontmatter));
	assert.equal(typeof got.body, "string");
});

test("good.card.md parses to the exact frontmatter object validateCard accepts (REQ-M1-1)", () => {
	const { frontmatter } = parseCardFile(path.join(FIX, "good.card.md"));
	assert.deepEqual(frontmatter, EXPECTED_GOOD);
});

test("good.card.md frontmatter validates against schema-card (REQ-M1-1)", () => {
	const { frontmatter } = parseCardFile(path.join(FIX, "good.card.md"));
	const r = validateCard(frontmatter);
	assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("inline arrays parse correctly: depends_on [], tags [sample, fixture] (REQ-M1-1)", () => {
	const { frontmatter } = parseCardFile(path.join(FIX, "good.card.md"));
	assert.deepEqual(frontmatter.depends_on, []);
	assert.deepEqual(frontmatter.tags, ["sample", "fixture"]);
});

test("scalars coerce to JS types: priority number, parallel_safe boolean", () => {
	const { frontmatter } = parseCardFile(path.join(FIX, "good.card.md"));
	assert.strictEqual(frontmatter.priority, 3);
	assert.strictEqual(frontmatter.parallel_safe, true);
	assert.strictEqual(frontmatter.est_commits, 2);
});

test("body is the markdown after the closing fence, verbatim", () => {
	const { body } = parseCardFile(path.join(FIX, "good.card.md"));
	assert.ok(body.startsWith("# Body"), `body started with: ${JSON.stringify(body.slice(0, 40))}`);
	// the fixture wraps across a newline, so assert on line-stable substrings
	assert.ok(body.includes("fixture card used by the M1-1 parser tests"));
	assert.ok(body.includes("reverse edges are derived from `depends_on`"));
	assert.ok(body.endsWith("(decision D6).\n"), `body did not end verbatim: ${JSON.stringify(body.slice(-40))}`);
});

test("bad-status.card.md parses to an object whose status fails schema validation (REQ-M1-1)", () => {
	const { frontmatter } = parseCardFile(path.join(FIX, "bad-status.card.md"));
	// the parser itself succeeds — 'wip' is a valid string; schema-card rejects it
	assert.equal(frontmatter.status, "wip");
	const r = validateCard(frontmatter);
	assert.equal(r.ok, false);
	assert.ok(r.errors.some(e => e.includes("status") && e.includes("wip")), r.errors.join("; "));
});

test("block-list syntax parses to an array (§5.1 subset)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parse-block-"));
	const p = path.join(dir, "blk.card.md");
	fs.writeFileSync(p, [
		"---",
		"id: blk-sample",
		"title: Block list sample",
		"status: todo",
		"project: apple-pi",
		"parent: root",
		"depends_on:",
		"  - card-a",
		"  - card-b",
		"tags:",
		"  - alpha",
		"  - beta",
		"created_at: 2026-07-02T22:00:00Z",
		"updated_at: 2026-07-02T22:00:00Z",
		"---",
		"# Body",
		"",
	].join("\n"), "utf8");
	const { frontmatter } = parseCardFile(p);
	assert.deepEqual(frontmatter.depends_on, ["card-a", "card-b"]);
	assert.deepEqual(frontmatter.tags, ["alpha", "beta"]);
	const r = validateCard(frontmatter);
	assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("quoted inline-array items have surrounding quotes stripped", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parse-quote-"));
	const p = path.join(dir, "q.card.md");
	fs.writeFileSync(p, [
		"---",
		"id: q-sample",
		"title: Quoted items",
		"status: todo",
		"project: apple-pi",
		"parent: root",
		'tags: ["alpha", "beta"]',
		"created_at: 2026-07-02T22:00:00Z",
		"updated_at: 2026-07-02T22:00:00Z",
		"---",
		"",
	].join("\n"), "utf8");
	const { frontmatter } = parseCardFile(p);
	assert.deepEqual(frontmatter.tags, ["alpha", "beta"]);
});

test("a file without frontmatter degrades gracefully (empty frontmatter, full body)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parse-nofm-"));
	const p = path.join(dir, "nofm.card.md");
	fs.writeFileSync(p, "# Just a body\nno frontmatter here\n", "utf8");
	const got = parseCardFile(p);
	assert.deepEqual(got.frontmatter, {});
	assert.ok(got.body.includes("Just a body"));
});
