# ROADMAP — apple-pi agent DB + native kanban (v2)

> Decomposition of `SUPERPROMPT.md` (v2) into atomic, independently-testable
> tasks. Decisions D1–D10 are **resolved** (see SUPERPROMPT §3) and baked in.
> One task = one commit = one card. Each task has a `REQ-<id>` + a runnable
> **Verify:** hook that must pass before "done."
> Status: ⬜ not started · 🟡 in progress · ✅ done.

## Module overview

| Mod | Name | Tasks | Depends on | Parallel-safe? |
|---|---|---|---|---|
| M0 | Schema & contract (card truth) | 3 | — | yes |
| M1 | MD layer: parse / discover / validate | 3 | M0 | yes |
| M2 | Unified DB + Tier-A kb partition | 5 | M1 | M2-1 first |
| M3 | kb query + dependency graph + FTS | 3 | M2 | yes |
| M4 | Session ingest (Tier B, durable) | 4 | M2-1 | yes |
| M5 | Analysis layer (findings) | 4 | M4 | yes |
| M6 | Self-improvement loop (propose→apply→measure) | 5 | M5 | yes |
| M7 | File watcher (kb reindex + session ingest) | 3 | M2,M4 | yes |
| M8 | CLI `apple-pi kanban` + `db` + `analyze`/`improve` | 8 | M3,M4,M5,M6 | M8-1..5 then 6..8 |
| M9 | Pi agent tools | 6 | M8 | yes |
| M10 | Validation + smokes (incl. tier-isolation) | 4 | M9 | yes |
| M11 | Migration (cards + 89 sessions + autoresearch; decommission the legacy kanban) | 4 | M10 | yes |

**Critical path:** M0 → M1 → M2-1 → M2-2 → M3 → M4 → M5 → M8(kanban+ingest) →
M9 → **M10-2 (tier isolation)** → M11. M6/M7 parallel once M2 is up.

---

## M0 — Schema & contract (Tier-A truth)

### M0-1 · Card frontmatter schema + fixtures ⬜
- **What:** `agentdb/kb/schema-card.js` — schema for SUPERPROMPT §5.1 (id/title/
  status/priority/project/assignee/parent/depends_on/tags/est_commits/
  parallel_safe/created_at/updated_at). Fixtures: `agentdb/test/fixtures/good.card.md`
  + `bad-status.card.md`. **Note:** `blocks` is NOT a field (D6).
- **REQ-M0-1:** schema accepts good, rejects bad with a field-specific error.
- **Verify:** `node --test agentdb/kb/schema-card.test.js` → `ok`, exit 0.
- **Commit:** `feat(kanban): card frontmatter schema + fixtures (M0-1)`

### M0-2 · Status enum + transition map + WIP ⬜
- **What:** status enum (`triage,backlog,todo,in_progress,blocked,review,done`),
  legal-transition map, WIP=3 on `in_progress` (env `KANBAN_WIP`).
- **REQ-M0-2:** illegal transitions rejected; WIP read from env with fallback 3.
- **Verify:** transition-matrix test + env-override test.
- **Commit:** `feat(kanban): status enum + transitions + WIP (M0-2)`

### M0-3 · Layout convention + discover stub ⬜
- **What:** doc for `Projects/<proj>/.kanban/{roadmap.md,cards/*.card.md,topics/}`;
  `agentdb/kb/discover.js` returns `.card.md` paths under a root (ignores
  `node_modules`/`.git`/`.index`).
- **REQ-M0-3:** discovers N cards in a fixture tree.
- **Verify:** `node agentdb/kb/discover.js agentdb/test/fixtures` lists expected.
- **Commit:** `docs(kanban): card layout + discover stub (M0-3)`

---

## M1 — MD layer

### M1-1 · Hand-rolled frontmatter+body parser ⬜
- **What:** `agentdb/kb/parse.js` — split `---` YAML frontmatter from body;
  parse scalars, `[a, b]` inline arrays, and `key:` block lists (the §5.1
  subset only). Return `{file, frontmatter, body}`. Zero deps (D3). **Record
  any edge case that forces a gray-matter fallback in the commit body.**
- **REQ-M1-1:** `good.card.md` → exact object M0-1 expects; arrays correct.
- **Verify:** `node --test` deep-equals expected.
- **Commit:** `feat(kanban): hand-rolled card parser (M1-1)`

### M1-2 · Workspace-wide discovery ⬜
- **What:** extend `discover.js` to walk `~/Projects/*/.kanban/cards/` (+ env
  `KANBAN_ROOTS` extras) → full inventory; dedupe; sorted.
- **REQ-M1-2:** over a 2-project fixture tree returns the right count/order.
- **Verify:** discovery test.
- **Commit:** `feat(kanban): workspace-wide card discovery (M1-2)`

### M1-3 · Validator with file:line errors ⬜
- **What:** `agentdb/kb/validate.js` — parse+schema; collect all violations
  with `file:line`; exit ≠0 on any invalid card.
- **REQ-M1-3:** one-bad-card tree → precise report + exit 1; clean → exit 0.
- **Verify:** fixture run → expected codes/messages.
- **Commit:** `feat(kanban): card validator w/ file:line errors (M1-3)`

---

## M2 — Unified DB + Tier-A kb partition

### M2-1 · `agentdb/lib/db.js` + tiered `schema.sql` (ALL tables) ⬜  *(critical)*
- **What:** `lib/db.js` (`open(mode)`, `dbPath()`→`~/.pi/agent/agent.db`,
  `piDir()`; mirrors `lifecycle/lib/db.js`). `lib/schema.sql` with **every**
  table from SUPERPROMPT §5.2, `CREATE IF NOT EXISTS`, FTS5, JSON1, indexes.
  Grouped by tier with banner comments. Idempotent.
- **REQ-M2-1:** `open()` creates `agent.db` + all tables; `PRAGMA compile_options`
  shows `ENABLE_FTS5`; JSON1 round-trips.
- **Verify:** load schema in a temp db; `.tables` lists kb_/sess_/analysis_/runs/proposals.
- **Commit:** `feat(agentdb): unified tiered schema.sql + db.js (M2-1)`

### M2-2 · `kb` full rebuild (DROP kb_* ONLY) ⬜  *(critical + the contract)*
- **What:** `agentdb/kb/index.js rebuild()` — `DROP TABLE kb_*` (kb_cards,
  kb_body_fts, kb_deps, kb_meta) then recreate + reindex all cards. **Must
  never touch `sess_*`/`analysis_*`/`runs`/`proposals`.** Content hash via
  `node:crypto`.
- **REQ-M2-2:** rebuild is deterministic; deletes+rebuilds → identical `kb_*`
  rows; AND `sess_*`/`analysis_*` row counts are byte-identical before/after
  (the tier-isolation contract).
- **Verify:** seed some `sess_*` rows; rebuild kb; assert sess_* unchanged.
- **Commit:** `feat(kanban): kb full rebuild — DROP kb_* only (M2-2)`

### M2-3 · `kb` incremental index (mtime+hash) ⬜
- **What:** `index()` — compare `kb_meta` mtime+hash; upsert only changed;
  delete rows for removed files; refresh `kb_deps` from `depends_on`.
- **REQ-M2-3:** touching one card reindexes 1 row; deleting a card drops its
  row + its dep edges; untouched cards not rewritten.
- **Verify:** row-hash snapshot before/after touching one card.
- **Commit:** `feat(kanban): kb incremental index (M2-3)`

### M2-4 · `ensureCurrent()` reconcile ⬜
- **What:** if `kb_*` empty/missing → rebuild; if any card newer than its
  `kb_meta` or count mismatch → incremental. Called lazily on first query.
- **REQ-M2-4:** `rm agent.db` → query → kb rebuilt transparently, query
  succeeds; fresh db → no-op.
- **Verify:** delete db, run a kb query, assert correct + db exists.
- **Commit:** `feat(kanban): kb ensureCurrent reconcile (M2-4)`

### M2-5 · Truth-mutation writer `kb/write.js` ⬜  *(security boundary — red/blue)*
- **What:** `createCard()` / `moveStatus()` / `setField()` that edit the
  `.card.md` (the TRUTH) preserving everything else, then reindex that file.
  **Path safety:** reject `..`, absolute, out-of-tree, non-`.card.md` targets;
  status transitions enforced (M0-2); `updated_at` auto-stamped.
- **REQ-M2-5:** `moveStatus` diff is exactly 2 lines (status+updated_at);
  illegal path/transition refused with no file write.
- **Verify:** `git diff` after move shows 2 lines; abuse cases return errors.
- **Commit:** `feat(kanban): kb truth-mutation writer + path safety (M2-5)`

---

## M3 — kb query + graph + FTS

### M3-1 · Filter queries ⬜
- **What:** `agentdb/kb/query.js` `list({status,project,assignee,tag,priority})`.
  Parameterized SQL only (red-blue).
- **REQ-M3-1:** filters narrow + AND-compose correctly.
- **Verify:** query tests over fixture index.
- **Commit:** `feat(kanban): kb filter queries (M3-1)`

### M3-2 · Dependency graph + ready() + cycle detect ⬜
- **What:** `agentdb/kb/graph.js` — edges from `depends_on` (D6: `blocks` =
  reverse, derived); topo sort; **ready** = status `todo` AND all `depends_on`
  `done`; detect cycles (report, don't throw).
- **REQ-M3-2:** 5-card DAG fixture → `ready()` returns unblocked todos in
  priority order; cyclic fixture reported.
- **Verify:** graph test.
- **Commit:** `feat(kanban): kb dep graph + ready() + cycles (M3-2)`

### M3-3 · FTS5 search ⬜
- **What:** `search(q)` over `kb_body_fts` → bm25-ranked hits + snippet.
- **REQ-M3-3:** a body term ranks its card first; absent term → empty.
- **Verify:** search test.
- **Commit:** `feat(kanban): kb FTS5 search (M3-3)`

---

## M4 — Session ingest (Tier B, durable)

### M4-1 · JSONL parser + event normalization ⬜
- **What:** `agentdb/ingest/sessions.js` parse line → `{session_id, seq, type,
  ts, role, tool_name, tokens_in/out, is_error, content_sha, event_json}`.
  Handle all pi entry types (`session`,`model_change`,
  `thinking_level_change`,`message` + future `type` passthrough).
- **REQ-M4-1:** each fixture line → expected normalized row; unknown types
  pass through (event_json retained, type recorded).
- **Verify:** `node --test` over a 4-type fixture.
- **Commit:** `feat(agentdb): session JSONL parser + normalization (M4-1)`

### M4-2 · Append-only incremental ingest ⬜
- **What:** per-file resume via `sess_files(ingested_lines,total_lines,
  file_hash)`. Grew → read from line N+1, append `sess_events`, upsert
  `sess_sessions` aggregates. Hash mismatch on the ingested prefix → full
  re-ingest of that session (delete+reinsert its events). O(new lines).
- **REQ-M4-2:** appending 10 lines to a 100-line session ingests exactly 10
  events; rewriting the file re-ingests only that session.
- **Verify:** ingest, append, re-ingest → assert event counts + no dupes.
- **Commit:** `feat(agentdb): append-only session ingest (M4-2)`

### M4-3 · Session aggregates + cost ⬜
- **What:** derive `sess_sessions` rollups (message_count, tokens_in/out,
  cost, error_count, tool_calls_json, started/ended/last_event_at, model, cwd).
- **REQ-M4-3:** aggregates match a hand-computed fixture; recompute on re-ingest.
- **Verify:** aggregate test.
- **Commit:** `feat(agentdb): session aggregates + cost (M4-3)`

### M4-4 · Retention + prune (opt-in only) ⬜
- **What:** no auto-purge (D7). `apple-pi db prune --before <date> --dry|--yes`
  deletes `sess_events`/`sess_sessions` older than date; default `--dry`;
  `--yes` required to write. Logs the prune to `analysis_runs`.
- **REQ-M4-4:** dry-run reports counts, writes nothing; `--yes` deletes scoped
  rows; `kb_*`/`analysis_*` untouched.
- **Verify:** prune dry vs yes over a dated fixture.
- **Commit:** `feat(agentdb): session prune — opt-in, scoped (M4-4)`

---

## M5 — Analysis layer (findings)

### M5-1 · `analysis_runs` bookkeeping ⬜
- **What:** start/end a run, record model/tokens/finding_count; every analyze
  call is one row. Idempotent within a day is NOT required (runs are cheap,
  keep them for the trend).
- **REQ-M5-1:** an analyze run creates exactly one `analysis_runs` row linked
  to its findings.
- **Verify:** run-then-assert test.
- **Commit:** `feat(agentdb): analysis_runs bookkeeping (M5-1)`

### M5-2 · Error + cost findings ⬜
- **What:** `analyze.js` detectors: `error_pattern` (recurring
  `is_error`+tool_name clusters), `cost_spike` (session cost > rolling p95),
  `model_drift` (cost/tokens per turn trending over runs).
- **REQ-M5-2:** over a seeded `sess_*` fixture, each detector emits the
  expected finding with `evidence_json`.
- **Verify:** detector tests.
- **Commit:** `feat(agentdb): analyze — error/cost/drift findings (M5-2)`

### M5-3 · Tool-usage + card-stall findings ⬜
- **What:** `tool_underuse`/`tool_overuse` (tools never/rarely vs dominantly
  used), `card_stall` (cards in `in_progress` past a threshold, or `blocked`
  long). Reads `sess_*` tool_calls + `kb_*` statuses.
- **REQ-M5-3:** fixtures trigger each finding type.
- **Verify:** detector tests.
- **Commit:** `feat(agentdb): analyze — tool-use + card-stall findings (M5-3)`

### M5-4 · `apple-pi analyze` CLI (autonomous, read-only) ⬜
- **What:** runs all detectors, prints a findings summary, writes
  `analysis_findings`. Read-only on the world (mutates only `analysis_*`).
- **REQ-M5-4:** `apple-pi analyze` exits 0, prints N findings, rows exist.
- **Verify:** run over the real `~/.pi/sessions/` (89 sessions) — completes
  in well under 1 s, prints a sane summary.
- **Commit:** `feat(agentdb): apple-pi analyze CLI (M5-4)`

---

## M6 — Self-improvement loop (propose → apply → measure)

### M6-1 · `propose` — findings → proposals ⬜
- **What:** `analysis/propose.js` turns findings into machine-checkable
  proposals (each: `{setting, from, to, rationale, expected_delta}`,
  `source_finding_ids`). Extends the existing `proposals` table (+source_finding_ids,
  +outcome_id). Status `proposed`.
- **REQ-M6-1:** a finding of a given kind yields a well-formed proposal citing
  its finding ids.
- **Verify:** propose test over seeded findings.
- **Commit:** `feat(agentdb): propose — findings to proposals (M6-1)`

### M6-2 · `review` (human gate, read-only) ⬜
- **What:** `apple-pi review [--latest]` — lists proposals + diffs, reads
  nothing else, writes nothing. (Mirrors existing autoresearch `review`.)
- **REQ-M6-2:** shows pending proposals with their source findings; no mutation.
- **Verify:** review over seeded proposals.
- **Commit:** `feat(agentdb): apple-pi review — human gate (M6-2)`

### M6-3 · `apply` (gated, audited) ⬜  *(red-blue)*
- **What:** `apple-pi apply --latest --yes` applies approved proposals: writes
  `audit` (what actually changed), snapshots "before" metric, flips status
  `applied`. **`--yes` required** (D9). Never auto-applies.
- **REQ-M6-3:** without `--yes` → no-op + notice; with `--yes` → changes
  applied + audit + before-snapshot recorded.
- **Verify:** apply gated test.
- **Commit:** `feat(agentdb): apple-pi apply — gated + audited (M6-3)`

### M6-4 · `measure` — outcome recording (closes the loop) ⬜
- **What:** `analysis/measure.js` for applied proposals past a window: compare
  before vs after metric → `improvement_outcomes` (improved|neutral|regressed).
  Regressed → next `analyze` can propose a revert.
- **REQ-M6-4:** a seeded before/after yields the right verdict + delta.
- **Verify:** measure test.
- **Commit:** `feat(agentdb): measure — closes the improvement loop (M6-4)`

### M6-5 · launchd schedule for the autonomous loop ⬜
- **What:** `apple-pi schedule` (extend existing) wires a periodic
  `analyze` + `measure` job (e.g. daily). **Propose/apply stay manual/gated.**
- **REQ-M6-5:** schedule install creates the LaunchAgent; `analyze` runs
  unattended; no `apply` ever fires from the schedule.
- **Verify:** `schedule run-now` triggers analyze only.
- **Commit:** `feat(agentdb): scheduled autonomous analyze+measure (M6-5)`

---

## M7 — File watcher (kb reindex + session ingest)

### M7-1 · chokidar watch both roots, debounced ⬜
- **What:** `agentdb/watch.js` watches `~/Projects/*/.kanban/` (→ kb reindex)
  AND `~/.pi/sessions/` (→ session ingest), debounce 150 ms, macOS fsevents.
- **REQ-M7-1:** editing a card updates `kb_*` within ~300 ms; a new session
  line ingests within ~300 ms.
- **Verify:** integration test edits a fixture card + appends a session line.
- **Commit:** `feat(agentdb): chokidar watcher — kb + sessions (M7-1)`

### M7-2 · Single-instance + resilience ⬜
- **What:** pidfile guard (one watcher); on parse failure of a partial write,
  skip + retry next tick; one bad card never stalls the watcher.
- **REQ-M7-2:** second start exits cleanly ("already running"); truncated save
  is skipped, watcher survives.
- **Verify:** fault-injection test.
- **Commit:** `feat(agentdb): watcher single-instance + resilience (M7-2)`

### M7-3 · launchd LaunchAgent + lazy reconcile ⬜
- **What:** `apple-pi kanban watch` daemon via LaunchAgent (D4); AND every
  query path calls `ensureCurrent()`/resume-ingest so it's correct with no
  daemon. Start/stop clean, no orphans.
- **REQ-M7-3:** daemon down + edit a card → next query still sees the change
  (lazy reconcile). start→stop leaves no orphan.
- **Verify:** daemon-down reconcile test.
- **Commit:** `feat(agentdb): watcher LaunchAgent + lazy reconcile (M7-3)`

---

## M8 — CLI

> Dispatch in `bin/apple-pi` mirroring `lifecycle/`. Group under `kanban`,
> `db`, and top-level `analyze`/`improve`/`measure`.

### M8-1 · `apple-pi kanban index [--rebuild]` ⬜
- **Verify:** exit 0 + row count; `--rebuild` drops kb_* first.
- **Commit:** `feat(kanban): CLI kanban index (M8-1)`
### M8-2 · `apple-pi kanban list/show/next/graph` ⬜
- **Verify:** filters; `next` is WIP-aware (M0-2) + ready (M3-2).
- **Commit:** `feat(kanban): CLI kanban list/show/next/graph (M8-2)`
### M8-3 · `apple-pi kanban new/move` (truth writers) ⬜
- **REQ:** path safety + transition rules enforced (red-blue).
- **Verify:** new→validate→show; move diff = 2 lines.
- **Commit:** `feat(kanban): CLI kanban new/move — truth writers (M8-3)`
### M8-4 · `apple-pi db ingest/status/query` ⬜
- **Verify:** ingest resumes append-only; status shows session/event counts.
- **Commit:** `feat(agentdb): CLI db ingest/status/query (M8-4)`
### M8-5 · `apple-pi kanban validate [--project]` ⬜
- **Verify:** exit 1 + report on invalid; clean → 0.
- **Commit:** `feat(kanban): CLI kanban validate (M8-5)`
### M8-6 · `apple-pi improve` (propose, gated) ⬜
- **Verify:** propose writes proposals; no apply without `--yes`.
- **Commit:** `feat(agentdb): CLI improve — propose, gated apply (M8-6)`
### M8-7 · `apple-pi measure` ⬜
- **Verify:** records outcomes for applied proposals past window.
- **Commit:** `feat(agentdb): CLI measure (M8-7)`
### M8-8 · `apple-pi db prune --before` (M4-4 wired) ⬜
- **Verify:** dry vs yes.
- **Commit:** `feat(agentdb): CLI db prune (M8-8)`

---

## M9 — Pi agent tools  *(replaces kanban-bridge.ts)*

### M9-1 · `kanban_list` / `kanban_get` ⬜
- **Verify:** pi harness returns correct JSON from kb_*.
- **Commit:** `feat(kanban): pi tools kanban_list/get (M9-1)`
### M9-2 · `kanban_create` / `kanban_move` (truth writers) ⬜
- **REQ:** same path-safety as M2-5; file created + reindexed.
- **Verify:** harness; file exists + valid.
- **Commit:** `feat(kanban): pi tools kanban_create/move (M9-2)`
### M9-3 · `kanban_next` / `kanban_graph` ⬜
- **Verify:** next is WIP+ready-aware.
- **Commit:** `feat(kanban): pi tools kanban_next/graph (M9-3)`
### M9-4 · `db_query` (sessions/events/findings) ⬜
- **What:** read-only agent query over `sess_*`/`analysis_*` (e.g. "my last
  N errors", "sessions that touched card X"). Parameterized.
- **Verify:** harness.
- **Commit:** `feat(agentdb): pi tool db_query (M9-4)`
### M9-5 · `self_improve` trigger ⬜
- **What:** agent-callable `analyze` (+ optional `propose`) within a session.
  **Never applies** — apply is CLI-gated only.
- **Verify:** harness runs analyze, returns findings, applies nothing.
- **Commit:** `feat(agentdb): pi tool self_improve — analyze only (M9-5)`
### M9-6 · Deprecate `kanban-bridge.ts` ⬜
- **What:** keep one release as a read-only alias to the new tools, then remove.
- **Verify:** alias still answers; deprecation notice logged.
- **Commit:** `chore(kanban): deprecate kanban-bridge.ts alias (M9-6)`

---

## M10 — Validation + smokes

### M10-1 · `smoke/kanban-*.sh` (index/query/truth/disposable-db) ⬜
- **Verify:** all green in `bash smoke/run.sh`.
- **Commit:** `test(kanban): smoke suite (M10-1)`
### M10-2 · **Tier-isolation smoke (headline reliability test)** ⬜
- **What:** `smoke/agentdb-tier-isolation.sh` — seed `sess_*`+`analysis_*`,
  snapshot their row hashes, `kanban index --rebuild`, assert Tier B byte-
  identical; then `db prune` and assert `kb_*` byte-identical. Proves each
  tier is disposable independently.
- **REQ-M10-2:** rebuild leaves Tier B untouched; prune leaves Tier A untouched.
- **Verify:** smoke exit 0.
- **Commit:** `test(agentdb): tier-isolation smoke — independent disposability (M10-2)`
### M10-3 · Ingest idempotency + append smoke ⬜
- **What:** `smoke/agentdb-ingest.sh` — ingest twice → no dupes; append lines
  → only new events.
- **Verify:** exit 0.
- **Commit:** `test(agentdb): ingest idempotency smoke (M10-3)`
### M10-4 · Sanitize + dep-budget ⬜
- **What:** extend `smoke/sanitize.sh` over `agentdb/`; assert deps ≤ chokidar
  (+ gray-matter only if D3 fallback used). No personal info on the product surface.
- **Verify:** `bash smoke/sanitize.sh` exit 0.
- **Commit:** `test(agentdb): sanitize + dep-budget (M10-4)`

---

## M11 — Migration

### M11-1 · Import existing workspace cards (dogfood parity) ⬜
- **What:** the real `~/Projects/*/.kanban/cards/*.md` already match §5.1 →
  `apple-pi kanban index`. (Drop `blocks` from any that still store it — D6;
  recompute.) Verify parity.
- **REQ-M11-1:** kb row count == sum of `cards/*.card.md`.
- **Verify:** one-shot count assertion over the real workspace.
- **Commit:** `chore(kanban): import existing workspace cards (M11-1)`

### M11-2 · Ingest the 89 existing sessions ⬜
- **What:** `apple-pi db ingest` over `~/.pi/sessions/`. Confirm event/session
  counts; spot-check aggregates vs `runs` (existing daily table).
- **REQ-M11-2:** all 89 files ingested; `sess_events` count plausible vs JSONL
  line totals.
- **Verify:** count assertion.
- **Commit:** `chore(agentdb): ingest existing sessions (M11-2)`

### M11-3 · Absorb `autoresearch.db` → `agent.db` ⬜
- **What:** `agentdb/lib/migrate.js` copies `runs`+`proposals` from
  `~/.pi/agent/autoresearch.db` into `agent.db`; points `lifecycle/lib/db.js`
  `dbPath()` at `agent.db`; keeps a `.pre-merge` backup of the old db.
- **REQ-M11-3:** after migrate, `apple-pi status` reads from `agent.db`;
  old rows present; old db backed up.
- **Verify:** status parity before/after.
- **Commit:** `chore(agentdb): absorb autoresearch.db into agent.db (M11-3)`

### M11-4 · Decommission the legacy kanban (gated, last) ⬜  *(confirm with user first)*
- **What:** stop the `kanban-roadmap-sync` cron; archive the legacy boards dir;
  unset pi `KANBAN_DB_PATH` (was the legacy DB); remove `kanban-bridge.ts`
  post-deprecation. **Confirm with user before disabling the cron** (it feeds
  the web kanban today).
- **REQ-M11-4:** new tools the only kanban surface; web kanban either repointed
  or formally retired.
- **Verify:** `apple-pi kanban list` works with no legacy DB.
- **Commit:** `chore(kanban): decommission hermes sync + bridge (M11-4)`

---

## Sequencing recap
- **Critical path:** M0→M1→M2-1→M2-2→M3→M4→M5→M8(kanban+db)→M9→**M10-2**→M11.
- **Parallel side-quests once M2 is up:** M6 (loop), M7 (watcher), M2-3/4/5.
- **Build M10-2 (tier isolation) early** — it is the contract that makes the
  whole "disposable mirror + durable memory" design safe. Do it right after M2-2.
- **Dogfood from M0-1:** the first card is a real `.card.md` in the new system.
