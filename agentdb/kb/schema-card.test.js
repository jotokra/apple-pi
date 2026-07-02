// agentdb/kb/schema-card.test.js — REQ-M0-1
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateCard } = require("./schema-card");

const GOOD = {
	id: "m0-1-card-schema", title: "Card frontmatter schema + fixtures",
	status: "todo", priority: 5, project: "apple-pi", assignee: null, parent: "root",
	depends_on: [], tags: ["meta"], est_commits: 1, parallel_safe: true,
	created_at: "2026-07-02T22:00:00Z", updated_at: "2026-07-02T22:00:00Z",
};

test("accepts a well-formed card", () => {
	const r = validateCard(GOOD);
	assert.equal(r.ok, true, JSON.stringify(r.errors));
	assert.deepEqual(r.errors, []);
});

test("rejects an invalid status with a field-specific error (REQ-M0-1)", () => {
	const r = validateCard({ ...GOOD, status: "wip" });
	assert.equal(r.ok, false);
	assert.ok(r.errors.some(e => e.includes("status") && e.includes("wip")), r.errors.join("; "));
});

test("requires id and title", () => {
	const noId = validateCard({ ...GOOD, id: undefined });
	assert.equal(noId.ok, false); assert.ok(noId.errors.some(e => e.includes("id")));
	const noTitle = validateCard({ ...GOOD, title: undefined });
	assert.equal(noTitle.ok, false); assert.ok(noTitle.errors.some(e => e.includes("title")));
});

test("rejects out-of-range priority", () => {
	const r = validateCard({ ...GOOD, priority: 11 });
	assert.equal(r.ok, false); assert.ok(r.errors.some(e => e.includes("priority")));
});

test("rejects 'blocks' field (D6: derived, never stored)", () => {
	const r = validateCard({ ...GOOD, blocks: ["some-other-card"] });
	assert.equal(r.ok, false); assert.ok(r.errors.some(e => e.includes("blocks") && e.includes("D6")), r.errors.join("; "));
});

test("rejects non-ISO timestamps", () => {
	const r = validateCard({ ...GOOD, created_at: "yesterday" });
	assert.equal(r.ok, false); assert.ok(r.errors.some(e => e.includes("created_at")));
});

test("rejects non-array depends_on / tags", () => {
	assert.equal(validateCard({ ...GOOD, depends_on: "not-array" }).ok, false);
	assert.equal(validateCard({ ...GOOD, tags: "nope" }).ok, false);
});

test("accepts minimal card (only required fields)", () => {
	const r = validateCard({ id: "x-1", title: "X", status: "triage", parent: "none", created_at: "2026-07-02T00:00:00Z", updated_at: "2026-07-02T00:00:00Z" });
	assert.equal(r.ok, true, JSON.stringify(r.errors));
});
