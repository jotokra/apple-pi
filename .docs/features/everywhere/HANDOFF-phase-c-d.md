# Handoff — Phase A + B done; C + D next

> Pickup here. Read this first, then `VISION.md` + the PHASE-A/PHASE-B specs
> for depth.

## State at handoff (2026-06-29)
- **repo**: `main` @ `8616af6`, in sync with remote, **working tree clean**
- **smoke**: 158 OK / 0 FAIL (full `bash smoke/run.sh`)
- **live install** (`~/.pi`): all 6 extensions registered, `/ingress` `/sources`
  `/vault` `/voice` all resolve (your model @ xhigh), no seed marker, no orphans
- **vision**: the two **core primitives** are shipped + red-team-pinned:
  - **Phase A (adapters)** — any MCP server → pi tools (`mcp__<server>__<tool>`);
    OpenAPI specs → tools too. Dogfooded: a live turn called
    `mcp__fs__list_directory` through the filesystem MCP server.
  - **Phase B (ingress)** — RSS/JSON/webdiff pollers → scheduled digest into a
    session, wrapped `[INGRESS · UNTRUSTED]` with `<tool_use>` stripping.
    Security gate (`smoke/ingress-injection.sh`) proven against a hostile feed.

## What's left (the vision's two remaining phases)

### Phase C — surfaces ("lives everywhere")
The agent can now *receive* events (B) and *call* anything (A); **C is how it
reaches the user** from phone/anywhere. From `VISION.md` P4 + P6:
- **C-1 Telegram full-duplex**: promote the existing `telegram.ts` from
  outbound-replies to a real surface — user prompts from phone, agent can ask
  back (select/confirm over chat), results stream. Cheapest phone surface, ~zero
  new infra. **Start here.**
- **C-2 unified `notify()`**: one primitive the agent calls; settings route it
  to whatever surfaces exist (Telegram, macOS notif, webhook, email). Means
  "the agent reaches me wherever I am" without per-channel code.
- **C-3 PWA `/m`** (later, only if Telegram proves limiting): small backend
  proxying to the harness over the ingress bus. Real "app" feel, no app store.

**Phase C red/blue** is lighter than B (no new inbound attack surface beyond
what Telegram bot APIs already enforce) — but destructive actions from the
phone need a *higher* confirm bar (the persona rule is surface-agnostic; C
just needs the phone path to honor it).

### Phase D — polish + ecosystem
- **D-1 MCP Registry browser** (`/sources browse mcp`) — discover/install
  servers from the MCP Registry without copy-pasting npx commands.
- **D-2 vault reveal audit log** — every `/vault get` appends to a tamper-evident
  log; the vault's blast radius grew a lot in A/B, worth the trail.
- **D-3 cookbook** — recipes: "watch a GitHub repo's issues → summarize daily"
  (ingress + MCP), "voice-control my n8n" (voice + n8n bridge), etc.
- **D-4 OpenAPI loader hardening** (A-7 was a stretch; smooth YAML edge cases,
  OAuth flows, multipart) — or adopt an upstream `openapi-to-mcp` tool.

## Process notes (so C/D don't re-hit these)
- **Always `git add -A` + audit `git diff --cached --stat` before commit.** I
  missed staging the same way 3× (e594f51, e2404f3, 77bcbc9) — files edited but
  not staged, smokes passed against the working tree masking the gap.
- **Commit on the right branch.** Mid-Phase-B I committed 6 commits to
  `feat/config-sync` (a separate PR branch) instead of `main`; they silently
  weren't on main until I reconstructed. `git branch --show-current` before
  every commit.
- **Extension loading**: pi auto-loads from `~/.pi/extensions/` BUT only if
  listed in `settings.extensions` (the discovery nuance). When you add a new
  extension in C/D, update BOTH the install.sh copy AND remember the live
  install needs the settings entry too.
- **TS extensions load via jiti**; pi does NOT await an async factory's internal
  awaits before collecting tools — use synchronous factory + `session_start`
  (see `mcp-bridge/index.ts`). `__dirname` misresolves under jiti — use
  `import.meta.url` + `createRequire`.
- **SDK `inMemory` snapshots tools before `session_start`** — extension smokes
  must use real `pi --mode rpc`, not the SDK inMemory path.
- **sanitize runs pre-commit, always**. Your current model id is on the
  forbidden-token list — don't reference it in any shipped content.

## Where everything lives
- `.docs/features/everywhere/VISION.md` — the whole vision + 3-axis reframing
- `.docs/features/everywhere/PHASE-A-SPEC.md` (mcp-bridge) · `PHASE-B-SPEC.md` (ingress)
- write `PHASE-C-SPEC.md` + `PHASE-D-SPEC.md` before building those (spec-first)
- code: `mcp-bridge/` (A) · `ingress/` (B) · `config/extensions/telegram.ts` (C-1 start)
- smokes: `smoke/mcp-*.sh` (6) · `smoke/ingress-*.sh` (4) — the pinned contracts

## First step when you pick up
`git pull`, `bash smoke/run.sh` (expect 158 OK), then read this file +
`VISION.md` and pick: **C-1 (Telegram full-duplex)** is the recommended start —
highest user value, lowest risk, builds on everything A/B already proved.
