---
name: session-record
description: "Save the current session as a distilled, durable record in your vault (docs OUT), and load relevant prior records when resuming or starting related work (docs IN). Raw session JSONL is the verbatim truth but rots — unreadable, unsynced, unsearchable. The vault record is the human/agent-readable distillation that is greppable by future sessions. Trigger phrases: save this session, session to vault, write a session summary, handoff, resume work on X, what did we do last time, continue from yesterday."
---

# session-record

Sessions are the connective tissue between days and between agents. The
raw session logs are the **verbatim truth** — tree-structured, every tool
call captured — but they **rot** for handoff purposes: huge, unstructured,
not synced off the machine, not searchable by topic. This skill is the
two-way bridge to a vault / second-brain / notes store:

- **docs OUT** — distill a finished session (or a meaningful phase of
  one) into one readable markdown record the vault can sync and a future
  session can grep.
- **docs IN** — when resuming or starting related work, find and load the
  relevant prior records instead of re-deriving context from scratch.

## Vault path

This skill writes to a vault directory you configure
(`APPLEPI_VAULT_SESSIONS`, defaulting to `$HOME/vault/Sessions/YYYY-MM/`
— set it to your real vault's sessions directory, e.g. an Obsidian
vault). The **obsidian workflow offer** in onboarding wires this up for
you.

## The principle

**The vault record is the executive distillation; the raw JSONL is the
verbatim truth; the in-tree repo is the detailed record. Three layers, no
duplication.** A vault record that copy-pastes a repo's design doc is a
bug (stale the moment the repo changes) — point to it instead. A vault
record that re-dumps the raw JSONL is a bug (defeats the point of
distilling) — link the `session_id` and pull raw only when verbatim is
needed.

## docs OUT — saving a session

### When to save

- At the **end of a session** that produced durable work (commits,
  configs, decisions, an experiment).
- At a **phase boundary** in a long multi-day session — record the phase,
  not the whole tree.
- **Before a pause** where the next agent (or tomorrow-you) will resume.
- **Not** for throwaway / exploratory turns that led nowhere.

One record per **logical unit of work** (a completed task or phase), not
per raw JSONL file. A branching session may yield several records; a
short one yields none.

### Where + what name

- Dir: `$APPLEPI_VAULT_SESSIONS/YYYY-MM/` (month bucket).
- File: `YYYY-MM-DD_<slug>.md` (kebab-case slug; agent is a frontmatter
  field, not in the filename). Match existing siblings' convention
  exactly.

### Frontmatter (greppable — this is what makes docs IN work)

```yaml
---
date: 2026-06-27
agent: apple-pi              # apple-pi | <other> | human
model: <model id + provider + thinking level>
session_id: <uuid>           # the JSONL uuid (raw pointer); omit if none
host: <hostname>
tags: [session, <topic>, ...]  # topic tags for search (include "session")
status: active               # active | done | blocked
repos: [<owner>/<repo>, ...] # repos touched
next: <one-line handoff hook>  # the single thing the next session must do
---
```

`tags` + `next` are the two fields docs IN actually searches — fill them
deliberately.

### Body sections (genre; adapt to the session)

```markdown
# YYYY-MM-DD — <slug>

## Goal
(one line: what the user asked for)

## What happened
(narrative arc, high-level — 3–8 sentences or bullets, not a log dump)

## Key decisions
- **decision** — rationale (cite the file/commit that encodes it)

## Commits
- `<hash>` (repo) — one-line subject

## Artifacts
- repos / files / docs created or changed (with paths)

## What's next / blocked
- the handoff: what the next session does, what's gated on the user

## See also
- links: related vault notes, repo docs, gists, the raw session

## Raw
- `~/.pi/sessions/<ts>_<uuid>.jsonl` — verbatim (pull only if needed)
```

Omit empty sections. Keep it **readable end-to-end in ~2 minutes** —
that's the bar; if it's longer, you're re-dumping detail that belongs
in-tree.

### Don't

- Don't copy a repo's design doc / decisions file into the record — link
  it.
- Don't re-narrate every tool call — that's the raw JSONL's job.
- Don't save a session that produced nothing durable.
- Don't fork the structure — match the existing month-bucket convention.

## docs IN — loading prior records

### When to load

- **Resuming** ("continue work on X", "where did we leave off") — find
  the most recent record touching X.
- **Starting related work** that probably has prior context.
- **Avoiding re-derivation** — before re-researching something, check if
  a prior session already established it.

### How to find

```bash
# by topic tag (frontmatter)
grep -rl "tags:.*<topic>" "$APPLEPI_VAULT_SESSIONS/"
# by free text in the body
grep -rl "<term>" "$APPLEPI_VAULT_SESSIONS/"
# most recent N records
ls -t "$APPLEPI_VAULT_SESSIONS/"*/*.md | head
```

### What to read

1. The frontmatter (`next`, `tags`, `repos`) — 10 seconds, tells you if
   it's relevant + what's pending.
2. The `## What's next / blocked` section — the explicit handoff hook.
3. `## Commits` + `## Artifacts` — where the work lives now.
4. Pull the raw JSONL (`session_id` pointer) **only** if you need
   verbatim detail (exact tool output, a specific error) — not by
   default.

Then **confirm against ground truth before acting** on a stale record: a
record from last week may cite a path/commit that's since moved. The
record is a map, not the territory — same "verify before trust" as
`self-assess`.

## Maintenance

- A record is **append-friendly**: if the same logical work continues in
  a later session, update the existing record (add a "## Continued" note
  + new commits) rather than forking a second one — unless it's a
  genuinely new phase, then a new record with a `see also` back-link.
- If a record's `next` was resolved, set `status: done` and strike the
  next line. Stale `next` hooks are the main decay mode — prune them.
- Periodically (e.g. month-end) skim the month bucket; merge/split
  records that grew incoherent.

## See also

- `long-horizon-compaction` — the in-session tree/branch/compact
  discipline (this skill is the *cross-session* analogue).
- `self-assess` — the recurring ritual; its decisions doc is a model
  record.
