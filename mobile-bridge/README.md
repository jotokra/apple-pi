# apple-pi-mobile-bridge

Local HTTP bridge that exposes the apple-pi `pi` session tree to the
iOS app (and any other first-party client) over HTTPS. Runs on the
mini, fronted by Caddy at `applepi-bridge.<your-domain>`.

This package is part of the apple-pi [mobile
v0.2.0 spec](../.docs/mobile/SUPERPROMPT.md) and follows the
[Phase 0 Shape B plan](../.docs/mobile/plan-01-phase-0-shape-b.md).

## Status: Phase 0 (T0: package skeleton only)

This commit ships only the npm package metadata (`package.json`,
`.gitignore`, this README, and a populated lockfile). The server
binary (`bin/bridge.mjs`) lands in Task 1 — the card list here
describes the Phase 0 *target* so the README is stable as Tasks 1-8
land:

- **No auth.** Task 3 adds pairing-code → bearer-token exchange; until
  then the bridge binds to `127.0.0.1` only and trusts the loopback
  boundary.
- **No IAP.** Subscription / App Store receipt validation is a
  Phase 1 concern (superprompt §3 → UC-4).
- **No `bin/bridge.mjs` yet.** This package imports cleanly but does
  not expose anything until Task 1.

## What it does (Phase 0 target)

- `GET  /v1/health` — liveness probe (`{ ok: true, version, uptime_s }`).
- `GET  /v1/sessions` — list of JSONL sessions under `~/.pi/sessions/`,
  with `{ id, started_at, ended_at, last_activity_at, current_status,
  model, branch_count, msg_count, size_bytes }` per row.

Phase 1+ adds pairing (`POST /v1/pair` + `/v1/pair/issue`), the
session tree (`/v1/sessions/:id/tree`), NDJSON stream
(`/v1/sessions/:id/raw`), and the send-a-turn endpoint.

## Run

```bash
# from this directory
npm start          # node bin/bridge.mjs  (after Task 1 lands)
# or, ad hoc:
BRIDGE_PORT=7892 BRIDGE_HOST=127.0.0.1 node bin/bridge.mjs
```

Defaults: `127.0.0.1:7892` (matches Caddy route
`applepi-bridge.<your-domain> → 127.0.0.1:7892`).

Caddy fronts it:

```
applepi-bridge.<your-domain> {
  tls internal
  reverse_proxy 127.0.0.1:7892
}
```

## Deps

| Package | Why |
|---|---|
| `fastify@^5` | HTTP server + plugin ecosystem |
| `@fastify/websocket@^11` | streaming for `POST /turns` (Phase 1) |
| `better-sqlite3@^11` | pairing-code / state persistence |
| `zod@^3` | single source of truth for request/response schemas |

Total installed size ~150 KB. No build step. ESM (`"type": "module"`).

## Smoke

`npm run smoke` runs `../smoke/run-mobile-bridge.sh` once it's added
in a later task; each per-route smoke (health, sessions, pair, tree,
raw, heartbeat) is a `mobile-bridge/smoke/<name>.sh` script that boots
the bridge, curls it, asserts, and tears it down.
