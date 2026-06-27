# Feature: Credential Vault — a reusable, encrypted, trace-free secret store

> Status: **SPEC** (not yet implemented). Branch: `feat/credential-vault`.
> Author: apple-pi planning pass, 2026-06-27.
> Supersedes the v1.0.0 "transient-only" vault model (D1/D2 in `.docs/PLAN.md`)
> with a **dual-lifetime** model: onboarding creds are still transient, but the
> vault becomes a **persistent, user-facing credential feature**.

## TL;DR

Today `~/.pi/onboarding.vault` is a throwaway: created during install, erased
the moment the model answers. The user is asking to **promote the vault to a
first-class feature** — a persistent, encrypted store for any credential the
agent is handed (API keys, tokens, gateway URLs, OAuth notes), writable from a
new `/vault` prompt **inside the pi TUI**, with a hard guarantee that the entry
path leaves **no log, no session trace, no shell history** of the key. Onboarding
creds flow through the same vault but are marked transient and pruned after
confirm; everything else persists until the user removes it.

## Why (the actual value)

1. **Convenience.** Today, adding a second provider's key after onboarding means
   hand-editing `auth.json` (easy to break, scary to touch) or running `/login`
   (OAuth-only, leaves token-refresh state). A `/vault` prompt that "just stores
   it" is the obvious UX.
2. **Security, by making the safe path the easy path.** The alternative users
   reach for today — pasting keys into `.zshrc`, `.env`, or chat — sprays the
   secret into process env, crash dumps, shell history, and session exports. A
   vault that writes the key encrypted-at-rest and never echoes it into any
   loggable surface is strictly safer *and* easier. That's the win.
3. **Single source of truth.** One encrypted file, one passphrase, one audit
   surface (`/vault list`), instead of keys scattered across `auth.json`,
   env vars, and memory.

## The core guarantee (the contract everything else serves)

> **A credential entered via `/vault add` is written to the encrypted vault and
> to nothing else.** It is not echoed to the TUI after entry, not written to the
> session transcript, not sent to the model, not logged by any pi telemetry or
> apple-pi autoresearch collector, not placed in any env var, and not retained in
> the in-process `ExtensionAPI` state beyond the duration of the write call.

This is a security-critical claim and is **enforced + tested**, not asserted
(see REQ-CV-7, the trace-free test).

---

## Design

### A. Two lifetimes, one vault

The vault is a single encrypted file holding a JSON document. Each entry has a
`lifetime` field:

| lifetime | source | fate |
|----------|--------|------|
| `transient` | onboarding (install.sh) | pruned from the vault at successful confirm (existing D1 behavior, unchanged) |
| `persistent` | `/vault add` in the TUI | kept until `/vault remove` |

So onboarding no longer *deletes the vault* — it deletes its *own transient
entries* from the vault, leaving any persistent entries the user added intact.
This is the minimal change to D1 that makes the vault reusable.

### B. Vault location + format

- **File:** `~/.pi/agent/credentials.vault` (NOT `~/.pi/onboarding.vault` —
  different name to avoid colliding with the old transient file; the old name is
  left to age out). Mode `0600`, owned by the user.
- **At rest:** `openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt`, exactly
  the existing D2 cipher (zero new crypto). Passphrase never on disk.
- **Plaintext schema (inside the envelope):**
  ```json
  {
    "version": 1,
    "created": "2026-06-27T12:00:00Z",
    "entries": [
      {
        "id": "openai",
        "kind": "api_key",
        "provider": "openai",
        "secret": "sk-...",
        "createdAt": "2026-06-27T12:00:00Z",
        "note": "personal account",
        "lifetime": "persistent"
      }
    ]
  }
  ```
- **Why JSON-in-openssl over a real secret-service backend:** matches the
  existing D2 rationale (zero deps, runs headless where macOS keychain can't be
  unlocked), keeps a single auditable file. **Threat model is unchanged from
  D2:** FileVault-off means plaintext-at-rest IF the disk is stolen; we still
  recommend turning FileVault on. The vault is *defense in depth for
  accidental leakage* (logs, env, exports), not a sealed-store against a
  disk-thief with the passphrase.

### C. The `/vault` prompt (TUI slash command)

A pi **extension** (`config/extensions/credential-vault.ts`) registers the
`/vault` slash command via `pi.registerCommand("vault", {...})` (verified
surface: `examples/extensions/commands.ts`). Subcommands:

| command | action |
|---------|--------|
| `/vault add [id]` | prompt for the secret via `ctx.ui.input()` (masked), write a `persistent` entry. If `id` exists, confirm overwrite. |
| `/vault list` | list entry **ids + metadata only** (never the secret). Shows `id · kind · provider · createdAt · note · lifetime`. |
| `/vault remove <id>` | delete one entry. |
| `/vault get <id>` | **privileged** — prints the secret to the TUI. Defaults to OFF; requires a setting `vault.allowReveal: true` or an in-prompt confirm. Rationale: most workflows never need to *see* the key again; reveal is a footgun. |
| `/vault rotate <id>` | convenience: alias for `remove` + `add` with the same id (re-encrypts under a new salt). |
| `/vault lock` | flush the in-memory decrypted cache and forget the passphrase; next access re-prompts. |
| `/vault import <file>` | bulk-load from a user-supplied JSON (for migration). Reads + shreds the source. |

**Entry path (the security-critical bit):** `/vault add` captures the secret
via a **masked capture**. `ctx.ui.input` has no native mask option (verified:
the only `ExtensionUIDialogOptions` are `signal` + `timeout`), so the extension
implements masking itself via one of two paths, decided in cv-tui:
  - **(preferred)** a focused overlay (`ctx.custom(...)`) that reads
    `onTerminalInput` keystrokes directly and renders dots, never the glyph; the
    buffer is a `let`, zeroed on submit. Cleanest trace-free path because the
    secret never touches the main input editor (which is what `sessions/*.jsonl`
    transcribes).
  - **(fallback)** `ctx.ui.input("Paste secret")` + immediate `setEditorText("")`
    after read. Weaker; acceptable only if cv-tui proves the overlay impractical.
The chosen path is documented in cv-tui and asserted by REQ-CV-7 (the trace-free
test catches any leakage regardless). Either way the secret is held in a local
variable for the minimum time needed to re-encrypt + write, then zeroed and
dropped. It is **never** passed to `ctx.ui.notify`, never returned from the
command, never written to the session, never passed as a `/vault add` argument
(argument entry is refused — REQ-CV-3). The command handler returns `void`.

### D. How the agent *uses* vault credentials

The vault is a **store**, not an auth provider. The agent does not auto-inject
secrets into tool calls. Instead:

1. **Onboarding mirror (backward compat):** install.sh writes the onboarding
   key to the vault as `transient`, and *also* seeds `auth.json` (as today) so
   pi's native auth works. At confirm, the transient entry is pruned. Net: the
   v1 auth flow is unchanged; the vault gains a parallel copy that gets cleaned.
2. **Post-onboarding (new):** the handoff persona (`config/agent/AGENTS.md`) is
   updated with a rule: *"if you need a credential the user has stored, tell them
   to run `/vault get <id>` — do not echo it; or, for tool auth, ask the user to
   `/vault export <id> to <provider>` which writes the key into `auth.json` in
   pi's native `{type:"api_key",key}` shape and re-purges it from env."* The
   vault-to-auth bridge is the deliberate, audited hop.
3. **No silent env injection.** We do *not* set `OPENAI_API_KEY=$vault[openai]`
   in the shell — that re-introduces the `ps e`/crash-dump leak the vault exists
   to prevent. The only path from vault → live use is the explicit
   `auth.json` bridge.

### E. The trace-free guarantee — how it's actually achieved

The four leak surfaces and the mitigation for each:

| surface | mitigation |
|---------|-----------|
| **Session transcript / `~/.pi/sessions/*.jsonl`** | `/vault add` is a slash command whose handler returns `void` — argument-based entry is **refused** (REQ-CV-3) and the masked capture (preferred: a `ctx.custom` overlay over `onTerminalInput`; fallback: `ctx.ui.input` + immediate `setEditorText("")`) never routes the secret through the main input editor, so the secret never appears in the user's typed input line at all. |
| **pi autoresearch / apple-pi telemetry** | the `lifecycle/collect-metrics.js` collector already excludes `~/.pi/agent/auth.json`; we extend its denylist to `credentials.vault` + assert it in a test. |
| **Shell history** | the vault is written by the extension in-process; no shell command ever contains the key. (install.sh's onboarding capture still uses `ask_secret`/`read -rs` — already history-safe.) |
| **Process env / crash dumps** | the secret lives in a local `let` for <1 frame; never exported to `process.env`; the `ExtensionAPI` does not retain it. |

---

## Requirements (REQ-CV-N)

- **REQ-CV-1** A new extension `config/extensions/credential-vault.ts` registers
  `/vault` with subcommands add/list/remove/get/rotate/lock/import/export,
  using `pi.registerCommand` + `ctx.ui.input`/`select`/`confirm`.
- **REQ-CV-2** The vault lives at `~/.pi/agent/credentials.vault`, mode 0600,
  encrypted with the existing D2 cipher (openssl aes-256-cbc · pbkdf2 · 600k).
  Plaintext schema is versioned JSON (see B). Forward-compat: unknown fields are
  preserved on rewrite.
- **REQ-CV-3** `/vault add` accepts the secret **only** via the masked
  `ctx.ui.input` dialog; a secret passed as a command argument is **refused**
  with a message explaining why (prevents transcript leakage). This is the
  load-bearing security decision and is tested.
- **REQ-CV-4** Onboarding (install.sh) writes its captured key as a `transient`
  vault entry AND seeds `auth.json` (unchanged). At successful confirm, only
  `lifetime: transient` entries are pruned; persistent entries survive.
  `--purge-auth-too` semantics unchanged.
- **REQ-CV-5** `/vault list` prints metadata only (never secrets). `/vault get`
  is gated behind `vault.allowReveal` (default false) or a confirm, and prints
  to the TUI only (never to a log/session).
- **REQ-CV-6** The `lifecycle/collect-metrics.js` denylist includes
  `credentials.vault` (and the old `onboarding.vault`); a smoke test asserts no
  vault path appears in collected telemetry.
- **REQ-CV-7** **Trace-free test (the headline security guarantee):** a test
  runs `/vault add test-id` with a marker secret, then greps the entire
  `~/.pi/sessions/` dir, the autoresearch DB, and any `*.log` for the marker.
  Must find **zero** occurrences. If found, FAIL loud.
- **REQ-CV-8** The persona (`config/agent/AGENTS.md`) gains a "credential
  handling" rule pointing at `/vault` and forbidding echo of secrets to
  commits/session exports.
- **REQ-CV-9** Sanitization (`smoke/sanitize.sh`) still passes — the vault
  extension ships no personal data and the vault file itself is never committed
  (it's runtime state; `.gitignore` gains `*.vault`).

## Decomposition (cards → commits)

Each card is one commit, parallelizable unless noted:

1. **cv-core** — `credential-vault.ts`: open/decrypt/read/encrypt/write the
   vault file (pure functions, no TUI). + a tiny CLI shim `bin/apple-pi vault`
   for headless/scripted access. REQ-CV-2.
2. **cv-tui** — the `/vault` slash command wiring (add/list/remove/get/lock),
   masked input, argument-refusal. Depends on cv-core. REQ-CV-1, REQ-CV-3,
   REQ-CV-5.
3. **cv-onboarding** — install.sh dual-lifetime change: write transient entry,
   prune-only-transient on confirm. REQ-CV-4. *(touches the just-shipped v2
   install.sh — do last, smallest blast radius.)*
4. **cv-telemetry-safety** — extend the collector denylist + persona rule.
   REQ-CV-6, REQ-CV-8. Parallelizable with cv-tui.
5. **cv-tracefree-test** — the REQ-CV-7 harness. Depends on cv-core + cv-tui.
6. **cv-rotate-import-export** — the convenience subcommands. REQ-CV-1 remainder.
   Can land after cv-tui.

Suggested merge order: 1 → 2 → 5 → (3 ‖ 4) → 6 → PR to `main`.

## Risks / open questions

- **Passphrase UX.** Decrypting the vault needs the passphrase. Onboarding
  already captured one (then destroyed it post-confirm). For a *persistent*
  vault we need a stable passphrase the user re-enters per session (or on
  `/vault unlock`). Options: (a) re-prompt on first `/vault` use per session,
  cache in-memory, `/vault lock` to flush; (b) optional `vault.passphraseCmd`
  setting (e.g. `!op read …` style, mirroring pi's own auth `key` resolution).
  **Recommend (a) for v1, document (b) as the power-user escape.** Not blocking
  the spec; it's a UX detail to settle in cv-tui.
- **Reveal-by-default-off friction.** Users may be annoyed they can't just see
  their key. The confirm gate + `allowReveal` setting is the compromise; the
  persona steers them toward `/vault export` → `auth.json` instead.
- **No cross-agent sharing.** The vault is apple-pi-local. The author's
  separate `agent-secrets` store (different machine) is a different product;
  we do not couple them. A future `/vault export-to agent-secrets` is possible
  but out of scope.
- **Headless pi.** `/vault add` needs the TUI (`ctx.ui.input`). For headless /
  scripted setup, the `bin/apple-pi vault add` CLI shim (cv-core) is the path —
  it reads from stdin (no echo), never a CLI arg, preserving the trace-free rule.

## Verification (REQ-CV-V)

- **V-1** `smoke/vault-roundtrip.sh`: add → list (no secret shown) → get (gated)
  → remove; vault re-encrypts; file mode 0600; JSON valid.
- **V-2** `smoke/vault-tracefree.sh` (the REQ-CV-7 headline): marker secret
  appears in **zero** of {sessions dir, autoresearch DB, *.log, shell history
  file if present}.
- **V-3** `smoke/vault-onboarding.sh`: install.sh writes a transient entry, a
  pre-existing persistent entry survives confirm, only transient is pruned.
- **V-4** `smoke/sanitize.sh` + `smoke/structure.sh` still green; `*.vault`
  gitignored.

## Out of scope (for this feature)

- Rotating the encryption passphrase (separate card; touches every entry).
- Sync/sharing across machines.
- OAuth token storage (the vault stores *opaque secrets*; OAuth refresh logic
  stays in pi's `auth.json`/`/login`).
- A GUI / web view of the vault.
