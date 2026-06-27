-- autoresearch.db schema. Applied idempotently by lib/db.js (CREATE IF NOT EXISTS).
-- DB path: $PI_DIR/agent/autoresearch.db  (PI_CODING_AGENT_DIR-aware; default ~/.pi/agent/autoresearch.db)

-- One row per daily collection. UNIQUE(run_date) so a re-run today overwrites today
-- (a flaky cron self-heals rather than producing duplicate rows).
CREATE TABLE IF NOT EXISTS runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date         TEXT    NOT NULL UNIQUE,   -- YYYY-MM-DD (the day covered)
  collected_at     TEXT    NOT NULL,          -- ISO timestamp of this collection
  session_count    INTEGER NOT NULL,          -- distinct session files seen
  total_turns      INTEGER NOT NULL,          -- user + assistant + toolResult messages
  tokens_in        INTEGER NOT NULL,
  tokens_out       INTEGER NOT NULL,
  cache_read       INTEGER NOT NULL,
  cache_write      INTEGER NOT NULL,
  cost             REAL    NOT NULL,          -- total $ across the day's assistant turns
  compaction_count INTEGER NOT NULL DEFAULT 0,
  error_count      INTEGER NOT NULL,          -- toolResult messages with isError=true
  tool_calls_json  TEXT    NOT NULL,          -- {"bash":N,"read":N,...}
  models_json      TEXT    NOT NULL           -- {"<model>":N_turns,...}
);

-- One row per weekly brief. status drives the review→apply gate.
CREATE TABLE IF NOT EXISTS proposals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT    NOT NULL,
  week_start   TEXT    NOT NULL,              -- YYYY-MM-DD (Mon)
  week_end     TEXT    NOT NULL,              -- YYYY-MM-DD (Sun)
  brief_path   TEXT    NOT NULL,              -- path to the markdown brief
  summary      TEXT    NOT NULL,              -- one-line summary for `apple-pi review`
  changes_json TEXT    NOT NULL,              -- [{setting,from,to,rationale}, ...]
  status       TEXT    NOT NULL DEFAULT 'proposed',  -- proposed|approved|applied|rejected|superseded
  applied_at   TEXT,
  audit        TEXT                           -- filled at apply time (what actually changed)
);

CREATE INDEX IF NOT EXISTS idx_runs_date      ON runs(run_date);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
