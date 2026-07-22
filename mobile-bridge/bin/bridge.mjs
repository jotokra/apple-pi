// mobile-bridge/bin/bridge.mjs
//
// apple-pi mobile-bridge — Phase 0.
//
// Boots a Fastify 5 server on 127.0.0.1:7892 (override via
// BRIDGE_HOST / BRIDGE_PORT env vars). This file is the entry point
// for the daemon; route handlers land in subsequent Tasks:
//   T1: GET /v1/health              (this file)
//   T2: GET /v1/sessions            (lib/sessions.mjs)
//   T3: POST /v1/pair/issue         (lib/pairing.mjs + lib/state.mjs)
//        POST /v1/pair
//        GET  /v1/whoami            (auth-required; returns the pair row)
//        preHandler bearer-token hook
//   T4: GET /v1/sessions/:id/tree   (lib/tree.mjs)
//   T5: GET /v1/sessions/:id/raw    (lib/raw.mjs)
//   T6: POST /v1/sessions/:id/heartbeat
//
// Plan ref: plan-01 Task 1 + Task 3 (auth scheme per SUPERPROMPT §7.1,
// D11: bearer-token post-sub OR pairing-code pre-sub; no OAuth).

import Fastify from "fastify";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promises as fs } from "node:fs";

import { State, defaultStatePath } from "../lib/state.mjs";
import * as pairing from "../lib/pairing.mjs";
import {
  SESSIONS_DIR,
  listSessions,
} from "../lib/sessions.mjs";
import {
  streamSessionJsonl,
  RawError,
} from "../lib/raw.mjs";
import { validateAndIssue, IapError } from "../lib/iap.mjs";

const PORT = Number(process.env.BRIDGE_PORT ?? 7892);
const HOST = process.env.BRIDGE_HOST ?? "127.0.0.1";
const VERSION = "0.1.0";

// Phase 1 — IAP receipt validation. The subscription GATE is opt-in:
// only bridges that set BRIDGE_REQUIRE_IAP=1 reject pairing-only tokens
// on /v1/sessions* with 402. Default (unset) preserves Phase 0
// behaviour (any valid token reads) for local/dev + the App-Review demo
// bridge. The Apple verifier URLs/secret are env-overridable so the smoke
// can point at a local mock and run fully offline.
const REQUIRE_IAP = process.env.BRIDGE_REQUIRE_IAP === "1";
const IAP_VERIFIER_OPTS = {
  ...(process.env.APPLE_VERIFY_PROD_URL ? { prodUrl: process.env.APPLE_VERIFY_PROD_URL } : {}),
  ...(process.env.APPLE_VERIFY_SANDBOX_URL ? { sandboxUrl: process.env.APPLE_VERIFY_SANDBOX_URL } : {}),
  ...(process.env.APPLE_SHARED_SECRET ? { sharedSecret: process.env.APPLE_SHARED_SECRET } : {}),
};

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = path.resolve(path.dirname(__filename), "..");

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
});

// Persistent state (mode 0600 on disk via lib/state.mjs). Holds
// pending pairing codes + issued pairs + (T6) session heartbeats.
const state = new State(defaultStatePath(PKG_ROOT));
await state.load();

// T1 — liveness probe. Always unauthenticated.
app.get("/v1/health", async () => ({
  ok: true,
  version: VERSION,
  uptime_s: Math.floor(process.uptime()),
}));

// T3 — pre-auth: issue a 6-char pairing code valid for 10 minutes.
// No Authorization header required (the code itself is the auth).
app.post("/v1/pair/issue", async () => pairing.issueCode(state));

// T3 — pre-auth: exchange the code for a long-lived bearer token.
// 200 on success; 410 Gone if the code expired or was already consumed;
// 400 if the body shape is wrong.
app.post("/v1/pair", async (req, reply) => {
  let body = req.body;
  // Fastify may not auto-parse JSON for short bodies; tolerate both.
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const code = body && typeof body === "object" ? body.code : undefined;
  try {
    return await pairing.consumeCode(state, code);
  } catch (err) {
    if (err instanceof pairing.PairingError) {
      return reply
        .code(err.status)
        .send({ error: err.reason, message: humanizePairError(err.reason) });
    }
    throw err;
  }
});

function humanizePairError(reason) {
  switch (reason) {
    case "missing_code":  return "request body must include { code: string }";
    case "invalid_code":  return "code must be exactly 6 alphanumeric characters";
    case "code_expired":  return "pairing code expired or already used; request a new one via POST /v1/pair/issue";
    default:              return reason;
  }
}

// Phase 1 — IAP receipt validation → subscription-gated bearer token.
// Unauthenticated (the receipt IS the credential). On an active Apple
// subscription, issues (or rotates) a token whose pair row is linked to
// the receipt; on inactive/expired/refunded/invalid, returns 402 with
// the subscription status so the app can act on it (re-purchase,
// restore, refresh). Apple-call config comes from IAP_VERIFIER_OPTS.
app.post("/v1/iap/validate", async (req, reply) => {
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const receipt = body && typeof body === "object" ? body.receipt : undefined;
  try {
    const result = await validateAndIssue(state, receipt, IAP_VERIFIER_OPTS);
    if (result.token) {
      return reply.code(200).send(result);
    }
    // Valid Apple response but no active entitlement.
    return reply.code(402).send({
      error: "payment_required",
      subscription: result.subscription,
    });
  } catch (err) {
    if (err instanceof IapError) {
      return reply.code(err.status).send({ error: err.reason });
    }
    throw err;
  }
});

// T3 — preHandler bearer-token gate. Applied to ALL routes except
// the unauthenticated ones below. Pattern matches plan-01 Task 3
// Step 4 + SUPERPROMPT §7.1 (auth scheme).
//
// We attach the resolved pair row to `req.pair` so handlers can
// access it without re-querying state.
const UNAUTHENTICATED = new Set(["/v1/health", "/v1/pair/issue", "/v1/iap/validate"]);
app.addHook("preHandler", async (req, reply) => {
  const url = req.url.split("?")[0];
  if (UNAUTHENTICATED.has(url)) return;
  if (url === "/v1/pair") return; // /v1/pair takes the code as auth
  const auth = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) {
    return reply.code(401).send({
      error: "unauthorized",
      message: "Authorization: Bearer <token> header required",
    });
  }
  const token = m[1].trim();
  const pair = state.findPairByToken(token);
  if (!pair) {
    return reply.code(401).send({
      error: "unauthorized",
      message: "bearer token does not match any issued pair",
    });
  }
  // Best-effort last_seen bump; do not block the request on it.
  state.touchPairLastSeen(pair.pair_id).catch((err) => {
    req.log.warn({ err: err.message, pair_id: pair.pair_id }, "touchPairLastSeen failed");
  });
  req.pair = pair;

  // Phase 1 subscription gate (opt-in, BRIDGE_REQUIRE_IAP=1). Only
  // session-reading routes require an active receipt; /v1/whoami stays
  // open so the app can detect "needs subscription" and surface the
  // paywall without first holding a valid token it can't use.
  if (REQUIRE_IAP && url.startsWith("/v1/sessions")) {
    if (!state.isPairEntitled(pair, true)) {
      return reply.code(402).send({
        error: "payment_required",
        message: "an active subscription is required; POST /v1/iap/validate with a receipt",
      });
    }
  }
});

// T3 — auth-required probe. Returns the pair record derived from
// the bearer token. Useful for the iOS app to verify auth state on
// cold start (UC-4: "is my stored token still valid?") and for
// smoke tests that need an auth-gated probe without depending on
// T2's /v1/sessions route.
app.get("/v1/whoami", async (req) => ({
  schema_version: 1,
  pair_id: req.pair.pair_id,
  created_at: req.pair.created_at,
  last_seen: req.pair.last_seen,
}));

// T2 — JSONL-derived session listing.
//
// Pure read-only computation: walks `SESSIONS_DIR()` (or the override
// pointed at by `$PI_SESSIONS_DIR`) once per request, derives the 9
// fields per row in lib/sessions.mjs, returns
// `{ schema_version: 1, sessions: [...] }`.
//
// The route sits BEHIND T3's preHandler bearer-token hook — if the
// caller has no valid pair, the hook already replied 401 before we
// get here. We don't need to re-check.
//
// Performance: ~5ms per session for the cheap fields, ~80ms for
// listings > 100 (SUPERPROMPT §6 cost note). Phase 0 hit-list is
// well under that.
app.get("/v1/sessions", async () => ({
  schema_version: 1,
  sessions: await listSessions(),
}));

// T5 — read-only NDJSON stream of the raw session JSONL.
//
// Resolves `:id` (the UUID stored as the trailing component of every
// ~/.pi/sessions/*.jsonl filename) to an absolute path, then pipes the
// file through `lib/raw.mjs::streamSessionJsonl` into Fastify's reply.
//
// Auth: required (the preHandler hook installed by T3 has already
// authenticated `req.pair` by the time we get here). Returns 401
// implicitly on a missing/invalid bearer.
//
// Failure modes (RawError → HTTP status via setErrorHandler below):
//   NOT_FOUND         → 404  (no file with matching UUID)
//   NOT_JSONL         → 415  (filename shape is wrong for a session)
//   MALFORMED_JSONL   → 422  (header is missing or non-JSON)
//   file > cap        → 200  truncated; bytes past cap dropped at the
//                              last line boundary (x-raw-capped: true).
//                              Phase 0 honour the cap silently rather
//                              than reject — per plan-01 Task 5:
//                              "Cap at min(file size, 50MB) for now".
async function resolveSessionJsonlPath(id) {
  const dir = SESSIONS_DIR();
  // Phase 0: O(n) readdir lookup. Sessions dir typically has < 1k
  // files; this is fine. For Phase 1+ (many sessions) a per-process
  // map would be cleaner.
  const entries = await fs.readdir(dir);
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    if (name.startsWith(".")) continue; // dotfiles (lock, swap)
    const stem = name.slice(0, -".jsonl".length);
    const idx = stem.lastIndexOf("_");
    if (idx < 0) continue;
    const candidate = stem.slice(idx + 1);
    if (candidate === id) {
      return path.join(dir, name);
    }
  }
  throw new RawError(
    "NOT_FOUND",
    `no session file with uuid ${id} in ${dir}`,
  );
}

app.get("/v1/sessions/:id/raw", async (req, reply) => {
  const id = req.params.id;
  const jsonlPath = await resolveSessionJsonlPath(id);
  const { readable, capBytes, capped } = streamSessionJsonl(jsonlPath);
  reply.header("content-type", "application/x-ndjson");
  reply.header("x-raw-cap-bytes", String(capBytes));
  reply.header("x-raw-capped", String(capped));
  reply.header("x-raw-session-uuid", id);
  reply.header("content-length", String(capBytes));
  // Fastify's reply.send(stream) handles backpressure + chunked
  // transfer encoding; we set content-length here so HTTP/1.1 clients
  // know the body size up front (no chunked transfer-encoding needed).
  return reply.send(readable);
});

// T5 — error mapper. RawError thrown anywhere in the route handler
// chain (validateSessionFile, streamSessionJsonl, resolveSession...)
// lands here, where we translate the typed `code` to an HTTP status.
app.setErrorHandler((err, req, reply) => {
  if (err instanceof RawError) {
    const status =
      err.code === "NOT_FOUND"        ? 404 :
      err.code === "NOT_JSONL"        ? 415 :
      err.code === "MALFORMED_JSONL"  ? 422 :
      err.code === "TOO_LARGE"        ? 413 :
      500;
    return reply.code(status).send({
      error: err.code,
      message: err.message,
    });
  }
  // Fall through to Fastify's default handler (logs the error).
  req.log.error({ err }, "mobile-bridge unhandled error");
  return reply.send(err);
});

// Surface the package root so downstream tasks can derive
// var/state.json / sessions-dir paths without re-implementing this
// URL→filesystem dance.
app.addHook("onReady", async () => {
  app.log.info({ pkg_root: PKG_ROOT, host: HOST, port: PORT }, "mobile-bridge ready");
});

await app.listen({ port: PORT, host: HOST });
console.log(`apple-pi-mobile-bridge v${VERSION} listening on http://${HOST}:${PORT}`);