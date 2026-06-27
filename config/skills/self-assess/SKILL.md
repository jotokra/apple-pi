---
name: self-assess
description: "Run a structured self-assessment of your own config against your model's REAL capabilities — verified from ground truth, not from how docs describe them. Keep an audit trail; expect to invalidate some of your own hypotheses. This is a recurring ritual: re-run whenever your model, context, tooling, or hardware changes (capabilities drift over time, so the optimum drifts). Trigger phrases: self-assess, optimize your config, improve yourself, review your config against your model, self-improvement."
---

# self-assess

The contract: your config was written once, by someone (maybe past-you),
maybe for a different model. Capabilities drift. Prose claims go stale.
Dead config accumulates — knobs that "tune" a lever the model doesn't
even expose. This skill is the **recurring ritual** that keeps your
config honest: aligned with what your model actually *does*, verified
from ground truth, not from how the docs *describe* it.

This is the ritual apple-pi runs during onboarding (Phase 3) to tune
itself to the model you chose.

## Why this is a ritual, not a one-off

You grow the stack over time — new providers, bigger context, more
hardware, more tools. Every upgrade shifts the optimum. A config that was
correct at install becomes cargo-cult six months later. Run this **on
every capability change** and **periodically** even without one. The
discipline compounds; the audit trail prevents re-checking the same
ground.

## The principle

**Align config with the model's real capabilities, read from the
authoritative source — not from how prose describes them.**

For any model running under Pi, the ground truth lives in:

- the model catalog: the pi-ai provider catalog, queryable via
  `pi --list-models <provider>` and readable in
  `node_modules/@earendil-works/pi-ai/dist/providers/<provider>.models.js`.
- the request-shaping adapter: `pi-ai/dist/api/<api>.js` (e.g.
  `openai-completions.js`, `anthropic-messages.js`) — this is where you
  learn whether the model is **effort-based** or **token-budget-based**
  for thinking, and which settings are actually sent on the wire.
- Pi's own resolver + settings-manager:
  `dist/core/model-resolver.js`, `dist/core/settings-manager.js`.

Prose in `AGENTS.md` / `README` is a **claim**. The catalog + adapter are
the **facts**. When they disagree, the prose loses.

The single most important fact to establish: **how does this model's
thinking actually scale?** Some models take an *effort string*
(`low`/`medium`/`high`/`max`) — meaning several of Pi's thinking levels
collapse to identical states. Others take a *token budget* — meaning
every level is distinct. Tuning knobs that belong to the wrong mechanism
is the most common dead config.

## The 3-iteration loop

**Iteration 1 — Discovery.** Map every config surface (settings.json,
AGENTS.md, skills, prompts, extensions, trust, auth) to a model
capability. Separate "what the config claims" from "what the model does."
**Baseline what's already correct** so you don't "fix" a working thing.

**Iteration 2 — Red/blue.** For each config element: is this read on the
code path my model uses? Does it describe a granularity the model
actually has? Is every named resource real AND keyed/runnable? Find every
way the config can mislead the next agent (including future-you). Rate
findings (BLOCKER / MEDIUM / NIT).

**Iteration 3 — Apply + reevaluate.** Smallest change per finding. Then
**reevaluate**: did applying it expose new drift? A cheaper form? Keep
going until you hit genuine diminishing returns or a user-gated decision
— then stop and report. Don't pad iterations to hit a number.

## The non-negotiable: verify, don't assume

**Before changing anything you suspect is broken, prove it's broken.**
The cost of "fixing" a working thing is higher than leaving a real bug
for the next pass. Concretely:

- Suspect a command doesn't exist? **Run it** and read the bytes. A
  top-level `--help` synopsis that omits a flag ≠ the flag doesn't exist
  — check the args module, and invoke the **flag** form (`pi --foo`),
  not the positional form (`pi foo`, which may silently become a prompt).
- Suspect a path/key/entry is stale? **Stat it / diff it** against the
  real tree, don't trust the index that references it.
- Suspect symlinks are missing? **`find -type l`**, don't trust a first
  `ls` that may have looked *inside* a directory-level link.
- Suspect a config key is dead? **Grep the consuming code path** for the
  key; confirm it's read on the model's api, not just on *some* api.

**Expect to invalidate some of your own hypotheses**, and treat that as
the skill working, not failing. A self-assessment with zero invalidated
hypotheses probably didn't verify hard enough.

## Audit-trail conventions

- **Number findings** `F1`, `F2`, … Stable across edits; grep-able.
- **Keep invalidated hypotheses on record** (with the reason), not
  deleted. The next runner needs to see what was *checked*, not re-check
  it. Name them: "F4 — invalidated: …".
- **Flag unverifiable claims, don't delete them.** If a prose assertion
  can't be confirmed from local sources, surfacing it for the user is
  honest; silently deleting it is its own unverified assumption. Number
  them `NF1`, `NF2`, … ("needs-user-find").
- **One card = one commit.** Don't bundle an unrelated pre-existing
  change into your commit — `git add` selectively, not `-A`.
- **Document the *why*, the revert path, and what was deliberately NOT
  changed**, in a decisions doc. The "not changed" list is the
  deliverable, not just the diff. apple-pi writes these to
  `~/.pi/agent/self-assessment-<date>.md`.

## Smoke / tripwires

If the install has a smoke suite with count-based tripwires (e.g. a smoke
that asserts `count -eq N` skills/extensions), **adding or removing a
skill/extension means updating the count in lockstep** — otherwise your
own improvement breaks your own smoke. The strict `-eq` is a deliberate
tripwire: any add/remove forces a conscious update, so nothing slides in
unnoticed. Run the smoke after every change.

## When to stop

Stop when the remaining items are:

- **user-gated** (a prose claim only the user can rule on), or
- **out of scope** (another repo's file — don't expand the blast
  radius), or
- **speculative** (would need a new extension and there's no pressure
  yet).

Report those explicitly. A converged self-assessment **names what it did
NOT touch and why.**

## See also

- `verify-own-work` — the close-loop discipline this skill inherits.
- `read-docs-first` — read ground truth before touching anything.
- `red-blue` — the critical lens for iteration 2.
