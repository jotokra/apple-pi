#!/usr/bin/env bash
# mobile-bridge/smoke/pair.sh — T3 smoke: pairing-code → bearer-token → gated request.
#
# Stages:
#   1. POST /v1/pair/issue  (no auth) → expect { code, expires_at }
#   2. POST /v1/pair        (no auth, body { code }) → expect { pair_id, token, created_at }
#   3. GET  /v1/whoami      with Authorization: Bearer *** → expect 200
#   4. GET  /v1/whoami      with NO Authorization          → expect 401
#   5. POST /v1/pair        reusing consumed code          → expect 410
#   6. GET  /v1/whoami      with bogus token               → expect 401
#   7. POST /v1/pair        with malformed body            → expect 400
#   8. GET  /v1/health      always unauthenticated         → expect 200
#
# Probes /v1/whoami (T3's auth-gated route) instead of /v1/sessions
# so the smoke is self-contained — T2 doesn't have to land first.
# T2 will land its /v1/sessions route behind the same hook and will
# inherit the same auth gate automatically.
#
# TDD: this file was written before the T3 routes existed. Run with
# the bridge NOT yet patched → stages 1-8 all FAIL (connection refused
# or 404). After T3 lands, all 8 PASS.

set -euo pipefail

PORT="${BRIDGE_PORT:-7892}"
HOST="${BRIDGE_HOST:-127.0.0.1}"
BASE="http://${HOST}:${PORT}"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "  ok  $*"; }

echo "== pair.sh: 3-stage pairing-code + bearer-token auth =="

# Stage 1: issue a pairing code (no auth)
issue_resp="$(curl -fsS -X POST "${BASE}/v1/pair/issue" || true)"
[[ -n "$issue_resp" ]] || fail "stage 1: /v1/pair/issue returned empty"
code="$(printf '%s' "$issue_resp" | jq -r '.code')"
[[ "$code" =~ ^[A-Z2-9]{6}$ ]] || fail "stage 1: code not 6-char alphanumeric: $issue_resp"
expires_at="$(printf '%s' "$issue_resp" | jq -r '.expires_at')"
[[ "$expires_at" == "null" || -z "$expires_at" ]] && fail "stage 1: missing expires_at"
ok "stage 1: issued code=$code (expires $expires_at)"

# Stage 2: exchange the code for a bearer token (no auth)
exchange_resp="$(curl -fsS -X POST -H 'Content-Type: application/json' \
  -d "{\"code\":\"${code}\"}" "${BASE}/v1/pair" || true)"
[[ -n "$exchange_resp" ]] || fail "stage 2: /v1/pair returned empty"
pair_id="$(printf '%s' "$exchange_resp" | jq -r '.pair_id')"
token="$(printf '%s' "$exchange_resp" | jq -r '.token')"
[[ "$pair_id" == dev_pair_* ]] || fail "stage 2: pair_id not prefixed dev_pair_: $exchange_resp"
[[ "$token" =~ ^[0-9a-f]{64}$ ]] || fail "stage 2: token not 64-char hex: $exchange_resp"
ok "stage 2: exchanged for pair_id=$pair_id (token=${token:0:8}...)"

# Stage 3: auth-gated request WITH a valid token → expect 200
auth_header3="Authorization: Bearer ${token}"
status="$(curl -s -o /tmp/pair_whoami_ok.json -w '%{http_code}' \
  -H "$auth_header3" "${BASE}/v1/whoami")"
[[ "$status" == "200" ]] || fail "stage 3: /v1/whoami with valid token returned $status (expected 200): $(cat /tmp/pair_whoami_ok.json)"
whoami_pair="$(jq -r '.pair_id' </tmp/pair_whoami_ok.json)"
[[ "$whoami_pair" == "$pair_id" ]] || fail "stage 3: /v1/whoami pair_id mismatch: $whoami_pair vs $pair_id"
ok "stage 3: auth-gated /v1/whoami → 200 (pair_id matches)"

# Stage 4: auth-gated request WITHOUT a token → expect 401
status="$(curl -s -o /tmp/pair_noauth.json -w '%{http_code}' "${BASE}/v1/whoami")"
[[ "$status" == "401" ]] || fail "stage 4: /v1/whoami without auth returned $status (expected 401): $(cat /tmp/pair_noauth.json)"
ok "stage 4: /v1/whoami without bearer → 401"

# Stage 5: reuse the consumed code → expect 410
status="$(curl -s -o /tmp/pair_reuse.json -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -d "{\"code\":\"${code}\"}" "${BASE}/v1/pair")"
[[ "$status" == "410" ]] || fail "stage 5: /v1/pair reuse returned $status (expected 410): $(cat /tmp/pair_reuse.json)"
ok "stage 5: consumed code reuse → 410"

# Stage 6: bogus token → expect 401
status="$(curl -s -o /tmp/pair_bogus.json -w '%{http_code}' \
  -H 'Authorization: Bearer 012345...def' \
  "${BASE}/v1/whoami")"
[[ "$status" == "401" ]] || fail "stage 6: /v1/whoami with bogus token returned $status (expected 401)"
ok "stage 6: bogus bearer token → 401"

# Stage 7: malformed body → expect 400
status="$(curl -s -o /tmp/pair_bad.json -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -d '{"code":"AB"}' "${BASE}/v1/pair")"
[[ "$status" == "400" ]] || fail "stage 7: /v1/pair invalid format returned $status (expected 400): $(cat /tmp/pair_bad.json)"
ok "stage 7: malformed pairing body → 400"

# Stage 8: /v1/health is never gated → expect 200 (auth scheme intact)
status="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/v1/health")"
[[ "$status" == "200" ]] || fail "stage 8: /v1/health returned $status (expected 200)"
ok "stage 8: /v1/health remains unauthenticated"

echo "PASS: 3-stage pairing-code + bearer-token auth (8/8 stages green)"