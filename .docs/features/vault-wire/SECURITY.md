# Vault Wire — Security design (red/blue)

> Companion to SPEC.md. Inherits the credential-vault attacker model
> (`../credential-vault/SECURITY.md`, A1–A7) **unchanged** — same cipher, same
> file, same entry path, same trace-free guarantee. This doc covers ONLY what
> vault-wire *adds*: the auto-wire layer, the keychain unlock, and the cloud
> sync. Read SPEC.md §"The core guarantee" first. 2026-06-29.

## Attacker model (additions on top of credential-vault A1–A7)

| # | attacker / scenario | defended? | how |
|---|---------------------|-----------|-----|
| A8 | **Same-user process reads a projected secret** — a malicious/curious tool or child process enumerates `process.env` to hoover keys. | ✅ **primary** | C-1 / B-VW-1: secrets go to an in-memory registry + `secret(id)`, **never** `process.env`. The whole point of not injecting env. |
| A9 | **`auth.json` / `agent-secrets` plaintext read by a disk thief** (the surfaces FileVault-off leaves exposed). | ⚠️ → ✅ (P3) | these become *regenerable projections* of the vault. P1 still writes plaintext (backward-compat baseline); P3 rewrites `auth.json` to `!command` pointers so no plaintext provider key sits there. agent-secrets stays plaintext but is now a fan-out, not an independent store. |
| A10 | **Cloud eavesdropper / iCloud account compromise** reads the synced vault. | ✅ | the synced file is ciphertext (aes-256-cbc · pbkdf2 · 600k); the passphrase is NOT in the cloud (it's per-device keychain). Compromise of iCloud yields an encrypted blob, not keys. |
| A11 | **Lost device** — a finder boots the mini; the keychain auto-unlocks (auto-login). | ⚠️ partial | the master passphrase is in the keychain, which unlocks at GUI login. Physical protection is the user's stated boundary (home server). `/vault lock --keychain` removes the passphrase entry for travel/loan. Same residual as A4 — the vault is defense-in-depth, not the outer wall. |
| A12 | **iCloud conflict copy merges a stale/revoked secret back in.** | ✅ | `/vault reconcile` **never silently overwrites a divergent secret** — it lists divergent ids for manual resolution (REQ-VW-10). A revoked key that lingers in a conflict copy is surfaced, not auto-merged. |
| A13 | **`!command` reader leaks the secret via its own env/argv** (P3). | ✅ | `bin/apple-pi vault-key <id>` takes the id as argv (non-secret), reads the passphrase via the keychain chain, prints the secret to **stdout only**. It is the *only* `!command` target we ship; users adding their own command target own that surface. |

## Blue-team (defenses) — the load-bearing ones

1. **B-VW-1 — No env injection (C-1, the headline).** This is the decision the
   red-team pass was built around, so it's recorded in full below in
   "The central decision." Short form: `process.env` is REFUSED as a projection
   target; secrets reach bridges via the registry + `secret(id)`. The credential-
   vault feature already established this (`SECURITY.md` blue-team #5: "No env
   injection"); vault-wire extends the same rule to the *auto-wire layer*, which
   is the new place a careless design would spray env.
2. **B-VW-2 — Wire is read-only on the vault (C-2).** The auto-wire decrypts and
   fans out; it never writes the vault. This is what makes multi-device cloud
   sync safe: N devices reading one synced file never contend. Only interactive
   `/vault add|rotate|remove` write, and those are rare + human-driven.
3. **B-VW-3 — Passphrase never in the cloud.** The synced vault is ciphertext;
   the master passphrase lives only in each device's keychain (`apple-pi-vault`),
   never in iCloud. Losing the cloud loses an encrypted blob. Per-device keychain
   also means a compromised passphrase is per-device-revocable
   (`/vault lock --keychain` on that one device).
4. **B-VW-4 — Graceful degradation, never a brick.** Every tier of
   `resolvePassphrase()` is best-effort: locked keychain → falls through; missing
   vault → `readVault` returns null → `secret(id)` returns `""` → bridge falls
   back to legacy. A vault-wire misconfiguration degrades to the pre-wire
   behavior, not a startup crash. (Contrast: the 2026-06-29 web-deps incident,
   where a hard dep bricked pi at startup — vault-wire is explicitly non-fatal.)
5. **B-VW-5 — Projection reuses proven primitives.** `auth` projection is the
   already-red-teamed `exportToAuth` (B1/W1-fixed: fail-closed on corrupt
   auth.json, O_EXCL temp). `command` projection is the already-red-teamed
   `exportToCommand` (secret on stdin only, `$VAULT_*` non-secret env, timeout).
   **No new write path is introduced** — the wire just *drives* the existing ones.

## The central decision — env vs. registry (rejected option in full)

The tempting design is "populate `process.env.FORGEJO_TOKEN = vault[forgejo] at
`session_start`." Zero bridge edits — every bridge already reads
`process.env.X ?? ""`. **This is rejected.** The red-team angles, any one of
which is disqualifying:

- **R-VW-a (child-process inheritance — the killer).** pi runs the `bash` tool
  on nearly every turn. Every bash command (and anything it spawns — `npm`,
  `git`, a test runner) **inherits pi's full env**. So a secret in pi's `env` =
  the secret in *every command pi executes*. This is strictly worse than the
  `.zshrc` problem the `agent-secrets` store was built to fix (that was
  shell-scoped; this is agent-process-scoped, and pi spawns shells constantly).
- **R-VW-b (`ps e` exposure).** Any same-user process can read pi's environment
  via `ps eww <pid>`. The mini is single-user, so the threat is "another
  process running as jay" — exactly the boundary `agent-secrets` defends in
  depth against. Injecting env re-opens the hole the vault exists to close.
- **R-VW-c (crash dumps / core files).** A pi crash captures `environ` into a
  core file. Secrets in env → secrets in a crash artifact.
- **R-VW-d (policy contradiction).** apple-pi's own `AGENTS.md` → Credentials:
  *"Do **not** set `process.env.X = vault[…]` — env is the leakiest surface."*
  The env-projection design would directly violate the product's stated rule.

**Accepted design:** module-scoped registry `Map<id, secret>` + `secret(id)`
helper. Secrets live in process memory (unavoidable — they must, to be used),
but are **not** copied into `environ`, are **not** inherited by child
processes, and are **not** enumerable by callers (you ask for a known id).
The one-line-per-bridge edit (SPEC §D) is the cost of this safety; it is
intentional and non-negotiable.

**Residual (accepted):** a same-user process can still read the vault file
(0600) and, if it has the passphrase, decrypt it — same residual as
credential-vault A3. The registry does not worsen this; it *improves* on the
status quo (where the same secret is ALSO in `auth.json` plaintext AND
`agent-secrets` plaintext AND possibly env). Net surfaces shrink.

## Red-team (failure modes) — and the design's answer

- **R-VW-1: "What if the keychain is locked on a headless SSH session?"**
  → DEFEND: `resolvePassphrase()` tier 2 is best-effort; a locked keychain
  falls through to tier 1 (`CREDENTIALS_VAULT_PASS`) or tier 3 (tty). On the
  mini specifically, auto-login + GUI session means the keychain is unlocked
  even for SSH-spawned pi (verified 2026-06-29). A pure server (no GUI) must
  set `CREDENTIALS_VAULT_PASS` via a wrapper. ACCEPTED per-platform residual.
- **R-VW-2: "What if the synced vault is mid-sync (half-written) when a device
  reads it?"** → MITIGATE: credential-vault already writes atomically (temp +
  `rename`); iCloud syncs the renamed-into-place file, never a half-write the
  app produced. A device reading during sync either sees the old or the new
  whole file, never a torn one. If `readVault` does fail (corrupt),
  `secret(id)` returns `""` (graceful). ACCEPTED.
- **R-VW-3: "What if two devices `/vault add` the same new id simultaneously?"**
  → DEFEND: that's the *only* write-contention window, and it's interactive +
  rare. iCloud produces a conflict copy (`credentials (2).vault`); `/vault
  reconcile` surfaces the divergence (REQ-VW-10) rather than silently picking.
  No auto-resolve of divergent secrets. ACCEPTED (the cost of human-driven
  writes; day-to-day reads never hit this).
- **R-VW-4: "What if `vault.wire` names an id that isn't in the vault?"**
  → MITIGATE: `/vault wire --dry-run` flags missing ids; the `session_start`
  projection logs a one-line notice (id only, never the secret) and skips. The
  bridge gets `""` and falls back. No crash, no partial projection. REQ-VW-8.
- **R-VW-5: "What if a malicious bridge calls `secret()` for an id it shouldn't
  have?"** → ACCEPTED: the registry is same-process; a loaded bridge is already
  trusted with full system perms (pi's extension trust model, credential-vault
  A3). The registry does not add an access-control layer because the boundary
  it would enforce (which extension may read which secret) does not exist in pi
  today. Document; do not pretend to isolate.
- **R-VW-6: "P3's `!command` runs a subprocess per provider key — what if it's
  slow or hangs?"** → MITIGATE: pi caches `!command` output for process lifetime
  (docs/providers.md:129), so it's one spawn per provider per pi process, not
  per request. `vault-key` is a fast local decrypt (<50ms). A documented
  timeout in pi's command resolver is the backstop. P3 is optional; P1's
  plaintext baseline has no subprocess. ACCEPTED.

## Multi-device sync — the honest threat picture

The credential-vault feature (single-device) had no sync story. Cloud sync adds:

- **Write contention** — moot day-to-day (C-2: wire is read-only). Only
  interactive writes contend, and `/vault reconcile` handles the conflict copy.
- **Stale-secret revival** — a revoked key in an old device's cache or a
  conflict copy could resurface. DEFEND: the synced vault is authoritative on
  next read (devices re-decrypt each session); `/vault remove` propagates via
  sync. The window is "until each device next reads" — bounded, not infinite.
  `/vault reconcile` surfaces divergent ids so a revival is visible. A future
  `vault.wire` "revoked ids" denylist could harden this (out of scope).
- **Cloud account compromise** — A10: yields ciphertext only. The passphrase is
  per-device keychain, not in the cloud. This is the structural win of
  sync-the-ciphertext over sync-a-plaintext-store.

## Re-read conclusion

Inherited A1–A7 unchanged and still satisfied (vault-wire adds no new entry
path, no new crypto, no new leak surface — it *removes* plaintext copies). The
new surfaces (A8–A13) are each defended or explicitly accepted. The load-bearing
decision (B-VW-1, no env injection) is the one a future refactor must not
revert; **VW-V-2's `process.env` grep assert** is the gate that catches it. Gate
item satisfied: every failure mode is mitigated or a documented residual.
