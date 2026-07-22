# apple-pi mobile — Phase 1 (IAP receipt validation): bridge side

**Goal.** Ship the **bridge-side** of Phase 1: validate an Apple IAP
receipt, issue a subscription-gated bearer token, and enforce an opt-in
subscription gate on session reads. This is the half of Phase 1 that does
NOT require an Apple Developer account — pure backend Node, hermetically
testable with a mock verifier.

**What shipped (this plan):**
- `mobile-bridge/lib/iap.mjs` — `verifyWithApple()` (prod → 21007 sandbox
  fallback; injectable `fetchImpl`/urls/secret so tests run offline),
  `interpretReceipt()` (active | expired | refunded | invalid |
  no_subscription), and `validateAndIssue()` (upsert `receipts[]`, issue
  or ROTATE a token linked to the receipt on an active sub; return no
  token + 402 on inactive).
- `mobile-bridge/lib/state.mjs` — `receipts[]` added to the default state
  + `isPairEntitled(pair, requireIap)`.
- `mobile-bridge/bin/bridge.mjs` — `POST /v1/iap/validate` (unauthenticated;
  the receipt is the credential) + an opt-in subscription gate:
  `BRIDGE_REQUIRE_IAP=1` rejects pairing-only tokens on `/v1/sessions*`
  with 402. Default (unset) preserves Phase 0 behaviour (any valid token
  reads) for local/dev + the App-Review demo bridge.
- `mobile-bridge/lib/iap.test.mjs` — 13 unit tests (offline; covers active/
  expired/refunded/invalid/sandbox-fallback/token-rotation/entitlement).
- `mobile-bridge/smoke/iap.sh` — self-contained end-to-end smoke: boots a
  mock Apple verifier + the real bridge (REQUIRE_IAP=1) and proves the
  full validate → gate → rotate → 402 flow.

**Verified:** `node --test lib/iap.test.mjs` → 13/13 pass; `smoke/iap.sh`
→ 5/5 stages green; Phase 0 regression (health + pair 8/8) unaffected.

**Decisions locked:**
- **D-P1-1 Opt-in gate (`BRIDGE_REQUIRE_IAP`).** The paywall is enforced
  only on bridges that opt in. Rationale: the user's own local bridge
  (and the App-Review demo bridge) must work without an Apple sub; a
  public App-Store-facing bridge turns the gate on. The value being sold
  is bridge hosting + Apple distribution, not the gate itself.
- **D-P1-2 Token rotation on re-validate.** Every successful re-validation
  rotates the bearer token, so a leaked old token dies the moment the
  client refreshes. The client always uses the latest returned token.
- **D-P1-3 verifyReceipt (not StoreKit 2 JWS) for v0.2.** Simplest server-
  side path; still supported. Swap the verifier when the iOS app moves to
  StoreKit 2 (Phase 3+); `interpretReceipt()`'s output shape stays stable.
- **D-P1-4 Revocation is implicit, via receipt status.** A refunded
  receipt (status `refunded`, set on next validate) fails the entitlement
  check at request time — no separate revoke endpoint needed in v0.2.
  Apple Server Notifications V2 (push refund/cancel events to the bridge)
  is a later hardening; until then, the client re-validates periodically.

**Deferred (blocked on the user / out of bridge scope):**
- Real Apple **sandbox walk-through** (needs Apple Developer Program
  enrollment — `$99/yr`, the user's identity; SUPERPROMPT risk R2).
- **`xcrun simctl` end-to-end** (sub → receipt → token → gated sessions)
  — the Phase 1 acceptance target; needs Xcode + the sandbox account.
- **iOS-side StoreKit 2** purchase flow (Phase 2+; the iOS app).
- **Apple Server Notifications V2** for push revocation (later hardening).
- The `/v1/sessions/:id/heartbeat` (T6) + `/v1/sessions/:id/tree` are
  Phase 0 surfaces and inherit the gate automatically.

**Reading order:** `.docs/mobile/SUPERPROMPT.md` §6 (receipts[] data
model), §7.1 (bridge component), §8 Phase 1 row, §9 D3/D11 → this file →
`mobile-bridge/lib/iap.mjs`.
