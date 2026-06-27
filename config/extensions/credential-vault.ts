/**
 * credential-vault.ts — apple-pi's `/vault` command: an encrypted, trace-free
 * credential store writable from the pi TUI.
 *
 * Commands (REQ-CV-1):
 *   /vault add [id] [--provider P] [--note N] [--lifetime persistent|transient]
 *       Captures a secret via a UI input and stores it encrypted in
 *       ~/.pi/agent/credentials.vault. The secret is NEVER accepted as a
 *       command argument (REQ-CV-3) — argument entry is refused, because the
 *       argument is what the session transcript records.
 *   /vault list                 metadata only — never the secret (REQ-CV-5)
 *   /vault remove <id>
 *   /vault get <id>             privileged reveal — confirm-gated (REQ-CV-5)
 *   /vault lock                 flush the cached passphrase (re-prompt next use)
 *   /vault prune-transient      reap stale onboarding entries (R6)
 *
 * Entry-path security (see .docs/features/credential-vault/SECURITY.md):
 *   v1 uses ctx.ui.input (a UI dialog, separate from the typed input line) +
 *   immediate setEditorText("") clear as the capture. The PREFERRED path is a
 *   custom masked overlay (ctx.custom + onTerminalInput rendering dots); that
 *   is a follow-up. The trace-free test (smoke/vault-tracefree.sh, REQ-CV-7)
 *   is the safety net: it FAILS the build if the chosen path leaks the secret
 *   into the session transcript, telemetry, or logs. If it leaks, the overlay
 *   ships. The handler always returns void and never notifies with a secret.
 *
 * The crypto core lives in the apple-pi repo at vault/lib/vault.js (single
 * source of truth — no duplicated crypto). The extension locates the repo via
 * the ~/.pi/.apple-pi-source marker that install.sh writes; if the marker or
 * the core is missing, the extension errors with reinstall guidance rather
 * than silently failing.
 *
 * Enabled on demand (add to settings.json `extensions`).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── locate the vault core via the install marker ──────────────────────
function piDir(): string {
	return process.env.PI_CODING_AGENT_DIR || `${process.env.HOME || os.homedir()}/.pi`;
}
function repoDir(): string | null {
	const marker = path.join(piDir(), ".apple-pi-source");
	try {
		const p = fs.readFileSync(marker, "utf8").trim();
		if (p && fs.existsSync(path.join(p, "vault", "lib", "vault.js"))) return p;
		return null;
	} catch {
		return null;
	}
}
function loadCore(): any | null {
	const repo = repoDir();
	if (!repo) return null;
	try {
		// require() caches by resolved path; clearing ensures a fresh load if moved.
		const corePath = path.join(repo, "vault", "lib", "vault.js");
		delete require.cache[require.resolve(corePath)];
		return require(corePath);
	} catch {
		return null;
	}
}
function noCoreError(ctx: ExtensionCommandContext): void {
	ctx.ui.notify(
		`apple-pi vault: can't find the vault core. Re-run the apple-pi installer ` +
			`(curl … | bash) or set PI_CODING_AGENT_DIR correctly. The repo must contain vault/lib/vault.js.`,
		"error",
	);
}

// ── passphrase cache (per-process; `/vault lock` flushes) ─────────────
let cachedPass: string | null = null;
async function getPassphrase(ctx: ExtensionCommandContext): Promise<string | null> {
	if (cachedPass) return cachedPass;
	// Preferred: env var (headless / set by a wrapper). Then tty-style prompt.
	const env = process.env.CREDENTIALS_VAULT_PASS;
	if (env) { cachedPass = env; return env; }
	if (!ctx.hasUI) { ctx.ui.notify("vault: passphrase required (set CREDENTIALS_VAULT_PASS or run in the TUI)", "error"); return null; }
	const pass = await ctx.ui.input("Vault passphrase");
	if (!pass) { ctx.ui.notify("vault: no passphrase entered", "warning"); return null; }
	cachedPass = pass;
	return pass;
}

// ── argument parsing ──────────────────────────────────────────────────
function parseArgs(args: string): { positional: string[]; flags: Record<string, string> } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const out = { positional: [] as string[], flags: {} as Record<string, string> };
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.startsWith("--")) {
			const k = t.slice(2);
			const v = tokens[i + 1];
			if (v === undefined || v.startsWith("--")) { out.flags[k] = ""; }
			else { out.flags[k] = v; i++; }
		} else out.positional.push(t);
	}
	return out;
}

// REQ-CV-3: refuse secrets passed as arguments. The heuristic lives in the
// shared core (vault/lib/vault.js looksLikeSecret) so the CLI + extension +
// tests all agree on what counts as a pasted credential.
const SECRET_LIKE_REFUSE_MSG =
	`vault: refusing to accept a secret as a command argument — it would be ` +
	`recorded in your session transcript. Re-run as "/vault add <id>" and paste ` +
	`the secret into the prompt that appears.`;

// ── subcommands ───────────────────────────────────────────────────────
async function cmdAdd(ctx: ExtensionCommandContext, core: any, args: string): Promise<void> {
	const { positional, flags } = parseArgs(args);
	// REQ-CV-3: refuse if a secret appears to be passed as an argument.
	const secretArgs = positional.filter((p) => core.looksLikeSecret(p));
	if (secretArgs.length > 0) {
		ctx.ui.notify(SECRET_LIKE_REFUSE_MSG, "warning");
		return;
	}
	const id = positional[0] || (await ctx.ui.input("Entry id (e.g. openai, anthropic, gateway)"));
	if (!id) { ctx.ui.notify("vault add: no id", "warning"); return; }

	// Capture the secret via the UI dialog (NOT the typed input line).
	const secret = await ctx.ui.input(`Paste the secret for "${id}" (it will not be shown)`);
	// Immediately clear any editor residue (defense in depth).
	try { (ctx.ui as any).setEditorText?.(""); } catch { /* not all contexts */ }
	if (!secret) { ctx.ui.notify("vault add: no secret entered — nothing stored", "warning"); return; }

	const lifetime = flags.lifetime === "transient" ? "transient" : "persistent";
	try {
		const r = core.addEntry(cachedPass!, {
			id, secret,
			provider: flags.provider || id,
			note: flags.note || "",
			lifetime,
		});
		// Deliberately do NOT echo the secret back. created/overwritten only.
		ctx.ui.notify(`vault: ${r.created ? "added" : "updated"} entry "${id}" (${lifetime})`, "info");
	} catch (e: any) {
		ctx.ui.notify(`vault add failed: ${e?.message || String(e)}`, "error");
	}
}

async function cmdList(ctx: ExtensionCommandContext, core: any): Promise<void> {
	let rows: any[];
	try { rows = core.listEntries(cachedPass!); }
	catch (e: any) { ctx.ui.notify(`vault list failed: ${e?.message || String(e)}`, "error"); return; }
	if (!rows.length) { ctx.ui.notify("vault is empty", "info"); return; }
	// Metadata only — never the secret (REQ-CV-5).
	const lines = rows.map((e) =>
		`${e.id}  ·  ${e.provider}  ·  ${e.lifetime}  ·  ${e.kind}${e.note ? "  ·  " + e.note : ""}`,
	);
	// Use a selector so the user can scroll; selecting does nothing useful here,
	// but it's the cleanest "show a list" primitive pi exposes.
	await ctx.ui.select("Vault entries (metadata only)", lines);
}

async function cmdRemove(ctx: ExtensionCommandContext, core: any, args: string): Promise<void> {
	const { positional } = parseArgs(args);
	const id = positional[0];
	if (!id) { ctx.ui.notify("vault remove: id required", "warning"); return; }
	const ok = await ctx.ui.confirm("Remove entry?", `Delete vault entry "${id}"? This cannot be undone.`);
	if (!ok) return;
	try {
		const removed = core.removeEntry(cachedPass!, id);
		ctx.ui.notify(removed ? `vault: removed "${id}"` : `vault: no entry "${id}"`, removed ? "info" : "warning");
	} catch (e: any) {
		ctx.ui.notify(`vault remove failed: ${e?.message || String(e)}`, "error");
	}
}

async function cmdGet(ctx: ExtensionCommandContext, core: any, args: string): Promise<void> {
	const { positional } = parseArgs(args);
	const id = positional[0];
	if (!id) { ctx.ui.notify("vault get: id required", "warning"); return; }
	// REQ-CV-5: reveal is gated behind a confirm (and warned about scrollback).
	const ok = await ctx.ui.confirm(
		"Reveal secret?",
		`Show the secret for "${id}"? It will appear in this dialog and may be captured by screen recorders or scrollback.`,
	);
	if (!ok) return;
	let entry: any;
	try { entry = core.getEntry(cachedPass!, id); }
	catch (e: any) { ctx.ui.notify(`vault get failed: ${e?.message || String(e)}`, "error"); return; }
	if (!entry) { ctx.ui.notify(`vault: no entry "${id}"`, "warning"); return; }
	// Show via a selector the user dismisses; the secret is visible only here.
	await ctx.ui.select(`Secret for "${id}" (dismiss to clear)`, [entry.secret]);
}

async function cmdPruneTransient(ctx: ExtensionCommandContext, core: any): Promise<void> {
	try {
		const n = core.pruneTransient(cachedPass!);
		ctx.ui.notify(`vault: pruned ${n} stale transient entr${n === 1 ? "y" : "ies"}`, "info");
	} catch (e: any) {
		ctx.ui.notify(`vault prune failed: ${e?.message || String(e)}`, "error");
	}
}

function cmdLock(ctx: ExtensionCommandContext): void {
	cachedPass = null;
	ctx.ui.notify("vault: passphrase forgotten — re-prompt next /vault use", "info");
}

// ── registration ──────────────────────────────────────────────────────
export default function credentialVaultExtension(pi: ExtensionAPI): void {
	const SUBS = ["add", "list", "get", "remove", "lock", "prune-transient"];
	pi.registerCommand("vault", {
		description: "Encrypted credential vault (add/list/get/remove/lock)",
		getArgumentCompletions: (prefix) => {
			const hits = SUBS.filter((s) => s.startsWith(prefix));
			return hits.length ? hits.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const core = loadCore();
			if (!core) { noCoreError(ctx); return; }

			// subcommand is the first token; everything after is its args
			const trimmed = args.trim();
			const sp = trimmed.indexOf(" ");
			const sub = (sp >= 0 ? trimmed.slice(0, sp) : trimmed) || "list";
			const rest = sp >= 0 ? trimmed.slice(sp + 1) : "";

			// lock + list need no passphrase upfront (lock clears it; list will prompt)
			if (sub !== "lock") {
				const pass = await getPassphrase(ctx);
				if (!pass) return;
				try { core.ensureVault(pass); }
				catch (e: any) { ctx.ui.notify(`vault: could not open vault: ${e?.message || String(e)}`, "error"); return; }
			}

			switch (sub) {
				case "add":              return cmdAdd(ctx, core, rest);
				case "list":             return cmdList(ctx, core);
				case "get":              return cmdGet(ctx, core, rest);
				case "remove":           return cmdRemove(ctx, core, rest);
				case "prune-transient":  return cmdPruneTransient(ctx, core);
				case "lock":             return cmdLock(ctx); return;
				default:
					ctx.ui.notify(`vault: unknown subcommand "${sub}" — try add/list/get/remove/lock`, "warning");
			}
		},
	});
}
