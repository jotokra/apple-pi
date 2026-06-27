# Credential Vault — follow-ups (2026-06-27)

> Decisions doc for three post-merge follow-ups to the credential vault
> (shipped v1.2.0 via PR #1). Each is one commit on
> `feat/credential-vault-followups`, then PR'd to main.
>
> The frozen spec is `.docs/features/credential-vault/SPEC.md` (unchanged by
> these follow-ups except where noted). This doc records the three NEW
> decisions + their red/blue notes.

## F1 — masked entry overlay (cv-masked-overlay)

**Decision: ship the masked overlay as the preferred `/vault add` entry path,
keeping the `ctx.ui.input` fallback for non-TUI / overlay-failure.**

### Why (the verified value)

The v1 fallback (`ctx.ui.input` + `setEditorText("")`) is **already trace-free**
for REQ-CV-7 — it's a separate UI dialog, not the main input editor, so the
secret never enters the session transcript (the tracefree smoke proves it).
So the overlay is NOT a trace-free fix. Its real, verified security gain is
**entry-time visual masking** (renders dots, never the plaintext glyph), which
defeats:

- **A5 (shoulder-surf)** during typing — the fallback shows the key in
  plaintext as you type it.
- **screen-recorder / tmux-scrollback capture during entry** — same window.

That's a genuine improvement worth building, grounded in the verified pi
surface (`ctx.ui.custom` + `Component.handleInput` + pi-tui's `matchesKey` /
`decodePrintableKey` — all confirmed in the installed package, see the
implementation header for the type refs).

### Design

- A `MaskedInputOverlay implements Component` (in the extension) rendered via
  `ctx.ui.custom<string | undefined>(factory, { overlay: true, ... })`.
- Keystrokes via `handleInput(data)` using pi-tui key utilities:
  - `matchesKey(data, Key.enter)` → submit (call `done(buffer)`).
  - `matchesKey(data, Key.backspace)` → drop last char.
  - `matchesKey(data, Key.escape)` OR `matchesKey(data, Key.ctrl("c"))` →
    cancel (`done(undefined)`).
  - `matchesKey(data, Key.ctrl("u"))` → clear buffer.
  - otherwise `decodePrintableKey(data)` → append (rejects non-printables,
    so ctrl/alt combos and escape sequences don't pollute the buffer).
- `render(width)` shows dots (one per char), truncated to `width - label` so
  **no line exceeds terminal width** (pi crashes otherwise — verified in the
  TUI source). No plaintext glyph ever emitted.
- The buffer is a `let` on the component instance; zeroed (`""`) on submit/
  cancel/dispose. The secret is held in-process for the minimum time.
- **Fallback retained:** if `ctx.mode !== "tui"` or `ctx.ui.custom` throws,
  the handler falls back to the existing `ctx.ui.input` path. REQ-CV-7's
  tracefree smoke re-asserts trace-freeness regardless of which path runs.
- `rotate` reuses the same overlay (it's also a secret-capture).

### Red/blue (F1)

- **R-F1a "render(width) exceeds terminal width → TUI crash."** MITIGATE:
  dots truncated to `Math.max(0, width - labelWidth)`; an empty/very-narrow
  terminal renders just the label. Tested by the overlay unit (render at
  width 10 with a 50-char buffer).
- **R-F1b "ctrl-c should still abort pi globally, not just the overlay."**
  ACCEPTED residual: the overlay consumes ctrl-c as cancel (returns to the
  prompt). This matches how every other pi dialog (confirm/select/input)
  behaves — ctrl-c in a focused component is dialog-cancel, not process-kill.
  Escape is the documented cancel key; ctrl-c is an alias.
- **R-F1c "a paste drops a multi-char `data` blob — does decodePrintableKey
  handle it?"** MITIGATE: decodePrintableKey is documented for single keys;
  for a multi-char paste we split on chars and append each printable. A paste
  with control chars mixed in is filtered (non-printables dropped).
- **R-F1d "does the overlay route the buffer through the main input editor?"**
  NO — `ctx.ui.custom` gives the component keyboard focus directly; the
  buffer lives only on the component. This is the whole point over the
  fallback. Re-asserted by REQ-CV-7 on every run.

## F2 — generic external export (`vault.exportCmd`) (cv-external-export)

**Decision: a generic `/vault export-to <id>` that runs a USER-CONFIGURED
command, piping the secret to its STDIN. Mirrors pi's `apiKey: "!command"`
pattern + git's `credential.helper`. NOT a hardcoded "agent-secrets" bridge —
apple-pi is sanitized; the command is the user's to configure.**

### Why

The vault already has `/vault export <id>` → `auth.json` (pi's native bridge).
That covers "get the key into pi's runtime auth." A second, user-configured
bridge lets someone populate their *real* secret manager (1Password CLI,
`pass`, bitwarden-cli, a custom helper) directly from the vault — the
migration/sync-out use case — without re-pasting the key. The safe path made
easy.

### Design

- Setting `vault.exportCmd` (string, in settings.json). Conventionally
  leading-`!` to signal "shell command" (mirrors pi's `apiKey` resolution).
  Interpolation of NON-SECRET metadata only: `$VAULT_ID`, `$VAULT_PROVIDER`,
  `$VAULT_KIND`, `$VAULT_NOTE`. The SECRET is NEVER interpolated — only piped
  to the command's stdin.
- Core fn `exportToCommand(passphrase, id, opts)`: resolves the entry, builds
  the env (metadata only), spawns the command via `child_process.spawn` with
  `{ stdio: ["pipe","inherit","inherit"], env }`, writes the secret to
  `child.stdin`, closes stdin, awaits exit. Returns `{ ok, exitCode }` or
  `{ ok:false, reason }`.
  - REFUSES if `exportCmd` is unset → `{ ok:false, reason:"no vault.exportCmd configured" }`.
  - REFUSES if the entry is missing.
- `/vault export-to <id>` (TUI, confirm gate) + `apple-pi vault export-to <id>` (CLI).
- **The secret transits ONLY: vault → child.stdin.** Never argv, never env,
  never the command string. This is the load-bearing safety property.

### Red/blue (F2)

- **R-F2a "secret leaks via argv / `ps e`."** DEFEND: the secret is stdin-only;
  the command template is metadata-interpolated, never secret-interpolated. A
  `ps e` shows the resolved command (metadata only) + the child's env (metadata
  only). Verified by the smoke: a marker secret piped to a command does NOT
  appear in the command line.
- **R-F2b "secret leaks via the child's env."** DEFEND: only `$VAULT_ID` etc.
  (metadata) are added to `process.env` for the child; the secret is never an
  env var. (Contrast: the leaky pattern we exist to prevent.)
- **R-F2c "command injection via metadata."** MITIGATE: the command is run via
  `spawn(command, { shell: true })` — the user WROTE the command, so
  shell-metacharacters in it are their intent. But metadata interpolated into
  it (e.g. a `note` containing `; rm -rf ~`) IS an injection vector. MITIGATE:
  metadata is passed via ENV vars (`$VAULT_NOTE`), not string-interpolated into
  the command, so a malicious note can't break out of the command's argv. The
  command string itself is static config, only `$VAULT_*` env vars are read.
  → This is the key design choice: **env-pass metadata, stdin-pass secret,
  never template-interpolate either.** Re-derived after first draft.
- **R-F2d "the command exits non-zero."** SURFACE: return exit code; the CLI
  prints it, the TUI notifies. The secret is NOT re-exposed on failure.
- **R-F2e "stdin stays open / command hangs."** MITIGATE: stdin is ended
  (`child.stdin.end()`) immediately after the write; a 10s timeout kills the
  child and reports timeout.

## F3 — landing-page vault callout (landing-vault-callout)

**Decision: add a vault callout to the landing's privacy section (the natural
home — "Everything ships. Nothing phones home."), not the hero.**

### Why

The vault is a privacy-first feature; the privacy section is where a security-
minded visitor reads. A hero callout would be marketing-heavy; the privacy
section callout is honest and on-theme. Pure copy + one stat bump.

### Design

- In the privacy "box" (`docs/index.html`), add a short vault paragraph: the
  four promises (trace-free entry, encrypted at rest, you gate reveals,
  onboarding cleans up), condensed. Link to the README section for the full
  treatment.
- Keep it tight — a paragraph + a one-liner, not a second full section (the
  README is the deep dive; the landing is the hook).

### Red/blue (F3)

- None — pure static copy. Sanitize smoke re-asserts no personal info. The
  only check is "do the claims match the shipped behavior" (they do — drawn
  from CONCEPT.md, which mirrors the verified SPEC).

## Out of scope (these follow-ups)

- Passphrase rotation (still a separate future card).
- Cross-machine sync.
- A `/vault` GUI / web view.
- Hardcoding any specific external store (agent-secrets, 1Password, etc.) —
  the generic `exportCmd` is the portable answer; specific stores are the
  user's config.
