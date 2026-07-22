// agentdb/kb/status.js — status enum, legal-transition map, WIP limit.
// SUPERPROMPT §5.1 taxonomy: triage → backlog → todo → in_progress → review → done,
// with `blocked` as a sidetrack. Decisions D3 (zero deps) + D5 (WIP=3, KANBAN_WIP).
// Pairs with schema-card.js — STATUS_ENUM is duplicated there intentionally to
// keep each module self-contained; if you add a status, update BOTH.
"use strict";

const STATUS_ENUM = ["triage", "backlog", "todo", "in_progress", "blocked", "review", "done"];

// Legal transitions off each status (self-transitions handled separately).
// Rationale:
//  - forward edges = the §5.1 happy path (triage→backlog→…→done)
//  - `blocked` is a sidetrack: in from {todo, in_progress, review}, back out to
//    the same set (the card resumes where it was)
//  - `review → in_progress` allows rework (review found issues → back to work)
//  - `done` is terminal: no outgoing edges
const LEGAL_TRANSITIONS = {
	triage:      ["backlog"],
	backlog:     ["todo"],
	todo:        ["in_progress", "blocked"],
	in_progress: ["review", "blocked"],
	blocked:     ["todo", "in_progress", "review"],
	review:      ["done", "in_progress", "blocked"],
	done:        [],
};

const DEFAULT_WIP = 3;

function isStatus(s) { return typeof s === "string" && STATUS_ENUM.includes(s); }

// legalTransition(from, to) -> bool
// A self-transition (from === to) is a legal no-op: it re-stamps updated_at
// without moving the card, so callers don't need a special case for "unchanged".
function legalTransition(from, to) {
	if (!isStatus(from) || !isStatus(to)) return false;
	if (from === to) return true;
	return LEGAL_TRANSITIONS[from].includes(to);
}

// wipLimit() -> number — D5: default 3, KANBAN_WIP env override.
// Non-integer / non-positive / unparseable values fall back to the default.
function wipLimit() {
	const raw = process.env.KANBAN_WIP;
	if (raw == null || raw === "") return DEFAULT_WIP;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) return DEFAULT_WIP;
	return n;
}

module.exports = { STATUS_ENUM, LEGAL_TRANSITIONS, legalTransition, wipLimit };
