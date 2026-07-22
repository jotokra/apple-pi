// mobile-bridge/lib/state.mjs
//
// Tiny JSON-on-disk state store for the mobile bridge. Holds the
// auth-related rows that the JSONL session tree cannot derive:
// pending pairing codes, issued pair records (token + last_seen),
// and advisory session_state (heartbeats). Atomic writes via
// temp-file + rename so a crash mid-write doesn't truncate the
// file. Mode 0600 — pairing tokens are bearer credentials.

import fs from "node:fs/promises";
import path from "node:path";

export const SCHEMA_VERSION = 1;

const DEFAULT_STATE = () => ({
  schema_version: SCHEMA_VERSION,
  pairs: [],
  pending_codes: [],
  session_state: {},
  receipts: [], // Phase 1: Apple IAP receipts (active|expired|refunded)
});

export class State {
  /**
   * @param {string} filePath - absolute path to state.json
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.dir = path.dirname(filePath);
    this._data = null;
    this._writeQueue = Promise.resolve();
  }

  async load() {
    try {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    let raw;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        this._data = DEFAULT_STATE();
        await this._atomicWrite();
        await this._chmod0600();
        return this._data;
      }
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt file — back it up and start fresh. The user can
      // recover pair tokens from the backup if needed.
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      await fs.rename(this.filePath, backup);
      console.warn(`state: corrupt state.json moved to ${backup}`);
      this._data = DEFAULT_STATE();
      await this._atomicWrite();
      await this._chmod0600();
      return this._data;
    }
    // Merge with defaults so newly-added top-level keys land safely.
    this._data = { ...DEFAULT_STATE(), ...parsed };
    await this._chmod0600();
    return this._data;
  }

  /**
   * Run a synchronous mutation under a write lock so concurrent
   * mutations don't clobber each other.
   * @template T
   * @param {(data: ReturnType<typeof DEFAULT_STATE>) => T} fn
   * @returns {Promise<T>}
   */
  async mutate(fn) {
    // Serialize writers so two issueCode calls don't race the
    // pending_codes list. Reads from inside fn see a consistent
    // snapshot.
    const next = this._writeQueue.then(async () => {
      if (this._data === null) {
        await this.load();
      }
      const result = fn(this._data);
      await this._atomicWrite();
      return result;
    });
    this._writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Read-only snapshot. Don't mutate the returned object. */
  snapshot() {
    return this._data;
  }

  async _atomicWrite() {
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(this._data, null, 2);
    await fs.writeFile(tmp, payload, { mode: 0o600 });
    try {
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
    await this._chmod0600();
  }

  async _chmod0600() {
    try {
      await fs.chmod(this.filePath, 0o600);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  // ---- pair lookup helpers (consumed by bridge.mjs preHandler) ----

  findPairByToken(token) {
    if (!this._data) return null;
    if (!token) return null;
    return this._data.pairs.find((p) => p.token === token) ?? null;
  }

  findPairById(pairId) {
    if (!this._data) return null;
    return this._data.pairs.find((p) => p.pair_id === pairId) ?? null;
  }

  findPendingCode(code) {
    if (!this._data) return null;
    const now = Date.now();
    // GC expired codes lazily — never return one and never match one.
    this._data.pending_codes = this._data.pending_codes.filter(
      (c) => c.expires_at_ms > now,
    );
    return this._data.pending_codes.find((c) => c.code === code) ?? null;
  }

  async touchPairLastSeen(pairId) {
    return this.mutate((data) => {
      const p = data.pairs.find((x) => x.pair_id === pairId);
      if (p) p.last_seen = new Date().toISOString();
      return p ?? null;
    });
  }

  // ---- Phase 1: subscription entitlement ----

  /**
   * Is this pair entitled to read session data?
   *
   * Two modes:
   *   - requireIap === false (default; BRIDGE_REQUIRE_IAP unset):
   *     any valid bearer token is entitled. Preserves Phase 0
   *     behaviour for local/dev use + the App-Review demo bridge.
   *   - requireIap === true (production App-Store bridge):
   *     the pair must be linked to a receipt whose status is active
   *     and whose expiry is in the future. Pairing-only tokens (no
   *     receipt link) are NOT entitled → the route returns 402.
   *
   * @param {object|null} pair - the pair row resolved by findPairByToken
   * @param {boolean} requireIap
   * @returns {boolean}
   */
  isPairEntitled(pair, requireIap) {
    if (!pair) return false;
    if (!requireIap) return true;
    const otx = pair.receipt_original_transaction_id;
    if (!otx) return false; // pairing-issued token, no subscription
    const receipts = Array.isArray(this._data?.receipts) ? this._data.receipts : [];
    const receipt = receipts.find((r) => r.original_transaction_id === otx);
    if (!receipt) return false;
    if (receipt.status !== "active") return false;
    if (receipt.expires_at_ms != null && receipt.expires_at_ms <= Date.now()) {
      return false;
    }
    return true;
  }
}

/**
 * Build the default state path: mobile-bridge/var/state.json,
 * resolved relative to the bridge package root (caller passes the
 * resolved path so this module doesn't need to know cwd).
 */
export function defaultStatePath(packageRoot) {
  return path.join(packageRoot, "var", "state.json");
}