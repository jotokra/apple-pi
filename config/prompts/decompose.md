---
name: decompose
description: "Decompose a goal into independent tasks with REQ-N-M verification hooks. Use this template when the user asks for a plan, a breakdown, or a decomposition."
---

# /prompt:decompose

Decompose the following goal into a parent spec + N independent
child tasks.

For each task:

1. **Deps**: which other tasks must complete first (or "none").
2. **Parallel-safe**: yes / no.
3. **Files**: absolute paths this task will touch.
4. **REQ-N-M**: numerized atomic requirements. Stable across edits.
5. **Verification**: exact commands that prove each REQ passes.
6. **Commit**: `<type>(<scope>): <subject>` line, ready to copy.

## Rules

- One task = one commit.
- Tasks are parallelizable unless a hard dep exists.
- No silent renumbering of REQ-N-M.
- Parent spec is frozen once work begins; new requirements get
  new REQ-N-M numbers, existing ones don't move.
- Verification is named in the card, not invented after the fact.

## Output shape

```
## Parent spec: <path>
(identity, vision, scope, frozen decisions, risks)

## Tasks

### REQ-1 — <name>
- **Deps**: none
- **Parallel-safe**: yes
- **Files**: <repo>/foo.go
- **REQ-1-1**: <atomic req>
- **REQ-1-2**: <atomic req>
- **Verify**: `go test ./internal/foo/...`
- **Commit**: `feat(foo): add bar`

### REQ-2 — <name>
- **Deps**: REQ-1
- **Parallel-safe**: no
- ...
```

## Goal

$ARGUMENTS
