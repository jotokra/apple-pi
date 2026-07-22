#!/usr/bin/env bash
# mobile-bridge/smoke/health.sh — T1 smoke: GET /v1/health returns ok.
#
# Tripwires pinned:
#   T1-T1  HTTP 200 from /v1/health on the bound port
#   T1-T2  body contains `"ok":true` (literal — no whitespace required)
#   T1-T3  body contains `"version":"0.1.0"` (literal)
#
# Pre-conditions: bridge must be running (start it in another shell with
#   BRIDGE_PORT=7892 node mobile-bridge/bin/bridge.mjs
# then run this script). When the route is NOT implemented yet, this
# smoke fails with `curl: (7) Failed to connect to 127.0.0.1 port 7892`
# — that's the expected RED step of the TDD cycle (plan-01 Task 1).
#
# Plan ref: plan-01 Task 1.

set -euo pipefail

PORT="${BRIDGE_PORT:-7892}"
HOST="${BRIDGE_HOST:-127.0.0.1}"

RESP=$(curl -fsS "http://${HOST}:${PORT}/v1/health")

if ! grep -q '"ok":true' <<<"$RESP"; then
  echo "FAIL: $RESP"
  exit 1
fi

echo "PASS: $RESP"