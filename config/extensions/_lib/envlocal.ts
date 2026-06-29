/**
 * envlocal.ts — device-local env overrides for apple-pi extensions.
 *
 * apple-pi's generic bridges read `process.env.X ?? ""` at module top-level.
 * pi's built-in env injection is provider-scoped (the auth.json `env` block;
 * `$VAR`/`!command` for apiKey/headers) and does NOT reach extension
 * `process.env`. So a device that wants a bridge pointed at, say,
 * `https://git.example.com` had no portable way to say so without baking
 * the host into the bridge — which is exactly why pi-config forked each
 * bridge (D1b). This helper closes that gap WITHOUT a launch wrapper.
 *
 * What it does: on import, merges a device-local, gitignored file
 * (`<piDir>/agent/env.local`, `KEY=VALUE` lines) into `process.env`. Generic
 * bridges then resolve device values (host URLs, DB paths) from env.local via
 * their existing `process.env.X ?? ""` — no per-bridge logic change beyond a
 * one-line `import "./_lib/envlocal"` at the top of the file.
 *
 * Properties (all enforced + smoke-tested in smoke/envlocal.sh):
 *  - Invocation-independent. Every pi process loads its extensions, so this
 *    runs for interactive `pi`, `pi -p`, cron, and Telegram invocations
 *    alike. No wrapper to remember, no PATH shim, no silent no-op when the
 *    user runs `pi` directly. (This is why E2 beat the wrapper approach E1.)
 *  - Real env wins. If `process.env[key]` is already set (an explicit export,
 *    an auth.json-injected value, or the spawning process's env), env.local
 *    does NOT override it. The file is a fallback, not an authority.
 *  - No-op when absent. A device without env.local is unaffected — generic
 *    installs behave identically before/after this feature.
 *  - Non-secret only. Put hostnames + paths here; keep keys/tokens in
 *    auth.json / the credential vault. `agent/env.local` is classified
 *    `secret` in sync/lib/paths.js → never tracked, refused by the
 *    pre-commit hook (default-deny), so it never leaves the device.
 *  - Fault-tolerant. A malformed env.local never breaks extension load;
 *    bridges fall back to "" defaults, same as a device without the file.
 *
 * Ordering: ESM import side-effects run before the importing module's body,
 * so `import "./_lib/envlocal"` at the top of a bridge populates process.env
 * before that bridge's top-level `const BASE = process.env.X ?? ""`. jiti
 * (pi's TS loader) honours ESM import semantics.
 *
 * See `.docs/decisions/2026-06-29-env-injection.md` (E2) for the design
 * rationale + the E1 (wrapper) alternative that was rejected as
 * invocation-dependent.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const piDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi");
try {
	const file = join(piDir, "agent", "env.local");
	if (existsSync(file)) {
		for (const raw of readFileSync(file, "utf8").split("\n")) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;
			const eq = line.indexOf("=");
			if (eq < 1) continue; // need a non-empty KEY
			const key = line.slice(0, eq).trim();
			const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
			// env-var-shaped keys only; real process.env is authoritative.
			if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
			if (process.env[key] === undefined) process.env[key] = val;
		}
	}
} catch {
	// Swallow: a bad env.local must not brick extension loading. Bridges
	// fall back to their "" defaults — identical to a device without the file.
}
