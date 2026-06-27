---
name: spec
description: "Draft a full spec for X without writing code. The spec is a contract for the next agent; it should be readable end-to-end in 5 minutes."
---

# /prompt:spec

Draft a complete spec for the following goal. Do NOT write code.
Output is a single markdown file.

## Sections (in this order)

1. **Identity** — one-line pitch, scope (in / out), owner.
2. **Vision** — why this exists in one paragraph.
3. **Use cases** — 3–5 concrete user stories with one-line acceptance criteria.
4. **Architecture** — the shape. Module boundaries. One diagram if it helps (ASCII).
5. **Stack** — languages, frameworks, infra. Each with a one-sentence *why*.
6. **Phased plan** — Phase 0 (skeleton), Phase 1, Phase 2... Each phase: goal, scope, exit criteria, dependencies.
7. **Frozen decisions** — table of decisions the next agent must NOT relitigate. With rationale + date.
8. **Risks + open questions** — what could go wrong, what we don't know yet.
9. **Conventions** — commit messages, file layout, test runner, naming.
10. **Reading order** — for the next agent. Numbered list of files in the order to read them.
11. **Version history** — list of bumps with one-line summaries.

## Quality bar

- The spec is **readable end-to-end in 5 minutes**.
- Every frozen decision has a rationale and a date.
- The phased plan is small enough that Phase 0 + Phase 1 together
  are a single session's work.
- Risks section names concrete failure modes, not generic
  platitudes.
- The reading order is the actual order, not the chronological
  order.

## Goal

$ARGUMENTS
