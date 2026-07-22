// mobile-bridge/lib/iap.test.mjs
//
// Unit tests for Phase 1 IAP validation. Fully offline — the Apple
// verifier is injected (fetchImpl / urls), so these run with no network
// and no Apple Developer account. Run with: node --test lib/iap.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  interpretReceipt,
  verifyWithApple,
  validateAndIssue,
  IapError,
  STATUS_SANDBOX_RECEIPT,
} from "./iap.mjs";
import { State } from "./state.mjs";

// ---- helpers --------------------------------------------------------------

async function tmpState() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iap-test-"));
  const state = new State(path.join(dir, "state.json"));
  await state.load();
  return { state, dir };
}

/** Build a canned Apple verifyReceipt response. */
function appleResp({ status = 0, expires_ms, cancelled = false, otx = "OTX_1", product = "app.monthly" } = {}) {
  if (status !== 0) return { status };
  const info = {
    original_transaction_id: otx,
    product_id: product,
    expires_date_ms: expires_ms != null ? String(expires_ms) : null,
  };
  if (cancelled) info.cancellation_date_ms = String(Date.now());
  return { status: 0, latest_receipt_info: [info] };
}

/** A fetchImpl that returns a fixed JSON body regardless of URL. */
function fetchReturning(body) {
  return async () => ({ ok: true, json: async () => body });
}

/** A fetchImpl that returns different bodies for prod vs sandbox URLs. */
function fetchRouting(prodBody, sandboxBody) {
  return async (url) => {
    const body = String(url).includes("sandbox") ? sandboxBody : prodBody;
    return { ok: true, json: async () => body };
  };
}

// ---- interpretReceipt (pure) ---------------------------------------------

test("interpretReceipt: active subscription in the future", () => {
  const r = interpretReceipt(appleResp({ expires_ms: Date.now() + 86_400_000 }));
  assert.equal(r.status, "active");
  assert.equal(r.is_active, true);
  assert.equal(r.original_transaction_id, "OTX_1");
});

test("interpretReceipt: expired (expires in the past)", () => {
  const r = interpretReceipt(appleResp({ expires_ms: Date.now() - 1000 }));
  assert.equal(r.status, "expired");
  assert.equal(r.is_active, false);
});

test("interpretReceipt: refunded (cancellation_date_ms present)", () => {
  const r = interpretReceipt(appleResp({ expires_ms: Date.now() + 86_400_000, cancelled: true }));
  assert.equal(r.status, "refunded");
  assert.equal(r.is_active, false);
});

test("interpretReceipt: invalid (non-zero Apple status)", () => {
  const r = interpretReceipt({ status: 21003 }); // receipt authentication failed
  assert.equal(r.status, "invalid");
  assert.equal(r.is_active, false);
  assert.equal(r.raw_status, 21003);
});

test("interpretReceipt: no_subscription (empty latest_receipt_info)", () => {
  const r = interpretReceipt({ status: 0, latest_receipt_info: [] });
  assert.equal(r.status, "no_subscription");
  assert.equal(r.is_active, false);
});

// ---- verifyWithApple (sandbox fallback, transport) -----------------------

test("verifyWithApple: status 21007 retries on the sandbox endpoint", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    // First (prod) call returns the sandbox-routing hint; the second
    // (sandbox) call returns a valid active receipt.
    const body = calls.length === 1
      ? { status: STATUS_SANDBOX_RECEIPT }
      : appleResp({ expires_ms: Date.now() + 86_400_000 });
    return { ok: true, json: async () => body };
  };
  const resp = await verifyWithApple("r", {
    fetchImpl,
    prodUrl: "https://prod.example",
    sandboxUrl: "https://sandbox.example",
  });
  assert.equal(calls.length, 2, "should call prod then sandbox");
  assert.match(calls[0], /prod/);
  assert.match(calls[1], /sandbox/);
  assert.equal(resp.status, 0);
});

test("verifyWithApple: transport failure → IapError(502)", async () => {
  const fetchImpl = async () => { throw new Error("network down"); };
  await assert.rejects(
    () => verifyWithApple("r", { fetchImpl, prodUrl: "https://prod.example", sandboxUrl: "https://sandbox.example" }),
    (err) => err instanceof IapError && err.status === 502,
  );
});

// ---- validateAndIssue (stateful) -----------------------------------------

test("validateAndIssue: active sub issues a token + persists the receipt row", async () => {
  const { state, dir } = await tmpState();
  try {
    const active = appleResp({ expires_ms: Date.now() + 86_400_000 });
    const res = await validateAndIssue(state, "receipt-blob", {
      fetchImpl: fetchReturning(active),
      prodUrl: "https://prod.example",
      sandboxUrl: "https://sandbox.example",
    });
    assert.equal(res.subscription.status, "active");
    assert.ok(res.token, "must issue a token on active sub");
    assert.ok(res.pair_id);
    const snap = state.snapshot();
    assert.equal(snap.receipts.length, 1);
    assert.equal(snap.receipts[0].status, "active");
    assert.equal(snap.pairs.length, 1);
    assert.equal(snap.pairs[0].receipt_original_transaction_id, "OTX_1");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("validateAndIssue: expired sub returns NO token (route → 402)", async () => {
  const { state, dir } = await tmpState();
  try {
    const expired = appleResp({ expires_ms: Date.now() - 1000 });
    const res = await validateAndIssue(state, "receipt-blob", {
      fetchImpl: fetchReturning(expired),
      prodUrl: "https://prod.example",
      sandboxUrl: "https://sandbox.example",
    });
    assert.equal(res.token, null);
    assert.equal(res.pair_id, null);
    assert.equal(res.subscription.status, "expired");
    // No pair should have been issued.
    assert.equal(state.snapshot().pairs.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("validateAndIssue: re-validation rotates the token + refreshes the receipt row", async () => {
  const { state, dir } = await tmpState();
  try {
    const active = appleResp({ expires_ms: Date.now() + 86_400_000 });
    const opts = { fetchImpl: fetchReturning(active), prodUrl: "https://prod.example", sandboxUrl: "https://sandbox.example" };
    const first = await validateAndIssue(state, "r", opts);
    const firstToken = first.token;
    const second = await validateAndIssue(state, "r", opts);
    // Same subscription (same OTX) → same pair_id, ROTATED token.
    assert.equal(second.pair_id, first.pair_id);
    assert.notEqual(second.token, firstToken, "token must rotate on re-validation");
    // Still exactly one receipt row + one pair row (upsert, not append).
    const snap = state.snapshot();
    assert.equal(snap.receipts.length, 1);
    assert.equal(snap.pairs.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("validateAndIssue: missing receipt → IapError(400)", async () => {
  const { state, dir } = await tmpState();
  try {
    await assert.rejects(
      () => validateAndIssue(state, "", { fetchImpl: fetchReturning({}), prodUrl: "x", sandboxUrl: "y" }),
      (err) => err instanceof IapError && err.status === 400 && err.reason === "missing_receipt",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- state entitlement gate ----------------------------------------------

test("State.isPairEntitled: requireIap off → any pair entitled (Phase 0 compat)", async () => {
  const { state, dir } = await tmpState();
  try {
    const pair = { pair_id: "p1", token: "t", receipt_original_transaction_id: undefined };
    assert.equal(state.isPairEntitled(pair, false), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("State.isPairEntitled: requireIap on → pairing token rejected, active-receipt pair allowed", async () => {
  const { state, dir } = await tmpState();
  try {
    // Seed an active receipt + a linked pair, and a pairing-only pair.
    await state.mutate((d) => {
      d.receipts = [{ original_transaction_id: "OTX_A", status: "active", expires_at_ms: Date.now() + 1000 }];
      d.pairs = [
        { pair_id: "sub", token: "t1", receipt_original_transaction_id: "OTX_A" },
        { pair_id: "pair", token: "t2", receipt_original_transaction_id: undefined },
      ];
    });
    assert.equal(state.isPairEntitled(state.findPairByToken("t1"), true), true);
    assert.equal(state.isPairEntitled(state.findPairByToken("t2"), true), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
