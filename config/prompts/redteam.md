---
name: redteam
description: "Find every way this can be broken, exploited, or silently fail. Red/blue review of a change. Run before claiming any auth / secret / network / filesystem-touching change is done."
---

# /prompt:redteam

Run a red/blue review on the following change. Output a finding
list, not a fix.

## Inputs

Describe the change in 1–2 paragraphs. Include:

- What it does (functional).
- What surfaces it touches (auth, secrets, network, filesystem,
  sudo, webhooks).
- What files / endpoints are involved.
- What credential / token / key it uses (if any) and where that
  lives.

## Threat model (output 1 paragraph)

"This change <does X>, protects <Y>, and trusts <Z>."

## Blue team findings

For each: cite the line / config. Rate BLOCKER / WARNING / NIT.

- Least privilege?
- Secrets out of repo?
- Input validation at boundary?
- Output encoding?
- Fail-closed default?
- Audit trail?
- Idempotency?
- Rotation path documented?

## Red team findings

For each: smallest input → worst output. Rate BLOCKER / WARNING
/ NIT.

- Path traversal?
- Command injection?
- SQL injection?
- SSRF?
- Privilege escalation?
- Race / TOCTOU?
- Symlink attack?
- Replay?
- Default-deny on missing config?
- Logging secrets?

## Mitigations

For each BLOCKER + WARNING, the smallest change that closes the
gap. List by commit (if changes are already committed) or as
"to apply."

## Change to review

$ARGUMENTS
