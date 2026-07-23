# apple-pi mobile — Phase 2+ gate: Apple Developer enrollment

**Status:** 🔴 **BLOCKED — on the user (not the agent).**
**Resumes when:** the user has an active Apple Developer Program membership
and hands the agent their **Team ID**. No code work can proceed on Phases
2–4 until then. Everything backend (Phases 0 + 1) is shipped.

> **Resume marker for a future agent/session:** read this file top-to-bottom,
> then `.docs/mobile/SUPERPROMPT.md` §8 (phased plan) + §9 (decisions) +
> §10 (risks). Phases 0 + 1 are done (`plan-01`, `plan-02`); the bridge runs,
> `POST /v1/iap/validate` + the `BRIDGE_REQUIRE_IAP` gate are live and tested.
> The **only** blocker is the Apple account below. Start at "Once enrolled".

---

## Why this is a gate (not something the agent can do)

Publishing the iOS app — and even validating a real IAP receipt end-to-end
— requires an **Apple Developer Program** membership. That membership is
tied to a human's Apple ID, costs $99/yr, and requires identity
verification. The agent cannot (and will not) cross into spending, identity
verification, or acting under a human's Apple ID. So enrollment is the
user's one manual step. After it, every remaining task is agent-doable.

This is **risk R2** in the SUPERPROMPT: "Apple Developer Program enrollment
($99/yr, identity verification, 1–2 day review)."

---

## The guide: enroll (≈10 min of your time + a 1–2 day wait)

1. **Go to** https://developer.apple.com/programs/ and click **Enroll**.
2. **Sign in with your Apple ID.** (Use the one you want the app published
   under — it becomes the app's "seller".)
3. **Choose Individual** (not Company/Organization — that needs a D-U-N-S
   number and is overkill for a one-person app). Individual is $99 USD/year.
4. **Pay + verify.** Complete the purchase; Apple runs identity verification
   (a prompt to upload government ID in some regions). This takes **1–2
   days**; you'll get an email when approved.
5. **Once approved**, sign in at https://developer.apple.com/account/ and
   grab your **Team ID**: *Membership → Membership Details → Team ID*
   (format `ABCDE12345`, a 10-character alphanumeric). Also note your
   **Apple ID email** — both are needed below.

That's the entire manual part. Then tell the agent: *"Apple Developer
enrollment done. Team ID is `<...>`. Apple ID is `<...>`. Resume apple-pi
mobile Phase 2."*

---

## Once enrolled — the agent's resume work (Phases 2 → 4)

When the user hands over the Team ID, execute in order. Each phase = its own
plan doc (`plan-04`+), one card = one commit, verify-own-work per phase.

### Step 0 — re-validate Phase 1 against the real sandbox (closes plan-02's gap)
Phase 1 shipped hermetically (mock Apple). The real Apple sandbox E2E was
deferred because it needs the account. Now it doesn't.
- Point `APPLE_VERIFY_PROD_URL` at the real Apple endpoints (unset the
  override); run `mobile-bridge/smoke/iap.sh` is the *mock* path — write a
  new `smoke/iap-sandbox.sh` that uses a **sandbox StoreKit test receipt**
  (`xcrun simctl` + a StoreKit Configuration File in the iOS project).
- Target: sub → receipt → `POST /v1/iap/validate` → token → gated
  `/v1/sessions`. This is the SUPERPROMPT §8 Phase 1 acceptance criterion.

### Step 1 — App Store Connect scaffolding (no code yet)
- **Bundle ID:** register `app.<your-domain>.applepi.mobile` (replace the
  placeholder currently in SUPERPROMPT §7.2 / D-bundle) against the Team ID.
  Enable capability **In-App Purchase**.
- **App:** create the App Store Connect app record (name, bundle ID, SKU).
- **IAP product:** create an **auto-renewable subscription**, monthly,
  `app.<your-domain>.applepi.mobile.monthly` (matches `plan-02` D-P1 + the
  smoke mock product id). Set the price point (SUPERPROMPT R6 default:
  $9.99/mo, no annual tier until post-launch review).
- **Shared secret:** generate the App-Specific Shared Secret; store it via
  `/vault add apple-shared-secret` (never in a repo/env). The bridge reads
  it as `APPLE_SHARED_SECRET` (already wired in `bin/bridge.mjs`).

### Step 2 — Phase 2: iOS app shell (read-only viewer)  [3–4 wk]
- `ios/` — SwiftUI, iOS 17 min (D9), native (D10). Project set up for the
  Team ID + automatic signing.
- Screens: pairing (bridge URL + code), session list (`GET /v1/sessions`),
  session tree view (`GET /v1/sessions/:id/tree` + `.../raw`). **Read-only.**
- Ship the Caddy root CA inline (SUPERPROMPT §7.3, option 1) so the app
  trusts the bridge's `tls internal` cert.
- App Store Connect listing draft + TestFlight build.
- **Verify:** TestFlight build lists your real sessions on your phone.

### Step 3 — Phase 3: send-a-turn + SSE reply streaming  [2–3 wk]
- `POST /v1/turns` on the bridge (new route; gated by `BRIDGE_REQUIRE_IAP`).
- **Resolve OQ-4 first** (SUPERPROMPT §10 R4): does `pi -c <uuid> -p "<msg>"`
  append to the existing JSONL or fork a new one? Decide + document; patch
  `pi` / fork-and-wrap if needed. This is load-bearing for D7 (JSONL as
  single source of truth).
- iOS: send-a-turn UI + SSE reply stream.
- **Verify:** full UC-1 (send a turn from the phone, watch the live reply).

### Step 4 — Phase 4: voice-in + share-via-gist + App Review prep  [2–3 wk]
- Voice-in via iOS `SpeechAnalyzer` (on-device; mirrors pivoice).
- Share-via-gist (session → GitHub gist).
- Polish: icon, onboarding flow, App Store screenshots.
- **Apple Server Notifications V2:** wire the bridge to receive
  refund/cancel events → update receipt status (hardens the Phase 1 gate
  beyond client-driven re-validation; see `plan-02` D-P1-4).
- **App Review prep** (SUPERPROMPT R7): build the demo-bridge path so
  reviewers without their own server can use the app — only if App Review
  rejects on "not useful without own server".
- **Verify:** shippable v0.1.0 in App Store.

### Phase 5 (post-ship) — out of scope for v0.2.0
Multi-bridge sync, hosted bridge, Android, agent-API for power users, Apple
Watch glance. Revisit after launch learnings.

---

## How to verify the gate is unblocked (for the agent, on resume)

Run this; if all green, the account is wired and Phase 2 work can start:
```bash
# 1. bridge still healthy (Phase 0 + 1 intact)
cd ~/Projects/apple-pi/mobile-bridge
bash smoke/health.sh && bash smoke/iap.sh
# 2. host node works (was broken once — brew upgrade node if it recurs)
node --version
# 3. the tripwire + history are clean (the public repo was force-scrubbed)
cd .. && bash smoke/sanitize.sh
```

## Risks carried forward (from SUPERPROMPT §10)

- **R2** enrollment delay (1–2 days) — this gate.
- **R3** TestFlight 90-day build expiry — rebuild monthly during dev.
- **R4** `pi -c` append-vs-fork semantics — resolve in Phase 3 Step 3.
- **R5** Caddy root CA rotation — bundled copies need an app release to
  update (mitigation in SUPERPROMPT §7.3; v2 moves to a config profile).
- **R7** "useful without own server" rejection — demo bridge only if needed.

## Reading order (for a new worker)

1. This file (the gate + the guide).
2. `.docs/mobile/SUPERPROMPT.md` §8 phases, §9 decisions, §10 risks.
3. `.docs/mobile/plan-01-phase-0-shape-b.md` (Phase 0 — done).
4. `.docs/mobile/plan-02-phase-1-iap.md` (Phase 1 — done; closes its sandbox
   gap in Step 0 above).
5. `mobile-bridge/bin/bridge.mjs` + `lib/iap.mjs` (the code you'll extend).

## State at the time this was written

- Phases 0 + 1: **shipped** (commits through the history-scrub). Bridge
  boots, `POST /v1/iap/validate` + `BRIDGE_REQUIRE_IAP` gate live, 13 unit
  tests + 5-stage smoke green.
- Public repo history: **force-scrubbed** of all author personal tokens
  (they remain only in `smoke/sanitize.sh`, the tripwire's detection list).
- Host node: **fixed** (brew `node` 26.5.0; `node@22` 22.23.1).
- Local feature branches + the Supacode worktree: still on pre-scrub hashes
  (harmless; resync with `git fetch --prune && git reset --hard origin/<br>`).
- Backup of pre-scrub history: `~/Projects/.tmp/apple-pi-pre-scrub-*.bundle`.
