# SUPERPROMPT — apple-pi agent DB + native kanban (v2)

> Status: design / spec. v2 — 2026-07-02. Supersedes v1.
> Scope expanded per user direction: the DB is no longer *only* a disposable
> kanban mirror. It is the agent's **durable memory** — full session ingest,
> long-retention analytics, and the substrate for **autonomous self-improvement
> loops baked into apple-pi's logic**. A fast DB is key to all of it.
> Feed this whole document to an apple-pi session to drive the build.
> Decomposition: `ROADMAP.md`. Worked-example skill: `handle-big-projects-pi`.

## 0. Mission

Build one **fast, unified, tiered agent database** at `~/.pi/agent/agent.db`
that serves three roles, and a **native kanban** whose human-readable truth
lives in card files:

1. **Kanban mirror (disposable).** `.card.md` files are the human-readable
   current-state truth; a `kb_*` partition mirrors them for fast queries and
   can be deleted and rebuilt any time.
2. **Session memory (durable).** Every pi session JSONL is ingested in full
   (one row per session + one row per event, original payload retained), kept
   long-term. This is the agent's recall + the raw material for improvement.
3. **Autonomous self-improvement (durable).** The agent analyzes its own
   sessions + metrics + kanban outcomes, proposes improvements, and — through
   a human gate — applies them, then measures whether they helped. Closed loop.

This **extends apple-pi's existing autoresearch lifecycle** (`collect` →
`aggregate` → `review` → `apply`), not a parallel system: the existing
`runs`/`proposals` tables migrate into the unified DB and deepen from
daily-aggregate granularity to per-session/per-event granularity + outcome
measurement.

## 1. The two governing principles

**Principle A — for project state: cards are truth, the DB mirrors them.**
`.kanban/cards/*.card.md` summarize the *current state* in human-readable
form. The `kb_*` DB partition is a one-way derived mirror. Never two-way. The
mirror is disposable. (Precedent: agentic-os ADR-0004, MarkdownDB, KiwiFS.)

**Principle B — for agent memory + improvement: the DB is primary and durable.**
Session data and analytical artifacts have **no file source of truth** the way
cards do — the DB *is* the store. This partition is **not** disposable: a
kanban rebuild never touches it. Long retention by default.

The contract that makes both coexist: **the durability tier is decided per
table** (`kb_*` = disposable; `sess_*`/`analysis_*`/`runs`/`proposals` =
durable), and every rebuild/reconcile operation is scoped to one tier.

## 2. The unified DB + two durability tiers (DECIDED)

**Topology:** ONE SQLite file, `~/.pi/agent/agent.db`, all tables, two tiers.
Migrate the existing `~/.pi/agent/autoresearch.db` (`runs`, `proposals`) into
it (M11). One file = one backup, one connection, fast cross-tier queries
("which sessions touched card X?").

| Tier | Tables | Source of truth | Disposable? | Rebuild scope |
|---|---|---|---|---|
| A — kanban mirror | `kb_cards`, `kb_body_fts`, `kb_deps`, `kb_meta` | the `.card.md` files | **yes** | `kb_*` only |
| B — session memory | `sess_sessions`, `sess_events`, `sess_files` | ingest of `~/.pi/sessions/*.jsonl` | no (primary) | n/a (append-only ingest) |
| B — analytics | `analysis_runs`, `analysis_findings`, `improvement_outcomes` | the agent's analysis | no (primary) | n/a |
| B — lifecycle (existing) | `runs`, `proposals` | collect/propose/apply | no (primary) | n/a |

**"Fast" is non-negotiable and it comes from:** SQLite **in-process** (no
server, no daemon-for-the-DB-itself), **JSON1** (flexible document columns),
**FTS5** (body/event search), tight **indexes** on every query path, and
append-only ingest (sessions grow by appending lines — ingest resumes from the
last line, never re-reads the whole file). All already in stack (`node:sqlite`).

### Why SQLite, not MongoDB (reaffirmed for the expanded scope)
The expanded role (long-retention session analytics + autonomous loops) makes
MongoDB *worse*, not better: it would add a `mongod` daemon to keep alive, a
server data dir to back up, and a security surface — for a single-user,
local-first, file-adjacent store. SQLite + JSON1 + FTS5 gives the document
flexibility and the text search server-free, with schema checks that catch
ingest bugs (reliability). The query layer is the swappable seam (§6): a future
remote/multi-device sync server can sit behind it without touching callers.

## 3. Decisions (resolved — no longer "open")

| # | Decision | Call |
|---|---|---|
| D1 | DB topology | **One unified `~/.pi/agent/agent.db`**, two tiers (§2). Absorb `autoresearch.db`. |
| D2 | Kanban index location | **Global** (inherent — it's the unified DB). |
| D3 | YAML frontmatter parser | **Hand-rolled minimal** (fixed card schema: scalars + `[a,b]` + block lists). **Zero new deps.** Fall back to `gray-matter` only if the subset proves brittle — recorded in M1. |
| D4 | File watcher run model | **launchd LaunchAgent** (`apple-pi kanban watch`), single-instance (pidfile). **Plus lazy reconcile on every query** so it's correct even if the daemon is down. |
| D5 | WIP limit default | **3** on `in_progress` (`KANBAN_WIP` env override). |
| D6 | `blocks` field | **Derived, not stored.** Keep only `depends_on`; `graph.js` computes reverse edges. Removes a drift source. |
| D7 | Session retention | **No auto-purge.** Explicit `apple-pi db prune --before <date>` only. Long retention is the point. |
| D8 | Session event storage | **Full payload retained** (`event_json` JSON1 column) + extracted scalar columns for fast queries. Nothing thrown away. |
| D9 | Improvement-loop autonomy | **Analyze + propose + measure = autonomous + scheduled** (launchd). **Apply = human-gated** (`apple-pi apply --yes`, existing posture). Nothing self-applies without explicit yes. |
| D10 | New runtime deps | **chokidar only** (+ gray-matter only if D3 falls back). Dep budget stated in M10. |

## 4. Legacy-kanban leftover analysis — keep / redesign / drop

| Legacy piece | Verdict | Why |
|---|---|---|
| `.kanban/cards/*.md` per-project card files | **KEEP** | Human-readable current-state truth (Principle A) |
| `tasks` SQLite (40+ orchestrator cols: claim_lock, circuit breaker, goal_mode, heartbeat…) | **REDESIGN → `kb_*` slim mirror** | It's a job-orchestrator DB; decouple truth from execution |
| Boards JSON (the legacy boards dir) | **DROP** | Third representation; pure duplication |
| `kanban-roadmap-sync` 12h cron | **REDESIGN → instant chokidar reindex** | 12h lag = the #1 "unreliable" complaint |
| Dispatcher + worker fleet + profiles | **DROP (v1)** | The complexity sinkhole; an *executor*, not a *kanban* |
| claim_lock / failures / retries / goal_mode / heartbeat | **DROP** | Dispatcher mechanics |
| Per-task git worktrees | **REDESIGN → optional one-liner helper** | Useful isolation, not a subsystem |
| Per-task logs, watchdog, ops-healer | **DROP** | Self-healing for complexity we're removing |
| Events/comments/attachments/notify tables | **SIMPLIFY** | Comments live in the card body; events come from session ingest instead |
| Web kanban frontend | **REDESIGN → optional reader** vs the new DB | Separate post-v1 module |
| `kanban-bridge.ts` (pi read-only bridge to the legacy DB) | **REPLACE** | With MD-aware read/write tools (M9) |
| The legacy `tasks`-as-execution-queue | **REDESIGN** → the `sess_*`+`analysis_*` durable tier replaces "agent memory"; execution (if ever) is a separate reader | Keep memory, drop the fleet |

**Net:** ~80% of the legacy surface goes away; what remains is cards + a fast
tiered DB + thin agent tools + an autonomous improvement loop.

## 5. Schemas

### 5.1 Card file (Tier-A truth) — `Projects/<proj>/.kanban/cards/<id>.card.md`
```yaml
---
id:            <stable-slug>        # = filename minus .card.md; idempotency key
title:         <string>             # required
status:        triage|backlog|todo|in_progress|blocked|review|done
priority:      <0-9>                # 0 = highest
project:       <slug>               # stored for portability (also derivable from path)
assignee:      <slug>               # optional
parent:        <card-id> | root | none
depends_on:    [<card-id>, ...]     # the ONLY dep direction; blocks is derived (D6)
tags:          [<string>, ...]
est_commits:   <int>                # metadata
parallel_safe: <bool>               # metadata
created_at:    <ISO8601>
updated_at:    <ISO8601>
---
<markdown body — spec / acceptance / notes; human + agent editable>
```
Status taxonomy (kept small): `triage → backlog → todo → in_progress → review
→ done`, with `blocked` as a sidetrack. WIP limit on `in_progress` (D5).

### 5.2 Unified DB schema (concrete) — `agentdb/lib/schema.sql`
**Tier A — disposable:**
- `kb_cards(id PK, title, status, priority, project, assignee, parent,
  tags_json, file_path, frontmatter_json, body, updated_at, file_hash)`
- `kb_body_fts` — FTS5 over (title, body)
- `kb_deps(from_id, to_id)` — edges from `depends_on`; reverse = blocks
- `kb_meta(file_path PK, mtime, file_hash)` — incremental reindex

**Tier B — durable, session memory:**
- `sess_files(file_path PK, file_hash, size, ingested_lines, total_lines,
  ingested_at)` — append-only resume cursor
- `sess_sessions(session_id PK, file_path, version, started_at, ended_at,
  last_event_at, model, cwd, message_count, tokens_in, tokens_out, cost,
  error_count, tool_calls_json, ingested_at)`
- `sess_events(id PK autoincr, session_id, seq, type, ts, role, tool_name,
  tokens_in, tokens_out, is_error, content_sha, event_json)` —
  indexes on (session_id,seq), (type), (tool_name), (ts)

**Tier B — durable, analytics + improvement:**
- `analysis_runs(id, started_at, ended_at, model, tokens, finding_count)`
- `analysis_findings(id, run_id, created_at, kind, scope, scope_id, metric,
  severity, evidence_json, summary)` — kind ∈ error_pattern, cost_spike,
  tool_underuse, tool_overuse, card_stall, model_drift, prompt_correlation…
- `proposals(id, created_at, week_start, week_end, brief_path, summary,
  changes_json, source_finding_ids_json, status, applied_at, audit, outcome_id)`
  — **extends the existing table** (+source_finding_ids, +outcome_id)
- `improvement_outcomes(id, proposal_id, measured_at, metric_before,
  metric_after, delta, verdict)` — closes the loop (improved|neutral|regressed)
- `runs` — **existing** daily-collection table, unchanged (M11 migrates it in)

## 6. Module map

```
apple-pi/
  agentdb/                     ← unified DB layer (absorbs lifecycle/lib)
    lib/db.js                  ← open()/dbPath()->~/.pi/agent/agent.db/piDir()
    lib/schema.sql             ← ALL tables, tiered (kb_* / sess_* / analysis_* / runs / proposals)
    lib/migrate.js             ← one-time: autoresearch.db -> agent.db
    kb/   parse.js validate.js discover.js
          index.js             ← rebuild() [DROP kb_* ONLY] + incremental + ensureCurrent()
          query.js graph.js search.js
          write.js             ← card create/move -> edits .card.md (TRUTH) -> kb reindex
    ingest/sessions.js         ← JSONL -> sess_sessions/sess_events (append-only)
    analysis/ analyze.js propose.js measure.js
    watch.js                   ← chokidar: .kanban -> kb reindex; ~/.pi/sessions -> ingest
  bin/apple-pi                 ← + kanban <sub> · db <sub> · analyze · improve · measure
  config/extensions/kanban.ts  ← pi tools (kb + ingest query + analyze trigger) [replaces kanban-bridge.ts]
  .docs/features/kanban/       ← SUPERPROMPT.md + ROADMAP.md
  smoke/agentdb-*.sh kanban-*.sh
```
The **query layer** (`kb/query.js`, `ingest` readers, `analysis/*`) is the
swappable seam: SQLite today; a future remote/sync server can sit behind it
without touching the CLI, tools, or watcher.

## 7. Data flow

- **Cards → `kb_*`:** edit a `.card.md` (by human, CLI, or agent tool) →
  watcher (or lazy reconcile) reindexes that file → mirror current. Rebuild =
  `DROP kb_*` + reindex; Tier B untouched.
- **Sessions → `sess_*`:** pi appends to `~/.pi/sessions/*.jsonl` → watcher
  (or `apple-pi db ingest`) resumes from `ingested_lines` → appends
  `sess_events` + upserts `sess_sessions`. Append-only = O(new lines), not O(file).
- **`sess_*` + `kb_*` + `runs` → analysis:** scheduled `analyze` scans for
  patterns, writes `analysis_findings`; `propose` turns findings into
  `proposals`; **`review`/`apply --yes`** is the human gate (existing);
  `measure` records `improvement_outcomes` after a window → feeds the next
  `analyze`. Closed loop.

## 8. The autonomous self-improvement loop (baked into apple-pi)

This is the user's "agentic autonomous improvements written into the logic."
It is the existing autoresearch lifecycle, **deepened**:

1. **`analyze` (autonomous, scheduled + self-triggerable).** Over `sess_*` +
   `runs` + `kb_*`: detect recurring tool errors, token/cost spikes &
   drift, under/over-used tools, stalled cards, skills that never fire,
   prompt/model correlations with bad outcomes. Emit `analysis_findings`.
   Runs on a launchd schedule AND the agent may invoke it mid-session.
2. **`propose` (autonomous).** Findings → concrete, machine-checkable
   proposals (a config value change, a new skill stub, a prompt edit, a dep
   fix). Each proposal cites its `source_finding_ids` + expected metric delta.
3. **`review` (human gate).** `apple-pi review` shows proposals read-only.
   **Nothing applies without explicit `apple-pi apply --yes`.** (D9 — matches
   the workspace's no-silent-mutation rule and the autonomy rule's "reckless
   options excluded.")
4. **`apply` (gated).** Applies approved proposals; writes `audit`; records
   the "before" metric snapshot.
5. **`measure` (autonomous, scheduled).** After a window, compares before vs
   after, writes `improvement_outcomes` (improved/neutral/regressed). Regressed
   outcomes surface in the next `analyze` → the loop can propose a revert.

The whole loop is **telemetry-driven self-improvement with a human apply
gate.** Fast DB = the loop can analyze 89 sessions × hundreds of events in
well under a second.

## 9. Non-goals (v1)

- No dispatcher / worker fleet / profiles / per-task worktree *subsystem* /
  claim-locks / circuit breakers / goal-mode / heartbeat / multi-tenant. An
  executor, if ever wanted, is a separate module that *reads* this kanban.
- No web UI in v1 (kanban-web becomes an optional reader vs the new DB, post-v1).
- No two-way card↔DB sync, ever.
- No auto-purge of session data.
- No new heavy deps — chokidar (+ gray-matter only as D3 fallback). No Mongo.

## 10. How to execute

1. `ROADMAP.md`, module-by-module M0 → M11. Critical path:
   **M0 → M1 → M2 → M3 → M4 → M5 → M8(kanban) → M9 → M10 → M11.**
   M6/M7 are parallel-safe side-quests once M2 is up.
2. One task = one commit = one card. Each task has a `REQ-<id>` and a
   runnable **Verify:** hook; "done" = hook passes (verify-own-work).
3. **The headline reliability test is M10-2:** rebuild `kb_*` and prove
   `sess_*`/`analysis_*` are byte-identical before/after. Build that test
   early; it is the contract that lets Tier A be disposable.
4. Dogfood: the first card you create is M0-1 written as a real `.card.md`.
5. Red/blue every task touching file paths outside a project, the truth-mutation
   path (`write.js`), or ingest (the durable tier's write path).

## 11. References (research trail; sanitized)
- agentic-os `ADR-0004-sqlite-index-markdown-source-of-truth.md` — disposable
  SQLite index over a markdown vault (closest analog to Tier A).
- MarkdownDB (flowershow) — MD → SQLite, FTS, links.
- KiwiFS — "files-as-truth" for agents and teams.
- chokidar (paulmillr) — fsevents file watching + debounce.
- Atlassian / Multiboard / teachingagile — WIP limits, column taxonomy.
- SQLite vs MongoDB (Airbyte, sqldocs, SoloDevStack, Five) — embedded/local-first/solo → SQLite.
- In-repo: `bin/apple-pi` + `lifecycle/` (module template + the existing
  autoresearch loop to extend); `lifecycle/schema.sql` (`runs`/`proposals`);
  `config/extensions/kanban-bridge.ts` (the bridge to deprecate);
  the workspace `AGENTS.md` § ".kanban/ convention" (the card format we codify).
