# Credential Vault — Security design (red/blue)

> Companion to SPEC.md. Records the attacker model and the failure modes the
> design refuses or mitigates. Read this before touching the crypto or the
> entry path. 2026-06-27.

## Attacker model (what we defend against, ranked)

| # | attacker / scenario | defended? | how |
|---|---------------------|-----------|-----|
| A1 | **Accidental leak via logs/transcripts/exports** — the agent, a tool, or telemetry echoes the key into something that gets read by a human or shipped to a repo. | ✅ **primary defense** | REQ-CV-3 (no arg entry), REQ-CV-7 (trace-free test), REQ-CV-6 (collector denylist), `/vault get` gated. |
| A2 | **Co-tenant / coworker on the same machine** reads `~/.pi/agent/credentials.vault` while I'm logged in. | ✅ | file mode 0600 + user-owned; encrypted, so even read access needs the passphrase. |
| A3 | **Malicious pi extension / skill** the user installed later tries to read the vault. | ⚠️ partial | the vault file is user-readable (0600), so any process running as the user can decrypt it if it has the passphrase *or* brute-force — see "residual" below. We do NOT promise isolation from arbitrary same-user code; pi's own extension trust model is the boundary. |
| A4 | **Disk thief** (stolen laptop, disk image leak). | ⚠️ partial | encrypted at rest (aes-256-cbc · pbkdf2 · 600k), BUT passphrase strength is the user's, and **FileVault-off** (per D2) means the OS ciphertext layer is absent. We recommend FileVault; the vault is *defense in depth*, not the outer wall. |
| A5 | **Shoulder-surf** while typing the key. | ✅ | `ctx.ui.input` masked; `ask_secret` uses `read -rs`. |
| A6 | **Phished passphrase** — attacker tricks the user into unlocking. | ❌ out of scope | no technical defense; standard phishing. |
| A7 | **Compromised pi binary / supply chain** — pi itself is malicious. | ❌ out of scope | if pi is hostile, no in-process vault can survive. Trust root is the pi npm package + the apple-pi repo. |

## Blue-team (defenses) — the load-bearing ones

1. **Argument entry is refused (REQ-CV-3).** `/vault add openai sk-...` is
   *rejected* — the secret must come through the masked dialog. This is the
   single most important defense: it means the secret **never appears in the
   user's typed input line**, which is the thing that gets transcribed into
   `sessions/*.jsonl`. Without this, the whole trace-free claim collapses.
2. **Handler returns `void`.** The slash-command handler writes the secret to
   the vault and returns nothing. Even if a future bug logs the return value,
   there's nothing to log.
3. **In-memory lifetime < 1 frame.** The secret is read from the dialog into a
   `let`, re-encrypts the vault, is written, then the `let` is set to a zero-
   length string and dropped. No long-lived process state holds it.
4. **`/vault get` is opt-in.** Revealing a stored key is a footgun (it then
   lives in scrollback, screen recordings, etc.). Default-off + confirm +
   `allowReveal` setting makes the safe path the default and the unsafe path
   deliberate.
5. **No env injection.** We never `process.env.X = vaultEntry`. Env is the
   leakiest surface (`ps e`, core dumps, child-process inheritance); the
   vault-to-`auth.json` bridge is the *only* live-use path, by design.

## Red-team (failure modes) — and the design's answer

- **R1: "What if a user pastes the key into normal chat anyway?"** The agent
  persona rule (REQ-CV-8) tells it to refuse to echo and to suggest `/vault add`.
  But we cannot *prevent* a user from typing a secret in chat — that's the
  session's input, which is transcribed. Mitigation is guidance, not enforcement.
  → ACCEPTED residual. The persona rule is the best we can do.
- **R2: "What if the passphrase is weak?"** pbkdf2-600k raises the cost, but a
  4-char passphrase falls to a GPU in minutes. → MITIGATE: cv-tui enforces a
  minimum passphrase length on first vault creation; warn (don't block) on
  known-weak patterns. Document the FileVault recommendation.
- **R3: "What if `/vault get` output is captured by a screen recorder or tmux
  scrollback that got saved?"** → MITIGATE: reveal is gated (REQ-CV-5); persona
  steers users to `/vault export` → `auth.json` instead, which never displays.
  ACCEPTED residual for users who choose to reveal.
- **R4: "What if the autoresearch collector is later extended to read
  `~/.pi/agent/`?"** → DEFEND: the denylist (REQ-CV-6) is asserted by a test
  that fails the build if the vault path is reachable. The test is the guardrail.
- **R5: "What if two `/vault add` calls race and corrupt the file?"** → MITIGATE:
  cv-core writes atomically (temp file + `rename`); the decrypt→modify→encrypt
  is serialized behind a file lock (mirror pi's own `FileAuthStorageBackend`
  `withLock` pattern, `auth-storage.d.ts`).
- **R6: "What if a transient onboarding entry is left behind because confirm
  crashed?"** → MITIGATE: at next pi start, the vault extension prunes any entry
  older than 24h that is still `lifetime: transient` (onboarding should never
  take that long; a crash mid-onboarding leaves a stale entry that's auto-
  reaped). Logged as a one-line info, no secret in the log.
- **R7: "What if the user forgets the passphrase?"** → ACCEPTED: there is no
  recovery. The vault is unrecoverable without it (that's the point). Document
  prominently. The cost is "re-add your keys"; the benefit is "no backdoor".
  This matches pi's own `auth.json` posture (keys are opaque; lose them, re-login).
- **R8: "pi's `ctx.ui.input` has no mask option (verified) — how is masked entry
  actually achieved, and what if the overlay API drifts?"** → MITIGATE: the
  preferred path is a custom overlay (`ctx.custom` + `onTerminalInput`) that
  renders dots and never routes the secret through the main input editor. The
  fallback (`ctx.ui.input` + immediate `setEditorText("")`) is version-stable
  but weaker; cv-tui pins which is in use. REQ-CV-7 re-asserts trace-freeness on
  every CI run, so a regression that re-leaks is caught at test time.

## Crypto choices — why nothing new

We deliberately reuse D2's `openssl enc -aes-256-cbc -pbkdf2 -iter 600000`:

- **Zero new crypto.** "Don't roll your own" — and we're not. OpenSSL is
  audited, ubiquitous, and already a dependency.
- **No node crypto dependency** in the extension — the encrypt/decrypt happens
  via a `child_process` `openssl` call (already a hard dep of install.sh's
  onboarding), so the extension stays portable and doesn't pull a crypto npm
  tree.
- **Trade-off accepted:** spawning openssl per read/write is slower than an
  in-process cipher, but vault access is rare (add/list/get are human-paced).
  If it ever matters, swapping to Node's built-in `crypto` (still aes-256-gcm,
  still not "our own") is a cv-core-internal change with no schema impact.

**Why CBC over GCM for v1:** matching D2 exactly keeps the onboarding path and
the vault path on identical primitives, so there's one crypto story to audit.
A future **v2 vault format** can move to aes-256-gcm (authenticated) + a
format-version bump; the versioned JSON envelope (SPEC §B) is there precisely
so that migration is a `version: 1 → 2` re-encrypt, not a breaking change.

---

## Addendum — rotate / import / export (cv-rotate-import-export)

The three convenience subcommands were added after the original R1–R8 pass.
Their failure modes, mapped onto the existing model:

- **`/vault export <id>` → auth.json.** This is the *deliberate* vault→auth
  bridge (SPEC §D): it writes the entry's secret into `~/.pi/agent/auth.json`
  in pi's native `{type:"api_key",key}` shape. **No net-new plaintext exposure**
  — auth.json is pi's existing mode-0600 key store (populated today by `/login`),
  and it always held plaintext keys. Moving a key vault→auth.json trades the
  vault's encrypted-at-rest + not-in-logs guarantees for pi's native runtime
  auth; it is a user-confirmed action (TUI confirm gate), and the secret is
  never echoed — it transits memory→auth.json only. The bridge REFUSES to
  clobber an existing non-`api_key` (OAuth) entry, so it can't silently destroy
  a token-refresh state. → maps to A1's "/vault get gated" posture, ACCEPTED.
- **`/vault import <file>` shred.** The source file is best-effort
  overwritten-with-zeros + unlinked after import. **Honest caveat:** on
  SSDs / APFS copy-on-write this is NOT a forensic guarantee (wear-leveling);
  the real at-rest protection is FileVault (A4), not shred. The shred guards
  against symlinks (refuses to follow — `openSync("r+")` + `unlinkSync` would
  zero the TARGET while removing only the link → silent data loss of an
  unrelated file). The CLI trusts the operator for the path (same posture as
  `vault get` printing a secret); the TUI confirms before shred. → ACCEPTED.
- **`/vault rotate <id>`.** Replaces an existing entry's secret via the same
  encrypt/write path as `add` (new salt each write). Refuses if the entry does
  not exist ("rotate" implies already-stored). **No new surface** beyond `add`.
  → covered by R1–R8 unchanged.

Re-read conclusion (R1–R8): every original failure mode is still mitigated or
explicitly accepted; the three new subcommands introduce no new crypto, no new
leak surface (export's plaintext hop is to pi's existing store, by design),
and one new footgun (symlink shred) that is guarded. Gate item satisfied.
