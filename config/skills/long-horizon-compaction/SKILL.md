---
name: long-horizon-compaction
description: "For multi-day or multi-hour work, use Pi's tree-structured sessions with deliberate branching, checkpointing, and compaction. This is the long-horizon planning persona's core feature. Trigger phrases: continue working on X, resuming, where did we leave off, this is a multi-day task."
---

# long-horizon-compaction

Pi's sessions are tree-structured JSONL. Every message,
tool call, and result is a node in the tree. You can branch
at any point, navigate to any ancestor, and share the whole
tree as HTML or a GitHub gist.

This skill is the discipline for *using* that surface well.

## The tree model

```
root
├─ user: "build feature X"
│   ├─ assistant: "starting..."
│   │   ├─ tool: bash `make build`
│   │   ├─ tool: bash `./bin --version`
│   │   └─ assistant: "built"
│   ├─ assistant: "configuring..."
│   │   ├─ tool: write config.json
│   │   └─ assistant: "configured"
│   └─ branch from "starting..." ─── (a fork point)
│       ├─ user: "actually, try a different approach"
│       └─ assistant: "switched"
```

Each node has a stable ID. Tree navigation is by ID. Branches
are first-class.

## When to branch

Branch at decision points, not at every message. A branch
captures a *what-if*:

- "What if we used a different model?"
- "What if the security review changes the approach?"
- "What if the user wants a smaller scope?"

The branch keeps the alternative alive. If you never come back
to the branch, no harm done; the main line continues.

Don't branch for:

- Trivial follow-ups ("now write the README"). Continue
  in-line.
- Tool-call retries. Just retry; don't branch a transient
  failure.
- Confirmed dead ends. Mark them as labeled entries
  (`/label dead-end-1`) and continue forward; don't branch.

## When to checkpoint

Checkpoint = create a named session via `/label <name>` or
`/name <session>`. Use them for:

- Phase boundaries (e.g. "p1-complete").
- Decision points where you'll want to come back.
- Work-pause moments ("end of day 1, resume tomorrow").

Resume later with:

- `pi -c` — continue the most recent session in the current
  directory.
- `pi -r` — interactive session picker.
- `pi --session <path|id>` — explicit session.

## When to compact

Pi auto-compacts near the context limit. You can also force:

- `/compact` — explicit compaction, optional custom prompt.
- The `compaction.enabled` + `compaction.reserveTokens` /
  `compaction.keepRecentTokens` settings in
  `~/.pi/agent/settings.json` (tuned to your model during
  onboarding).

For a large-context model the bar to compact is high. When to
consider:

- Sessions that have run >1 hour with many tool results.
- Sessions where you're asking the model to recall a
  far-back message.
- Sessions where you're about to `/tree` for context.

Don't compact if:

- The session is short (<30 turns).
- You just need to recall a specific message — use `/tree` or
  read the session file directly.

## Sharing a session

```bash
# Inside Pi, after a meaningful checkpoint:
/share
# → uploads to a GitHub gist, returns a URL.
```

The shared session is a render-only view. The URL is durable;
people can read the tree, see the thinking blocks, follow the
branches.

Use this when:

- Handing work off to the next agent (paste the URL in the
  task).
- Sharing a debugging session with the user.
- Documenting a multi-day decision tree.

## Long-horizon patterns

### Multi-day project

Day 1: spec, decompose, start P1. `/name feature-d1`,
`/label spec-frozen`. `/share` for the user.

Day 2 (next session): `pi -r`, pick `feature-d1`, continue from
the spec. Build P2. `/label p2-done`.

Day 3: `pi -r` → `feature-d1` → continue. The whole tree is one
session; you navigate by branch.

### Decision exploration

User: "build X."

You: branch A — try approach 1. Branch B — try approach 2. Both
alive for an hour. Pick one. Mark the other `dead-end-N` and
move on. The tree shows the user that both were considered.

### Bug investigation

Working session hits a bug. Branch from the failure point: "try
fix A." If that works, continue on the branch; the main line
still shows the original code (good for diffing). If fix A
doesn't work, branch from the same point again: "try fix B."

## Anti-patterns

- Continuing in-line when a branch would have captured the
  alternative cleanly.
- Compacting at the start of a session "to be safe" — wastes
  context budget.
- Sharing a session with thinking blocks still embedded — by
  default they are; if you don't want to share them, toggle
  `hideThinkingBlock` for that session.
- Losing the parent spec because you branched too aggressively —
  the parent should be in a labeled entry, not in a branch.
- Treating the session file as disposable — it's the durable
  record of how the work happened. Don't delete the session dir.

## Session hygiene checklist (before pausing)

- [ ] Session has a `/name`.
- [ ] Phase boundaries are `/label`'d.
- [ ] The parent spec is referenced in a labeled entry (not just
  in the diff).
- [ ] If this session might be shared or resumed, `/share` for
  the user.
- [ ] No uncommitted tool results in the "pending" state (they
  should all be appended to a message).

## See also

- `session-record` — the cross-session analogue: distill a
  finished session into a durable vault record.
- `plan-decompose` — what a multi-day session is usually
  executing.
