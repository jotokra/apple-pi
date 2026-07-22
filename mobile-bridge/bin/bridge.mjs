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

import { State, defaultStatePath } from "../lib/state.mjs";
import * as pairing from "../lib/pairing.mjs";

const PORT = Number(process.env.BRIDGE_PORT ?? 7892);
const HOST = process.env.BRIDGE_HOST ?? "127.0.0.1";
const VERSION = "0.1.0";

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

// T3 — preHandler bearer-token gate. Applied to ALL routes except
// the unauthenticated ones below. Pattern matches plan-01 Task 3
// Step 4 + SUPERPROMPT §7.1 (auth scheme).
//
// We attach the resolved pair row to `req.pair` so handlers can
// access it without re-querying state.
const UNAUTHENTICATED = new Set(["/v1/health", "/v1/pair/issue"]);
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

// Surface the package root so downstream tasks can derive
// var/state.json / sessions-dir paths without re-implementing this
// URL→filesystem dance.
app.addHook("onReady", async () => {
  app.log.info({ pkg_root: PKG_ROOT, host: HOST, port: PORT }, "mobile-bridge ready");
});

await app.listen({ port: PORT, host: HOST });
console.log(`apple-pi-mobile-bridge v${VERSION} listening on http://${HOST}:${PORT}`);