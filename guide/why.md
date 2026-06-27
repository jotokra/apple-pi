# Why apple-pi

Most ways of giving an agent a key leak. `~/.zshrc` sprays it into every
process's environment (`ps e`, crash dumps); `.env` gets `git add`'d by
accident; pasting it into chat lives forever in the session transcript. And
most agent configs are written for **one** model — switch models and you
hand-tune the knobs yourself, or you adopt a cloud agent that's easy to
start but comes with a vendor account, one model family, and telemetry.

apple-pi is the bet that there's a better middle.

## The safe path is the easy path for keys

`/vault` stores a key encrypted, enters it through a masked prompt that
never touches your input line, and leaves **no trace** in sessions,
telemetry, logs, or shell history. You stop pasting keys anywhere else
because you don't need to.

## It tunes itself to *your* model

On install — and any time your stack changes — the `self-assess` ritual
reads your model's **real** capabilities from the pi-ai catalog (context
window, thinking model, vision, cost) and rewrites `settings.json` for it,
from the code path, not from prose. Bring any model; the harness adapts.

## Methodology arrives as skills, not opinions baked into the binary

Spec-first planning, verify-your-own-work, red/blue review, decomposition —
eight reusable skills you can read, run, edit, or remove. The agent is
opinionated about *how* to work; you keep the right to disagree.

## You own it

Zero telemetry, zero vendor lock-in, MIT. Nothing phones home —
`smoke/sanitize.sh` enforces that no personal data ships, on every change.
It's a pi config plus a persona, not a service.

---

If you want raw `pi` with none of the opinions, use `pi` directly. If you
want a one-vendor cloud agent, use one. apple-pi is for the person who wants
the opinionated, privacy-first, self-tuning middle — and wants to own it.

::: tip Next
[Install →](./install) · or browse the [how-to guides](./howto).
:::
