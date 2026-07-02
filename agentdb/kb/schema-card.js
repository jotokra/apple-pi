// agentdb/kb/schema-card.js — validation for the .card.md frontmatter (Tier-A truth).
// SUPERPROMPT §5.1 + decisions D6 (blocks is derived, never stored).
// Hand-rolled, zero deps (D3). Parsing raw .card.md is M1-1; this validates an
// already-parsed frontmatter OBJECT.
"use strict";

const STATUS_ENUM = ["triage", "backlog", "todo", "in_progress", "blocked", "review", "done"];
// fields the card may carry. 'blocks' is intentionally absent (D6: derived from depends_on).
const KNOWN_FIELDS = new Set([
	"id", "title", "status", "priority", "project", "assignee", "parent",
	"depends_on", "tags", "est_commits", "parallel_safe", "created_at", "updated_at",
]);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/i;

function isInt(n) { return typeof n === "number" && Number.isInteger(n); }
function isStrArr(a) { return Array.isArray(a) && a.every(x => typeof x === "string"); }

// validateCard(frontmatter) -> { ok: boolean, errors: string[] }
function validateCard(fm) {
	const errors = [];
	if (!fm || typeof fm !== "object" || Array.isArray(fm)) return { ok: false, errors: ["frontmatter must be an object"] };

	// D6 enforcement: blocks must never be stored (it's derived).
	if ("blocks" in fm) errors.push("field 'blocks' must not be stored — it is derived from depends_on (D6)");

	// unknown fields -> warn-level error (keeps the schema honest, catches typos)
	for (const k of Object.keys(fm)) if (!KNOWN_FIELDS.has(k)) errors.push(`unknown field '${k}'`);

	// required
	if (!fm.id) errors.push("id is required");
	else if (typeof fm.id !== "string" || !SLUG_RE.test(fm.id)) errors.push(`id '${fm.id}' is not a valid slug (alphanumeric/-/_ only)`);

	if (!fm.title) errors.push("title is required");
	else if (typeof fm.title !== "string") errors.push("title must be a string");

	if (!fm.status) errors.push("status is required");
	else if (!STATUS_ENUM.includes(fm.status)) errors.push(`status '${fm.status}' not in enum {${STATUS_ENUM.join(",")}}`);

	if (fm.project != null && (typeof fm.project !== "string" || !SLUG_RE.test(fm.project))) errors.push(`project '${fm.project}' is not a valid slug`);
	if (fm.parent != null && typeof fm.parent !== "string") errors.push("parent must be a string (card-id | root | none)");

	if (fm.assignee != null && typeof fm.assignee !== "string") errors.push("assignee must be a string or null");

	if ("priority" in fm) { if (!isInt(fm.priority) || fm.priority < 0 || fm.priority > 9) errors.push(`priority ${fm.priority} must be an integer 0-9`); }

	if ("depends_on" in fm && !isStrArr(fm.depends_on)) errors.push("depends_on must be an array of strings");
	if ("tags" in fm && !isStrArr(fm.tags)) errors.push("tags must be an array of strings");

	if ("est_commits" in fm && (!isInt(fm.est_commits) || fm.est_commits < 0)) errors.push("est_commits must be a non-negative integer");
	if ("parallel_safe" in fm && typeof fm.parallel_safe !== "boolean") errors.push("parallel_safe must be a boolean");

	if (!fm.created_at) errors.push("created_at is required");
	else if (typeof fm.created_at !== "string" || !ISO_RE.test(fm.created_at)) errors.push(`created_at '${fm.created_at}' is not ISO8601`);
	if (!fm.updated_at) errors.push("updated_at is required");
	else if (typeof fm.updated_at !== "string" || !ISO_RE.test(fm.updated_at)) errors.push(`updated_at '${fm.updated_at}' is not ISO8601`);

	return { ok: errors.length === 0, errors };
}

module.exports = { validateCard, STATUS_ENUM, KNOWN_FIELDS };
