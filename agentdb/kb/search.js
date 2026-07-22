// agentdb/kb/search.js — FTS5 full-text search (M3-3).
//
// ROADMAP M3-3: search(q, db, opts={limit=10}) -> [{id, title, snippet, rank}]
// from kb_body_fts. Uses FTS5 bm25() ranking (lower = better; we negate
// for sort-asc in case the caller wants sort-by-best). snippet(...) is the
// FTS5 highlight function that wraps matched terms with <mark>…</mark>.
//
// RED-BLUE CONTRACT:
//   - q is wrapped in double-quotes for the MATCH expression (literal phrase
//     matching, not boolean operators); user input never reaches the FTS5
//     query parser as raw syntax.
//   - Internal double-quotes are escaped by doubling them (FTS5's escape).
//   - LIMIT is bound via ? placeholder, not concatenated.
//   - Pure function; no side effects on the db.
//
// The FTS5 virtual table is keyed by an implicit rowid that maps to the
// kb_cards row (we INSERT into both atomically in the indexer). The search
// joins kb_body_fts back to kb_cards to expose id/title; rowid is the join
// key per the schema (kb_body_fts has no explicit id column — that's by
// FTS5 design: the rowid is the implicit primary key).
"use strict";

// FTS5_OPERATORS — characters that have special meaning in FTS5 MATCH syntax
// when used outside a quoted phrase. Escaping strategy: wrap q in double-
// quotes (phrase match) and escape any internal " by doubling. This means
// the user query becomes a literal phrase — they get fewer false hits from
// FTS5 operators, but the search is predictable and safe.
const SNIPPET_BEFORE = "<mark>";
const SNIPPET_AFTER = "</mark>";
const SNIPPET_SEPARATOR = "…";
const SNIPPET_TOKEN_COUNT = 8;

// escapeFtsPhrase(q) -> string — wrap q in double-quotes and escape internal
// quotes by doubling. Empty/whitespace-only q returns "" (the caller treats
// that as a "no results" outcome).
function escapeFtsPhrase(q) {
	if (typeof q !== "string") return "";
	const trimmed = q.trim();
	if (trimmed.length === 0) return "";
	return `"${trimmed.replace(/"/g, '""')}"`;
}

// search(q, db, opts={}) -> { ok, hits, errors? }
//   q    : user query string. Whitespace-only -> { ok: true, hits: [] }.
//   db   : an open node:sqlite DatabaseSync (lib/db.js open()).
//   opts : { limit?: number = 10 }
//   hits : [{ id, title, snippet, rank }] sorted by rank ASC (best first).
//
// Snippet generation: FTS5's snippet(title, body, before, after, sep, n)
// returns a short excerpt of `body` (or `title` if body is empty) with the
// matched terms wrapped in before/after. n is the approximate token count.
// We pass the kb_cards title and body as columns to snippet().
function search(q, db, opts = {}) {
	const trimmed = typeof q === "string" ? q.trim() : "";
	if (trimmed.length === 0) return { ok: true, hits: [] };

	const o = (opts === null || opts === undefined) ? {} : opts;
	if (typeof o !== "object" || Array.isArray(o)) {
		return { ok: false, errors: ["search: opts must be a plain object"] };
	}
	const limit = (o.limit != null) ? o.limit : 10;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
		return { ok: false, errors: ["search: opts.limit must be a positive integer"] };
	}

	const phrase = escapeFtsPhrase(q);
	if (phrase.length === 0) return { ok: true, hits: [] };

	// FTS5 bm25() returns a negative rank where lower (more negative) is
	// a better match. We ORDER BY rank ASC so the best matches come first.
	// The MATCH expression uses the bound phrase (literal query).
	//
	// snippet(kb_body_fts, <column>, before, after, sep, n) — column 0 is
	// `title`, column 1 is `body` (per schema.sql CREATE VIRTUAL TABLE).
	// We pick column 1 (body) because the user's query typically targets
	// the body; if the body is empty, FTS5 falls back to whatever column
	// has content. Either way the rowid join carries the title back.
	const sql = `
		SELECT kb_cards.id AS id,
		       kb_cards.title AS title,
		       snippet(kb_body_fts, 1, ?, ?, ?, ?) AS snippet,
		       bm25(kb_body_fts) AS rank
		FROM kb_body_fts
		JOIN kb_cards ON kb_cards.rowid = kb_body_fts.rowid
		WHERE kb_body_fts MATCH ?
		ORDER BY rank
		LIMIT ?
	`;

	let stmt;
	try {
		stmt = db.prepare(sql);
	} catch (e) {
		return { ok: false, errors: [`search: SQL prepare failed (${e.message})`] };
	}

	let rows;
	try {
		// bind order: snippet before/after/sep/tok, then the MATCH phrase, then LIMIT
		rows = stmt.all(SNIPPET_BEFORE, SNIPPET_AFTER, SNIPPET_SEPARATOR, SNIPPET_TOKEN_COUNT, phrase, limit);
	} catch (e) {
		// FTS5 syntax errors shouldn't fire because we phrase-quote, but be safe.
		return { ok: false, errors: [`search: SQL exec failed (${e.message})`] };
	}

	// Normalize rows: rank is a number (negate for caller convenience so
	// higher = better, which matches common UI conventions).
	const hits = rows.map(r => ({
		id: r.id,
		title: r.title,
		snippet: r.snippet,
		rank: -r.rank, // negate so caller sees "higher = better match"
	}));
	return { ok: true, hits };
}

module.exports = {
	search,
	// Exported for tests; not part of the public API.
	escapeFtsPhrase,
	SNIPPET_BEFORE,
	SNIPPET_AFTER,
	SNIPPET_SEPARATOR,
	SNIPPET_TOKEN_COUNT,
};