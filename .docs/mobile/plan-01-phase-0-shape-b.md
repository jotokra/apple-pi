# apple-pi mobile — Phase 0 (Bridge MVP) Shape B

> **For the-agent:** Use subagent-driven-development / kanban-orchestrator
> to execute task-by-task. Every task = one card = one commit.
> TDD-first per existing apple-pi convention (`smoke/<name>.sh`).

**Goal:** A running bridge daemon on the mini that can answer
`GET /health` + `GET /sessions` + handle a pairing-code → bearer-token
exchange. No IAP, no iOS app, no auth beyond pairing — local-only and
smoke-tested end-to-end. By Phase 0 end, `curl localhost:7892/v1/sessions`
should return your JSONL list.

**Architecture:** Node 20 ESM + Fastify 5 + better-sqlite3 (pairing
codes) + zod (schemas). One process, listens on `127.0.0.1:7892`. Caddy
fronts it at `applepi-bridge.<your-domain> { tls internal reverse_proxy
127.0.0.1:7892 }`. State file at `mobile-bridge/var/state.json` mode
0600.

**Tech stack:** Node 20+, ESM, Fastify 5, @fastify/websocket,
better-sqlite3, zod. ~150 KB installed. No compile step.

---

## Task 0: Bootstrap `mobile-bridge/` package

**Files:** Create `mobile-bridge/package.json`, `mobile-bridge/.gitignore`,
`mobile-bridge/README.md`, `mobile-bridge/bin/bridge.mjs`.

**Step 1: Write package.json**

```json
{
  "name": "apple-pi-mobile-bridge",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node bin/bridge.mjs",
    "smoke": "bash smoke/run.sh"
  },
  "dependencies": {
    "fastify": "^5.0.0",
    "@fastify/websocket": "^11.0.0",
    "better-sqlite3": "^11.0.0",
    "zod": "^3.23.0"
  }
}
```

**Step 2: Write `.gitignore`** — ignore `var/`, `node_modules/`,
`*.log`, `*.sqlite`.

**Step 3: Write the README** — 50 lines: what it is, how to run, the
two routes it currently exposes, and that this is Phase 0 (no auth,
no IAP yet).

**Step 4: Run `npm install`** to populate `node_modules/` + a
`package-lock.json` (committed; apple-pi already commits lockfiles).

**Step 5: Commit**

```bash
git add mobile-bridge/package.json mobile-bridge/.gitignore \
        mobile-bridge/README.md mobile-bridge/package-lock.json
git commit -m "feat(mobile-bridge): Phase 0 package skeleton (Fastify, zod, sqlite)"
```

---

## Task 1: Fastify server boots + `GET /health`

**Files:** Create `mobile-bridge/bin/bridge.mjs`,
`mobile-bridge/smoke/health.sh`.

**Step 1: Write the failing smoke test**

```bash
# mobile-bridge/smoke/health.sh
#!/usr/bin/env bash
set -euo pipefail
PORT="${BRIDGE_PORT:-7892}"
RESP=$(curl -fsS "http://127.0.0.1:${PORT}/v1/health")
if ! grep -q '"ok":true' <<<"$RESP"; then
  echo "FAIL: $RESP"; exit 1
fi
echo "PASS: $RESP"
```

**Step 2: Run it — expect FAIL** ("connection refused")

**Step 3: Write the minimal bridge to pass**

```js
// mobile-bridge/bin/bridge.mjs
import Fastify from "fastify";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = Number(process.env.BRIDGE_PORT ?? 7892);
const HOST = process.env.BRIDGE_HOST ?? "127.0.0.1";
const __filename = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(__filename), "..", "..");

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
});

app.get("/v1/health", async () => ({
  ok: true,
  version: "0.1.0",
  uptime_s: Math.floor(process.uptime()),
}));

await app.listen({ port: PORT, host: HOST });
console.log(`apple-pi-mobile-bridge v0.1.0 listening on http://${HOST}:${PORT}`);
```

**Step 4: Run `node bin/bridge.mjs` in background, run smoke test,
expect PASS; kill server.**

**Step 5: Commit**

```bash
git add mobile-bridge/bin/bridge.mjs mobile-bridge/smoke/health.sh
git commit -m "feat(mobile-bridge): Fastify boot + GET /v1/health"
```

---

## Task 2: Session listing derived from `~/.pi/sessions/*.jsonl`

**Files:** Modify `mobile-bridge/bin/bridge.mjs`,
`mobile-bridge/lib/sessions.mjs`, `mobile-bridge/smoke/sessions.sh`.

**Step 1: Write `mobile-bridge/lib/sessions.mjs`** — given a JSONL
path, parse and return: `id` (UUID from filename), `started_at`,
`ended_at` (last message timestamp), `last_activity_at`,
`current_status` ("running" if last activity < 5 min ago else "idle"),
`model`, `branch_count`, `msg_count`, `size_bytes`. Don't try to
be clever; a single pass through the JSONL is fine.

**Step 2: Write `mobile-bridge/smoke/sessions.sh`** — starts the
bridge, expects ≥1 session in `~/.pi/sessions/` (the user's actual
sessions; the smoke test asserts only the JSON shape, not the count),
curls `GET /v1/sessions` and validates each row has all 9 fields.

**Step 3: Run smoke — FAIL** (no /v1/sessions route yet)

**Step 4: Add the route** to `bridge.mjs`:

```js
import { listSessions, SESSIONS_DIR } from "./lib/sessions.mjs";
// ...inside app:
app.get("/v1/sessions", async () => ({
  schema_version: 1,
  sessions: await listSessions(SESSIONS_DIR),
}));
```

where `SESSIONS_DIR` defaults to `$HOME/.pi/sessions` and is overridable
via the `PI_SESSIONS_DIR` env var.

**Step 5: Run smoke — PASS**

**Step 6: Commit**

```bash
git add mobile-bridge/bin/bridge.mjs mobile-bridge/lib/sessions.mjs \
        mobile-bridge/smoke/sessions.sh
git commit -m "feat(mobile-bridge): GET /v1/sessions derived from JSONL"
```

---

## Task 3: Pairing-code issuance + bearer-token exchange

**Files:** Modify `mobile-bridge/bin/bridge.mjs`,
`mobile-bridge/lib/pairing.mjs`, `mobile-bridge/lib/state.mjs`,
`mobile-bridge/var/` (created at runtime),
`mobile-bridge/smoke/pair.sh`.

**Step 1: Write `mobile-bridge/lib/state.mjs`** — a tiny module that
loads/saves `var/state.json`. Mode 0600 enforced on the file. Returns
`{ pairs: [], session_state: {} }` if missing.

**Step 2: Write `mobile-bridge/lib/pairing.mjs`** — exports:

```js
export function issueCode()             // returns { code, expires_at } (10-min TTL)
export function consumeCode(code)        // returns { pair_id, token } or throws
```

The code is 6 random alphanumeric chars (collision probability with
10-min rotation is fine). The token is a 32-byte hex secret.

**Step 3: Write `mobile-bridge/smoke/pair.sh`** — calls
`POST /v1/pair/issue` (no auth), saves the code; calls `POST /v1/pair`
with the code; expects a bearer token; calls `GET /v1/sessions` with
`Authorization: Bearer *** expecting 200.

**Step 4: Add routes to `bridge.mjs`**:

```js
// pre-auth
app.post("/v1/pair/issue", async () => pairing.issueCode());
app.post("/v1/pair", async (req) => pairing.consumeCode(req.body.code));
// post-pair (any of these require Bearer)
app.addHook("preHandler", async (req, reply) => {
  if (req.url === "/v1/health" || req.url.startsWith("/v1/pair")) return;
  const auth = req.headers.authorization ?? "";
  const token = auth.replace(/^Bearer\s+/, "");
  if (!state.findPairByToken(token)) return reply.code(401).send({ error: "unauthorized" });
});
```

**Step 5: Run smoke — PASS (3 stages)**

**Step 6: Commit**

```bash
git add mobile-bridge/bin/bridge.mjs mobile-bridge/lib/pairing.mjs \
        mobile-bridge/lib/state.mjs mobile-bridge/smoke/pair.sh
git commit -m "feat(mobile-bridge): pairing-code → bearer-token auth"
```

---

## Task 4: Session tree endpoint

**Files:** Modify `mobile-bridge/bin/bridge.mjs`,
`mobile-bridge/lib/tree.mjs`, `mobile-bridge/smoke/tree.sh`.

**Step 1: Write `lib/tree.mjs`** — parse the JSONL into a parent-child
tree (each message has a `parent_id` field per Pi's session schema;
this is a one-pass build). Returns a nested JSON. Stream as NDJSON
optional — not needed for v0.1.

**Step 2: Add `GET /v1/sessions/:id/tree`** that returns the tree.

**Step 3: Write smoke** — picks any session, calls the route, asserts
first node has `parent_id: null` and at least one child.

**Step 4: Run smoke — PASS**

**Step 5: Commit**

```bash
git add mobile-bridge/bin/bridge.mjs mobile-bridge/lib/tree.mjs \
        mobile-bridge/smoke/tree.sh
git commit -m "feat(mobile-bridge): GET /v1/sessions/:id/tree"
```

---

## Task 5: Session JSONL stream (read-only)

**Files:** Modify `bridge.mjs`, smoke/raw.sh.

**Step 1: Write the route** — `GET /v1/sessions/:id/raw` returns
`application/x-ndjson` by piping the JSONL through (Fastify's
`reply.send(stream)` pattern).

**Step 2: Write smoke** — picks a session, curls with
`-H "Accept: application/x-ndjson"`, asserts first line is valid JSON
with a `role` field.

**Step 3: Run smoke — PASS**

**Step 4: Commit**

```bash
git add mobile-bridge/bin/bridge.mjs mobile-bridge/smoke/raw.sh
git commit -m "feat(mobile-bridge): GET /v1/sessions/:id/raw (NDJSON stream)"
```

---

## Task 6: Heartbeat + status (advisory only)

**Files:** Modify `bridge.mjs`, lib/state.mjs, smoke/heartbeat.sh.

**Step 1: Write `POST /v1/sessions/:id/heartbeat`** — takes a body
with `{ status, model?, branch_count? }` and writes to
`session_state`. Auth required.

**Step 2: Write smoke** — issue pair → POST heartbeat for a fake
session ID → GET /v1/sessions/fake-id returns the heartbeat-derived
status.

**Step 3: Commit**

```bash
git add mobile-bridge/bin/bridge.mjs mobile-bridge/lib/state.mjs \
        mobile-bridge/smoke/heartbeat.sh
git commit -m "feat(mobile-bridge): POST /v1/sessions/:id/heartbeat"
```

---

## Task 7: `apple-pi mobile` CLI subcommands

**Files:** Modify `bin/apple-pi`, `lifecycle/mobile.sh` (new),
`lifecycle/lib/mobile-bridge-launchd.plist` (new — template).

**Step 1: Write `lifecycle/mobile.sh`** — accepts `{start, stop,
status, install, uninstall, pair-device}`. Delegates to `node
mobile-bridge/bin/bridge.mjs` or `launchctl load/bootout`.

**Step 2: Add `case "mobile": return spawnSync(...)` to `bin/apple-pi`'s
main()**, matching the existing pattern (see `schedule` and `vault`
cases).

**Step 3: Write smoke** — `apple-pi mobile status` exits 0 (no
matter what state); `apple-pi mobile install` writes a LaunchAgent
to `~/Library/LaunchAgents/local.mobile-bridge.plist`; `apple-pi
mobile uninstall` removes it. No bridge running is fine.

**Step 4: Test the round trip manually:**

```bash
apple-pi mobile install
launchctl load ~/Library/LaunchAgents/local.mobile-bridge.plist
sleep 2
curl localhost:7892/v1/health
apple-pi mobile status
launchctl bootout gui/502/local.mobile-bridge 2>/dev/null
```

**Step 5: Commit**

```bash
git add bin/apple-pi lifecycle/mobile.sh \
        lifecycle/lib/mobile-bridge-launchd.plist
git commit -m "feat(mobile): apple-pi mobile {start|stop|status|install|...} subcommands"
```

---

## Task 8: Caddy route + publish Phase 0

**Files:** Modify `config/caddy/sites/local.mobile-bridge.site`
(new), `smoke/smoke-caddy-routes.sh` (new — verify route is
served).

**Step 1: Write the site file**

```
applepi-bridge.<your-domain> {
  tls internal
  reverse_proxy 127.0.0.1:7892
}
```

**Step 2: Add the import to `config/caddy/local-imports.conf`**

```
import /opt/homebrew/etc/caddy/applepi-bridge.site
```

This step requires `sudo cp` + Caddy reload (acquires the cert the
first time).

**Step 3: Add a smoke** that curls
`https://applepi-bridge.<your-domain>/v1/health` from the host LAN and
expects 200.

**Step 4: Commit + tag**

```bash
git add config/caddy/local-imports.conf config/caddy/sites/local.mobile-bridge.site
git commit -m "feat(mobile): Caddy route applepi-bridge.<your-domain> → :7892"

git tag -a apple-pi-mobile-v0.1.0 -m "Phase 0: bridge MVP"
```

---

## Phase 0 acceptance

- [ ] `npm start` in `mobile-bridge/` boots the bridge.
- [ ] `apple-pi mobile install` registers the LaunchAgent.
- [ ] `curl applepi-bridge.<your-domain>/v1/health` returns `{ok:true}`.
- [ ] `curl -H "Authorization: Bearer $TOKEN" applepi-bridge.<your-domain>/v1/sessions`
      returns a JSON list of your real JSONL sessions.
- [ ] `apple-pi mobile pair-device` issues a code that can be exchanged.
- [ ] All 6 smoke tests pass.
- [ ] Phase 0 risks OQ-3 (does `pi -c <uuid> -p ...` append?) is
      resolved — either confirmed working, or Phase 0 includes a
      workaround (sentinel-file, manual proxy mode, or `pi` patch).
- [ ] Working-state note `plan-02-phase-0-shipped.md` written at
      `~/Projects/gh/apple-pi/.docs/mobile/`.

## Out of scope for Phase 0 (Phase 1+)

- IAP receipt validation.
- iOS app of any kind.
- Caddy root CA distribution to non-host devices.
- Send-a-turn (POST /turns).
- SSE reply streaming.
- Voice-in.
- Sharing via gist.
