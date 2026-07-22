// agentdb/kb/validate.js — card validator: parse (M1-1) + schema (M0-1) with
// file:line errors so a human or agent can jump straight at the fix.
//
// SUPERPROMPT §5.1 + ROADMAP M1-3. Stitches the two existing primitives:
//   parseCardFile(path)  -> { file, frontmatter, body }   (parse.js, M1-1)
//   validateCard(fm)     -> { ok, errors: string[] }       (schema-card.js, M0-1)
// and re-tags every schema violation with the file + the line it came from.
// Hand-rolled, zero deps (D3) — mirrors the rest of agentdb/kb.
//
// API:
//   validateCardFile(path) -> { ok: boolean, errors: string[] }
//     errors are "file:line: <schema message>" — file is the path argument
//     echoed back, line is the absolute (1-indexed) line the offending field
//     sat on (falls back to the opening '---' fence when the field is absent,
//     e.g. a missing required field). A read/parse failure is itself reported
//     as a file-tagged error rather than thrown, so a transiently truncated
//     save never crashes a caller (best-effort, like parse.js / discover.js).
//   validateTree(root) -> { ok: boolean, cards: [{file, ok, errors}] }
//     validates every *.card.md discover.js (M0-3) finds under root, in sorted
//     order. ok is true iff every discovered card is ok; an empty tree is
//     vacuously ok.
//
// CLI helper (`require.main === module`): `node validate.js [root]` validates
// the tree at root (default cwd) and exits 1 if any card is invalid, 0 if all
// clean — the M1-3 acceptance gate. The agent-facing CLI plumbing
// (bin/apple-pi kanban ...) lands later; this block is the standalone helper.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseCardFile } = require("./parse");
const { validateCard, KNOWN_FIELDS } = require("./schema-card");
const { findCards } = require("./discover");

// fieldLineMap(content) -> { fieldLines, fenceLine }
//   fieldLines : { <fieldName>: <1-indexed absolute line> } for every
//                'key:' line inside the frontmatter block
//   fenceLine  : the absolute line of the opening '---' (0 if there is none)
// A field appearing on multiple lines keeps the LAST occurrence (matches how a
// hand-rolled parser would resolve it); block-list keys record the key line,
// which is the line a human would edit to fix the whole list.
function fieldLineMap(content) {
	const lines = content.split(/\r?\n/);
	const fieldLines = {};
	if (lines.length === 0 || lines[0].trim() !== "---") return { fieldLines, fenceLine: 0 };
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") break; // closing fence
		const m = lines[i].match(/^\s*([A-Za-z0-9_]+):/);
		if (m) fieldLines[m[1]] = i + 1; // 1-indexed absolute line
	}
	return { fieldLines, fenceLine: 1 };
}

// fieldFromError(err) -> string | null
// Extracts the offending field name from a schema-card error message so we can
// look up its line. Three shapes cover every error schema-card emits:
//   "unknown field 'foo'"        -> foo   (not in KNOWN_FIELDS)
//   "field 'blocks' must not..." -> blocks
//   "id is required" / "priority 11 must be..." / "status 'wip' not in enum..."
//                              -> the leading known-field token
function fieldFromError(err) {
	let m = err.match(/^unknown field '([^']+)'/);
	if (m) return m[1];
	m = err.match(/^field '([^']+)'/);
	if (m) return m[1];
	m = err.match(/^([A-Za-z_][A-Za-z0-9_]*)\b/);
	if (m && KNOWN_FIELDS.has(m[1])) return m[1];
	return null;
}

// validateCardFile(path) -> { ok, errors[] }
function validateCardFile(file) {
	let content;
	try {
		content = fs.readFileSync(file, "utf8");
	} catch (e) {
		// unreadable file is itself a violation — report it, don't throw.
		return { ok: false, errors: [`${file}:1: could not read file (${e.code || e.message})`] };
	}
	const { fieldLines, fenceLine } = fieldLineMap(content);
	const fallbackLine = fenceLine || 1;

	let parsed;
	try {
		parsed = parseCardFile(file);
	} catch (e) {
		return { ok: false, errors: [`${file}:${fallbackLine}: parse failed (${e.message})`] };
	}

	const { ok, errors } = validateCard(parsed.frontmatter);
	const tagged = errors.map(msg => {
		const field = fieldFromError(msg);
		const line = (field && fieldLines[field]) || fallbackLine;
		return `${file}:${line}: ${msg}`;
	});
	return { ok, errors: tagged };
}

// validateTree(root) -> { ok, cards: [{file, ok, errors}] }
function validateTree(root) {
	const cards = findCards(root).map(file => {
		const r = validateCardFile(file);
		return { file, ok: r.ok, errors: r.errors };
	});
	return { ok: cards.every(c => c.ok), cards };
}

// --- CLI helper -------------------------------------------------------------
// `node validate.js [root]` -> exit 1 on any invalid card, 0 if all clean.
// Prints each invalid card's file:line errors to stderr; silent on success.
if (require.main === module) {
	const root = process.argv[2] || process.cwd();
	const { ok, cards } = validateTree(root);
	if (!ok) {
		for (const c of cards) {
			if (c.ok) continue;
			for (const e of c.errors) process.stderr.write(e + "\n");
		}
		process.exit(1);
	}
	process.exit(0);
}

module.exports = { validateCardFile, validateTree, fieldLineMap, fieldFromError };
