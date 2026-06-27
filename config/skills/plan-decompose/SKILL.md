---
name: plan-decompose
description: "When asked to plan a non-trivial goal, decompose it into a parent spec + N independent sibling tasks with REQ-N-M verification hooks and an explicit commit message per task. Use this skill before writing code on a multi-card or multi-day project. Trigger phrases: plan X, design X, how should we build X, decompose, break this down."
---

# plan-decompose

Take a goal. Turn it into a plan. The plan has exactly two layers:

1. **Parent spec** — the *why* and the *what*. A single file
   (`<repo>/.docs/decisions/plan-NN-<slug>.md` for repo work, or a
   plans directory you designate for cross-repo work). It has:
   identity, vision, use cases, architecture, stack, phased plan,
   frozen decisions, risks, conventions, reading order, version
   history.

2. **Child cards** — the *how*. One card per independent task.
   Each card has: file paths, deps, parallel-safe flag, REQ-N-M
   numerized requirements, the test that proves each REQ, the
   commit message. Cards reference the parent spec; the parent
   spec does not re-summarize cards.

## Output shape

For each decomposition, produce:

### Parent spec (one file)

```markdown
# <Project / Goal>

## Identity
- one-line pitch
- scope (in / out)
- owner

## Vision
Why this exists in one paragraph.

## Use cases
3–5 concrete user stories.

## Architecture
The shape. Diagram if it helps. Module boundaries.

## Stack
Languages, frameworks, infra, with the *why*.

## Phased plan
Phase 0 (skeleton), Phase 1 (...), Phase N (...).
Each phase has: goal, scope, exit criteria, dependencies.

## Frozen decisions
| Decision | Rationale | Date |
Decisions the next agent must NOT relitigate.

## Risks + open questions
What could go wrong. What we don't know yet.

## Conventions
- commit messages
- file layout
- test runner

## Reading order (for future agents)
1. this file
2. ...

## Version history
- v0.1.0 — initial spec
```

### Child cards (one per task)

```markdown
# <REQ-ID> — <one-line task>

**Parent**: <spec file path>
**Deps**: <other REQ-IDs, or "none">
**Parallel-safe**: yes / no
**Files**: <absolute paths>
**Commit**: `<type>(<scope>): <subject>`

## Requirement
What must be true when this card is done. One sentence.

## REQ-N-M sub-requirements
1. REQ-N-M.1 — <atomic requirement>
2. REQ-N-M.2 — <atomic requirement>

## Verification
- [ ] `pytest tests/test_X.py::test_REQ_N_M_1` — passes
- [ ] `pytest tests/test_X.py::test_REQ_N_M_2` — passes
- [ ] `<smoke command>` — produces expected output

## Out of scope
What this card explicitly does NOT do.
```

## Decomposition rules

1. **Independence first.** Cards should be parallelizable unless a
   hard dep exists. If a dep exists, call it out in the
   `Deps:` line and tag the dependent card's spec.
2. **One card = one commit.** Don't bundle. If a card needs two
   commits, split it.
3. **Smallest verifiable unit.** Each card ends in a green test
   or a documented manual verification.
4. **REQ numbers are stable.** REQ-1-1, REQ-1-2, REQ-2-1, ...
   Don't renumber. New requirements get a new REQ-N-M; existing
   ones don't move.
5. **No silent renames.** If a card's scope changes mid-flight,
   bump its REQ to REQ-N-M+1 and write a "what changed" note.
6. **The parent spec is frozen.** Once work begins, edit the
   parent spec only via a "version bump" with a working-state
   note. Children track drift; the parent does not.

## Anti-patterns

- "Phase 0: do everything" — too big.
- "Phase 1: write tests" without a Phase 0 that has anything to
  test.
- A 50-card fanout with no deps called out — that's a wish list,
  not a plan.
- Cards that touch 6 files in 4 repos — too broad, decompose more.
- Tests written *after* code (not in this skill, but a plan that
  doesn't list verification per card invites this).

## See also

- `read-docs-first` — read the repo's contract before decomposing.
- `verify-own-work` — the close-loop each card ends in.
