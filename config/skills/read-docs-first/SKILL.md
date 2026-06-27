---
name: read-docs-first
description: "Before touching any repo, read its top-level AGENTS.md, the README, and the relevant docs. Top-level AGENTS.md + nearest per-file <name>.md sibling. Trigger phrases: in repo X, fix this in <project>, or any task that names a repo."
---

# read-docs-first

The single biggest cause of bad work is touching a repo without
reading its contract first. This skill is the pre-flight read.

## Pre-flight: 4 file types, in order

For any repo:

1. **`<repo>/AGENTS.md`** (or `CLAUDE.md`) — the project contract.
   Read this first.
2. **`<repo>/README.md`** — operator-facing orientation. Quick read.
3. **`<repo>/.docs/`** (or `docs/`) — design + history. Read the
   index file first, then the relevant section.
4. **Per-file `<name>.md` siblings** — for any file you intend to
   edit, check if a `<file>.md` exists next to it. If yes, read it
   before editing. (This is the DOX framework rule: per-file docs
   over folder-only docs.)

For the workspace as a whole, walk the parent `AGENTS.md` chain
from the cwd up to the home directory. Each level adds scope;
the nearest doc controls local work details, but no child doc may
weaken a parent's invariants.

## Why per-file docs

The user (or a prior agent) writes a `<name>.md` next to a complex
file precisely because the side effects and contracts live there,
not in a folder overview. Skipping it means missing the one place
a constraint is documented.

## Repo-specific reading orders

Many repos encode a reading order in their top-level `AGENTS.md`.
If one is present, follow it exactly — it names the frozen spec,
the design history, and the roadmap-projection layer in the
intended sequence. Don't invent your own order.

If a repo ships a roadmap / kanban layer (`.kanban/`, `.plan/`, or
similar), the contract is usually: read `AGENTS.md`, then the
roadmap index, then the specific card for your task, then design
notes if relevant. Do not bypass that layer for substantive work.

## Anti-patterns

- Skipping `AGENTS.md` because "I already know this repo."
- Reading only the README, missing the contract in AGENTS.md.
- Skipping per-file `<name>.md` siblings — they're often the only
  place a side effect is documented.
- Re-reading docs you already loaded this session — wasteful; the
  session's context already has them.
- Touching a file whose per-file doc you haven't read yet.

## Self-test

Before you write or edit code, answer these out loud:

1. Which `AGENTS.md` did I just read?
2. What's the project's preferred commit message format?
3. What's the test runner? Where does it live?
4. What's the closest per-file `<name>.md` for my target file?
5. Are there any frozen decisions that constrain my change?

If you can't answer 3, you skipped a read. Go back.

## See also

- `verify-own-work` — the close-loop after the read.
- `red-blue` — when the change touches auth / secrets / paths.
