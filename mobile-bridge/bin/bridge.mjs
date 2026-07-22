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
//   T4: GET /v1/sessions/:id/tree   (lib/tree.mjs)
//   T5: GET /v1/sessions/:id/raw    (lib/raw.mjs)
//   T6: POST /v1/sessions/:id/heartbeat
//
// Plan ref: plan-01 Task 1.

import Fastify from "fastify";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = Number(process.env.BRIDGE_PORT ?? 7892);
const HOST = process.env.BRIDGE_HOST ?? "127.0.0.1";
const VERSION = "0.1.0";

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = path.resolve(path.dirname(__filename), "..");

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
});

// T1 — liveness probe. The first route; everything else hangs off it.
app.get("/v1/health", async () => ({
  ok: true,
  version: VERSION,
  uptime_s: Math.floor(process.uptime()),
}));

// Surface the package root so downstream tasks can derive
// var/state.json / sessions-dir paths without re-implementing this
// URL→filesystem dance.
app.addHook("onReady", async () => {
  app.log.info({ pkg_root: PKG_ROOT, host: HOST, port: PORT }, "mobile-bridge ready");
});

await app.listen({ port: PORT, host: HOST });
console.log(`apple-pi-mobile-bridge v${VERSION} listening on http://${HOST}:${PORT}`);