#!/usr/bin/env bash
# mobile-bridge/smoke/iap.sh — Phase 1 smoke: IAP receipt validation end-to-end.
#
# Self-contained: boots a MOCK Apple verifyReceipt server + the real bridge
# (with BRIDGE_REQUIRE_IAP=1 and the verifier pointed at the mock), then
# exercises the full Phase 1 contract:
#
#   1. POST /v1/iap/validate  with an ACTIVE receipt   → 200 + {token, subscription.active}
#   2. GET  /v1/sessions      with that token           → 200  (entitled)
#   3. POST /v1/pair/issue + /v1/pair → pairing-only token
#      GET  /v1/sessions      with pairing token        → 402  (no receipt, gate ON)
#   4. POST /v1/iap/validate  again (same receipt)      → 200 + ROTATED token
#   5. POST /v1/iap/validate  with an EXPIRED receipt   → 402 payment_required
#
# Fully offline — no Apple account, no network. The mock verifier returns
# a canned verifyReceipt JSON shaped like Apple's. Run with:
#   bash mobile-bridge/smoke/iap.sh
# (uses whatever `node` is on PATH; on a host with broken system node,
#  prepend a working node bin to PATH.)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || { echo "FAIL: node not on PATH" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'cleanup' EXIT
cleanup() {
  [[ -n "${MOCK_PID:-}" ]]   && kill "$MOCK_PID"   2>/dev/null || true
  [[ -n "${BRIDGE_PID:-}" ]] && kill "$BRIDGE_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
fail() { echo "FAIL iap: $*" >&2; exit 1; }
ok()   { echo "  ok  $*"; }

# Pick two free ports.
MOCK_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')"
BRIDGE_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')"
BASE="http://127.0.0.1:${BRIDGE_PORT}"

echo "== iap.sh: Phase 1 IAP receipt validation (mock Apple, REQUIRE_IAP=1) =="

# ---- 1. Mock Apple verifyReceipt server -----------------------------------
# Returns an ACTIVE auto-renewable sub for receipts whose payload contains
# "ACTIVE", an EXPIRED one for "EXPIRED". Anything else → status 21002.
cat > "$WORK/mock.mjs" <<'MOCK'
import http from "node:http";
const port = Number(process.env.MOCK_PORT);
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let receipt = "";
    try { receipt = JSON.parse(body)["receipt-data"] ?? ""; } catch {}
    const now = Date.now();
    let resp;
    if (receipt.includes("ACTIVE")) {
      resp = { status: 0, latest_receipt_info: [{ original_transaction_id: "OTX_SMOKE", product_id: "app.monthly", expires_date_ms: String(now + 86_400_000) }] };
    } else if (receipt.includes("EXPIRED")) {
      resp = { status: 0, latest_receipt_info: [{ original_transaction_id: "OTX_SMOKE_OLD", product_id: "app.monthly", expires_date_ms: String(now - 1000) }] };
    } else {
      resp = { status: 21002 }; // bad receipt
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(resp));
  });
});
server.listen(port, "127.0.0.1");
MOCK

MOCK_PORT="$MOCK_PORT" "$NODE_BIN" "$WORK/mock.mjs" &
MOCK_PID=$!

# A tiny sessions dir so /v1/sessions returns a valid (empty) list.
mkdir -p "$WORK/sessions"
export PI_SESSIONS_DIR="$WORK/sessions"

# ---- 2. Boot the real bridge (verifier → mock, gate ON) -------------------
MOCK_PORT="$MOCK_PORT" BRIDGE_PORT="$BRIDGE_PORT" BRIDGE_HOST="127.0.0.1" \
  BRIDGE_REQUIRE_IAP=1 \
  APPLE_VERIFY_PROD_URL="http://127.0.0.1:${MOCK_PORT}" \
  APPLE_VERIFY_SANDBOX_URL="http://127.0.0.1:${MOCK_PORT}" \
  "$NODE_BIN" "$BRIDGE_ROOT/bin/bridge.mjs" > "$WORK/bridge.log" 2>&1 &
BRIDGE_PID=$!

# Wait for the bridge to be ready (poll /v1/health).
for _ in $(seq 1 50); do
  curl -fsS "${BASE}/v1/health" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -fsS "${BASE}/v1/health" >/dev/null 2>&1 || { cat "$WORK/bridge.log"; fail "bridge did not come up"; }
ok "bridge up on :${BRIDGE_PORT} (verifier→mock :${MOCK_PORT}, REQUIRE_IAP=1)"

# ---- 3. Stage 1: validate an ACTIVE receipt → 200 + token -----------------
v1="$(curl -sS -o /tmp/iap_v1.body -w "%{http_code}" -X POST -H 'Content-Type: application/json' \
  -d '{"receipt":"ACTIVE-receipt-blob"}' "${BASE}/v1/iap/validate" || true)"
[[ "$v1" == "200" ]] || { cat /tmp/iap_v1.body; fail "stage 1: expected 200, got $v1"; }
token1="$(jq -r '.token' /tmp/iap_v1.body)"
sub1="$(jq -r '.subscription.status' /tmp/iap_v1.body)"
[[ "$token1" =~ ^[0-9a-f]{64}$ ]] || fail "stage 1: no 64-hex token: $(cat /tmp/iap_v1.body)"
[[ "$sub1" == "active" ]] || fail "stage 1: subscription not active: $sub1"
ok "stage 1: active receipt → 200, token=${token1:0:8}..., sub=$sub1"

# ---- 4. Stage 2: sessions with the IAP token → 200 (entitled) -------------
s2="$(curl -sS -o /tmp/iap_s2.body -w "%{http_code}" -H "Authorization: Bearer ${token1}" \
  "${BASE}/v1/sessions" || true)"
[[ "$s2" == "200" ]] || { cat /tmp/iap_s2.body; fail "stage 2: expected 200 on /v1/sessions with IAP token, got $s2"; }
ok "stage 2: /v1/sessions with IAP token → 200 (entitled)"

# ---- 5. Stage 3: pairing-only token → /v1/sessions → 402 (gate ON) --------
code="$(curl -fsS -X POST "${BASE}/v1/pair/issue" | jq -r '.code')"
pairtok="$(curl -fsS -X POST -H 'Content-Type: application/json' -d "{\"code\":\"${code}\"}" "${BASE}/v1/pair" | jq -r '.token')"
s3="$(curl -sS -o /tmp/iap_s3.body -w "%{http_code}" -H "Authorization: Bearer ${pairtok}" \
  "${BASE}/v1/sessions" || true)"
[[ "$s3" == "402" ]] || { cat /tmp/iap_s3.body; fail "stage 3: expected 402 for pairing-only token under REQUIRE_IAP, got $s3"; }
ok "stage 3: pairing-only token → 402 (gate ON, no receipt)"

# ---- 6. Stage 4: re-validate same receipt → 200 + ROTATED token -----------
v4="$(curl -sS -o /tmp/iap_v4.body -w "%{http_code}" -X POST -H 'Content-Type: application/json' \
  -d '{"receipt":"ACTIVE-receipt-blob"}' "${BASE}/v1/iap/validate" || true)"
[[ "$v4" == "200" ]] || { cat /tmp/iap_v4.body; fail "stage 4: expected 200 on re-validate, got $v4"; }
token2="$(jq -r '.token' /tmp/iap_v4.body)"
[[ "$token2" =~ ^[0-9a-f]{64}$ ]] || fail "stage 4: no token on re-validate"
[[ "$token1" != "$token2" ]] || fail "stage 4: token did NOT rotate on re-validate"
ok "stage 4: re-validate → 200, rotated token=${token2:0:8}... (≠ stage 1)"

# ---- 7. Stage 5: EXPIRED receipt → 402 payment_required -------------------
v5="$(curl -sS -o /tmp/iap_v5.body -w "%{http_code}" -X POST -H 'Content-Type: application/json' \
  -d '{"receipt":"EXPIRED-receipt-blob"}' "${BASE}/v1/iap/validate" || true)"
[[ "$v5" == "402" ]] || { cat /tmp/iap_v5.body; fail "stage 5: expected 402 for expired receipt, got $v5"; }
err5="$(jq -r '.error' /tmp/iap_v5.body)"
[[ "$err5" == "payment_required" ]] || fail "stage 5: error not payment_required: $err5"
ok "stage 5: expired receipt → 402 payment_required"

echo
echo "OK   iap: Phase 1 IAP validation end-to-end (validate → gate → rotate → 402)"
