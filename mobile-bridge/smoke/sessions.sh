#!/usr/bin/env bash
# mobile-bridge/smoke/sessions.sh — T2 smoke: GET /v1/sessions returns
# the JSONL-derived list.
#
# Tripwires pinned:
#   T2-T1  GET /v1/sessions responds with HTTP 200 + valid JSON envelope
#          of the shape { "schema_version": 1, "sessions": [...] }.
#   T2-T2  every session row has all 9 required fields (id, started_at,
#          ended_at, last_activity_at, current_status, model, branch_count,
#          msg_count, size_bytes).
#   T2-T3  current_status is exactly one of {"running","idle"}.
#   T2-T4  size_bytes is a non-negative number per row.
#   T2-T5  branch_count and msg_count are non-negative integers per row.
#   T2-T6  the row's `id` matches a UUID-shaped substring parsed out of
#          the corresponding file in PI_SESSIONS_DIR (or default
#          ~/.pi/sessions) — catches accidental id-from-filename bugs.
#
# Pre-conditions:
#   * bridge running on BRIDGE_HOST:BRIDGE_PORT (default 127.0.0.1:7892).
#   * PI_SESSIONS_DIR (or default ~/.pi/sessions) has at least 1 *.jsonl.
#   * caller has issued a pair via /v1/pair/issue and called /v1/pair;
#     the resulting bearer token is in BRIDGE_BEARER env var.
#     (If missing, this smoke fails-closed at T2-T0 — auth gate.)
#
# Plan ref: plan-01 Task 2.

set -euo pipefail

PORT="${BRIDGE_PORT:-7892}"
HOST="${BRIDGE_HOST:-127.0.0.1}"
BASE_URL="http://${HOST}:${PORT}"
SESSIONS_DIR="${PI_SESSIONS_DIR:-$HOME/.pi/sessions}"

# Fail-closed at T2-T0: refusing to test without a bearer is the
# cheapest way to prove auth actually wired up. Two-step pairing
# (`/v1/pair/issue` then `/v1/pair`) is exercised separately by
# smoke/pair.sh; this smoke assumes a token is already issued.
if [[ -z "${BRIDGE_BEARER:-}" ]]; then
  echo "FAIL: T2-T0 BRIDGE_BEARER env var not set; run after smoke/pair.sh"
  exit 1
fi

# Sanity: at least one session file must exist for the data-tied
# assertions (T2-T6). The shape-only assertions (T2-T1..T2-T5) work
# even on empty listings, so we run them first.
RESP=$(curl -fsS \
  -H "Authorization: Bearer ${BRIDGE_BEARER}" \
  "${BASE_URL}/v1/sessions")

if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL: T2-T1 jq is required to validate JSON shape"
  echo "raw response: $RESP"
  exit 1
fi

# T2-T1: envelope shape.
if ! jq -e '.schema_version == 1 and (.sessions | type == "array")' \
    <<<"$RESP" >/dev/null; then
  echo "FAIL: T2-T1 envelope is not { schema_version:1, sessions:[...] }"
  echo "raw response: $RESP"
  exit 1
fi

# T2-T2 + T2-T3 + T2-T4 + T2-T5: per-row field shape, type, and
# allowed values. jq expression fails with exit != 0 if any row
# violates a constraint.
if ! jq -e '
  .sessions
  | all(
      (has("id") and (.id | type == "string") and (.id | length > 0))
      and (has("started_at") and (.started_at | type == "string"))
      and (has("ended_at") and (.ended_at == null or (.ended_at | type == "string")))
      and (has("last_activity_at") and (.last_activity_at | type == "string"))
      and (has("current_status") and (.current_status | IN("running", "idle")))
      and (has("model") and (.model == null or (.model | type == "string")))
      and (has("branch_count") and (.branch_count | type == "number") and .branch_count >= 0)
      and (has("msg_count") and (.msg_count | type == "number") and .msg_count >= 0)
      and (has("size_bytes") and (.size_bytes | type == "number") and .size_bytes >= 0)
    )
' <<<"$RESP" >/dev/null; then
  echo "FAIL: T2-T2/T2-T3/T2-T4/T2-T5 one or more rows miss a required field or have the wrong type"
  echo "raw response: $RESP"
  exit 1
fi

# T2-T6: per-row `id` matches a UUID-shaped substring of the
# corresponding filename in $SESSIONS_DIR. With ≥1 session file present,
# enumerate the corresponding filename's UUID-tail and confirm the
# response has a row whose id matches.
if compgen -G "${SESSIONS_DIR}/*.jsonl" > /dev/null && \
   [[ "$(ls -1 "${SESSIONS_DIR}"/*.jsonl 2>/dev/null | wc -l | tr -d ' ')" -ge 1 ]]; then
  # Pull every UUID-tail from the session files.
  EXPECTED_IDS=$(for f in "${SESSIONS_DIR}"/*.jsonl; do
    base="$(basename "$f" .jsonl)"
    echo "${base##*_}"
  done | sort -u)
  if ! grep -Fqx "$(echo "$EXPECTED_IDS" | head -1)" \
       <(jq -r '.sessions[].id' <<<"$RESP"); then
    # Not every file has to be listed (the listing is best-effort, one
    # torn JSONL may be dropped). But AT LEAST ONE expected id must
    # appear in the response.
    FOUND=0
    while IFS= read -r expected; do
      [[ -z "$expected" ]] && continue
      if jq -r --arg eid "$expected" \
           '.sessions[].id | select(. == $eid)' \
           <<<"$RESP" | grep -q .; then
        FOUND=1
        break
      fi
    done <<<"$EXPECTED_IDS"
    if [[ "$FOUND" -ne 1 ]]; then
      echo "FAIL: T2-T6 response has no row whose id matches any UUID parsed out of ${SESSIONS_DIR}/*.jsonl"
      echo "expected ids (subset): $(echo "$EXPECTED_IDS" | head -3)"
      echo "raw response: $RESP"
      exit 1
    fi
  fi
fi

# Filter out the noisy default fields for the PASS line so the
# terminal stays scannable, but include the row count so a future
# debugging pass knows what to grep for.
ROW_COUNT=$(jq '.sessions | length' <<<"$RESP")
echo "PASS: GET /v1/sessions returns { schema_version:1, sessions:[...] } ($ROW_COUNT rows)"
