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

-- ===== Tier B — durable memory (sessions + analysis + runs + proposals) =====
--
-- Added by M4 (session ingest) + M5 (analysis layer) + M6 (proposals) +
-- M11 (migrate autoresearch.db). Tier B survives a kanban rebuild and a
-- Tier-B prune; the tier-isolation contract is verified by the M10-2
-- smoke test (a rebuild leaves Tier B byte-identical; a prune leaves
-- Tier A byte-identical).
--
-- Idempotent CREATE ... IF NOT EXISTS so open() can apply the full schema
-- on every connection without races.

-- One row per ingested JSONL session file under ~/.pi/sessions/. Carries
-- the file-level state needed for append-only incremental ingest (M4-2):
-- file_hash detects mid-file rewrites (forces a full re-ingest of that
-- session); ingested_lines + total_lines drive the O(new_lines) resume.
CREATE TABLE IF NOT EXISTS sess_files (
  file_path        TEXT    PRIMARY KEY,              -- absolute path to the JSONL session file
  session_id      TEXT    NOT NULL,                  -- the session_id embedded in the file (UUID)
  file_hash       TEXT    NOT NULL,                  -- content hash of the WHOLE file at last ingest
  prefix_hash     TEXT    NOT NULL DEFAULT '',       -- content hash of lines [0..ingested_lines) at last ingest
  total_lines     INTEGER NOT NULL DEFAULT 0,        -- current line count of the file
  ingested_lines  INTEGER NOT NULL DEFAULT 0,        -- how many lines we've ingested so far
  ingested_at     TEXT    NOT NULL,                  -- ISO8601 of last successful ingest
  last_event_at   TEXT                               -- ISO8601 of the most-recent event_ts in the file
);
CREATE INDEX IF NOT EXISTS idx_sess_files_session ON sess_files(session_id);

-- One row per session — the AGGREGATE row, rolled up from sess_events.
-- Carries everything a card-stall detector / cost-spike detector needs to
-- score the session without re-scanning events. message_count / tokens_*
-- / cost are recomputed on every ingest (M4-3). tool_calls_json is a
-- {tool_name: call_count} map for the tool_underuse/tool_overuse detector.
CREATE TABLE IF NOT EXISTS sess_sessions (
  session_id        TEXT    PRIMARY KEY,             -- UUID
  started_at        TEXT    NOT NULL,                -- ISO8601 of first event
  ended_at          TEXT,                            -- ISO8601 of last event (NULL if still active)
  last_event_at     TEXT    NOT NULL,                -- ISO8601 of last event (kept warm by ingest)
  message_count     INTEGER NOT NULL DEFAULT 0,      -- human + assistant messages only
  tool_call_count   INTEGER NOT NULL DEFAULT 0,      -- total tool invocations
  error_count       INTEGER NOT NULL DEFAULT 0,      -- events with is_error=true
  tokens_in         INTEGER NOT NULL DEFAULT 0,      -- sum of input tokens
  tokens_out        INTEGER NOT NULL DEFAULT 0,      -- sum of output tokens
  cost              REAL    NOT NULL DEFAULT 0,      -- estimated cost in USD (model-priced)
  model             TEXT,                            -- last model seen (e.g. MiniMax-M3, glm-5.2)
  cwd               TEXT,                            -- working directory from session_meta
  tool_calls_json   TEXT    NOT NULL DEFAULT '{}',   -- JSON {tool_name: count}
  file_path         TEXT                             -- back-ref to sess_files.file_path (for pruning)
);
CREATE INDEX IF NOT EXISTS idx_sess_sessions_started ON sess_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sess_sessions_model ON sess_sessions(model);

-- One row per event from the JSONL file. Each session has many events;
-- the seq column is the 0-indexed position in the source file (so partial
-- re-ingests can resume from a specific line). event_json retains the
-- verbatim pi JSONL entry — anything the indexer doesn't normalize lives
-- in the raw blob for future read paths.
CREATE TABLE IF NOT EXISTS sess_events (
  session_id      TEXT    NOT NULL,                   -- FK to sess_sessions.session_id (no formal FK; SQLite)
  seq             INTEGER NOT NULL,                   -- 0-indexed line position in the file
  type            TEXT    NOT NULL,                   -- event type (session, message, model_change, ...)
  ts              TEXT    NOT NULL,                   -- ISO8601 timestamp from the event
  role            TEXT,                               -- user|assistant|tool|system (when applicable)
  tool            TEXT,                               -- tool name (when type is tool_call)
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  is_error        INTEGER NOT NULL DEFAULT 0,         -- 0|1 (SQLite has no native bool)
  content_sha     TEXT,                               -- content hash for de-dup on retry
  event_json      TEXT    NOT NULL,                   -- verbatim pi JSONL entry
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_sess_events_ts ON sess_events(ts);
CREATE INDEX IF NOT EXISTS idx_sess_events_tool ON sess_events(tool);

-- One row per analyze() invocation. Append-only (D7): no auto-purge, but
-- the prune tool can target older runs. finding_count is denormalized for
-- quick dashboard read; the actual findings live in analysis_findings.
CREATE TABLE IF NOT EXISTS analysis_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT    NOT NULL,                   -- ISO8601
  ended_at        TEXT,                               -- ISO8601 (NULL while running)
  model           TEXT,                               -- LLM that produced the analysis (often the same as the session model)
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  finding_count   INTEGER NOT NULL DEFAULT 0,
  notes           TEXT                                -- free-form notes (operator / human)
);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_started ON analysis_runs(started_at);

-- One row per detected finding (error_pattern / cost_spike / model_drift /
-- tool_underuse / tool_overuse / card_stall). detector is the detector id;
-- evidence_json is the supporting data the detector used (e.g. the matched
-- tool names + counts for an error_pattern).
CREATE TABLE IF NOT EXISTS analysis_findings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          INTEGER NOT NULL,                   -- FK to analysis_runs.id
  detector        TEXT    NOT NULL,                   -- e.g. "error_pattern", "card_stall"
  severity        TEXT    NOT NULL,                   -- info|warn|critical
  title           TEXT    NOT NULL,                   -- one-line summary
  evidence_json   TEXT    NOT NULL DEFAULT '{}',      -- JSON {key: value} supporting the finding
  proposal_id     INTEGER,                             -- FK to proposals.id (when propose linked this finding; M6-1)
  detected_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_analysis_findings_run ON analysis_findings(run_id);
CREATE INDEX IF NOT EXISTS idx_analysis_findings_detector ON analysis_findings(detector);

-- One row per self-improvement proposal (M6-1 propose). proposal.status:
-- 'proposed' -> 'reviewing' -> 'applied' | 'rejected'. Each proposal can
-- cite 0..N source findings via source_finding_ids_json (JSON array of
-- analysis_findings.id). outcome_id links to improvement_outcomes (M6-4)
-- once the measurement window closes.
CREATE TABLE IF NOT EXISTS proposals (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  status                 TEXT    NOT NULL DEFAULT 'proposed',
  setting                TEXT    NOT NULL,            -- e.g. "agent.max_turns"
  from_value             TEXT,                         -- previous value (JSON-encoded)
  to_value               TEXT,                         -- proposed value (JSON-encoded)
  rationale              TEXT    NOT NULL,             -- human-readable justification
  expected_delta_json    TEXT    NOT NULL DEFAULT '{}', -- JSON {metric: predicted change}
  source_finding_ids_json TEXT   NOT NULL DEFAULT '[]', -- JSON array of analysis_findings.id
  outcome_id             INTEGER,                      -- FK to improvement_outcomes.id (set after measure)
  proposed_at            TEXT    NOT NULL,             -- ISO8601
  applied_at             TEXT                          -- ISO8601 (NULL until apply)
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);

-- One row per measurement (M6-4 measure). verdict is 'improved' |
-- 'neutral' | 'regressed'. before_json / after_json snapshot the metric
-- values around the proposal's window so a human can audit why a verdict
-- was given.
CREATE TABLE IF NOT EXISTS improvement_outcomes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id     INTEGER NOT NULL,                   -- FK to proposals.id
  measured_at     TEXT    NOT NULL,                   -- ISO8601
  before_json     TEXT    NOT NULL DEFAULT '{}',      -- metric snapshot before the proposal
  after_json      TEXT    NOT NULL DEFAULT '{}',      -- metric snapshot after the proposal window
  delta_json      TEXT    NOT NULL DEFAULT '{}',      -- computed delta
  verdict         TEXT    NOT NULL,                   -- improved|neutral|regressed
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_improvement_outcomes_proposal ON improvement_outcomes(proposal_id);
