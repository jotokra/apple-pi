// mobile-bridge/lib/iap.mjs
//
// Phase 1 — IAP receipt validation + subscription-gated token issuance.
//
// Flow (SUPERPROMPT §6 receipts[], §7.1, D3 IAP-only, D11 post-sub token):
//   1. iOS app completes a StoreKit 2 purchase → obtains a transaction
//      receipt (base64-encoded PKCS#7 payload).
//   2. App POSTs { receipt: <base64> } to /v1/iap/validate.
//   3. The bridge forwards the receipt to Apple's verifyReceipt endpoint
//      (production first; on status 21007 "this is a sandbox receipt"
//      it retries against the sandbox endpoint — Apple's documented
//      guidance). The verifier is INJECTED so tests never hit Apple.
//   4. interpretReceipt() turns Apple's response into a subscription
//      status: active | expired | refunded | invalid | no_subscription.
//   5. On active sub: upsert a receipts[] row, issue (or rotate) a
//      bearer token whose pair row is linked to the receipt, and return
//      { pair_id, token, created_at, subscription }.
//   6. On inactive sub: return { pair_id: null, token: null, subscription }
//      (HTTP 402 from the route — no entitlement, no token).
//
// The subscription GATE itself lives in bridge.mjs (requireSubscription
// preHandler, opt-in via BRIDGE_REQUIRE_IAP). This module is pure
// validation + issuance — no route knowledge, no Fastify.
//
// Apple's verifyReceipt is officially deprecated in favour of StoreKit 2
// JWS / App Store Server API, but remains the simplest server-side path
// and is still supported. When the iOS app moves to StoreKit 2 (Phase 3+),
// swap verifyWithApple() for a JWS verifier; interpretReceipt()'s output
// shape stays the same so the rest of the bridge is untouched.

import crypto from "node:crypto";
import * as pairing from "./pairing.mjs";

export const APPLE_VERIFY_PROD = "https://buy.itunes.apple.com/verifyReceipt";
export const APPLE_VERIFY_SANDBOX = "https://sandbox.itunes.apple.com/verifyReceipt";

// Apple verifyReceipt `status` field. 0 == valid. 21007 == "this is a
// sandbox receipt, retry on the sandbox endpoint" — the one status that
// is not a hard failure, it's a routing hint.
export const STATUS_OK = 0;
export const STATUS_SANDBOX_RECEIPT = 21007;

export class IapError extends Error {
  /**
   * @param {string} reason - machine-readable (missing_receipt | verifier_failure)
   * @param {number} status - HTTP status
   */
  constructor(reason, status) {
    super(reason);
    this.name = "IapError";
    this.reason = reason;
    this.status = status;
  }
}

/**
 * Default Apple verifier. POSTs the receipt to production, and if Apple
 * replies 21007 (sandbox receipt), retries against the sandbox endpoint.
 * Everything Apple-facing is injectable (fetchImpl, urls, sharedSecret)
 * so unit tests run fully offline.
 *
 * @param {string} receiptB64 - base64 receipt payload from the device
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl] - defaults to globalThis.fetch
 * @param {string} [opts.prodUrl]
 * @param {string} [opts.sandboxUrl]
 * @param {string} [opts.sharedSecret] - App-Specific Shared Secret (auto-renew subs)
 * @returns {Promise<object>} parsed Apple verifyReceipt JSON
 * @throws {IapError} on a network/transport failure (not on Apple status codes —
 *                   those are returned in-band as { status: <n> } so the caller
 *                   can interpret them).
 */
export async function verifyWithApple(receiptB64, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new IapError("verifier_failure", 500);
  }
  const prodUrl = opts.prodUrl ?? APPLE_VERIFY_PROD;
  const sandboxUrl = opts.sandboxUrl ?? APPLE_VERIFY_SANDBOX;
  const body = JSON.stringify({
    "receipt-data": receiptB64,
    ...(opts.sharedSecret ? { password: opts.sharedSecret } : {}),
  });

  const call = async (url) => {
    let resp;
    try {
      resp = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    } catch (err) {
      throw new IapError("verifier_failure", 502);
    }
    // Apple always returns 200 with the real status in the JSON body,
    // but tolerate a non-200 transport if it ever happens.
    if (!resp.ok) throw new IapError("verifier_failure", 502);
    try {
      return await resp.json();
    } catch {
      throw new IapError("verifier_failure", 502);
    }
  };

  const prod = await call(prodUrl);
  if (prod.status === STATUS_SANDBOX_RECEIPT) {
    return call(sandboxUrl);
  }
  return prod;
}

/**
 * Interpret an Apple verifyReceipt response as a subscription status.
 * Pure function — no I/O, no state. Trivially unit-testable.
 *
 * Apple's auto-renewable-sub response puts the transaction history in
 * `latest_receipt_info` (an array, last entry = newest). A subscription
 * is active iff the newest entry's expires_date_ms is in the future AND
 * it has not been cancelled/refunded (cancellation_date_ms present).
 *
 * @param {object} appleResp
 * @returns {{
 *   is_active: boolean,
 *   status: "active"|"expired"|"refunded"|"invalid"|"no_subscription",
 *   expires_at_ms: number|null,
 *   original_transaction_id: string|null,
 *   product_id: string|null,
 *   raw_status?: number,
 * }}
 */
export function interpretReceipt(appleResp) {
  if (!appleResp || typeof appleResp !== "object") {
    return { is_active: false, status: "invalid", expires_at_ms: null, original_transaction_id: null, product_id: null };
  }
  // Any non-zero status (other than the 21007 routing hint, which the
  // verifier already resolved before we get here) = invalid receipt.
  if (typeof appleResp.status === "number" && appleResp.status !== STATUS_OK) {
    return { is_active: false, status: "invalid", expires_at_ms: null, original_transaction_id: null, product_id: null, raw_status: appleResp.status };
  }
  const infos = appleResp.latest_receipt_info;
  const latest = Array.isArray(infos) && infos.length ? infos[infos.length - 1] : null;
  if (!latest) {
    return { is_active: false, status: "no_subscription", expires_at_ms: null, original_transaction_id: null, product_id: null };
  }
  const expires_at_ms = latest.expires_date_ms != null ? Number(latest.expires_date_ms) : null;
  const refunded = latest.cancellation_date_ms != null;
  const now = Date.now();
  const not_expired = expires_at_ms != null && expires_at_ms > now;
  const status = refunded ? "refunded" : not_expired ? "active" : "expired";
  return {
    is_active: !refunded && not_expired,
    status,
    expires_at_ms,
    original_transaction_id: latest.original_transaction_id ?? null,
    product_id: latest.product_id ?? null,
  };
}

/**
 * Validate a receipt against Apple, upsert the receipts[] state, and
 * issue (or rotate) a subscription-linked bearer token on an active sub.
 * Atomic with respect to other state mutations (runs under state.mutate's
 * serial queue).
 *
 * @param {import("./state.mjs").State} state
 * @param {string} receiptB64
 * @param {object} [verifierOpts] - forwarded to verifyWithApple (inject for tests)
 * @returns {Promise<{pair_id: string|null, token: string|null, created_at: (string|null), subscription: object}>}
 * @throws {IapError} missing_receipt (400) | verifier_failure (502)
 */
export async function validateAndIssue(state, receiptB64, verifierOpts = {}) {
  if (typeof receiptB64 !== "string" || receiptB64.length === 0) {
    throw new IapError("missing_receipt", 400);
  }
  const appleResp = await verifyWithApple(receiptB64, verifierOpts);
  const sub = interpretReceipt(appleResp);
  const now = Date.now();
  const isoNow = new Date(now).toISOString();

  return state.mutate((data) => {
    // Forward-compat: Phase 0 state files have no receipts[] key.
    if (!Array.isArray(data.receipts)) data.receipts = [];

    let receiptRow = null;
    if (sub.original_transaction_id) {
      receiptRow = data.receipts.find(
        (r) => r.original_transaction_id === sub.original_transaction_id,
      );
    }
    if (receiptRow) {
      // Refresh-in-place: update status/expiry/product on re-validate.
      receiptRow.status = sub.status;
      receiptRow.expires_at_ms = sub.expires_at_ms;
      receiptRow.product_id = sub.product_id;
      receiptRow.validated_at = isoNow;
    } else if (sub.original_transaction_id) {
      // First validation of this subscription.
      receiptRow = {
        receipt_uuid: "rcpt_" + crypto.randomBytes(10).toString("hex"),
        original_transaction_id: sub.original_transaction_id,
        product_id: sub.product_id,
        expires_at_ms: sub.expires_at_ms,
        status: sub.status,
        validated_at: isoNow,
        pair_id: null,
      };
      data.receipts.push(receiptRow);
    }

    if (!sub.is_active || !receiptRow) {
      // No entitlement. Never issue a token. The route maps this to 402.
      return { pair_id: null, token: null, created_at: null, subscription: sub };
    }

    // Active sub: issue or rotate a bearer token linked to this receipt.
    let pair = receiptRow.pair_id
      ? data.pairs.find((p) => p.pair_id === receiptRow.pair_id)
      : null;
    if (pair) {
      // Rotate the token on every successful re-validation so a leaked
      // old token stops working once the client refreshes.
      pair.token = pairing.generateToken();
      pair.last_seen = isoNow;
    } else {
      const pair_id = pairing.generatePairId();
      pair = {
        pair_id,
        token: pairing.generateToken(),
        created_at: isoNow,
        last_seen: isoNow,
        label: null,
        receipt_original_transaction_id: sub.original_transaction_id,
      };
      data.pairs.push(pair);
      receiptRow.pair_id = pair_id;
    }
    return {
      pair_id: pair.pair_id,
      token: pair.token,
      created_at: pair.created_at,
      subscription: sub,
    };
  });
}
