# 2026-06-29 — Env injection for generic extensions (D1a)

Status: **plan** (mechanism design + options; no code). Unblocks retiring the
5 bridge overrides in `pi-config` (D1b) so they inherit apple-pi generic.
Author: Pi session 2026-06-29. Refreshed after discovering `apple-pi sync`
(config-sync) shipped to `main` via PR #7 the same day — the extension
points below now reference the **shipped** `sync/lib/paths.js` + `profile.js`,
not a future land plan.

## TL;DR

apple-pi's generic bridges are written `const BASE = process.env.X ?? ""`
(portable, no baked host). On this device, host URLs (`git.example.com`,
`n8n.example.com`, …) currently reach the bridges by **forking each bridge into
the `pi-config` overlay with a baked default** (D1b). That works but
duplicates 5 files and blocks generic updates. **D1a = keep bridges generic,
deliver device values another way.** pi's *built-in* env injection is
provider-scoped (auth.json `env` block; `$VAR`/`!command` for apiKey/headers)
and does **not** reach extension `process.env` — so a mechanism outside pi
core is needed. Recommended mechanism: a thin **launch wrapper that sources
a gitignored, device-local `env.local`** (E1), because the bridge values are
**non-secret LAN hostnames** (keys already live in `auth.json`/the vault) —
plaintext device-local is the correct tier. `env.local` gets classified by
the **shipped** `sync/lib/paths.js` as device-local/secret → never tracked.

## 1. The constraint (verified from pi docs, not assumed)

pi injects environment in exactly two places, **both provider-scoped**
(`docs/providers.md` §"provider-scoped environment values", `docs/models.md`
§apiKey, `docs/custom-provider.md`):

- **`auth.json` per-provider `env` block** — injects vars used when resolving
  *that provider's* key/headers/config (Cloudflare account ID, Vertex
  project, `HTTP_PROXY`, …). Scope: provider resolution only.
- **Value interpolation** — `key`/header values accept `$ENV_VAR`,
  `${ENV_VAR}`, `!command`. Scope: provider apiKey/headers only.

Extensions are **not** providers. A bridge does
`process.env.FORGEJO_BASE_URL ?? ""` at **module top level** (evaluated once
at load). Neither pi mechanism populates `process.env` for extension code.
**Conclusion: pi core cannot deliver these values today.** (If pi later adds
a general `env` key to `settings.json`, revisit — that would make E0 = native
and this collapses to "set it in settings.")

## 2. What kind of value are we even injecting? (decides the tier)

| Value | Example | Secret? | Today's home |
|-------|---------|---------|--------------|
| Bridge host URL | `https://git.example.com` | **No** (LAN hostname) | baked in overlay bridge |
| Bridge API key | `FORGEJO_TOKEN` | **Yes** | `auth.json` / agent-secrets store |
| Path | `~/tasks.db` | No | baked (`kanban-bridge`) |
| Telegram group/thread id | `-100XXXXXXXXXX` | No (but private-ish) | baked (`telegram-pi-topic`) |

**The bridge URL problem is a non-secret, device-local problem.** Keys are
already solved (auth.json). So the mechanism need not be encrypted-at-rest —
it must be **device-local (never synced)** and **present at process start**.
This rules *in* a plaintext device-local file and rules *out* any design that
ships URLs in a synced repo.

## 3. Options

- **E1 — launch wrapper + `env.local` (RECOMMENDED for v1).**
  apple-pi ships a `pi` shim (or an `apple-pi run` subcommand) that sources
  `~/.pi/agent/env.local` (mode 0600, gitignored, **device-local**) then
  `exec`s the real pi. Bridges stay 100% generic; `process.env` is populated
  before any extension loads.
  - *Pro:* zero bridge code; works for headless `pi -p` (cron/Telegram);
    trivially auditable; `env.local` is classified device-local/secret by the
    shipped `sync/lib/paths.js` → never tracked.
  - *Con:* one indirection on the `pi` launch path; env.local is plaintext
    (acceptable per §2).
- **E2 — bridges read a config file.** Generic bridges read
  `~/.pi/agent/bridge-env.json` (gitignored) instead of `process.env ?? ""`.
  No wrapper.
  - *Pro:* no launch-path change; values load lazily.
  - *Con:* every bridge gains file-read boilerplate (or a shared helper);
    changes the generic bridge contract (must be agreed upstream in
    apple-pi/config); doesn't help non-bridge extensions.
- **E3 — vault-backed.** Bridges read URLs/paths from the credential vault
  (`vault/lib/vault.js` already lists "gateway URLs" as a supported entry
  kind). `/vault add` for `FORGEJO_BASE_URL`, etc.
  - *Pro:* encrypted at rest; reuses existing infra; one secret store.
  - *Con:* vault unlock needs a passphrase at pi start — **must verify**
    headless `pi -p` (cron/Telegram bridge) can unlock non-interactively,
    else E3 breaks the unattended paths. Overkill for non-secret URLs.
- **E4 — config-sync `profile.js` device fields.** The **shipped**
  `sync/lib/profile.js` settings.json portable/device split handles *settings*
  device fields, not arbitrary extension env. Partial fit only; not a general
  answer. (Confirmed: profile.js touches compaction/theme/extensions/skill
  toggles — not `process.env` for bridge code.)

## 4. Recommendation + migration (D1b → D1a)

**Ship E1.** Concretely:

1. **apple-pi side (extends the shipped sync feature):**
   - Add a launch wrapper (`bin/pi` or `apple-pi run`) that sources
     `~/.pi/agent/env.local` (0600) before `exec`ing pi.
   - Extend the **shipped** `sync/lib/paths.js` classification to include
     `agent/env.local` → device-local/secret (default-deny → never tracked;
     the secret hook refuses it on force-add, same path as `auth.json`).
   - REQ-E1-1: a bridge tool call returns real data with env.local set,
     generic bridge inherited (no overlay fork).
   - REQ-E1-2: `smoke/sync-gitignore.sh` confirms `env.local` is in the
     generated default-deny gitignore + `smoke/sync-init.sh`'s hook-run
     refuses it on force-add.
2. **pi-config side (D1a migration, once E1 ships):**
   - Write `~/.pi/agent/env.local` with this device values:
     `FORGEJO_BASE_URL=https://git.example.com`,
     `N8N_BASE_URL=https://n8n.example.com`, `LLM_SIDECAR_URL=…`,
     `KANBAN_DB_PATH=…`, `TELEGRAM_PI_GROUP=…`, `TELEGRAM_PI_THREAD=…`.
   - Drop the 5 bridge overrides from `overlay/extensions/`
     (`forgejo/n8n/kanban/llm-sidecar/netbird-status`) → inherit apple-pi
     generic. Keep `mcp-bridge/`, `telegram-pi-topic.ts` (additions; its
     group/thread could move to env.local too), `sysinfo-guard.ts`
     (reconcile separately).
   - `apply.sh` regenerates; `pi` runs under the wrapper.
3. **Upgrade path E1 → E3:** if a device value becomes genuinely secret,
   move it from `env.local` to the vault and have the wrapper `/vault get`
   it (or use `/vault export-to` to hydrate env.local at launch). The
   wrapper is the stable seam; the storage backend swaps behind it.

## 5. Why not do D1a right now (honest)

E1 needs an apple-pi-side wrapper + a `paths.js` classification entry. The
classification engine now exists (shipped), so the apple-pi-side work is
smaller than when first estimated: ~1 commit (wrapper) + ~1 commit
(paths.js entry + smoke). D1b (baked overlay bridges) costs 5 duplicated
files but **works today** and was the right call at the 2026-06-29 migration.
Then the §4.2 migration is ~1 pi-config commit.

## 6. Risks

- **Headless unlock (E3 only):** if we later pick E3, the cron/Telegram
  `pi -p` path must unlock the vault without a TTY. E1 has no such risk.
- **Wrapper portability:** the shim must resolve the real pi across install
  methods (npm global, bun binary, brew) AND the source-checkout case (see
  §7). Reuse pi's own `detectInstallMethod()` logic rather than hardcoding.
- **Double-source footgun:** if a value is in BOTH env.local and auth.json,
  define precedence (auth.json wins for provider keys; env.local for
  extension env — they don't overlap by scope, so this is naturally clean).
- **Sync leakage:** env.local MUST be in the default-deny gitignore + hook.
  REQ-E1-2 is the tripwire. (Default-deny means a new file is ignored until
  allowlisted, so the failure mode is "stops syncing," not "leaks" — same
  safety net as R1 in the config-sync spec.)

## 7. Discovery (2026-06-29): mini has no global `apple-pi` binary

While reconciling, found mini runs apple-pi **from source** (`node
~/Projects/apple-pi/bin/apple-pi`); there is no `apple-pi` on PATH and no
`~/.apple-pi/bin/apple-pi`. The shipped sync `pre-commit` hook shim resolves
its delegate via `command -v apple-pi` → `~/.apple-pi/bin/apple-pi`, finds
neither, and **fails closed** (refuses to commit — the safe default). On
mini this surfaces as 3 sync smokes failing (`sync-init`, `sync-pushpull`,
`sync-consolidate` — all commit-dependent). Proven not-a-bug: prepending the
source `bin/` to PATH makes the hook resolve and all three pass.

Two consequences for D1a:
- The E1 wrapper's binary-resolution logic (§6) MUST handle the
  source-checkout install (a third path beyond PATH/`~/.apple-pi/bin`), or
  mini hits the same fail-closed wall. Likely fix: also try
  `$APPLE_PI_DIR/bin/apple-pi` (mirrors `apply.sh`'s `APPLE_PI_DIR` env).
- Separately worth a small apple-pi enhancement: the hook shim could gain an
  `APPLE_PI_BIN` env override / source-checkout probe so dev installs work.
  Out of D1a's scope but discovered here — flag for a `fix(sync)` card.

## See also
- `.docs/decisions/2026-06-28-config-sync-feature.md` — the **shipped**
  config-sync spec (S-0..S-9 done, merged via PR #7). `paths.js` +
  `profile.js` are the extension points for §4.1.
- `sync/lib/paths.js` / `sync/lib/profile.js` — the shipped classification +
  settings-split this feature extends.
- `pi-config/.docs/decisions/2026-06-29-config-sync-overlay.md` §5 D1/D1a/D1b
  — the original decision record where D1a was deferred to this doc.
- `pi-config/overlay/extensions/*-bridge.ts` — the 5 D1b forks this retires.
- pi `docs/providers.md` §"provider-scoped environment values" — proof that
  pi's env injection doesn't reach extensions (§1).
