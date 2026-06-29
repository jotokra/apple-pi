# Feature: Vault Wire — single-point-of-touch secrets, keychain-unlocked, cloud-synced

> Status: **SPEC** (not yet implemented). Branch: `feat/vault-wire`.
> Author: apple-pi planning pass, 2026-06-29.
> Sequel to the credential-vault feature (`../credential-vault/`), which shipped
> the encrypted store + `/vault` commands but explicitly deferred
> "Sync/sharing across machines" to out of scope. This feature closes that gap
> and adds the auto-wire layer that makes the vault the **single source of truth**
> every credential flows from.

## TL;DR

Today, adding a secret touches up to **four** surfaces by hand: the encrypted
vault (`/vault add`), `auth.json` (pi provider keys, plaintext), the
`agent-secrets` store (the-agent/Claude, plaintext), and per-bridge `process.env`
via `env.local` (non-secret by convention, but keys leak in there in practice).
Each device re-does this; there's no sync; the plaintext copies proliferate.

**Vault Wire makes the vault the single write-point.** You run `/vault add
<id>` once; on every pi start the vault is **decrypted via the keychain**
(P3 — no passphrase re-typing), held in an **in-memory registry**, and
**projected** to `auth.json`, to bridges (via a `secret(id)` helper — **never
`process.env`**), and to the cross-agent `agent-secrets` store — all read-only
on the vault, all from a per-entry `vault.wire` map in `settings.json`. The
vault file itself is **ciphertext, so it syncs over iCloud Drive** unchanged;
each device holds only the one master passphrase in its own keychain. Net: one
secret, one place, fan-out is automatic and local.

## Why (the actual value)

1. **Single point of touch.** One ingestion command (`/vault add`), one source
   of truth. Adding a new provider key no longer means hand-editing three files
   on N devices.
2. **No passphrase typing.** P3 stores the master passphrase in the keychain;
   every pi process (interactive, cron, Telegram, `-p`) resolves it headlessly.
   The vault is encrypted at rest *and* unlocked without a human in the loop.
3. **Sync without a pivot.** The vault is already ciphertext, and its path is
   already configurable (`CREDENTIALS_VAULT` env, `vault/lib/vault.js:34`).
   Pointing it at iCloud Drive needs **zero code changes** — just config +
   setup docs. We reuse the entire credential-vault crypto; we are *not*
   adopting a new store (1Password) or new crypto.
4. **Strictly less plaintext at rest.** `auth.json` and `agent-secrets` become
   *regenerable projections* of the vault rather than independent plaintext
   stores. P3 (optional) further lets `auth.json` hold `!command` pointers that
   resolve keys from the registry at runtime, so no plaintext provider key sits
   in `auth.json` at all. (Orthogonal to FileVault — which the user has
   deliberately left off; this feature shrinks that surface regardless.)

## The core guarantee (the contract everything else serves)

> **The vault is the single source of truth. All other secret surfaces
> (`auth.json`, bridges, `agent-secrets`) are regenerable projections,
> rewritten from the vault on every wire. Populating `process.env` with a
> vault secret is REFUSED by design.** The vault-wire layer is read-only on the
> vault file; only interactive `/vault add|rotate|remove` writes it.

Two corollaries the spec enforces, not asserts:

- **C-1 (no env injection).** Secrets reach bridges via a module-scoped
  in-memory registry + a `secret(id)` helper, **never** `process.env`. This is
  the load-bearing security decision (see SECURITY.md blue-team item B-VW-1).
- **C-2 (read-only wire).** The auto-wire decrypts and fans out; it never
  encrypts or writes the vault. The only writers are the existing `/vault
  add|rotate|remove|import` commands (unchanged). This keeps multi-device
  day-to-day operation write-free → zero iCloud contention.

---

## Design

### A. The registry — secrets live in memory, not env

A new module `config/extensions/_lib/vault-registry.ts` (sibling to the existing
`_lib/envlocal.ts`) holds a module-scoped `Map<string, string>` of decrypted
secrets. It is populated **lazily on first `secret(id)` call** and **memoized**:
the first call anywhere in the process reads the keychain passphrase, decrypts
the vault (one `openssl` spawn, ~30–50ms), and caches the whole envelope;
subsequent calls are `Map.get` lookups.

```ts
// config/extensions/_lib/vault-registry.ts  (sketch)
import { loadCore } from "../credential-vault/_core";   // reuses the existing loadCore + .apple-pi-source marker
let cache: Map<string,string> | null = null;
function populate(): Map<string,string> {
  const core = loadCore(); if (!core) return new Map();
  const pass = resolvePassphrase();              // see VW-B (keychain chain)
  if (!pass) return new Map();
  const env = core.readVault(pass) ?? { entries: [] };  // decrypt-once
  const m = new Map<string,string>();
  for (const e of env.entries) m.set(e.id, e.secret);
  return m;
}
export function secret(id: string): string {           // the ONLY read API
  if (!cache) cache = populate();
  return cache.get(id) ?? "";                          // "" = not wired / vault locked
}
```

**Why lazy + memoized over eager-import (like envlocal):** lazy pays the
decrypt cost only when a secret is actually needed (a tool fires), not on
every pi start; and a locked keychain / missing vault degrades to `""`
per-secret instead of bricking all extension load. `secret()` is callable at
call-time (inside tool handlers) or at module top-level (the import's side-effect
ordering still holds for an eager variant — see Risks). The registry exposes
**no** `process.env` writes and **no** iteration of ids to callers (callers ask
for a known id).

### B. Keychain unlock — the passphrase resolution chain (P0/P3)

`resolvePassphrase()` returns the first non-empty result of:

1. **`CREDENTIALS_VAULT_PASS` env** (headless/CI/wrapper-set; unchanged from
   credential-vault). Highest priority — explicit operator intent.
2. **`security find-generic-password -s apple-pi-vault -w`** (keychain, P3).
   Headless-safe on the mini because it auto-logs-in at boot → keychain unlocks
   with the GUI session. **Verified** (2026-06-29): a probe item round-tripped
   read/write/delete in this exact process context.
3. **tty prompt** (interactive `pi` only; the v1 credential-vault path).

New command **`/vault unlock`** writes the passphrase the user enters into the
keychain service `apple-pi-vault` (once per device), so all future resolution
hits tier 2. `/vault lock` (existing) flushes the in-memory cache; a new
`/vault lock --keychain` also deletes the keychain entry (re-prompt next time).

### C. The wire map — what projects where

`settings.json` gains a `vault.wire` object. Keys are **vault entry ids**;
values declare the projection. The auto-wire (a `session_start` handler + the
lazy registry) reads this map and fans out:

```jsonc
"vault": {
  "passphraseSource": "keychain:apple-pi-vault",   // resolves via tier 2 above
  "wire": {
    "<provider>":      { "to": "auth" },                                   // → auth.json (provider key, plaintext in P1; !command in P3)
    "minimax":  { "to": "auth" },
    "forgejo":  { "to": "bridge", "secret": "forgejo" },            // → registry; bridge calls secret("forgejo")
    "netbird":  { "to": "bridge", "secret": "netbird" },
    "github":   { "to": "command", "cmd": "agent-secret set $VAULT_ID" },  // → agent-secrets store (exportToCommand)
    "obsidian": { "to": "command", "cmd": "agent-secret set OBSIDIAN_REST_TOKEN" }
  }
}
```

| `to` | mechanism | plaintext at rest? | takes effect |
|------|-----------|--------------------|--------------|
| `auth` | existing `core.exportToAuth` → `auth.json[provider]` | **P1 yes** / **P3 no** (`!command`) | next pi start (P1) / live (P3) |
| `bridge` | registry Map; bridge reads via `secret(id)` | **no** (memory only) | live (first tool call) |
| `command` | existing `core.exportToCommand` (secret on stdin, `$VAULT_*` env) | depends on the target store | on every wire (write-through) |

`command` reuses the existing `exportToCommand` primitive unchanged — the
vault→agent-secrets fan-out is literally the F2 feature already shipped in
credential-vault. No new code path; just a `vault.wire` entry driving it.

### D. How a bridge opts in (the one-line-per-bridge edit)

A bridge swaps env lookup for the registry. Diff is one import + one call site:

```ts
- import "./_lib/envlocal";
- const FORGEJO_TOKEN = (process.env as any)["FORGEJO_TOKEN"] ?? "";
+ import "./_lib/envlocal";          // keep — env.local still carries NON-secret host/path overrides
+ import { secret } from "./_lib/vault-registry";
  // …then at call-time (inside the tool handler), not top-level:
-   headers: { authorization: `token ${FORGEJO_TOKEN}` },
+   headers: { authorization: `token ${secret("forgejo")}` },
```

`env.local` stays for **non-secret** overrides (`FORGEJO_BASE_URL`, `KANBAN_DB_PATH`)
— its contract is unchanged. Only the *secret* moves from env to registry. A
bridge wired via `vault.wire` but reading `process.env` still (legacy) gets `""`
from the registry and falls back — graceful, no breakage.

### E. Cloud sync over iCloud Drive (P2)

The vault is ciphertext, so it is safe over untrusted cloud. Sync needs no new
crypto, no new store — just a path:

1. **Enable iCloud Drive** on the mini (signed into iCloud today; Drive is the
   one toggle off — a System Settings step the user drives). AGENTS.md already
   permits Apple ID/iCloud.
2. **Point the vault at iCloud**: `CREDENTIALS_VAULT="$HOME/Library/Mobile
   Documents/com~apple~CloudDocs/apple-pi/credentials.vault"` in `env.local`
   (or shell). The path is already honored (`vault.js:34`).
3. **Per-device keychain**: each device runs `/vault unlock` once → stores the
   *shared* master passphrase in *its own* keychain (`apple-pi-vault`). The
   passphrase is the one secret NOT in the synced vault (it *opens* the vault).

**Multi-device contention is moot day-to-day (C-2):** the auto-wire is
read-only, so N devices reading one synced vault never conflict. Writes happen
only on interactive `/vault add|rotate|remove` — rare, human-driven, one device
at a time. iCloud's occasional "duplicate on conflict" copy
(`credentials (2).vault`) is handled by **`/vault reconcile`** (VW-P2): detects a
sibling `*.vault`, merges non-conflicting entries by `id`, and reports ids that
differ so the user resolves by hand. No silent merge of divergent secrets.

### F. Why `!command` for provider keys in P3 (the timing constraint)

pi reads `auth.json` at **startup** to get provider keys — *before* extensions
load. So an extension projecting a provider key to a plaintext `auth.json`
can't serve the *current* session (it lands next start). The `!command` form
(`docs/providers.md:129`, verified) resolves at **request time** via a
subprocess and is cached for process lifetime — so it CAN serve the current
session live:

```jsonc
"<provider>": { "type": "api_key", "key": "!<vault-reader> <provider>" }
```

where `<vault-reader>` is a tiny helper (`bin/apple-pi vault-key <id>`) that
reads the keychain passphrase, decrypts the vault, and prints one secret to
stdout. This makes `auth.json` hold **only command pointers** — no plaintext
provider key at rest. P3 is optional (P1's plaintext `auth.json` is the
backward-compatible baseline), but it's the natural endpoint of "single point
of touch" and aligns with the at-rest-shrinking goal.

---

## Requirements (REQ-VW-N)

**Phase 0 — keychain unlock (foundational)**

- **REQ-VW-1** `resolvePassphrase()` returns the first non-empty of
  `CREDENTIALS_VAULT_PASS` env → `security find-generic-password -s
  apple-pi-vault -w` → tty prompt. The keychain tier is **best-effort**: a
  locked/missing keychain falls through to the next tier, never throws.
- **REQ-VW-2** `/vault unlock` stores the entered passphrase into keychain
  service `apple-pi-vault` (account = the user); `/vault lock --keychain`
  deletes it. Both are confirm-gated and never echo the passphrase.
- **REQ-VW-3** A smoke verifies the keychain tier resolves headlessly on the
  mini (probe item round-trip), proving P3 viability per device.

**Phase 1 — the wire (core)**

- **REQ-VW-4** A module `config/extensions/_lib/vault-registry.ts` exposes
  `secret(id): string`, lazily decrypts + memoizes the vault via the existing
  `loadCore` + `readVault`, and **never** writes `process.env`. Missing id or
  locked vault → `""` (graceful, no throw).
- **REQ-VW-5** A `session_start` handler reads `vault.wire` and projects each
  entry: `auth` via `exportToAuth`, `command` via `exportToCommand`. The wire
  is **read-only on the vault** (never encrypts/writes it). A missing/empty
  `vault.wire` is a no-op (zero behavior change for installs that don't opt in).
- **REQ-VW-6** `to: "bridge"` entries populate the registry only; bridges read
  via `secret(id)`. The projection does **not** touch `process.env` for any
  secret. (This is C-1, enforced by SECURITY.md B-VW-1 + a test.)
- **REQ-VW-7** `env.local` continues to carry **non-secret** overrides only;
  `vault.wire` is the secret authority. A bridge wired for a secret in
  `vault.wire` but still reading legacy `process.env.X` degrades gracefully
  (`""`) — no crash, a one-time TUI notice pointing at the bridge edit.
- **REQ-VW-8** `/vault wire [--dry-run]` previews the projection (which id →
  which surface, whether the entry exists) without writing. `--apply` runs it
  on demand outside the `session_start` auto-path.

**Phase 2 — cloud sync**

- **REQ-VW-9** Pointing `CREDENTIALS_VAULT` at an iCloud Drive path requires no
  code change (the path is already configurable); documented in a HowTo +
  `vault.wire` setup. The vault file remains ciphertext (no sync-layer crypto).
- **REQ-VW-10** `/vault reconcile` detects a sibling conflict copy
  (`credentials (2).vault`, iCloud's conflict shape), merges entries by `id`
  where secrets match or one side is absent, and **lists ids whose secrets
  differ** for manual resolution (never silently overwrites a divergent secret).
- **REQ-VW-11** Multi-device setup is documented: shared master passphrase,
  per-device `/vault unlock`, `CREDENTIALS_VAULT` → iCloud path. A smoke
  simulates two vaults (one with an extra entry) and asserts the merge is
  idempotent and divergence-safe.

**Phase 3 — at-rest hardening (optional)**

- **REQ-VW-12** `bin/apple-pi vault-key <id>` prints one secret to stdout
  (passphrase via the tier-2 keychain chain), for use as pi's `!command` target.
- **REQ-VW-13** `/vault wire --p3` rewrites `auth` entries' `auth.json`
  provider blocks to `{ "type":"api_key", "key":"!<vault-reader> <id>" }`,
  removing the plaintext key from `auth.json`. Confirm-gated; reversible
  (`--p1` restores plaintext).

## Decomposition (cards → commits)

Each card is one commit. Phases are sequential (P1 depends on P0; P2/P3 are
independent after P1).

1. **vw-keychain** (P0) — `resolvePassphrase()` keychain tier + `/vault unlock`/
   `lock --keychain`. REQ-VW-1/2/3. Touches `credential-vault.ts` + core.
2. **vw-registry** (P1, foundation) — `_lib/vault-registry.ts` + `secret()`.
   REQ-VW-4. Pure module, unit-testable.
3. **vw-wire** (P1, core) — `vault.wire` map + `session_start` projection +
   `/vault wire`. REQ-VW-5/6/8. Depends on vw-registry.
4. **vw-bridges** (P1, parallelizable) — convert forgejo/netbird/etc. bridges
   to `secret(id)` (one card per bridge, or one card all-at-once). REQ-VW-7.
   Parallel with vw-wire.
5. **vw-sync** (P2) — iCloud path docs + `/vault reconcile`. REQ-VW-9/10/11.
   Depends on P1.
6. **vw-p3** (P3, optional) — `vault-key` helper + `--p3`/`--p1` rewrite.
   REQ-VW-12/13. Independent after P1.

Suggested merge order: 1 → 2 → 3 ‖ 4 → (5 ‖ 6) → PR to `main`.

## Risks / open questions

- **`secret()` timing.** Lazy + memoized means the first call pays the decrypt.
  Bridges that resolve at **module top-level** (`const X = secret(id)`) are fine
  *only if* they import the registry first (import side-effects precede the
  module body, same as envlocal). Bridges that resolve at **call-time** (inside
  handlers) are unconditionally fine. **Recommendation: wire bridges at
  call-time** (idiomatic, fault-isolated). Document the top-level caveat.
- **Eager vs lazy cost.** Lazy avoids decrypting on every pi start. If a bridge
  *must* have the secret at top-level (rare), the eager import variant exists;
  otherwise lazy is strictly cheaper. Settled in vw-registry.
- **Keychain portability.** The keychain tier is macOS-only. On Linux devices,
  tier 2 is absent → falls through to env (tier 1) or tty (tier 3). Document
  that the cloud-synced vault is cross-platform, but keychain unlock is mac-
  specific; Linux devices use `CREDENTIALS_VAULT_PASS` from a wrapper.
- **iCloud Drive not yet enabled on the mini.** Drive is off today (signed into
  iCloud). Enabling is a user GUI step; the vault works locally until then.
- **1Password as a future backend.** iCloud is the zero-code choice; if iCloud
  conflict-copy churn ever bites, a 1Password backend (vault becomes a cache,
  `op` canonical) is the documented upgrade — out of scope here.

## Verification (REQ-VW-V)

- **VW-V-1** `smoke/vault-keychain.sh`: `/vault unlock` → keychain item
  exists → a fresh `pi -p` process resolves the passphrase headless (probe
  round-trip). REQ-VW-1/2/3.
- **VW-V-2** `smoke/vault-registry.sh`: `secret("probe")` returns the stored
  value; `secret("missing")` returns `""`; `process.env` contains **none** of
  the vault secrets (grep assert — the C-1 gate). REQ-VW-4/6.
- **VW-V-3** `smoke/vault-wire.sh`: `vault.wire` with one `auth`, one `bridge`,
  one `command` entry → `/vault wire --dry-run` previews; `--apply` writes
  `auth.json` + agent-secrets; the bridge's tool call resolves the secret.
  REQ-VW-5/8.
- **VW-V-4** `smoke/vault-reconcile.sh`: two vaults (one with an extra entry,
  one with a divergent secret for an existing id) → merge adds the extra,
  **lists** the divergence, never overwrites it. Idempotent on re-run.
  REQ-VW-10/11.
- **VW-V-5** `smoke/sanitize.sh` + `smoke/structure.sh` still green; no personal
  data in the shipped extension; `vault.wire` examples in docs use placeholder
  ids. REQ-VW-9 (docs) + sanitization.

## Out of scope (for this feature)

- **A new crypto or store.** Reuses the credential-vault core + cipher + iCloud
  file sync. No 1Password, no keyring, no DB.
- **OAuth token storage / refresh logic.** Unchanged — stays in pi's
  `auth.json`/`/login`. The vault stores opaque secrets.
- **Rotating the master passphrase.** Separate card (touches every device's
  keychain + re-encrypts the synced vault).
- **A GUI / web view.** The TUI `/vault` commands remain the surface.
- **Auto-discovery of bridges needing secrets.** Each bridge opts in via the
  one-line edit (D). A future lint could flag `process.env.<*_TOKEN>` in bridges.

## See also

- `../credential-vault/SPEC.md` — the store this builds on (REQ-CV-N).
- `../credential-vault/SECURITY.md` — attacker model inherited unchanged (A1–A7).
- `SECURITY.md` (this folder) — the vault-wire red/blue pass, esp. B-VW-1
  (no env injection — the load-bearing decision) + R-VW-1..6.
