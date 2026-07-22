// Smoke test for lib/state.mjs + lib/pairing.mjs (no HTTP layer).
// Run with: node mobile-bridge/smoke/test-pairing-unit.mjs
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { State } from "../lib/state.mjs";
import * as pairing from "../lib/pairing.mjs";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-state-"));
const file = path.join(tmp, "state.json");

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

try {
  console.log("== state + pairing unit smoke ==");

  const state = new State(file);
  await state.load();

  check("load creates empty state", state.snapshot().pairs.length === 0);
  check("load creates empty pending_codes", state.snapshot().pending_codes.length === 0);

  const issued = await pairing.issueCode(state);
  check("issueCode returns 6-char alphanumeric", /^[A-Z2-9]{6}$/.test(issued.code), issued.code);
  check("issueCode returns expires_at ISO", typeof issued.expires_at === "string" && issued.expires_at.endsWith("Z"));
  check("expires_at is ~10 minutes in future", new Date(issued.expires_at).getTime() - Date.now() > 9 * 60 * 1000);

  // Bad-code formats
  let thrown;
  thrown = null;
  try { await pairing.consumeCode(state, ""); } catch (e) { thrown = e; }
  check("empty code → 400", thrown && thrown.status === 400, thrown && thrown.reason);

  thrown = null;
  try { await pairing.consumeCode(state, "AB"); } catch (e) { thrown = e; }
  check("too-short code → 400", thrown && thrown.status === 400, thrown && thrown.reason);

  thrown = null;
  try { await pairing.consumeCode(state, "ABCDEFG"); } catch (e) { thrown = e; }
  check("too-long code → 400", thrown && thrown.status === 400, thrown && thrown.reason);

  thrown = null;
  try { await pairing.consumeCode(state, "ZZZZZZ"); } catch (e) { thrown = e; }
  check("unknown code → 410", thrown && thrown.status === 410, thrown && thrown.reason);

  // Valid exchange
  const pair = await pairing.consumeCode(state, issued.code);
  check("consumeCode returns pair_id starting with dev_pair_", pair.pair_id.startsWith("dev_pair_"));
  check("consumeCode returns 64-char hex token", /^[0-9a-f]{64}$/.test(pair.token), pair.token);
  check("pair is findable by token", state.findPairByToken(pair.token) !== null);
  check("unknown token returns null", state.findPairByToken("deadbeef") === null);

  // Reuse → 410
  thrown = null;
  try { await pairing.consumeCode(state, issued.code); } catch (e) { thrown = e; }
  check("reuse consumed code → 410", thrown && thrown.status === 410, thrown && thrown.reason);

  // File mode 0600
  const st = await fs.stat(file);
  const mode = st.mode & 0o777;
  check(`state.json mode 0600 (got 0${mode.toString(8)})`, mode === 0o600);

  // Reload preserves state
  const reloaded = new State(file);
  await reloaded.load();
  check("reloaded pairs survives", reloaded.snapshot().pairs.length === 1);
  check("reloaded pair is findable", reloaded.findPairByToken(pair.token) !== null);
  check("reloaded pending_codes empty", reloaded.snapshot().pending_codes.length === 0);

  // Touch last_seen (look up by token, mutate by pair_id)
  const beforeRow = reloaded.findPairByToken(pair.token);
  check("findPairByToken returns row before touch", beforeRow !== null);
  const before = beforeRow.last_seen;
  await new Promise((r) => setTimeout(r, 15));
  await reloaded.touchPairLastSeen(pair.pair_id);
  const after = reloaded.findPairByToken(pair.token).last_seen;
  check("touchPairLastSeen updates timestamp", after !== before, `before=${before} after=${after}`);

  // Corrupt-file recovery
  await fs.writeFile(file, "{not json", "utf8");
  const recovered = new State(file);
  await recovered.load();
  check("corrupt file → fresh state (no throw)", recovered.snapshot().pairs.length === 0);
  const dir = await fs.readdir(tmp);
  check("corrupt file backed up", dir.some((n) => n.startsWith("state.json.corrupt-")));

  console.log(failures === 0 ? "PASS" : `FAIL (${failures} failure${failures === 1 ? "" : "s"})`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}