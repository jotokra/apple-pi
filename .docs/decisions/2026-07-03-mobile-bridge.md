# 2026-07-03 — apple-pi mobile: iOS app + IAP subscription

**Goal.** Add a paid iOS app to apple-pi that lets users list, read,
search, and resume their `pi` sessions from their phone, exposing the
existing local-JSONL session tree via a self-hosted bridge daemon on
the user's mini (over the existing NetBird overlay) plus an App Store
IAP subscription.

**Why.** The session tree (`~/.pi/sessions/*.jsonl` + the
`session-record` + `long-horizon-compaction` skills) is apple-pi's
most distinctive surface — and right now it's invisible to anyone
not on the same machine. Anyone trying to check on a running agent
session from their phone today has to SSH to their mini and run
`pi -r`, which is the wrong form factor for the 80% use case ("how
is my refactor going?"). A paywall here is honest because the
*value* is the bridge daemon + auth + Apple-distribution surface,
not the LLM (which the user already brings).

**Scope.**
- NEW: `mobile-bridge/` (Node HTTP server, Fastify, ~500-1000 LoC)
- NEW: `ios/` (SwiftUI app, native, ~3000-5000 LoC)
- NEW: `bin/apple-pi mobile ...` CLI subcommands (3-5 lines each,
  delegating to mobile-bridge)
- NEW: `.docs/mobile/SUPERPROMPT.md` v0.2.0 frozen spec
- NEW: `mobile-bridge/bin/bridge.mjs`, package.json, smoke tests
- NEW: 1 Caddy route (`applepi-bridge.<your-domain>`) — config only
- MODIFIED: `.docs/PLAN.md` — NOT modified (stays v1.0.0 of the
  core product); the mobile spec is separate (v0.2.0 lives in
  `.docs/mobile/SUPERPROMPT.md`)
- MODIFIED: `install.sh` — offers to `apple-pi mobile install` at
  the end (decline-able, doesn't auto-run)
- UNCHANGED: `~/.pi/` user state, JSONL format, skills,
  vault record workflow, autoresearch loop

## Decisions locked

- D1 same-repo · D2 self-hosted bridge · D3 IAP-only · D4
  viewer + send-turn · D5 no on-device LLM · D6 one-bridge-per-user
  · D7 JSONL as SoT · D8 Caddy route · D9 iOS 17 min · D10 native
  Swift/SwiftUI · D11 bearer+pairing auth · D12 single sub tier
  · D13 no telemetry.
- See `.docs/mobile/SUPERPROMPT.md` §9 for the full frozen-decisions
  table.

## Phases

| Phase | Scope | Time |
|---|---|---|
| 0 | Bridge MVP (no IAP, no iOS): `mobile-bridge/bin/bridge.mjs` + `apple-pi mobile {start,stop,status,install,pair-device}` + smoke tests | 1-2 wk |
| 1 | IAP receipt validation + token issuance | 1 wk |
| 2 | iOS app shell (read-only viewer) + App Store Connect listing | 3-4 wk |
| 3 | iOS app: send-a-turn + SSE reply streaming | 2-3 wk |
| 4 | iOS app: voice-in + share-via-gist + App Review prep | 2-3 wk |
| 5 (post) | Multi-bridge sync, hosted bridge, Android, etc. | TBD |

## Open questions (deferred to phases)

- **OQ-3** `pi -c <uuid> -p "<msg>"` — does it append to the existing
  JSONL, or start a fresh one? Phase 0 resolves this.
- **OQ-4** Demo bridge for App Review (R7) — only build if App
  Review rejects.
- **OQ-5** Annual sub tier (R6) — default no; revisit post-launch.

## Risks — see SUPERPROMPT.md §10 for the full table

- R1 (App Store 3.1.5a), R2 (Apple Developer Program enrollment),
  R3 (TestFlight 90-day wait), R4 (`pi -c` semantics — load-bearing
  for D7!), R5 (Caddy CA rotation + iOS trust), R6 (price point),
  R7 (Apple "useful without own server" reject), R8 (iOS-on-device
  ASR vs pivoice), R9 (no-running-pi fallback), R10 (MIT-but-paid
  user perception).
