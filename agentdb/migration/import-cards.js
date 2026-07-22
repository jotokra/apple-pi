// agentdb/migration/import-cards.js — M11-1 dogfood parity (one-shot import).
//
// SUPERPROMPT §5.1 + ROADMAP M11-1: the REAL ~/Projects/*/.kanban/cards/*.md
// are the human-readable truth this agent DB mirrors. They pre-date the §5.1
// schema, so a straight `kanban index` over them fails three ways:
//   1. extension:  real cards are `<id>.md`, the §5.1 layout is `<id>.card.md`
//   2. frontmatter: real cards carry `blocks` (D6 forbids storing it) +
//      non-§5.1 fields (`lane`, `est_lines`, `progress`, `last_updated`), and
//      lack the required `created_at`/`updated_at`; some use JSON-style quoted
//      keys (`"id": "x"`) the §5.1 parser doesn't accept bare
//   3. layout:      the workspace is nested `~/Projects/<group>/<proj>/.kanban`,
//      not the flat `~/Projects/<proj>/.kanban` the watcher assumes
//
// This module is the bridge: discover the real cards, normalize each to a
// canonical §5.1 `.card.md`, stage them, then reuse the existing `rebuild()`
// (M2-2) to populate kb_cards / kb_body_fts / kb_deps / kb_meta. Reusing
// rebuild means the import inherits the SAME tested parse+validate+FTS+deps
// path — no SQL duplication, no second index implementation.
//
// REQ-M11-1: kb row count == # staged canonical cards (one row per unique id).
//
// D6 ("blocks is derived, not stored"): dropped from every card; the reverse
// edges are re-derived from `depends_on` by rebuild() into kb_deps (a reverse
// scan of kb_deps yields "what blocks X"). Mirror repos with byte-identical
// cards (e.g. aether vs aether-dev) share ids; kb_cards.id is the PK (§5.2), so
// they collapse to one row and are reported in `duplicateIds`.
//
// Best-effort + no-throw posture (matches the rest of agentdb/kb): a card that
// can't be normalized to valid §5.1 is skipped + reported, not fatal.
//
// API: importCards({ db, parents }) -> { ok, discovered, imported, staged,
//                                        skipped, duplicateIds, stagedDir }
//   db        : open DatabaseSync (caller owns it; rebuild owns only kb_*)
//   parents   : project-root parents to scan (default [~/Projects])
//   discovered  : # of real .md card files found (before dedup)
//   imported    : # of kb_cards rows written (== # unique ids == # staged)
//   staged      : # of canonical .card.md files written to stagedDir
//   skipped     : [{ file, errors }] for cards that failed normalization
//   duplicateIds: [{ id, file }] for ids already staged from another file
//   stagedDir   : temp dir holding the canonical .card.md files (caller cleans)
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { splitFrontmatter, parseFrontmatter } = require("../kb/parse"); // M1-1
const { validateCard } = require("../kb/schema-card");                  // M0-1
const { renderCard } = require("../kb/write");                          // M2-5
const { rebuild } = require("../kb/index");                             // M2-2

// §5.1 fields kept as-is when present + non-null. `blocks` is intentionally
// absent (D6); `created_at`/`updated_at`/`project` are handled specially below
// (stamped from mtime / derived from path when the source lacks them).
const KEEP_FIELDS = [
	"id", "title", "status", "priority", "assignee", "parent",
	"depends_on", "tags", "est_commits", "parallel_safe",
];
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const PRUNE = new Set([".git", "node_modules", ".worktrees"]);

// discoverWorkspaceMdCards(parents) -> string[] — recursive inventory of every
// `<id>.md` inside any `.../.kanban/cards/` directory under `parents`. Nested
// layouts (~/Projects/<group>/<proj>/.kanban) work because the walk descends
// at any depth; only files inside a `cards/` dir whose parent is `.kanban` are
// collected, so roadmap.md / README.md / stray notes never index. `.worktrees`
// (git-worktree shadows of the same ids), `.git`, and `node_modules` are pruned.
// Deduped by absolute path + sorted (deterministic; mirror dedup is resolved
// later, at staging, by id).
function discoverWorkspaceMdCards(parents) {
	const out = [];
	for (const parent of parents) walkMd(path.resolve(parent), out, false);
	return [...new Set(out)].sort();
}

function walkMd(dir, out, inCards) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return; // missing/unreadable dir -> nothing to discover here
	}
	for (const ent of entries) {
		if (PRUNE.has(ent.name)) continue;
		const full = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			// entering a `cards` dir whose parent is `.kanban` flips the collect flag
			const entersCards = ent.name === "cards" && path.basename(dir) === ".kanban";
			walkMd(full, out, inCards || entersCards);
		} else if (ent.isFile() && inCards && ent.name.endsWith(".md")) {
			out.push(full);
		}
	}
}

// parseLenient(content) -> { frontmatter, body }. The §5.1 parser (kb/parse.js)
// accepts bare keys only; real workspace cards come in two shapes — YAML
// (`id: x`) and JSON-style (`"id": "x"`). Stripping the optional surrounding
// quotes from each KEY line reduces JSON-style to what the bare-key parser
// already handles (parseScalar already strips value quotes). Block-list items
// (`- "x"`) don't match the key regex, so their quotes are left intact.
function parseLenient(content) {
	const { frontmatterText, body } = splitFrontmatter(content);
	const dequoted = frontmatterText.split(/\r?\n/).map(line =>
		line.replace(/^(\s*)"([A-Za-z0-9_]+)"(\s*:)/, "$1$2$3"),
	).join("\n");
	return { frontmatter: parseFrontmatter(dequoted), body };
}

// deriveProject(filePath) -> slug | null. The <proj> dir immediately before
// `.kanban` (portable project tag — §5.2 stores project for board scoping).
// Null if the path has no `.kanban` segment or the derived name isn't a slug.
function deriveProject(filePath) {
	const parts = filePath.split(path.sep);
	const i = parts.lastIndexOf(".kanban");
	if (i <= 0) return null;
	const proj = parts[i - 1];
	return SLUG_RE.test(proj) ? proj : null;
}

// normalize(fm, filePath, mtimeMs) -> §5.1 frontmatter object. Drops `blocks`
// (D6) and every non-§5.1 field, keeps the rest, and stamps the required
// created_at/updated_at from file mtime when the source lacks them. Null
// values are dropped (the schema rejects e.g. `est_commits: null`).
function normalize(fm, filePath, mtimeMs) {
	const out = {};
	for (const k of KEEP_FIELDS) {
		if (fm[k] !== undefined && fm[k] !== null) out[k] = fm[k];
	}
	if (fm.project != null) out.project = fm.project;
	else {
		const proj = deriveProject(filePath);
		if (proj) out.project = proj;
	}
	const stamp = new Date(mtimeMs).toISOString();
	out.created_at = (typeof fm.created_at === "string" && fm.created_at) ? fm.created_at : stamp;
	out.updated_at = (typeof fm.updated_at === "string" && fm.updated_at) ? fm.updated_at : stamp;
	return out;
}

// importCards({ db, parents }) -> { ok, discovered, imported, staged, skipped,
//                                   duplicateIds, stagedDir } — see file header.
function importCards({ db, parents } = {}) {
	const roots = (Array.isArray(parents) && parents.length)
		? parents
		: [path.join(os.homedir(), "Projects")];
	const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), "apple-pi-import-"));

	const skipped = [];
	const duplicateIds = [];
	const seen = new Set();
	let discovered = 0;
	let staged = 0;

	for (const file of discoverWorkspaceMdCards(roots)) {
		discovered++;
		try {
			const content = fs.readFileSync(file, "utf8");
			const { frontmatter, body } = parseLenient(content);
			const stat = fs.statSync(file);
			const fm = normalize(frontmatter, file, stat.mtimeMs);
			const vr = validateCard(fm);
			if (!vr.ok) {
				skipped.push({ file, errors: vr.errors.map(e => `${file}: ${e}`) });
				continue;
			}
			if (seen.has(fm.id)) {
				// mirror repo / shared id: kb_cards.id is the PK, so only one row
				// survives anyway — stage the first (sorted) occurrence + report.
				duplicateIds.push({ id: fm.id, file });
				continue;
			}
			seen.add(fm.id);
			fs.writeFileSync(path.join(stagedDir, `${fm.id}.card.md`), renderCard(fm, body), "utf8");
			staged++;
		} catch (e) {
			skipped.push({ file, errors: [`${file}: ${e && e.message ? e.message : String(e)}`] });
		}
	}

	// Reuse the M2-2 rebuild over the staged canonical cards: DROP kb_* ONLY,
	// recreate, parse+validate+FTS+deps+meta. Every staged card is already
	// §5.1-valid (we pre-validated), so inserted == staged on a clean tier.
	const rebuilt = rebuild(db, stagedDir);

	return {
		ok: skipped.length === 0 && rebuilt.ok,
		discovered,
		imported: rebuilt.inserted,
		staged,
		skipped,
		duplicateIds,
		stagedDir,
	};
}

module.exports = { importCards, discoverWorkspaceMdCards, parseLenient, normalize, deriveProject, KEEP_FIELDS, PRUNE };
