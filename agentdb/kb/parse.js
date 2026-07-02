// agentdb/kb/parse.js — hand-rolled frontmatter+body parser for .card.md.
//
// Parses the SUPERPROMPT §5.1 subset only (decision D3: zero new deps):
//   - scalar key:value  -> string | integer | boolean | null
//   - inline array      -> key: [a, b, c]   (and key: [] for empty)
//   - block list        -> key:\n  - a\n  - b
// Anything outside this subset is left as a plain string (no silent coercion).
// Card ids/tags never contain commas or '#', so a simple comma split for inline
// arrays is sufficient; if a future card needs nested mappings or quoted
// commas, THAT is the trigger to fall back to gray-matter (D3) — record it in
// the commit that adds the fallback.
//
// API: parseCardFile(path) -> { file, frontmatter, body }
//   - file        : the path argument, echoed back (callers resolve as needed)
//   - frontmatter : parsed JS object the M0-1 schema expects
//   - body        : the markdown after the closing '---' fence, verbatim
//
// A file with no opening '---' fence degrades to { frontmatter: {}, body: <full
// content> } rather than throwing — parse stays best-effort so a transiently
// truncated save never crashes a caller (M7-2 watcher resilience depends on it).
"use strict";

const fs = require("node:fs");

// parseCardFile(path) -> { file, frontmatter, body }
function parseCardFile(file) {
	const content = fs.readFileSync(file, "utf8");
	const { frontmatterText, body } = splitFrontmatter(content);
	return { file, frontmatter: parseFrontmatter(frontmatterText), body };
}

// splitFrontmatter(content) -> { frontmatterText, body }
// Recognises a leading '---' fence; the next '---' line closes the frontmatter.
// No leading fence -> everything is body, frontmatter empty.
function splitFrontmatter(content) {
	const lines = content.split(/\r?\n/);
	if (lines.length === 0 || lines[0].trim() !== "---") {
		return { frontmatterText: "", body: content };
	}
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") { end = i; break; }
	}
	if (end === -1) {
		// opening fence but no closer: treat the rest as frontmatter, body empty
		return { frontmatterText: lines.slice(1).join("\n"), body: "" };
	}
	return { frontmatterText: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n") };
}

// parseFrontmatter(text) -> object. §5.1 subset only (see file header).
// Full-line comments (first non-space char '#') are skipped; inline comments
// are NOT stripped (a '#' inside a value would be mangled) — none of the §5.1
// fields use inline comments, so this keeps values faithful.
function parseFrontmatter(text) {
	const fm = {};
	const lines = text.split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		const trimmed = lines[i].trim();
		i++;
		if (trimmed === "") continue;
		if (trimmed.startsWith("#")) continue;
		const m = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
		if (!m) continue; // not a recognisable 'key: value' line; skip silently
		const key = m[1];
		const rest = m[2];
		if (rest === "") {
			// block list? collect the immediately-following indented '- item' lines
			const items = [];
			while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
				items.push(parseScalar(lines[i].replace(/^\s*-\s+/, "").trim()));
				i++;
			}
			fm[key] = items.length > 0 ? items : null;
			continue;
		}
		fm[key] = parseValue(rest);
	}
	return fm;
}

// parseValue(v) -> scalar | array. Inline arrays + scalars only.
function parseValue(v) {
	const s = v.trim();
	if (s.startsWith("[") && s.endsWith("]")) {
		const inner = s.slice(1, -1).trim();
		if (inner === "") return [];
		return inner.split(",").map(part => parseScalar(part.trim()));
	}
	return parseScalar(s);
}

// parseScalar(s) -> string | number | boolean | null. Surrounding quotes are
// stripped; no float coercion (§5.1 uses ints only — a float-looking token stays
// a string so the schema can reject it loudly rather than silently mangling).
function parseScalar(s) {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	if (s === "true") return true;
	if (s === "false") return false;
	if (s === "null" || s === "~") return null;
	if (/^-?\d+$/.test(s)) return Number(s);
	return s;
}

module.exports = { parseCardFile, splitFrontmatter, parseFrontmatter };
