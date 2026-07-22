// mobile-bridge/lib/pairing.mjs
//
// Pairing-code → bearer-token exchange.
//
// Flow:
//   1. The host runs `POST /v1/pair/issue` (or `apple-pi mobile
//      pair-device` once T7 lands) to get a 6-char alphanumeric
//      code valid for 10 minutes.
//   2. The iOS app (or curl) calls `POST /v1/pair` with the code.
//   3. The bridge consumes the code (one-shot), issues a 32-byte
//      hex bearer token, persists a `pairs[]` row, returns
//      `{ pair_id, token, expires_at: null }`.
//
// Token format: 32 random bytes → 64 hex chars. Pair-id format:
// `dev_pair_<14-char-base32>` (ULID-ish; readable in logs, no
// timestamp-in-id needed yet — start time is stored separately).
//
// We use `node:crypto` for everything; no third-party deps.

import crypto from "node:crypto";

export const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const CODE_LENGTH = 6;
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
// 32 random bytes → 64 hex chars. Spec: §7.1 + D11.
const TOKEN_BYTES = 32;

export function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH * 2); // oversample for rejection sampling
  let out = "";
  for (let i = 0; i < bytes.length && out.length < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  if (out.length < CODE_LENGTH) {
    // Extremely unlikely with 12 random bytes → 6 picks; fall back
    // to a fresh draw rather than panic.
    return generateCode();
  }
  return out;
}

export function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("hex");
}

export function generatePairId() {
  // 14 base32 chars (no padding). 5 random bytes → ~80 bits,
  // collision-safe at this scale.
  const bytes = crypto.randomBytes(10);
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford-ish
  let out = "dev_pair_";
  for (let i = 0; i < bytes.length && out.length < 14 + "dev_pair_".length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/**
 * Issue a fresh pairing code. Atomic with respect to other
 * issueCode / consumeCode calls (relies on State.mutate's serial
 * queue).
 *
 * @param {import("./state.mjs").State} state
 * @returns {Promise<{code: string, expires_at: string}>}
 */
export async function issueCode(state) {
  return state.mutate((data) => {
    // Drop any stale codes first so the active set is clean.
    const now = Date.now();
    data.pending_codes = data.pending_codes.filter(
      (c) => c.expires_at_ms > now,
    );
    const code = generateCode();
    const expires_at_ms = now + CODE_TTL_MS;
    data.pending_codes.push({
      code,
      expires_at_ms,
      issued_at: new Date(now).toISOString(),
    });
    return {
      code,
      expires_at: new Date(expires_at_ms).toISOString(),
    };
  });
}

/**
 * Consume a pairing code → issue a bearer token. The code is
 * removed whether or not it was valid (so attackers can't burn a
 * guessed code twice).
 *
 * @param {import("./state.mjs").State} state
 * @param {string} code
 * @returns {Promise<{pair_id: string, token: string, created_at: string}>}
 * @throws {PairingError} when code is missing, unknown, or expired.
 */
export async function consumeCode(state, code) {
  if (typeof code !== "string" || code.length === 0) {
    throw new PairingError("missing_code", 400);
  }
  const normalized = code.trim().toUpperCase();
  if (normalized.length !== CODE_LENGTH) {
    throw new PairingError("invalid_code", 400);
  }
  return state.mutate((data) => {
    const now = Date.now();
    // GC expired codes first.
    data.pending_codes = data.pending_codes.filter(
      (c) => c.expires_at_ms > now,
    );
    const idx = data.pending_codes.findIndex((c) => c.code === normalized);
    if (idx === -1) {
      // Either expired-then-GC'd, never existed, or already consumed.
      // All three collapse to 410 Gone — the spec calls this out
      // explicitly (plan-01 Task 3 Step 2).
      throw new PairingError("code_expired", 410);
    }
    data.pending_codes.splice(idx, 1);
    const pair_id = generatePairId();
    const token = generateToken();
    const created_at = new Date(now).toISOString();
    data.pairs.push({
      pair_id,
      token,
      created_at,
      last_seen: created_at,
      label: null,
    });
    return { pair_id, token, created_at };
  });
}

export class PairingError extends Error {
  /**
   * @param {string} reason - machine-readable: missing_code | invalid_code | code_expired
   * @param {number} status - HTTP status to return
   */
  constructor(reason, status) {
    super(reason);
    this.name = "PairingError";
    this.reason = reason;
    this.status = status;
  }
}