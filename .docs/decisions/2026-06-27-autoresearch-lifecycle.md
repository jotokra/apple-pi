# 2026-06-27 — autoresearch lifecycle (daily metrics + weekly self-improvement)

**Goal.** An internal self-improvement loop: collect behavioral metrics
once a day, keep them for the next run in a local DB, and once a week
produce a brief of proposed improvements to the Pi framework for the user
to review BEFORE any self-update is applied.

**Why.** The `self-assess` skill is a manual ritual. Autoresearch is its
*data-driven, automated* counterpart: instead of the agent introspecting
prose, it introspects actual session telemetry (the same data the original
autoresearch experiment used to find "71% bash / 9% read"). Run it on a
schedule so the config keeps drifting toward the model's real usage without
a human remembering to re-tune.

**Scope.** apple-pi repo only. One design doc (this file), one commit per
card. Cross-platform (launchd on macOS, cron elsewhere; Node for parsing).

---

## Architecture

```
~/.pi/sessions/*.jsonl  ──►  lifecycle/collect-metrics.js  ──►  ~/.pi/agent/autoresearch.db
                                  (DAILY, local, no LLM)              │
                                                                      │ (each daily run = 1 row)
                                                                      ▼
                            lifecycle/aggregate-week.js  ◄────────── runs table (last 7 days)
                                  (WEEKLY, local, no LLM)
                                      │
                                      ├──► ~/.pi/agent/proposals/<date>.md   (the BRIEF)
                                      └──► proposals table (status: proposed)
                                                                      │
                                                                      ▼
   user runs:  apple-pi review   ──►  reads the brief
               apple-pi apply    ──►  lifecycle/apply-update.js
                                        (REVIEW GATE — nothing applies until the user says yes)
                                        applies the proposal's changes to settings.json,
                                        marks proposal 'applied', writes audit row.
```

**LLM posture.** Both scheduled jobs are **pure-local, zero-quota**
(deterministic aggregation from session telemetry). The interpretive LLM
work stays in the interactive `self-assess` skill the user runs by choice.
This honours sovereignty: no unattended LLM calls. (A future `--with-research`
flag could enrich the weekly brief via the agent; deliberately deferred.)

---

## The DB schema (`~/.pi/agent/autoresearch.db`, SQLite via `node:sqlite`)

```
runs(row_date UNIQUE, collected_at, session_count, total_turns,
     tokens_in, tokens_out, cache_read, cache_write, cost,
     compaction_count, error_count, tool_calls_json, models_json)

proposals(id, created_at, week_start, week_end, brief_path,
          summary, changes_json, status, applied_at, audit)
  status ∈ {proposed, approved, applied, rejected, superseded}
```

- `runs` is **idempotent per day** (`UNIQUE(run_date)` → re-running today
  overwrites today's row, so a flaky cron self-heals).
- `tool_calls_json` = `{"bash":140,"read":41,"edit":45,"write":54,...}` —
  drives the tool-discipline metric (bash% vs read%).
- `changes_json` = the concrete settings the weekly brief proposes to change:
  `[{"setting":"compaction.keepRecentTokens","from":64000,"to":128000,"rationale":"..."}]`.
  `apply` writes exactly these.

## Cards (one commit each)

| Card | Files | Deps |
|---|---|---|
| A — metrics engine | `lifecycle/schema.sql`, `lifecycle/lib/db.js`, `lifecycle/collect-metrics.js` | — |
| B — weekly aggregator + brief | `lifecycle/aggregate-week.js`, `lifecycle/lib/brief.js` | A |
| C — apply (review gate) | `lifecycle/apply-update.js` | A, B |
| D — CLI shim + scheduler | `bin/apple-pi`, `lifecycle/schedule.sh` | A, B, C |
| E — curl\|bash bootstrap | `install.sh` (re-exec detection) | — |
| F — landing page | `docs/index.html` (+ Pages config) | — |
| G — GitHub private repo + push + Pages | (needs fresh creds; gated) | E, F |

Order: A → B → C → D → E, F (parallel) → G (gated on creds).

## Verification

- **V-A** `node --no-warnings lifecycle/collect-metrics.js --dry` parses the
  real `~/.pi/sessions/` and prints a metrics summary without writing the DB.
- **V-B** after a forced `collect`, `aggregate-week` produces a brief whose
  tool-call ratios match a hand-computed count from the same sessions.
- **V-C** `apply --dry --latest` prints the diff it WOULD make, writes nothing.
- **V-D** `apple-pi schedule status` shows the installed jobs; `install`/`remove`
  are idempotent.
- **V-E** `curl -fsSL …/install.sh | bash` in a temp HOME clones + re-execs
  without touching the real `~/.pi`.
- **V-F** `docs/index.html` is valid HTML + the install one-liner is copy-pasteable.

## Decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| L1 | SQLite via `node:sqlite` for the metrics store | Already the kanban-bridge's dep (Node 22); queryable for weekly aggregation; JSONL would need re-parsing every week. |
| L2 | Daily collect is local + LLM-free | Reliability + zero quota burn. The interpretive work stays in the interactive `self-assess` skill. |
| L3 | Nothing applies without explicit `apple-pi apply` | User's explicit requirement: review the brief BEFORE the self-update applies. The weekly job only *proposes*. |
| L4 | `runs` is `UNIQUE(run_date)` | A flaky daily cron self-heals on re-run (today overwrites today); no duplicate rows. |
| L5 | launchd on macOS, cron elsewhere | launchd is the native macOS scheduler; cron is the portable fallback (and works on Linux). systemd timer is a documented future option. |
| L6 | The agent is NOT required for the loop | All four scheduled-path scripts are plain Node. The agent is only the interactive `apply`/`self-assess` companion. This means the loop runs even if the model is unreachable. |

## Out of scope (deferred)

- LLM-enriched weekly brief (`--with-research`) — needs an unattended model
  call; deferred per L2.
- Surfacing "pending proposal" on Pi session start (a tiny extension) —
  nice-to-have; the `apple-pi review` CLI + the weekly marker file cover v1.
- Cross-machine metrics aggregation — single-host for now.
