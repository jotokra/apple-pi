---
name: verify-own-work
description: "After every concrete change, run the test, run the linter, smoke-check the binary, diff against expected. Closed-loop self-test before claiming a card is done. Trigger phrases: is this done, verify, smoke test, did it work, or any task where you've finished a code/config change."
---

# verify-own-work

The contract: you do not claim a card is done until you have run
the verification. The verification is named in the card; you do
not invent it after the fact.

## The 5-step close

For every non-trivial change:

1. **Tests pass.** Run the project's test runner. Every test, not
   just the one you wrote. If a pre-existing test now fails,
   that's a regression — fix it before claiming done.
2. **Lint passes.** Run the project's linter. If the linter
   complains about pre-existing code, leave it; if it complains
   about yours, fix it.
3. **Builds clean.** Compile the binary / build the bundle. No
   new warnings, no missing imports.
4. **Smoke check.** Run the binary or invoke the change in a way
   that proves it works end-to-end. One sentence in the commit
   body describing the smoke command and its result.
5. **Diff against expected.** Read your own diff with fresh eyes.
   Does it do what the card said? Anything you removed that you
   shouldn't have? Anything left as a TODO that should be done?

## Per-stack recipes (adapt to the project)

| Stack | Tests | Lint | Build | Smoke |
|-------|-------|------|-------|-------|
| Go | `go test -race ./...` | `go vet ./...` | `go build ./...` | run the binary |
| Python | `pytest` (in the project venv) | `ruff` / `flake8` | n/a | invoke the script |
| Node/TS | `npm test` | `npm run lint` / `tsc --noEmit` | `npm run build` | run the CLI |
| Rust | `cargo test` | `clippy` | `cargo build` | run the binary |
| JSON/config | (no suite — data) | `jq` / schema check | n/a | exercise the config |
| Shell scripts | n/a | `bash -n` / `shellcheck` | n/a | run in a scratch dir |
| Docs | `markdownlint` if configured | n/a | n/a | open the file, read it |

If the project declares its own recipe in `AGENTS.md`, that wins.

## Bug triage discipline

When a verification step fails:

1. **Read the actual error.** Don't paraphrase. Don't assume.
2. **Reproduce once.** Make sure it's not a stale state / race /
   leftover from a previous run.
3. **Hypothesize the cause.** One sentence: "I think X is happening
   because Y." If you can't, re-read the doc / contract.
4. **Fix the smallest thing that addresses the cause.** Don't
   rewrite the file. Don't bundle unrelated changes.
5. **Re-run the full close.** Not just the failing step — the
   whole 5-step close, because the fix may have shifted another
   step.
6. **Write the bug report in the commit body.** What failed,
   what the cause was, what the fix was. Future agents (and
   future you) will read this.

## Anti-patterns

- "It probably works" — not verified, not done.
- Skipping the linter because the test passed — linter catches
  different bugs.
- "I didn't run the smoke because the binary doesn't exist yet" —
  build the binary first, then smoke.
- Claiming done with `git status` showing uncommitted changes —
  if it's not committed, it's not done.
- A long debug session where the original bug fix got buried in
  unrelated edits — `git add` selectively, not `-A`, and the
  commit body should explain what's actually in this commit.

## When the user's standing rule applies

If the user's contract says "no review before commit; commit when
tests pass," that rule applies **after** this skill's close. It
does NOT replace the close. The close is the contract; the user's
standing rule is the *hand-off*.

So the loop is: close (5 steps, all green) → commit (no review
pause) → report (one-line per commit).
