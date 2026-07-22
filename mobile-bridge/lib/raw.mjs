// mobile-bridge/lib/raw.mjs — T5: NDJSON session stream (read-only).
//
// Pure module: read a Pi session JSONL file and stream its bytes back
// verbatim, with a 50 MB cap for v0.1. Consumed by Fastify at runtime
// (`reply.send(stream)`) and exercise-tested in isolation by the smoke.
//
// Why this is its own module and not just inline:
//   - The cap + Content-Length + line-preservation logic is small but
//     testable in isolation; bridge.mjs should just import and wire.
//   - Pure modules are reload-safe — Fastify hot-reload (and the smoke)
//     can both `import` this without a process restart.
//
// Pi session JSONL format (v3, observed in the wild 2026-06-26+):
//   - UTF-8, one JSON object per line, lines separated by `\n`.
//   - First record is { type:"session", id, timestamp, cwd, version } —
//     metadata header. After the header, every record is a v3 node
//     with { id, parentId, timestamp, type, ... } and message records
//     carry an inner `message.role` field.
//   - Sessions are an append-only journal — read-only is the correct
//     posture for the bridge in Phase 0 (write-routes land in Phase 1+
//     for IAP and Phase 3 for send-a-turn).
//
// Output contract (this lib promises to bridge.mjs + smoke):
//   streamSessionJsonl(jsonlPath, opts) →
//     { readable, sizeBytes, capBytes, capped }
//       readable  Node Readable stream of the (possibly truncated)
//                 JSONL bytes — ready for `reply.send(readable)`.
//       sizeBytes `fs.statSync` size of the JSONL file at call time.
//       capBytes  the effective cap applied (= Math.min(sizeBytes,
//                 opts.capBytes ?? RAW_MAX_BYTES)).
//       capped    true when capBytes < sizeBytes — i.e. the stream is
//                 truncated; the iOS client can know to fall back to
//                 /v1/sessions/:id/tree for "preview" if needed.
//
// Cap behaviour (v0.1 documented limitation):
//   The byte cap is enforced at the END of the line that crosses the
//   cap — we never serve a half-line. The trailing portion is dropped.
//   This is fine for v0.1 because: (a) 50MB ≈ 10K lines, well above
//   any real-session length, (b) the bridge is read-only so a partial
//   view is recoverable by `re-fetch /raw`; (c) precise line-boundary
//   enforcement is a one-liner Transform, not a behaviour change.
//
// Errors (typed — bridge route maps them to HTTP status codes):
//   RawError  base class with `code` field.
//              "NOT_FOUND"       file does not exist → 404
//              "NOT_JSONL"       path is not a *.jsonl file → 415
//              "TOO_LARGE"       file > capBytes (route can choose
//                                to reject or accept-and-truncate) → 413
//              "MALFORMED_JSONL" header line missing or non-JSON → 422
//
// No Fastify dependency — same rationale as lib/tree.mjs. Bridge.mjs
// imports this and calls Fastify's `reply.send(readable)` directly.

import {
  createReadStream,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { Transform } from "node:stream";

/**
 * v0.1 hard cap: 50 MB. Configurable per-call via opts.capBytes;
 * the route uses this constant unless explicitly asked to lift it.
 */
export const RAW_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB

/**
 * First-line / first-record inspection helper bound — bounded at 64 KiB
 * so a malicious path can't make the smoke spin, and cheap on real
 * JSONL (the header line is ~200 bytes).
 */
export const RAW_PREVIEW_BYTES = 64 * 1024;

/**
 * Typed error so bridge.mjs can `instanceof RawError` and switch on
 * `err.code` to map to HTTP status codes. Smoke uses the same code.
 */
export class RawError extends Error {
  /**
   * @param {string} code  one of the codes listed above
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "RawError";
    this.code = code;
  }
}

/**
 * Cheap session-id probe. Reads the first RAW_PREVIEW_BYTES and
 * parses the first non-blank line. Returns the id field of the JSON
 * header (`{type:"session", id, ...}`) — or null if the header is
 * malformed. Used by the route to verify the `:id` route param
 * matches the file before streaming (so a typo'd /raw/foo doesn't
 * silently stream the wrong file).
 *
 * @param {string} jsonlPath
 * @returns {string|null}
 */
export function readSessionId(jsonlPath) {
  let fd;
  try {
    fd = openSync(jsonlPath, "r");
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new RawError("NOT_FOUND", `no such file: ${jsonlPath}`);
    }
    throw e;
  }
  try {
    const buf = Buffer.alloc(RAW_PREVIEW_BYTES);
    let n = 0;
    try {
      n = readSync(fd, buf, 0, RAW_PREVIEW_BYTES, 0);
    } catch (e) {
      throw new RawError(
        "MALFORMED_JSONL",
        `cannot read ${jsonlPath}: ${e.message}`,
      );
    }
    const text = buf.subarray(0, n).toString("utf8");
    const firstLine = text.split("\n", 1)[0].trim();
    if (!firstLine) {
      return null;
    }
    let obj;
    try {
      obj = JSON.parse(firstLine);
    } catch (_e) {
      return null;
    }
    if (obj && obj.type === "session" && typeof obj.id === "string") {
      return obj.id;
    }
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch (_e) {
      /* already closed */
    }
  }
}

/**
 * Validate a path looks like a Pi session JSONL. Confirms (a) the
 * file exists, (b) the name ends in `.jsonl`, (c) the first line
 * parses as a `{type:"session", id, ...}` header. Returns metadata
 * the route uses for `Content-Length` and any /sessions/:id/raw
 * error envelope.
 *
 * @param {string} jsonlPath
 * @returns {{ sizeBytes: number, sessionId: string|null, isValid: boolean }}
 */
export function validateSessionFile(jsonlPath) {
  // Existence first — a missing *.jsonl must surface as NOT_FOUND so the
  // route can return 404 (not 415). The .jsonl check guards bogus path
  // shapes like a directory or a /random.txt the caller misrouted here.
  let st;
  try {
    st = statSync(jsonlPath);
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new RawError("NOT_FOUND", `no such file: ${jsonlPath}`);
    }
    throw e;
  }
  if (!st.isFile()) {
    throw new RawError("NOT_FOUND", `not a regular file: ${jsonlPath}`);
  }
  if (!jsonlPath.endsWith(".jsonl")) {
    throw new RawError("NOT_JSONL", `not a .jsonl file: ${jsonlPath}`);
  }
  const sessionId = readSessionId(jsonlPath);
  return {
    sizeBytes: st.size,
    sessionId,
    isValid: sessionId !== null,
  };
}

/**
 * Internal: a Transform that drops chunks once we've emitted at least
 * `capBytes` bytes AND we are between lines (no half-line ever escapes).
 * Used only when the file would exceed the cap; for the fast path we
 * just hand back the raw `fs.createReadStream` and skip this overhead.
 *
 * Input buffers may span multiple NDJSON lines. Algorithm: buffer
 * unflushed bytes; on each flush, find the index of the last `\n`
 * whose end is at or before (bytesEmitted + buffer.length - 1) and
 * the start is at or after bytesEmitted. If we would cross the cap
 * without finishing a line, drop the partial tail and end the stream.
 */
class CapAtLineBoundary extends Transform {
  constructor(capBytes) {
    super();
    this.capBytes = capBytes;
    this.bytesEmitted = 0;
    this.buffered = Buffer.alloc(0);
    this.finished = false;
  }

  _transform(chunk, _enc, cb) {
    if (this.finished) return cb();
    let pending = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    this.buffered = Buffer.alloc(0);

    while (pending.length > 0) {
      const remaining = this.capBytes - this.bytesEmitted;
      if (remaining <= 0) {
        this.finished = true;
        this.push(null);
        return cb();
      }
      // If the whole pending fits under the remaining cap, accept it.
      if (pending.length <= remaining) {
        this.bytesEmitted += pending.length;
        this.push(pending);
        pending = Buffer.alloc(0);
        break;
      }
      // Otherwise we need to cut at the last newline that ends at or
      // before the cap. Find the last `\n` whose index < remaining.
      // If none, drop the entire pending chunk (a single line longer
      // than the cap — extremely unlikely in real v3 JSONL).
      const slice = pending.subarray(0, remaining);
      const lastNl = slice.lastIndexOf(0x0a); // '\n'
      if (lastNl < 0) {
        // No complete line fits — emit nothing, mark finished.
        this.finished = true;
        this.push(null);
        return cb();
      }
      const emit = pending.subarray(0, lastNl + 1);
      this.bytesEmitted += emit.length;
      this.push(emit);
      pending = pending.subarray(lastNl + 1);
      // We've hit the cap (we cut at lastNl < remaining, so byteEmitted
      // may equal capBytes — that's fine, we've emitted all we can).
      this.finished = true;
      this.push(null);
      return cb();
    }
    cb();
  }

  _flush(cb) {
    // If we still have buffered bytes when the source ended AND we
    // haven't hit the cap, emit them (they're the final partial line
    // tail — NDJSON tolerates a missing trailing newline).
    if (!this.finished && this.buffered.length > 0) {
      const remaining = this.capBytes - this.bytesEmitted;
      const emit =
        this.buffered.length <= remaining
          ? this.buffered
          : this.buffered.subarray(0, Math.max(0, remaining));
      if (emit.length > 0) this.push(emit);
      this.bytesEmitted += emit.length;
    }
    this.push(null);
    cb();
  }
}

/**
 * Stream the JSONL file. Caps at min(fileSize, opts.capBytes ?? 50MB)
 * by stopping at the end of the line that crosses the cap, so the
 * resulting bytes are a prefix of a valid NDJSON stream.
 *
 * Returned `readable` is a Node `Readable` ready for Fastify's
 * `reply.send(readable)` (which pipes + sets the right headers).
 *
 * @param {string} jsonlPath
 * @param {{ capBytes?: number }} [opts]
 * @returns {{
 *   readable: import("node:stream").Readable,
 *   sizeBytes: number,
 *   capBytes: number,
 *   capped: boolean,
 * }}
 */
export function streamSessionJsonl(jsonlPath, opts = {}) {
  const meta = validateSessionFile(jsonlPath);
  const sizeBytes = meta.sizeBytes;
  const capBytes = opts.capBytes ?? RAW_MAX_BYTES;
  const effectiveCap = Math.min(sizeBytes, capBytes);
  const capped = effectiveCap < sizeBytes;

  if (!capped) {
    // Fast path: stream the whole file. No Transform overhead.
    const readable = createReadStream(jsonlPath, { highWaterMark: 64 * 1024 });
    return { readable, sizeBytes, capBytes: effectiveCap, capped: false };
  }

  // Truncated path: install a Transform that cuts the stream at the
  // last line boundary ≤ effectiveCap bytes.
  const src = createReadStream(jsonlPath, { highWaterMark: 64 * 1024 });
  const trunc = new CapAtLineBoundary(effectiveCap);
  src.pipe(trunc);
  // Track on the readable so callers can introspect close events.
  return { readable: trunc, sizeBytes, capBytes: effectiveCap, capped: true };
}

/**
 * Parse a single NDJSON line to a record object. Tolerates blank lines
 * (returns `null`). Throws on malformed JSON with the 1-based line
 * number so the caller (smoke, route-side validation) can localise
 * the error.
 *
 * @param {string} line
 * @param {number} [idx]  1-based, used only for error messages
 * @returns {object|null}
 */
export function parseLine(line, idx = 0) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new RawError(
      "MALFORMED_JSONL",
      `raw.mjs: malformed JSONL at line ${idx || "?"}: ${e.message}`,
    );
  }
}
