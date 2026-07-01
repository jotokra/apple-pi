/**
 * vault-registry.ts — the vault-wire P1 layer: an in-memory secret registry +
 * the read-only projection ("wire") that fans vault entries out to auth.json /
 * bridges / external commands. Sibling to envlocal.ts in this _lib.
 *
 * WHY this exists (see ../.docs/features/vault-wire/SPEC.md):
 *   apple-pi's bridges read `process.env.X ?? ""`. The tempting design is to
 *   inject vault secrets into process.env at session_start. THAT IS REFUSED
 *   (SECURITY.md B-VW-1 / R-VW-a..d): pi's bash tool inherits env to every
 *   spawned command, re-opening the `ps e`/core-dump leak the vault exists to
 *   kill. Instead, secrets live in a module-scoped Map reached only via
 *   `secret(id)`, and the wire projects entries to auth.json / external
 *   commands on session_start. NEVER process.env. Read-only on the vault.
 *
 * Two load-bearing guarantees (enforced by smoke/vault-wire.sh):
 *   C-1 — this module NEVER writes process.env. secret() reads from the Map.
 *   C-2 — projectWire NEVER writes the vault. Only /vault add|rotate|remove do.
 *
 * Module-scope state (singleDecrypt-per-process): `cache` (the Map) and `_core`
 * (the vault core). Lazily populated on first secret()/projectWire(); repopulate
 * with clearCache() (/vault lock, tests). Self-contained core loading mirrors
 * credential-vault's loadCore (kept independent rather than cross-imported, the
 * same way envlocal has its own piDir — a few lines of duplication buys module
 * independence and avoids a circular import with the extension that consumes
 * this). Non-interactive passphrase resolution (env → keychain → null); the
 * interactive tty tier is the extension's job, not the registry's.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

// node-native ESM (node 22 type-stripping, used by smoke/vault-wire.sh) has no
// `require`; jiti (pi's loader) provides one. createRequire works under BOTH, so
// the dynamic core load resolves identically regardless of loader.
const nodeRequire = createRequire(import.meta.url);

// ── core loading (self-contained; mirrors credential-vault.ts#loadCore) ──
function piDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi");
}
function repoDir(): string | null {
	const marker = join(piDir(), ".apple-pi-source");
	try {
		const p = readFileSync(marker, "utf8").trim();
		if (p && existsSync(join(p, "vault", "lib", "vault.js"))) return p;
		return null;
	} catch { return null; }
}
let _core: any | null | undefined; // undefined = not-yet-resolved
function loadCore(): any | null {
	if (_core !== undefined) return _core;
	const repo = repoDir();
	if (!repo) { _core = null; return null; }
	try { _core = nodeRequire(join(repo, "vault", "lib", "vault.js")); return _core; }
	catch { _core = null; return null; }
}

// ── passphrase (NON-interactive: env → keychain → null) ───────────────
// The tty tier lives in the extension (it needs ctx.ui). The registry resolves
// headlessly: env var first (explicit operator intent), then the keychain (P0
// unlock). Null = locked → callers degrade gracefully (secret()→"", wire→no-op).
export function resolvePassphrase(): string | null {
	if (process.env.CREDENTIALS_VAULT_PASS) return process.env.CREDENTIALS_VAULT_PASS;
	const core = loadCore();
	if (core) {
		const kc = core.keychainRead(); // best-effort; null on locked/missing/non-darwin
		if (kc) return kc;
	}
	return null;
}

// ── the registry (module-scoped Map; NEVER process.env) ───────────────
let cache: Map<string, string> | null = null;
export function clearCache(): void { cache = null; } // /vault lock + tests repopulate

/** The ONLY read API for bridges. Lazy-decrypts on first call; "" on miss/lock. */
export function secret(id: string): string {
	if (cache === null) populate();
	return (cache && cache.get(id)) || "";
}
function populate(): void {
	cache = new Map();
	const core = loadCore(); if (!core) return;
	const pass = resolvePassphrase(); if (!pass) return;
	try {
		const env = core.readVault(pass);
		if (env && Array.isArray(env.entries)) for (const e of env.entries) cache.set(e.id, e.secret);
	} catch { /* wrong passphrase / corrupt → empty registry; secret() returns "" */ }
}

// ── read vault.wire from settings.json (ExtensionContext has no settings API) ──
// Same file-read pattern credential-vault uses for vault.exportCmd. Missing or
// non-object → {} (no-op wire; REQ-VW-5).
export interface WireEntry {
	to: "auth" | "bridge" | "command";
	provider?: string; // auth: provider name in auth.json (default = entry id)
	cmd?: string;       // command: the command to run (secret on its stdin)
}
export function readWireConfig(): Record<string, WireEntry> {
	try {
		const s = JSON.parse(readFileSync(join(piDir(), "agent", "settings.json"), "utf8"));
		const w = s && s.vault && s.vault.wire;
		return (w && typeof w === "object" && !Array.isArray(w)) ? w as Record<string, WireEntry> : {};
	} catch { return {}; }
}

export interface WireResult {
	auth: string[];     // ids projected to auth.json
	command: string[];  // ids projected via the command (or previewed, in dry-run)
	bridge: string[];   // ids available in the registry (no external write)
	missing: string[];  // wire ids absent from the vault
	errors: string[];   // per-entry failures (id only; never the secret)
}

// ── the projection (READ-ONLY on the vault; NEVER process.env) ─────────
// Decrypts once, populates the registry (so bridges resolve), then fans each
// wired entry out by `to`. `auth`→exportToAuth, `command`→exportToCommand
// (secret on stdin, $VAULT_* non-secret env — neither touches process.env),
// `bridge`→registry only. Missing ids are reported, not fatal (R-VW-4).
//
// `passphrase` lets a caller reuse an already-unlocked passphrase (e.g. the
// extension's cachedPass); absent → resolvePassphrase(). `dryRun` previews
// without writing/running. `log` receives one line per entry (id + surface;
// never the secret). Returns a summary for the caller to surface.
export async function projectWire(opts: {
	dryRun?: boolean;
	passphrase?: string;
	log?: (msg: string) => void;
} = {}): Promise<WireResult> {
	const log = opts.log || (() => {});
	const res: WireResult = { auth: [], command: [], bridge: [], missing: [], errors: [] };
	const core = loadCore();
	const wire = readWireConfig();
	const ids = Object.keys(wire);
	if (ids.length === 0) { log("vault wire: no vault.wire entries — nothing to project"); return res; }
	if (!core) { res.errors.push("vault core not found"); log("vault wire: vault core not found — skipping"); return res; }

	const pass = opts.passphrase != null ? opts.passphrase : resolvePassphrase();
	if (!pass) {
		res.errors.push("passphrase not resolved");
		log("vault wire: passphrase not resolved — skipping (set CREDENTIALS_VAULT_PASS or run /vault unlock)");
		return res;
	}

	// decrypt once (also pre-populates the registry for bridges)
	let entries: any[] = [];
	try {
		const env = core.readVault(pass);
		if (env && Array.isArray(env.entries)) entries = env.entries;
	} catch (e: any) {
		res.errors.push(`vault decrypt failed: ${e?.message || e}`);
		log("vault wire: vault decrypt failed — skipping");
		return res;
	}
	if (cache === null) { cache = new Map(); for (const e of entries) cache.set(e.id, e.secret); }

	const byId = new Map(entries.map((e: any) => [e.id, e]));
	for (const id of ids) {
		const cfg = wire[id];
		const entry = byId.get(id);
		if (!entry) { res.missing.push(id); log(`vault wire: '${id}' not in vault — skipped`); continue; }
		if (cfg.to === "bridge") {
			res.bridge.push(id);
			log(`vault wire: '${id}' → bridge (registry; bridges call secret('${id}'))`);
			continue;
		}
		if (cfg.to === "auth") {
			const provider = cfg.provider || id;
			if (opts.dryRun) { res.auth.push(id); log(`vault wire: [dry-run] '${id}' → auth.json['${provider}']`); continue; }
			try {
				const r = core.exportToAuth(pass, id, { provider });
				if (r.wrote) { res.auth.push(id); log(`vault wire: '${id}' → auth.json['${r.provider}']`); }
				else { res.errors.push(`auth '${id}': ${r.reason}`); log(`vault wire: '${id}' → auth FAILED: ${r.reason}`); }
			} catch (e: any) { res.errors.push(`auth '${id}': ${e?.message || e}`); log(`vault wire: '${id}' → auth threw`); }
			continue;
		}
		if (cfg.to === "command") {
			if (!cfg.cmd) { res.errors.push(`command '${id}': no cmd`); log(`vault wire: '${id}' → command: no cmd`); continue; }
			if (opts.dryRun) { res.command.push(id); log(`vault wire: [dry-run] '${id}' → command: ${cfg.cmd}`); continue; }
			try {
				// exportToCommand: secret on the child's STDIN only; $VAULT_* non-secret
				// env on the child only. Neither leaks to THIS process's env (C-1).
				const r = await core.exportToCommand(pass, id, { exportCmd: cfg.cmd });
				if (r.ok) { res.command.push(id); log(`vault wire: '${id}' → command OK`); }
				else { res.errors.push(`command '${id}': ${r.reason}`); log(`vault wire: '${id}' → command FAILED: ${r.reason}`); }
			} catch (e: any) { res.errors.push(`command '${id}': ${e?.message || e}`); log(`vault wire: '${id}' → command threw`); }
			continue;
		}
		res.errors.push(`'${id}': unknown to '${cfg.to}'`);
		log(`vault wire: '${id}' has unknown to '${cfg.to}' — skipped`);
	}
	return res;
}
