// agentdb/kb/status.test.js — REQ-M0-2
// Status enum + legal-transition map + WIP limit (D5).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { legalTransition, wipLimit, STATUS_ENUM, LEGAL_TRANSITIONS } = require("./status");

test("STATUS_ENUM matches the SUPERPROMPT §5.1 taxonomy", () => {
	assert.deepEqual(STATUS_ENUM, ["triage", "backlog", "todo", "in_progress", "blocked", "review", "done"]);
});

test("LEGAL_TRANSITIONS keys cover the whole enum", () => {
	assert.deepEqual(Object.keys(LEGAL_TRANSITIONS).sort(), [...STATUS_ENUM].sort());
});

test("forward happy-path transitions are legal", () => {
	assert.equal(legalTransition("triage", "backlog"), true);
	assert.equal(legalTransition("backlog", "todo"), true);
	assert.equal(legalTransition("todo", "in_progress"), true);
	assert.equal(legalTransition("in_progress", "review"), true);
	assert.equal(legalTransition("review", "done"), true);
});

test("illegal transitions are rejected (REQ-M0-2)", () => {
	// done is terminal — no outgoing transitions at all
	assert.equal(legalTransition("done", "in_progress"), false);
	assert.equal(legalTransition("done", "review"), false);
	assert.equal(legalTransition("done", "todo"), false);
	// no skipping backward across the main chain
	assert.equal(legalTransition("todo", "triage"), false);
	assert.equal(legalTransition("in_progress", "backlog"), false);
	assert.equal(legalTransition("review", "todo"), false);
	// no skipping forward
	assert.equal(legalTransition("triage", "done"), false);
	assert.equal(legalTransition("backlog", "review"), false);
	assert.equal(legalTransition("triage", "in_progress"), false);
});

test("blocked is a sidetrack: reachable from active states and returns", () => {
	// into blocked from the active states only
	assert.equal(legalTransition("todo", "blocked"), true);
	assert.equal(legalTransition("in_progress", "blocked"), true);
	assert.equal(legalTransition("review", "blocked"), true);
	// back out of blocked to an active state
	assert.equal(legalTransition("blocked", "in_progress"), true);
	assert.equal(legalTransition("blocked", "todo"), true);
	assert.equal(legalTransition("blocked", "review"), true);
	// blocked is not a staging step toward done
	assert.equal(legalTransition("blocked", "done"), false);
	// intake/terminal states don't use blocked
	assert.equal(legalTransition("triage", "blocked"), false);
	assert.equal(legalTransition("backlog", "blocked"), false);
	assert.equal(legalTransition("done", "blocked"), false);
});

test("review can send a card back for rework", () => {
	assert.equal(legalTransition("review", "in_progress"), true);
});

test("self-transitions are a legal no-op (re-stamp, not a move)", () => {
	for (const s of STATUS_ENUM) assert.equal(legalTransition(s, s), true, `${s}->${s}`);
});

test("unknown / non-enum statuses are rejected", () => {
	assert.equal(legalTransition("triage", "wip"), false);
	assert.equal(legalTransition("nope", "done"), false);
	assert.equal(legalTransition(null, "done"), false);
	assert.equal(legalTransition("done", undefined), false);
});

test("wipLimit defaults to 3 when env unset (REQ-M0-2)", () => {
	const saved = Object.getOwnPropertyDescriptor(process.env, "KANBAN_WIP");
	delete process.env.KANBAN_WIP;
	assert.equal(wipLimit(), 3);
	restoreEnv(saved);
});

test("wipLimit reads KANBAN_WIP from env (REQ-M0-2)", () => {
	const saved = Object.getOwnPropertyDescriptor(process.env, "KANBAN_WIP");
	process.env.KANBAN_WIP = "5";
	assert.equal(wipLimit(), 5);
	restoreEnv(saved);
});

test("wipLimit falls back to 3 on garbage / non-positive env", () => {
	const saved = Object.getOwnPropertyDescriptor(process.env, "KANBAN_WIP");
	for (const v of ["abc", "0", "-2", "3.5", "  "]) {
		process.env.KANBAN_WIP = v;
		assert.equal(wipLimit(), 3, `expected fallback for KANBAN_WIP=${JSON.stringify(v)}`);
	}
	restoreEnv(saved);
});

function restoreEnv(saved) {
	if (saved === undefined) delete process.env.KANBAN_WIP;
	else process.env.KANBAN_WIP = saved.value;
}
