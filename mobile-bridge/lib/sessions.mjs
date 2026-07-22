// mobile-bridge/lib/sessions.mjs — T2: Session listing derived from JSONL.
//
// Pure module: enumerate `~/.pi/sessions/*.jsonl` and return one row
// per file. NO Fastify / no I/O outside the sessions dir.
//
// Each row contract (9 fields, per SUPERPROMPT §6 / plan-01 Task 2):
//   {
//     id: <uuid extracted from filename>,
//     started_at:         ISO timestamp from first record,
//     ended_at:           null when current_status="running" else last msg ts,
//     last_activity_at:   ISO timestamp of last record with any field "timestamp",
//     current_status:     "running" if last_activity_at within RUNNING_WINDOW_MS,
//                         else "idle",
//     model:              first msg.model found (latest-wins on conflict),
//     branch_count:       count of records with parentId:null and type≠"session",
//     msg_count:          count of records with type="message",
//     size_bytes:         byte size of the JSONL file at read time,
//   }
//
// computed_at_ms at the row envelope level (not per-row) lets the iOS UI
// detect staleness without inflating 100-row responses — but plan-01
// pins the wire format to the 9 fields above exactly, so we keep it
// strict. computed_at_ms is exposed only via `listSessionsAt(...)`.
//
// PI_SESSIONS_DIR env override (plan-01 Step 1):
//   SESSIONS_DIR is resolved lazily at call time so test code can
//   set the env var before importing; the bridge process typically
//   sets it once at startup. Default = `$HOME/.pi/sessions`.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { createReadStream } from "node:fs";

// Threshold for "running" vs "idle" per plan-01 Task 2 Step 1.
const RUNNING_WINDOW_MS = 5 * 60 * 1000;

/**
 * Resolved sessions directory. Falls back to `$HOME/.pi/sessions` when
 * PI_SESSIONS_DIR is unset. Read once per call so tests can mutate the
 * env between invocations.
 *
 * @returns {string} absolute path
 */
export function SESSIONS_DIR() {
  return process.env.PI_SESSIONS_DIR ?? path.join(os.homedir(), ".pi", "sessions");
}

/**
 * Extract the UUID from a Pi session filename.
 * Format observed in the wild (since 2026-06-26):
 *   `<UTC-timestamp-with-dashes>Z_<uuid>.jsonl`
 * Example:
 *   `2026-07-02T00-27-49-586Z_019f2039-89d2-78f1-9d6c-f23e04811263.jsonl`
 *
 * UUID extraction is anchored on the underscore before the UUID +
 * the `.jsonl` suffix. If the filename doesn't conform, returns the
 * raw basename — degraded gracefully rather than throwing, because a
 * single misnamed file should not poison the whole listing.
 *
 * @param {string} baseName  e.g. "2026-07-02T00-…_<uuid>.jsonl"
 * @returns {string}         the UUID or basename fallback
 */
export function uuidFromFilename(baseName) {
  const stem = baseName.endsWith(".jsonl")
    ? baseName.slice(0, -".jsonl".length)
    : baseName;
  const idx = stem.lastIndexOf("_");
  if (idx < 0 || idx === stem.length - 1) return stem;
  return stem.slice(idx + 1);
}

/**
 * Build one session row from a JSONL file path. Single-pass over the
 * file (streaming readline) — does not load the file into memory,
 * which matters because Pi session JSONLs hit 1.5MB+ for hour-long
 * sessions.
 *
 * @param {string} absPath
 * @returns {Promise<{
 *   id: string,
 *   started_at: string|null,
 *   ended_at: string|null,
 *   last_activity_at: string|null,
 *   current_status: "running"|"idle",
 *   model: string|null,
 *   branch_count: number,
 *   msg_count: number,
 *   size_bytes: number,
 * }>}
 */
export async function sessionFromFile(absPath) {
  const baseName = path.basename(absPath);
  const id = uuidFromFilename(baseName);

  // size_bytes: stat the file at read time (independent of what the
  // JSONL lines contain — a file may grow between listings).
  const st = await fs.stat(absPath);
  const size_bytes = st.size;

  // Initialize fields.
  let started_at = null;
  let last_activity_at = null;
  let model = null;
  let branch_count = 0;
  let msg_count = 0;

  // Stream-read line by line. Skip blank lines; tolerate malformed JSON
  // by ignoring that line (the JSONL is best-effort: a torn line at
  // append time should NOT make the whole listing 500).
  const stream = createReadStream(absPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;

    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // Malformed/torn line — skip and keep going. The worst-case
      // damage is one dropped stat field; the listing still works.
      continue;
    }
    if (!rec || typeof rec !== "object") continue;

    // started_at: first timestamp seen (works for both `{type:"session"}`
    // headers and the first post-header record).
    if (started_at === null && typeof rec.timestamp === "string") {
      started_at = rec.timestamp;
    }
    if (typeof rec.timestamp === "string") {
      last_activity_at = rec.timestamp;
    }

    // branch_count: every record whose parentId is null and which is
    // NOT the session header (the session header has no parentId at
    // all in v3, but explicitly excluding `type:"session"` defends
    // against both v3 and pre-v3).
    if (
      rec.type !== "session" &&
      (rec.parentId === null ||
        !Object.prototype.hasOwnProperty.call(rec, "parentId")) &&
      // Only count the records that actually grow the DAG. v3 schema:
      // a node without parentId IS a root. Pre-v3 (legacy): every
      // record lacks parentId — in that case treat each as a root so
      // branch_count is meaningful, but accept that it's "flat"
      // because the parent/child linkage is degenerate.
      rec.type !== undefined
    ) {
      branch_count++;
    }

    if (rec.type === "message") {
      msg_count++;
      // msg.model — pick the most-recent model seen so far (the
      // session's effective model at the end of its life is usually
      // the user-relevant one). Fall back to msg.api or rec.model
      // for older schemas.
      const m =
        (rec.message && typeof rec.message.model === "string"
          ? rec.message.model
          : null) ??
        (typeof rec.model === "string" ? rec.model : null);
      if (typeof m === "string" && m.length > 0) model = m;
    }
  }

  // current_status: "running" if last activity is within the 5-min
  // window of "now"; else "idle".
  const now_ms = Date.now();
  const last_ms = last_activity_at ? Date.parse(last_activity_at) : NaN;
  const current_status =
    Number.isFinite(last_ms) && now_ms - last_ms <= RUNNING_WINDOW_MS
      ? "running"
      : "idle";

  // ended_at per SUPERPROMPT §6: null while running, last msg ts when
  // idle (the session may still get a new message — that's what makes
  // it "running" again).
  const ended_at = current_status === "idle" ? last_activity_at : null;

  return {
    id,
    started_at,
    ended_at,
    last_activity_at,
    current_status,
    model,
    branch_count,
    msg_count,
    size_bytes,
  };
}

/**
 * List all sessions in a directory, sorted by `last_activity_at`
 * descending (most recent first — matches iOS list UI expectations).
 *
 * Behaviors:
 *   - Skip the file silently if it's unreadable (one corrupt JSONL
 *     must not block the listing).
 *   - Skip files whose name doesn't end in `.jsonl`.
 *   - Skip dotfiles (`.DS_Store` etc.).
 *   - If the directory doesn't exist, returns [].
 *
 * @param {string} [dir]  directory to scan; defaults to SESSIONS_DIR()
 * @returns {Promise<Array<...sessionFromFile-row...>>}
 */
export async function listSessions(dir) {
  const target = dir ?? SESSIONS_DIR();

  let entries;
  try {
    entries = await fs.readdir(target);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }

  const rows = await Promise.all(
    entries
      .filter((name) => name.endsWith(".jsonl") && !name.startsWith("."))
      .map(async (name) => {
        const abs = path.join(target, name);
        try {
          return await sessionFromFile(abs);
        } catch {
          // Unreadable file — drop it from the listing rather than
          // failing the whole request. The iOS app shouldn't 500
          // because Pi appended a torn line.
          return null;
        }
      }),
  );

  return rows
    .filter((r) => r !== null)
    .sort((a, b) =>
      String(b.last_activity_at ?? "").localeCompare(
        String(a.last_activity_at ?? ""),
      ),
    );
}
