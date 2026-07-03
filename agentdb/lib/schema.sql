-- agentdb/lib/schema.sql — unified agent DB schema (SUPERPROMPT §5.2).
-- Applied idempotently by lib/db.js (every statement is CREATE ... IF NOT
-- EXISTS; a second apply is a no-op). DB path: ~/.pi/agent/agent.db
-- ($PI_CODING_AGENT_DIR-aware; overridable via $AGENT_DB) — see lib/db.js.
--
-- Milestone scope: this file currently defines **Tier A only** — the
-- disposable kanban mirror (kb_*). Tier B (sess_*, analysis_*, runs,
-- proposals) is added INTO THIS SAME FILE by later milestones (M6+ ingest,
-- M7+ analysis, M11 migrates the existing autoresearch.db). One file, two
-- tiers, applied by the single open() pass — that is the unified-DB contract
-- (§2). Rebuild scope is per-tier: a kanban rebuild DROPs kb_* ONLY and never
-- touches Tier B.
--
-- Principle A (§1): the .card.md files are the human-readable truth; kb_* is a
-- one-way derived mirror. Never two-way.

-- ===== Tier A — kanban mirror (DISPOSABLE; rebuild = DROP kb_* only) =====

-- One row per .card.md. id is the card slug (frontmatter 'id' = filename minus
-- '.card.md'); it is the PK so reindexing the same card id overwrites cleanly.
-- file_path is the source-of-truth location on disk; frontmatter_json retains
-- the full parsed frontmatter verbatim (nothing thrown away — §1, Principle A).
CREATE TABLE IF NOT EXISTS kb_cards (
  id                TEXT    PRIMARY KEY,            -- card slug (frontmatter id)
  title             TEXT    NOT NULL,
  status            TEXT    NOT NULL,               -- triage|backlog|todo|in_progress|blocked|review|done
  priority          INTEGER,                        -- 0-9 (nullable; not every card sets it)
  project           TEXT,                           -- slug; stored for portability (also derivable from path)
  assignee          TEXT,                           -- slug, or NULL
  parent            TEXT,                           -- card-id | root | none
  tags_json         TEXT    NOT NULL DEFAULT '[]',  -- JSON array of tag strings
  file_path         TEXT    NOT NULL,               -- absolute path to the .card.md (Tier-A truth)
  frontmatter_json  TEXT    NOT NULL,               -- full parsed frontmatter, retained verbatim
  body              TEXT    NOT NULL DEFAULT '',    -- markdown body after the closing '---' fence
  updated_at        TEXT,                           -- from frontmatter updated_at (ISO8601)
  file_hash         TEXT    NOT NULL                -- content hash of the source file (incremental reindex key)
);
CREATE INDEX IF NOT EXISTS idx_kb_cards_status  ON kb_cards(status);   -- board column view
CREATE INDEX IF NOT EXISTS idx_kb_cards_project ON kb_cards(project);  -- project-scoped board
CREATE INDEX IF NOT EXISTS idx_kb_cards_parent  ON kb_cards(parent);   -- parent -> children tree walk

-- FTS5 full-text index over card title + body (§2: FTS5 is the search engine).
-- Standalone (stores its own copy): a rebuild is `DELETE FROM kb_body_fts` +
-- re-insert; no external-content rowid sync to keep correct. Duplication is
-- negligible for a single-user kanban (hundreds of cards).
CREATE VIRTUAL TABLE IF NOT EXISTS kb_body_fts USING fts5(
  title, body,
  tokenize = 'unicode61'
);

-- Dependency edges from each card's frontmatter depends_on. Only the forward
-- direction is stored (decision D6: blocks is DERIVED, never stored) — reverse
-- traversal of this table yields "what blocks X". idx_kb_deps_to makes that
-- reverse lookup fast.
CREATE TABLE IF NOT EXISTS kb_deps (
  from_id  TEXT NOT NULL,                           -- the card that depends
  to_id    TEXT NOT NULL,                           -- the card it depends on
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_kb_deps_to ON kb_deps(to_id);  -- reverse edges (blocks)

-- Per-file reindex state for the incremental indexer (M2-3). mtime is a
-- fast-path "unchanged?" check; file_hash is authoritative — a same-mtime file
-- with a different hash still re-parses + upserts. This is what makes a reindex
-- O(changed files), not O(all files).
CREATE TABLE IF NOT EXISTS kb_meta (
  file_path  TEXT    PRIMARY KEY,                    -- absolute path to the .card.md
  mtime      INTEGER NOT NULL,                       -- fs.stat mtime ms; quick "unchanged?" gate
  file_hash  TEXT    NOT NULL                        -- content hash; authoritative change check
);
