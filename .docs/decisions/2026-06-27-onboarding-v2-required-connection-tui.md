# D7 — Onboarding v2: required connection, sleek TUI, guided key acquisition

> Date: 2026-06-27. Supersedes the v1.0.0 OAuth/blank-key path. Amends
> REQ-1-4, REQ-1-5, REQ-1-6 in `.docs/PLAN.md`. Scope: `install.sh`,
> `lib/_common.sh`, `lib/providers/` (new), `lib/provider-guide.sh` (new).

## Why

v1 onboarding "completed" without a working provider connection: a blank
API key was silently taken as confirmed (the "OAuth/subscription path"),
and worse, **two latent bugs** meant even a real key never authenticated:

- **BUG A (critical)** — `auth.json` was written as
  `{provider:{apiKey}}`, but pi's loader (`auth-storage.js`, checks
  `cred?.type === "api_key"` then `cred.key`) requires
  `{provider:{type:"api_key",key}}`. Verified: WRONG shape → pi reports
  the key MISSING; RIGHT shape → FOUND. So every key-based onboarding
  silently failed auth. Never caught because the smoke test uses
  `--skip-confirm` (no live call).
- **BUG B** — `BASE_URL` was captured into the vault but **never written
  anywhere pi reads**. Custom-gateway users (e.g. an Anthropic-compatible
  proxy) got a dead config.
- **BUG C** — base URL wasn't normalized (`api.minimax.io/anthropic`
  entered as-is, no scheme).

## What changes (the v2 contract)

### The connection gate (amends REQ-1-5)
Onboarding does **not** finish until a live model call succeeds. The
"blank key = confirmed" path is removed. Flow:

1. Capture model + provider + key + base URL (see guidance below).
2. Normalize base URL (prepend `https://` if no scheme; strip trailing `/`).
3. If a base URL was given, write `~/.pi/agent/models.json` with a
   provider override `{providers:{<provider>:{baseUrl:...}}}` (BUG B fix;
   pi reads base URLs here, per `docs/models.md`). For a fully custom
   provider the agent resolves it in P3.
4. Seed `auth.json` in the **correct shape**
   `{provider:{type:"api_key",key}}` (BUG A fix).
5. Make ONE live confirm call (`pi --no-tools --no-session -p "Reply with
   exactly: OK"`). Must reply `OK`. On failure: show the provider-specific
   error, route to the **Guide** for that provider's common mistakes, then
   re-capture + retry. Loop until OK or the user aborts.
6. Only on OK: purge the vault (REQ-1-6) and hand off.

`--skip-confirm` is retained but demoted to a **clearly-marked test-only
escape hatch** (its help text says so; the wizard warns when used). It is
no longer the OAuth path — OAuth/subscription providers are handled by an
explicit "I'll authorise after onboarding" branch that still requires the
user to complete `pi /login` before the wizard declares success (the
wizard runs `/login`'s equivalent check, not a blank-key shortcut).

### Sleek TUI (`lib/_common.sh`)
Enhanced rendering, zero new runtime deps (pure bash + ANSI, portable to
the `curl|bash` path that just got fixed):
- consistent color palette + dim/bold helpers, rounded box panels,
- a **progress stepper** `◆ phase 2 of 5 — connect provider` shown at each
  gate,
- a **spinner** (`with_spinner <msg> -- <cmd>`) for the confirm call,
- an **arrow-key selector** `select_option` (number-key fallback when
  stdin isn't a tty, so the piped smoke test still drives it),
- masked key echo (`sk-…AB12`) wherever a value is shown back.

### Guided key acquisition ("ask the agent") — `lib/providers/` + `lib/provider-guide.sh`
A curated, **offline** provider knowledge base (no key needed to get a
key — solves the chicken-and-egg). One markdown file per provider under
`lib/providers/<slug>.md`: how to get a key (steps), the dashboard URL,
the env var / `auth.json` key, default base URL if non-standard, free
tier + cost notes, common errors. The Guide is an interactive menu +
mini Q&A: pick a provider → see steps → drill into "free tier / cost /
where do I paste it / common errors" by keyword. Invoked from the creds
step ("Need help getting a key?") and from the confirm-failure loop.

A **live** LLM assistant is intentionally NOT wired pre-key (can't be —
no key yet). Post-connection, the handoff agent itself is the live
assistant (P2–P5 already run on the confirmed model).

## Verification (REQ-V additions)
- **V-5** `lib/provider-guide.sh` lists ≥8 providers and renders one
  without error.
- **V-6** `smoke/onboard-sandbox.sh` asserts the NEW `auth.json` shape
  (`type:"api_key"`,`key`) and that a base URL produces a `models.json`.
- **V-7** `smoke/structure.sh` runs `node --check` on any new `.js` and
  `bash -n` on new shell; the comma-bug class is caught by parsing the
  bundled `.ts` if `tsc`/`node` can.
- **V-8** a fresh-container run (colima, node:22) completes a REAL
  confirm against a known-good key shape (the gate that would have caught
  BUG A).

## What is NOT changing
- The bootstrap (clone + re-exec + `/dev/tty`) — fixed in `a7d8186`, untouched.
- The 6-phase split, sanitization contract, the handoff prompt's P2–P5.
- `--skip-confirm` exists for air-gapped tests; it just no longer doubles
  as the OAuth shortcut.
