# apple-pi mobile — Product Spec (v0.2.0, frozen)

> **Frozen spec — v0.2.0.** Edits require a version bump + a working-state
> note in `.docs/decisions/`. The companion working-state notes
> (`plan-NN-*.md`) capture decisions that aren't visible in `git log`.

---

## 1. Project identity

| Key | Value |
|---|---|
| Repo | `~/Projects/gh/apple-pi/` (same repo as core apple-pi) |
| New paths under that repo | `.docs/mobile/` (this spec + working-state), `mobile-bridge/` (Node HTTP server), `ios/` (SwiftUI app) |
| Remote | `github.com/jotokra/apple-pi` (existing) |
| Owner | @jotokra (jay) |
| Sovereignty posture | LAN-first; reach via the existing NetBird overlay (`apple-pi-mobile-bridge` is self-hosted, exposed only to enrolled NetBird peers) |
| Status | **v0.2.0 frozen spec, no code yet** |

---

## 2. The greater goal

**One sentence:** A paid iPhone app that lets apple-pi users list, read,
search, and resume their `pi` sessions from anywhere on their phone,
without SSH — turning the local JSONL session tree into a mobile-first
surface.

**What makes this non-trivial:**

- The current "remote access" story for apple-pi users is "SSH to your
  mini, run `pi -r`, read the JSONL." That's high friction for the
  80% use case ("I want to see what the agent did this morning on my
  phone, on the train").
- Sessions are a *first-class* apple-pi surface (the `session-record` +
  `long-horizon-compaction` skills are core to the product). Right
  now they're invisible to anyone not on the same machine.
- A paywall here is honest: users pay for the bridge daemon (always-on
  server, auth, App Store distribution) — not for the LLM, which they
  already bring.

**Anti-features (scope this is NOT):**

- **NOT a cloud-hosted LLM service.** The LLM stays wherever the user
  already runs it. The bridge just *talks to sessions*.
- **NOT a phone-first reimplementation of `pi`.** No on-device LLM,
  no forked session tree, no "compete with ChatGPT." The phone is a
  thin viewer/controller; the heavy lifting stays on the mini.
- **NOT multi-tenant.** One bridge instance per user, talking to one
  mini. No "apple-pi cloud" v0. Hosted bridge is a possible v2 only.
- **NOT a CLI for everything.** The phone's job is *browse + send a
  turn + get a reply*. Long-running interactive sessions (tool spam,
  huge file diffs) belong on a laptop over SSH.
- **NOT a generic OAuth/session API.** If a tool other than the
  official iOS app wants to talk to the bridge, it'll get a token
  anyway. The bridge is a *product surface*, not a generic platform
  — keep it small.

---

## 3. Use cases (anchor stories)

### UC-1 — Resume on the train

> I left the house with `pi` running a 3-hour refactor on my mini. On
> the train, I open the apple-pi iOS app and see the session is
> *running*. The latest message is a tool error. I tap the session,
> see the full turn including the bash that failed, send a one-line
> clarification ("the docker socket is at `/var/run/docker.sock` not
> `~/.docker`"), and watch the agent's next turn stream back as I
> type my reply.

Why it matters: **remote visibility into + control over a live agent
session, from the most common form factor after the laptop.**

### UC-2 — Read past sessions like a journal

> Last week the agent made a config change I forgot about. I open the
> app, scroll the session list, search "fstrim," tap the session, and
> read the relevant turns. I share the session as a link via
> iMessage to a colleague.

Why it matters: **the vault records are greppable and the JSONL is
file-shaped — both are already a "journal."** The app makes that
journal browseable.

### UC-3 — Voice-in a turn while away from keyboard

> I'm at the supermarket. I want the agent to start a long task that
> I'll read later. I open the app, tap the active session, hold the
> mic button, dictate "start a kanban card for P3 of aether, write
> the body, do not commit yet," watch the transcript, get an ack.

Why it matters: **pivoice (`/voice`) is already shipped in apple-pi.**
The app inherits voice-in as a free side-effect — no new ASR work.

### UC-4 — Onboard a subscriber

> I find the app in the App Store, see "Free download — $9.99/mo for
> unlimited sessions." I sign in with my Apple ID, tap "Start
> subscription," confirm via Face ID. The app then asks for the URL
> of my bridge (e.g. `https://applepi-bridge.<your-domain>` — local) and
> a one-time pairing code from the mini (`apple-pi mobile
> pair-device` prints it). I paste the code, the app stores the
> bridge URL + auth token. I'm in.

Why it matters: **the onboarding is "what URL? what code?" — three
fields total.** No Apple ID sharing, no iCloud, no server-side
handshake. The store is sovereign end-to-end.

---

## 4. System architecture

```
┌────────────────────────────────────────────────────────────┐
│ iPhone (apple-pi iOS app)                                  │
│                                                            │
│  SwiftUI + Combine                                         │
│  Keychain holds: 1 pairing code (then becomes opaque        │
│  session token), 1 IAP receipt (or: don't store;           │
│  validate server-side on every wake)                       │
└──────────────────────┬─────────────────────────────────────┘
                       │  HTTPS over the existing NetBird
                       │  overlay (LAN or remote, same path)
                       ▼
┌────────────────────────────────────────────────────────────┐
│ apple-pi-mobile-bridge (Node, on the mini)                 │
│                                                            │
│  Listens on 127.0.0.1:7892 (LAN/overlay via Caddy route)    │
│  Auth: Apple-issued IAP receipt OR the pairing token        │
│  Routes:                                                   │
│    GET  /sessions                    → list (status, dur.) │
│    GET  /sessions/:id                → tree (rendered JSON) │
│    GET  /sessions/:id/raw            → JSONL stream         │
│    POST /sessions/:id/turns          → spawn `pi -c`, stream│
│    POST /sessions/:id/share          → make a /share gist   │
│    GET  /health                      → liveness             │
│                                                            │
│  Storage: sessions/*.jsonl at ~/.pi/sessions/ (READ-ONLY)   │
│           + mobile-bridge/var/state.json (heartbeats,      │
│           pending status, last-error) — gitignored          │
└──────────────────────┬─────────────────────────────────────┘
                       │  spawns `pi -c <session-id> -p "<msg>"`
                       │  with the user's existing pi auth.json
                       ▼
┌────────────────────────────────────────────────────────────┐
│ pi (the existing CLI)                                       │
│  Reads ~/.pi/agent/auth.json + settings.json (unchanged)    │
│  Appends to ~/.pi/sessions/<uuid>.jsonl (the user's data)   │
└────────────────────────────────────────────────────────────┘
```

### What changes vs the existing apple-pi

| Surface | Today | After |
|---|---|---|
| `~/.pi/sessions/` | File-on-disk only | File-on-disk + readable over HTTPS via bridge |
| `pi -r` resume CLI | Same | Same — bridge POSTs to it; CLI unchanged |
| `install.sh` | Adds Pi + skills | Same + offers to install `mobile-bridge/` |
| App Store | N/A | Paid iOS app, IAP subscription |
| Auth boundary | Loopback | Loopback + NetBird overlay ACL (already in place) + token |

### What does NOT change

- The user's `pi` runtime, model choice, auth keys.
- The JSONL format.
- The vault record (`session-record`) workflow.
- The self-improvement loop (autoresearch).
- Any user-facing skill — `session-record`, `long-horizon-compaction`,
  `self-assess` etc. all continue to work locally.

---

## 5. Tech stack & dep budget

| Component | Stack | New deps | Cost |
|---|---|---|---|
| `mobile-bridge/` server | Node 20, Fastify 5, `@fastify/websocket`, `better-sqlite3`, `zod` | 4 prod + ~6 dev | ~150 KB installed |
| `ios/` app | Swift 6, SwiftUI, Combine, `URLSession`, `StoreKit 2` | 0 (Apple system frameworks only) | ~5 MB binary |
| `apple-pi mobile` CLI subcommand | Node, reuses lib/db | 0 | reuses existing |
| Bridge docker image | Optional, not required | 0 | ships as Node script |
| **Total new top-level deps** | | **4 + 0 Apple = 4** | within budget |

### Why this stack

- **Node + Fastify** matches the existing apple-pi CLI (Node 20, ESM).
  Reuses `lifecycle/lib/db.js` for SQLite. The autoresearch pattern
  uses better-sqlite3 there.
- **Fastify + `@fastify/websocket`** = streaming support for
  `POST /turns` → SSE reply, which is the core UX of UC-1.
- **Zod** = a single source of truth for the bridge's request/response
  schemas (shared by both server and `apple-pi mobile` CLI tests).
- **SwiftUI + StoreKit 2** = the modern App Store happy path. StoreKit
  2's `Transaction.currentEntitlements` API gives the bridge the
  receipt without any IAP-verification-server dance (Apple's own
  JWT-verification endpoint is called from the bridge).
- **No React Native, no Flutter, no Capacitor, no Tauri.** A native
  Swift app with vanilla SwiftUI is the smallest deployment artifact
  (smallest binary, fastest startup, longest App Store acceptance
  history). Building it is the slowest *first* step but the cheapest
  *every subsequent* step.

---

## 6. Data model

### bridge/var/state.json (NEW, gitignored, ~10 KB)

```json
{
  "schema_version": 1,
  "bridge": {
    "version": "0.1.0",
    "started_at": "2026-07-15T09:12:33Z"
  },
  "pairs": [
    {
      "pair_id": "dev_pair_01HX...",
      "created_at": "...",
      "last_seen": "...",
      "ip_at_pair": "100.64.0.1",
      "label": "Jonathan's iPhone"
    }
  ],
  "receipts": [
    {
      "receipt_id": "dev_receipt_01HX...",
      "created_at": "...",
      "apple_user_id_hash": "sha256:...",
      "product_id": "apple.pi.mobile.monthly",
      "last_validated_at": "...",
      "expires_at": "...",
      "status": "active" | "expired" | "refunded"
    }
  ],
  "session_state": {
    "<session_uuid>": {
      "last_heartbeat_at": "...",
      "last_turn_at": "...",
      "active_branch": "main",
      "model": "MiniMax-M3",
      "current_status": "running" | "idle" | "awaiting_input"
    }
  }
}
```

Rationale:
- **Pairs vs receipts are stored separately**: a user can have a
  legacy paired device + an active sub, but the two don't depend on
  each other. Removing a pair doesn't cancel the sub.
- **`apple_user_id_hash`** is the SHA-256 of Apple's opaque user ID
  — never the raw Apple ID. We use it to dedup receipts (one
  subscription per Apple ID, multiple devices can share).
- **session_state** is *advisory only*, derived from the JSONL's
  last-modified time + the bridge's last-write-time to that file.
  Pure advisory, no source of truth; the JSONL wins on any conflict.

### Sessions endpoint output (derived, never stored)

```json
{
  "schema_version": 1,
  "sessions": [
    {
      "id": "<uuid>",
      "started_at": "...",
      "ended_at": null,
      "last_activity_at": "...",
      "current_status": "running",
      "model": "MiniMax-M3",
      "branch_count": 1,
      "msg_count": 47,
      "size_bytes": 1426087
    }
  ]
}
```

The bridge does *not* persist session metadata — it's computed from
the JSONL on every `GET /sessions`. (Acceptable cost: ~5ms per
session for the cheap fields, ~80ms for 100+ session listings.)

---

## 7. Component specs

### 7.1 `mobile-bridge/` (Node server, on the mini)

- **Entrypoint:** `mobile-bridge/bin/bridge.mjs` (ESM, Node 20+)
- **Boot:** `apple-pi mobile start` (new subcommand in `bin/apple-pi`)
  OR `~/Library/LaunchAgents/com.applepi.mobile-bridge.plist` (after
  `apple-pi mobile install`).
- **Routes** (Fastify, all prefixed `/v1`):
  - `GET /v1/health` — `{ ok: true, version, uptime_s }`. No auth.
  - `POST /v1/pair` — exchanges a one-time pairing code for a long
    device token. No pre-auth; the code is the auth.
  - `GET /v1/sessions` — returns the JSON list above. Requires `Authorization: Bearer <token>`.
  - `GET /v1/sessions/:id` — returns a *tree-rendered* JSON of the
    session (parent → children). Streaming optional.
  - `GET /v1/sessions/:id/raw` — streams the raw JSONL as
    `application/x-ndjson`. Read-only.
  - `POST /v1/sessions/:id/turns` — body `{ content: "...", parent_node_id?: "..." }`. Server spawns `pi -c <id> -p "<content>" --no-session` (or the equivalent that appends to the existing JSONL), captures stdout, streams reply turns as SSE. Returns 401 if no active subscription.
  - `POST /v1/sessions/:id/share` — invokes `pi /share` to gist it,
    returns the URL.
  - `POST /v1/iap/validate` — body `{ receipt, product_id }`. Server
    verifies with Apple's `verifyReceipt` endpoint, stores a
    normalized row in `state.json::receipts[]`.
- **Storage:**
  - `mobile-bridge/var/state.json` — gitignored, mode 0600.
  - `mobile-bridge/var/pairing-codes/` — rotating pairing codes
    (one active code at a time, expires in 10 min). Mode 0700.
- **Auth scheme:**
  - Pre-sub: any device with a valid pairing token. Used for
    receiving a receipt.
  - Post-sub: requires an active `receipts[]` row with status=active
    AND a valid `Authorization: Bearer` header. Both must be true.
- **Logging:** structured JSON to stdout; the existing autoresearch
  watchdog can scrape it.
- **Plays well with Caddy:** bind 127.0.0.1:7892, expose via
  `applepi-bridge.<your-domain> { reverse_proxy 127.0.0.1:7892; tls
  internal }` in the brew Caddyfile (same path as
  `tank.<your-domain>`, `hermes.<your-domain>`).

### 7.2 `ios/` (SwiftUI app)

- **Bundle ID:** `app.jotokra.applepi.mobile` (placeholder — user to
  confirm Apple Developer team ID)
- **Target:** iOS 17 minimum (StoreKit 2 requires it; covers 92%+
  of devices in 2026).
- **Modules:**
  - **App shell** — `@main ApplePiApp`, main `TabView` (Sessions,
    Settings).
  - **SessionsListView** — `List<SessionSummary>` from
    `GET /v1/sessions`. Pull-to-refresh. Search bar.
  - **SessionView** — `TreeView<SessionNode>` rendering the JSON
    tree (parent → child). Tap a node to expand tool calls.
  - **SendTurnSheet** — `TextEditor` + send button. Streams the
    reply SSE as a chat-style bubble feed.
  - **VoiceTurnSheet** — wraps `AVAudioEngine` + on-device
    `SpeechAnalyzer` (iOS 17+) for ASR. Note: on-device ASR is
    Apple's framework, not a model we ship.
  - **PairingView** — text field for bridge URL + pairing code.
  - **SettingsView** — bridge URL, account/subscription status, sign
    out, debug panel.
- **Persistence:**
  - Keychain: 1 device token, 1 current bridge URL.
  - No local DB; the app is stateless and re-fetches from the
    bridge every cold start. (Offline cache is a v2.)
- **Network:**
  - Single `URLSession` configured with the bridge host pinned to
    the user's NetBird-overlay DNS name.
  - TLS via the existing Caddy `tls internal` (the app trusts the
    Caddy root CA the same way as `curl -k` on the user's other
    devices).
- **IAP:**
  - Product: `app.jotokra.applepi.mobile.monthly` ($9.99/mo,
    placeholder).
  - `Product.loadProducts()` on launch; `Transaction.currentEntitlements` to verify.
  - Receipt is sent to the bridge on every cold start + on every
    `POST /turns` (bridge re-validates with Apple each time — receipt
    expiry is handled server-side).

### 7.3 `bin/apple-pi` new subcommands

- `apple-pi mobile start` — boots the bridge (foreground or
  daemon, per existing `--install`/`--uninstall` pattern).
- `apple-pi mobile stop`
- `apple-pi mobile status` — same shape as `apple-pi status`,
  rows for bridge process + active pairs + active subs.
- `apple-pi mobile pair-device` — prints a 1-shot pairing code
  valid for 10 min. Cancel-able.
- `apple-pi mobile install` — registers the LaunchAgent.
- `apple-pi mobile uninstall`

---

## 8. Phased build plan

| Phase | Scope | Result | Lone-dev time |
|---|---|---|---|
| **Phase 0** | Bridge MVP: `mobile-bridge/bin/bridge.mjs` (Node, Fastify) with `/health` + `/sessions` + `/pair`. `apple-pi mobile start/stop/status/install`. Smoke tests. No iOS app, no auth, no IAP — local-only, prompt-paired. | `curl localhost:7892/v1/sessions` returns your JSONL list. | 1-2 weeks |
| **Phase 1** | IAP + receipt validation. `POST /iap/validate` + Apple sandbox walk-through. Token issuance + revocation. | A `xcrun simctl` driven end-to-end test of sub → receipt → token → gated `/sessions`. | 1 week |
| **Phase 2** | iOS app shell: pairing, session list, session tree view. **Read-only**, no send-turn yet. App Store Connect listing draft. | TestFlight build that lists your sessions on your phone. | 3-4 weeks |
| **Phase 3** | iOS app: `POST /turns` + SSE reply streaming. Send a turn from phone, watch live reply. | Full UC-1 working. | 2-3 weeks |
| **Phase 4** | iOS app: voice-in (pivoice-equivalent using iOS `SpeechAnalyzer`). Share-via-gist. Polish (icon, onboarding flow, App Store screenshots). App Review prep. | Shippable v0.1.0 in App Store. | 2-3 weeks |
| **Phase 5 (post-ship)** | Multi-bridge sync, hosted bridge v2, Android app, agent-API for power users, Apple Watch glance. (Out of scope for v0.2.0.) | TBD after learnings. | TBD |

**Total MVP (Phases 0-4):** ~10-14 weeks part-time (assumes 10-15 hr/week).

---

## 9. Frozen decisions

| ID | Decision | Why this over the alternative |
|---|---|---|
| **D1** | Same-repo (`apple-pi` + `ios/` + `mobile-bridge/`), not a separate repo. | One bundle, one release flow, one canon of "what is apple-pi." Splitting fragments the marketing story and forces two README cross-links. |
| **D2** | Self-hosted bridge on the user's mini (over NetBird overlay), no hosted bridge in v0. | Matches apple-pi's sovereignty posture. Users who want hosted bridge can run `mobile-bridge/` on a VPS instead of their mini — no product code change. A v2 "apple-pi cloud" might exist; not in scope here. |
| **D3** | App Store IAP only ($9.99/mo, sandbox-tested). No website-token path in v0. | Cleanest App Store story. Avoids guideline 3.1.5(a) risk. 30% to Apple is acceptable — the bridge daemon is the costly part of the service, not the LLM. |
| **D4** | Viewer + send-a-turn surface. No live-stream of tool calls. Send-a-turn uses SSE for the reply only. | "Live-stream tool calls" requires the bridge to host the agent loop, which is a much bigger rewrite. SSE-reply-only is enough to make UC-1 work without that rewrite. v2 can promote to full WebSocket + agent-loop hosting. |
| **D5** | No on-device LLM. Phone is a thin client. | pi/mlx/ANE inference on iPhone is a separate product (months of work, lower quality, battery cost). The point of paying for the sub is *access to YOUR existing LLM on YOUR existing mini*. Don't scope-creep. |
| **D6** | One bridge per user (no multi-user, no team). | Multi-user bridges require per-user auth + per-user rate limits + a hosted control plane. Out of scope; team support is a v2. |
| **D7** | All session metadata derived live from the JSONL at request time. No session DB. | Single source of truth. A bridge crash loses zero state. State DB only holds pair/receipt state, which is genuinely new (not derived). |
| **D8** | Caddy route at `applepi-bridge.<your-domain>`, tls internal. Same Caddy root CA model as the rest of apple-pi. iOS app ships the Caddy root CA inline. | Reuses existing infra. The user already trusts this CA across their NetBird-connected devices. |
| **D9** | iOS minimum = iOS 17 (StoreKit 2 + SpeechAnalyzer). | Covers 92%+ of devices in 2026. StoreKit 2 is dramatically simpler than StoreKit 1; the older IAP machinery is well past its maintenance prime. |
| **D10** | Native Swift + SwiftUI, not React Native / Flutter / Capacitor. | Smallest deployment artifact, longest App Store acceptance history, no JS bridge to debug. First build is slower; subsequent builds (which is most of the work) are faster. |
| **D11** | Bridge auth = bearer token (post-sub) OR pairing-code (pre-sub). No OAuth, no Apple ID handoff, no third-party login. | The bridge is the user's own process. There's no service-side identity to federate with. Apple ID for IAP is enough. |
| **D12** | Subscription tier is single-tier; no "free for self-hosted vs paid for hosted" in v0. | Hosted bridge isn't in v0. There's no second tier to differentiate against. |
| **D13** | No analytics / telemetry from the bridge. Existing apple-pi zero-telemetry posture preserved. The bridge logs to stdout only. | Matches apple-pi posture; avoids Apple privacy-nutrition-label complications (the App Store nutrition label would otherwise require declaring collection of usage data). |

---

## 10. Risks + open questions

### R1 — App Store guideline 3.1.5(a) and the "buying digital content inside the app" rule

IAP is required if the app "unlocks features or functionality" used in the
app. Since the iOS app's entire purpose is "talk to the bridge," this is
clearly IAP. **Status:** locked-in, no risk.

**Risk that remains:** Apple sometimes interprets "the app exists to
consume a subscription the user bought elsewhere" as still requiring IAP
when the sub unlocks *any* in-app functionality. We've chosen D3
(IAP-only) specifically to avoid this. Verify with App Review during the
TestFlight phase.

**Default:** IAP only. **If Apple changes the guideline post-ship:**
revisit D3.

### R2 — Apple Developer Program enrollment + paid apps

iOS apps that charge money need the user enrolled in the **Apple
Developer Program** ($99/yr). The bundle ID placeholder
`app.jotokra.applepi.mobile` is a stub — confirm the actual team ID
before Phase 2.

**Default:** ship under `@jotokra` personal team. If `@jotokra` is a
GitHub org, the Apple Developer team may differ. **Open question:**
which Apple Developer team / App Store listing?

### R3 — iOS app signing + TestFlight

TestFlight build requires Apple Developer Program + 90-day review
wait + DUNS for the org. Realistic timing is "TestFlight-ready in
2 weeks from Phase 2 start." **Default:** ship with a personal team
if no org. Open question is the org/team choice.

### R4 — `pi`'s `-c` and `-p` flags may or may not append to the existing JSONL

This is the load-bearing assumption of the design (D7). Need to verify
in Phase 0 that `pi -c <uuid> -p "<msg>"` actually *appends to the
existing JSONL* (rather than starting a fresh one). If it doesn't,
Phase 0 needs to either patch `pi`, fork-and-wrap, or come up with a
"manual mode" pattern.

**Mitigation:** if `pi` doesn't append, the bridge can implement a
small "send-turn" mode that spawns a fresh `pi -p "<msg>"` then
*symlinks/copies* the resulting JSONL back into the existing tree's
parent node. Ugly but workable. Or: the iOS app's "send a turn" mode
writes a *sentinel file* (`~/.pi/sessions/<uuid>.queued`) that the
long-running `pi` (if any) picks up. Or: the bridge acts as a
*manual human proxy* — it tells `pi` "act as if the user said X" via
the TUI escape sequence on the existing session. Decide in Phase 0.

### R5 — Caddy TLS internal + iOS app certificate trust

The bridge route will use the user's existing Caddy `tls internal` CA.
The iOS app must trust that CA. Two ways:

- Ship the Caddy root CA inline in the app bundle. Trivially doable
  but the CA rotates when Caddy rotates, and bundled copies can't be
  updated without an app release.
- Install the CA via a configuration profile (the way the iPad
  enrolled via NetBird already does for `*.<your-domain>`).

**Default:** ship the CA inline in v0.2.0 (option 1). On CA rotation,
release a v0.2.1 of the app with the new CA bundled. v2 can switch to
the profile approach.

### R6 — "Premium" price point vs market

$9.99/mo is the App Store default tier. This product is for users
who already pay for an LLM subscription + run a mini + use apple-pi.
The actual addressable market is small. **Open question:** is $9.99
too high? Too low? Should there be an annual discount? **Default:**
$9.99/mo, no annual tier until Phase 5 review. TestFlight users
can give feedback before App Review.

### R7 — App Store rejected on "the app is not useful without the user's own server"

Apple has rejected apps for "this requires the user to set up their
own backend to be functional." Mitigation: the Phase 2 onboarding
flow can include an optional "Use the apple-pi demo bridge (free,
read-only, 7-day sessions)" so the app is *useful on day one* even
without a paid sub or self-hosted bridge. **Default:** ship without
demo bridge; document the option. If rejected in App Review, add the
demo bridge.

### R8 — pivoice on iPhone vs ASR on iPhone

Apple's `SpeechAnalyzer` (iOS 17+) is on-device ASR that is good
enough for "send a one-line turn." pivoice is whisper.cpp + ASR + TTS
on macOS. **Open question:** is iOS-on-device ASR quality equivalent?
**Default:** ship with iOS `SpeechAnalyzer`, no model shipping. If
the quality is insufficient, swap to a hosted ASR (OpenAI Whisper
API, charges the user 1 cent per minute). Out of scope for v0.2.0.

### R9 — "Send a turn" semantics when there's no running `pi`

If the user opens the app and the session they're resuming hasn't
had a `pi` running for 2 hours, what does "send a turn" do?

**Options:**
- **A.** Spawn a fresh `pi -c <id> -p "<msg>"`, append to the JSONL,
  return when the agent turn completes.
- **B.** Reject the request (409), tell the user "session is not
  active, start it from your laptop first."

**Default:** A. The bridge is the *thing that makes pi resumable*
in this product; if pi didn't auto-resume, the bridge does.

### R10 — Subscription tier bumps when apple-pi is "free"

`apple-pi` is MIT. The iOS app costs money. Some users will object:
"why am I paying for a front-end to MIT-licensed code?" Honest
answer: because the bridge daemon is the service. Document this in
the App Store description, the GitHub README, and the apple-pi
landing site.

**Default:** publish both README and App Store description that
make the bridge daemon's role explicit. Do not apologize; explain.

---

## 11. Conventions

- **TDD where the code base already does it.** `mobile-bridge/` ships
  with the same smoke-first pattern as `lifecycle/`:
  `mobile-bridge/smoke/<route>.sh`. Each smoke test is curl-based, no
  framework required.
- **Card ↔ commit 1:1.** Each Shape B phase breakdown produces a
  kanban card per file change. Card body = path + commit msg + test
  ref. The orchestrator ships one card per commit.
- **Vault mirror.** This spec lives at
  `~/Projects/gh/apple-pi/.docs/mobile/SUPERPROMPT.md` (in-tree) and
  mirrors to `~/Vault/Projects/apple-pi/.docs/mobile/SUPERPROMPT.md`
  (vault). Working-state notes (`plan-NN-*.md`) go to BOTH on every
  commit.
- **AGENTS.md update.** When the first card ships, the
  `apple-pi` repo's `AGENTS.md` (if any) gets a section on the new
  `mobile-bridge/` + `ios/` paths and their conventions. If no
  `AGENTS.md` exists in the repo, leave one off until Phase 1 ships.
- **Sanitization contract preserved.** `smoke/sanitize.sh` continues
  to grep for personal info. New code in `mobile-bridge/` and `ios/`
  must add no personal info to the shipped tree. (The iOS app's
  strings files are the main place to watch.)
- **No telemetry.** Per D13.

---

## 12. Reading order for new workers

1. `~/Projects/gh/apple-pi/README.md` — what apple-pi is
2. `~/Projects/gh/apple-pi/.docs/PLAN.md` — v1.0.0 product spec
3. `~/Projects/gh/apple-pi/config/skills/session-record/SKILL.md`
4. `~/Projects/gh/apple-pi/config/skills/long-horizon-compaction/SKILL.md`
5. This file (v0.2.0 mobile spec)
6. `~/Projects/gh/apple-pi/.docs/decisions/2026-07-03-mobile-bridge.md`
   (created in Phase 0 — design rationale + the "where do we put it"
   decision)
7. `~/Projects/gh/apple-pi/.docs/mobile/plan-01-phase-0-shape-b.md`
   (created alongside this spec — the Phase 0 task breakdown)
8. The bridge's own `mobile-bridge/README.md` once Phase 0 ships.

---

## 13. Resolved decisions (filled in on first greenlight)

| ID | Decision | Resolved |
|---|---|---|
| D1 | Same repo | ✅ frozen |
| D2 | Self-hosted bridge | ✅ frozen |
| D3 | App Store IAP only | ✅ frozen |
| D4 | Viewer + send-turn (no live tool stream) | ✅ frozen |
| D5 | No on-device LLM | ✅ frozen |
| D6 | One bridge per user | ✅ frozen |
| D7 | JSONL as source of truth, no session DB | ✅ frozen |
| D8 | Caddy route + tls internal | ✅ frozen |
| D9 | iOS 17 minimum | ✅ frozen |
| D10 | Native Swift + SwiftUI | ✅ frozen |
| D11 | Bearer-token + pairing-code auth, no OAuth | ✅ frozen |
| D12 | Single subscription tier | ✅ frozen |
| D13 | No telemetry | ✅ frozen |
| OQ-1 | Apple Developer team (R2)? | open |
| OQ-2 | Bundle ID confirms (R2)? | open |
| OQ-3 | `pi -c` appends to existing JSONL, or needs Phase-0 workaround (R4)? | open (resolved in Phase 0) |
| OQ-4 | Demo bridge for App Review (R7)? | open |
| OQ-5 | Annual sub tier (R6)? | open — default no annual tier in v0 |

---

## 14. Version history

| Version | Date | Change |
|---|---|---|
| v0.2.0 | 2026-07-03 | Initial frozen spec. Greenlit by user reply "Go" against Shape A menu (A + 2a + 3a + 4b + same-repo defaults). |
