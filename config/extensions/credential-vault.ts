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
 *   /vault rotate <id>          replace an existing entry's secret (re-encrypts)
 *   /vault import <file>        bulk-load entries from JSON, then shred source
 *   /vault export <id> [--provider P]  write the secret into auth.json (api_key shape)
 *
 * Entry-path security (see .docs/features/credential-vault/SECURITY.md):
 *   The PREFERRED capture is a custom masked overlay (ctx.ui.custom + a
 *   MaskedInputOverlay component rendering dots via pi-tui's matchesKey /
 *   decodePrintableKey) — the secret NEVER appears as a plaintext glyph
 *   (defeats shoulder-surf / screen-recorder during entry) and the buffer
 *   lives only on the component, never the main input editor. Falls back to
 *   ctx.ui.input (plaintext-while-typing, still trace-free) when the overlay
 *   is unavailable (non-TUI mode, or custom() throws). The trace-free test
 *   (smoke/vault-tracefree.sh, REQ-CV-7) is the safety net: it FAILS the
 *   build if the chosen path leaks the secret into the session transcript,
 *   telemetry, or logs. The handler always returns void and never notifies
 *   with a secret.
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
// pi-tui key utilities — verified exports of @earendil-works/pi-tui (see the
// installed package's dist/keys.d.ts). Used by the masked-entry overlay (F1)
// to parse raw terminal keystrokes without hand-rolling escape sequences.
import { Key, matchesKey, decodePrintableKey, type TUI, type Theme, type Component } from "@earendil-works/pi-tui";
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
// REQ-VW-1: three-tier passphrase resolution. First non-empty wins:
//   tier 1 — CREDENTIALS_VAULT_PASS env (headless / wrapper-set; explicit operator intent)
//   tier 2 — macOS keychain service "apple-pi-vault" (P3 unlock; best-effort,
//            locked/missing/non-macOS falls through — never throws)
//   tier 3 — tty prompt (interactive pi only)
// `core` is the vault core (provides keychainRead); it is already loaded by
// the handler before this is called. Cached on first success for the process.
async function getPassphrase(ctx: ExtensionCommandContext, core: any): Promise<string | null> {
	if (cachedPass) return cachedPass;
	// tier 1: env (highest priority — explicit operator intent).
	const env = process.env.CREDENTIALS_VAULT_PASS;
	if (env) { cachedPass = env; return env; }
	// tier 2: keychain (P3). Best-effort: locked/missing/non-macOS → null → fall through.
	const kc = core.keychainRead();
	if (kc) { cachedPass = kc; return kc; }
	// tier 3: tty prompt (interactive pi only).
	if (!ctx.hasUI) { ctx.ui.notify("vault: passphrase required (set CREDENTIALS_VAULT_PASS, run /vault unlock, or run in the TUI)", "error"); return null; }
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

// ── F1: masked entry overlay ─────────────────────────────────────────
// The preferred secret-capture path: a focused TUI overlay (ctx.ui.custom)
// that renders dots and parses raw keystrokes via pi-tui. The secret NEVER
// appears as a plaintext glyph (defeats shoulder-surf / screen-recorder
// during entry), and the buffer lives only on the component instance (never
// the main input editor, so it can't enter the session transcript).
//
// Falls back to ctx.ui.input (the v1 path) when overlay capture is
// unavailable (non-TUI mode, or custom() throws). REQ-CV-7's tracefree smoke
// re-asserts trace-freeness regardless of which path runs.
class MaskedInputOverlay implements Component {
	private buffer = "";
	private tui: TUI;
	private prompt: string;
	private done: (result: string | undefined) => void;
	private dotRow: (prompt: string, bufferLen: number, width: number) => string;
	constructor(
		tui: TUI,
		prompt: string,
		done: (result: string | undefined) => void,
		dotRow: (prompt: string, bufferLen: number, width: number) => string,
	) {
		this.tui = tui;
		this.prompt = prompt;
		this.done = done;
		this.dotRow = dotRow;
	}
	// REQUIRED by Component. Render the label + dots, one dot per buffered
	// char. Lines must NEVER exceed `width` (pi crashes otherwise — verified
	// in the TUI source). The dot count comes from the shared pure helper
	// vault.js#maskedDotRow, unit-tested for the width invariant (R-F1a).
	render(width: number): string[] {
		const dots = this.dotRow(this.prompt, this.buffer.length, width);
		// dim the prompt, show dots at full intensity. No plaintext glyph emitted.
		return [`\x1b[2m${this.prompt}\x1b[0m ${dots}`];
	}
	// REQUIRED (no-op; the overlay has no cached render state beyond `buffer`).
	invalidate(): void { /* stateless beyond this.buffer */ }
	handleInput(data: string): void {
		// submit
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			this.finish(this.buffer);
			return;
		}
		// cancel (escape OR ctrl-c, matching how pi's own dialogs behave)
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.esc) || matchesKey(data, Key.ctrl("c"))) {
			this.finish(undefined);
			return;
		}
		// clear line (ctrl-u, the shell convention)
		if (matchesKey(data, Key.ctrl("u"))) {
			this.buffer = "";
			this.tui.requestRender();
			return;
		}
		// backspace / delete-last
		if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
			if (this.buffer.length > 0) {
				this.buffer = this.buffer.slice(0, -1);
				this.tui.requestRender();
			}
			return;
		}
		// printable chars (handles a multi-char paste by walking each char).
		// decodePrintableKey rejects non-printables (ctrl/alt combos, escape
		// sequences) so they can't pollute the buffer.
		for (const ch of data) {
			const p = decodePrintableKey(ch);
			if (p) this.buffer += p;
		}
		if (this.buffer) this.tui.requestRender();
	}
	private finish(result: string | undefined): void {
		// zero the buffer, then resolve. The secret lived only on this instance.
		this.buffer = "";
		this.done(result);
	}
	dispose?(): void { this.buffer = ""; }
}

// Capture a secret via the masked overlay (preferred), falling back to the
// v1 ctx.ui.input path. Returns the secret, or undefined if cancelled/empty.
// NEVER accepts the secret as a command argument (REQ-CV-3, enforced by callers).
// `core` is the vault core (provides maskedDotRow, the shared render helper).
async function captureSecret(ctx: ExtensionCommandContext, core: any, prompt: string): Promise<string | undefined> {
	// Preferred: the masked overlay (TUI only).
	if (ctx.mode === "tui") {
		try {
			const secret = await ctx.ui.custom<string | undefined>((tui, _theme, _kb, done) => {
				return new MaskedInputOverlay(tui, prompt, done, core.maskedDotRow);
			}, { overlay: true, overlayOptions: { width: "80%", anchor: "center", margin: { top: 1 } } });
			if (secret !== undefined) return secret; // undefined = cancelled
			return undefined;
		} catch {
			// custom() unavailable or threw — fall through to the input path.
		}
	}
	// Fallback: ctx.ui.input (a UI dialog, NOT the main editor — still trace-free
	// per REQ-CV-7; just shows plaintext while typing, which the overlay avoids).
	if (!ctx.hasUI) { ctx.ui.notify("vault: secret capture needs a TUI (run in interactive mode)", "error"); return undefined; }
	const secret = await ctx.ui.input(prompt);
	try { (ctx.ui as any).setEditorText?.(""); } catch { /* not all contexts */ }
	return secret;
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

	// Capture the secret via the masked overlay (preferred) / input fallback.
	// NEVER the typed input line (REQ-CV-3 + trace-free entry, REQ-CV-7).
	const secret = await captureSecret(ctx, core, `Paste the secret for "${id}" (masked: dots only)`);
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

async function cmdRotate(ctx: ExtensionCommandContext, core: any, args: string): Promise<void> {
	const { positional } = parseArgs(args);
	const id = positional[0] || (await ctx.ui.input("Entry id to rotate"));
	if (!id) { ctx.ui.notify("vault rotate: no id", "warning"); return; }
	// rotate implies the entry exists; refuse early before prompting for a secret.
	let exists: any;
	try { exists = core.getEntry(cachedPass!, id); }
	catch (e: any) { ctx.ui.notify(`vault rotate failed: ${e?.message || String(e)}`, "error"); return; }
	if (!exists) { ctx.ui.notify(`vault rotate: no entry "${id}" (use /vault add to create)`, "warning"); return; }
	const confirmRotate = await ctx.ui.confirm("Rotate secret?", `Replace the secret for "${id}" with a new one?`);
	if (!confirmRotate) return;
	const secret = await captureSecret(ctx, core, `Paste the NEW secret for "${id}" (masked: dots only)`);
	if (!secret) { ctx.ui.notify("vault rotate: no secret entered — nothing changed", "warning"); return; }
	try {
		const r = core.rotateEntry(cachedPass!, { id, secret });
		ctx.ui.notify(r.rotated ? `vault: rotated "${id}"` : `vault: could not rotate "${id}"`, r.rotated ? "info" : "warning");
	} catch (e: any) {
		ctx.ui.notify(`vault rotate failed: ${e?.message || String(e)}`, "error");
	}
}

async function cmdImport(ctx: ExtensionCommandContext, core: any, args: string): Promise<void> {
	const { positional } = parseArgs(args);
	const file = positional[0] || (await ctx.ui.input("Path to JSON file to import"));
	if (!file) { ctx.ui.notify("vault import: no file", "warning"); return; }
	const ok = await ctx.ui.confirm(
		"Import + shred source?",
		`Read entries from "${file}", add them to the vault, then securely delete the source file?`,
	);
	if (!ok) return;
	try {
		const entries = core.parseImportFile(file);
		const r = core.importEntries(cachedPass!, entries);
		const shredded = core.shredFile(file);
		ctx.ui.notify(
			`vault: imported ${r.imported}${r.errors.length ? ` (${r.errors.length} errors)` : ""}${shredded ? "; source shredded" : "; could not shred source"}`,
			"info",
		);
	} catch (e: any) {
		ctx.ui.notify(`vault import failed: ${e?.message || String(e)}`, "error");
	}
}

async function cmdExport(ctx: ExtensionCommandContext, core: any, args: string): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const id = positional[0] || (await ctx.ui.input("Entry id to export"));
	if (!id) { ctx.ui.notify("vault export: no id", "warning"); return; }
	const provider = flags.provider;
	const ok = await ctx.ui.confirm(
		"Write to auth.json?",
		`Write the secret for "${id}" into auth.json under "${provider || id}"? (pi's native auth store; other providers are preserved.)`,
	);
	if (!ok) return;
	try {
		const r = core.exportToAuth(cachedPass!, id, { provider });
		if (!r.wrote) { ctx.ui.notify(`vault export: ${r.reason}`, "warning"); return; }
		ctx.ui.notify(`vault: exported "${id}" → auth.json["${r.provider}"]`, "info");
	} catch (e: any) {
		ctx.ui.notify(`vault export failed: ${e?.message || String(e)}`, "error");
	}
}

// F2: run the user-configured vault.exportCmd with the secret on STDIN.
// Reads exportCmd from settings.json (same place the CLI reads it). The secret
// transits only vault → child.stdin; metadata via $VAULT_* env vars.
async function cmdExportTo(ctx: ExtensionCommandContext, core: any, args: string): Promise<void> {
	const { positional } = parseArgs(args);
	const id = positional[0] || (await ctx.ui.input("Entry id to export to your external command"));
	if (!id) { ctx.ui.notify("vault export-to: no id", "warning"); return; }
	// read vault.exportCmd from settings.json (the user's config; the CLI reads
	// the same file).
	let exportCmd = "";
	try {
		const pdir = process.env.PI_CODING_AGENT_DIR || `${process.env.HOME || os.homedir()}/.pi`;
		const s = JSON.parse(fs.readFileSync(path.join(pdir, "settings.json"), "utf8"));
		const v = s && s.vault && s.vault.exportCmd;
		if (typeof v === "string") exportCmd = v;
	} catch { /* settings unreadable → treat as unset */ }
	if (!exportCmd.trim()) {
		ctx.ui.notify(
			"vault export-to: no vault.exportCmd configured. Set it in settings.json " +
			"(e.g. { \"vault\": { \"exportCmd\": \"op item create $VAULT_PROVIDER\" } }). " +
			"The secret is piped to the command's stdin; metadata via $VAULT_ID/PROVIDER/KIND/NOTE.",
			"warning",
		);
		return;
	}
	const ok = await ctx.ui.confirm(
		"Run external export command?",
		`Run your vault.exportCmd to export "${id}"?\n  command: ${exportCmd}\nThe secret is piped to its stdin (never on the command line).`,
	);
	if (!ok) return;
	try {
		const r = await core.exportToCommand(cachedPass!, id, { exportCmd });
		if (!r.ok) { ctx.ui.notify(`vault export-to: ${r.reason}`, "warning"); return; }
		ctx.ui.notify(`vault: exported "${id}" via vault.exportCmd`, "info");
	} catch (e: any) {
		ctx.ui.notify(`vault export-to failed: ${e?.message || String(e)}`, "error");
	}
}

// REQ-VW-2: `/vault unlock` — capture the master passphrase (masked) and store
// it in the keychain so every future /vault use (and the auto-wire, P1) resolves
// headlessly without re-typing. Verifies the passphrase actually opens the vault
// (readVault throws on a wrong one) before storing; bootstraps an empty vault if
// none exists yet. Re-running replaces the stored entry (keychainWrite is idempotent).
async function cmdUnlock(ctx: ExtensionCommandContext, core: any): Promise<void> {
	const existing = core.keychainRead();
	const prompt = existing
		? "Re-enter the vault passphrase (replaces the stored keychain entry; masked)"
		: "Enter the vault passphrase to store in the keychain (masked; dots only)";
	const pass = await captureSecret(ctx, core, prompt);
	if (!pass) { ctx.ui.notify("vault unlock: no passphrase entered — nothing stored", "warning"); return; }
	// verify: readVault throws on a WRONG passphrase; returns null only if no vault
	// file exists (then bootstrap an empty one with this passphrase).
	try {
		const env = core.readVault(pass);
		if (env === null) core.ensureVault(pass);
	} catch (e: any) {
		ctx.ui.notify(`vault unlock: incorrect passphrase — not stored`, "error");
		return;
	}
	const ok = core.keychainWrite(pass);
	if (!ok) { ctx.ui.notify("vault unlock: could not write to the keychain (macOS only, or keychain locked)", "error"); return; }
	cachedPass = pass; // cache for this session too, so the very next /vault call is instant
	ctx.ui.notify(`vault: passphrase stored in the keychain${existing ? " (replaced)" : ""} — /vault now resolves headlessly`, "info");
}

function cmdLock(ctx: ExtensionCommandContext, core: any, args: string): void {
	const { flags } = parseArgs(args);
	cachedPass = null;
	if (flags["keychain"] !== undefined) {
		const ok = core.keychainDelete();
		ctx.ui.notify(
			ok ? "vault: passphrase forgotten + keychain entry removed (next /vault re-prompts)" : "vault: passphrase forgotten, but no keychain entry was present to remove",
			ok ? "info" : "warning",
		);
		return;
	}
	ctx.ui.notify("vault: passphrase forgotten for this session — re-prompt next /vault use (add --keychain to also remove the stored keychain entry)", "info");
}

// ── registration ──────────────────────────────────────────────────────
export default function credentialVaultExtension(pi: ExtensionAPI): void {
	const SUBS = ["add", "list", "get", "remove", "rotate", "import", "export", "export-to", "lock", "unlock", "prune-transient"];
	pi.registerCommand("vault", {
		description: "Encrypted credential vault (add/list/get/remove/rotate/import/export/lock/unlock)",
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

			// lock + unlock manage the passphrase themselves and skip the upfront gate;
			// list will prompt via getPassphrase below.
			if (sub !== "lock" && sub !== "unlock") {
				const pass = await getPassphrase(ctx, core);
				if (!pass) return;
				try { core.ensureVault(pass); }
				catch (e: any) { ctx.ui.notify(`vault: could not open vault: ${e?.message || String(e)}`, "error"); return; }
			}

			switch (sub) {
				case "add":              return cmdAdd(ctx, core, rest);
				case "list":             return cmdList(ctx, core);
				case "get":              return cmdGet(ctx, core, rest);
				case "remove":           return cmdRemove(ctx, core, rest);
				case "rotate":           return cmdRotate(ctx, core, rest);
				case "import":           return cmdImport(ctx, core, rest);
				case "export":           return cmdExport(ctx, core, rest);
				case "export-to":        return cmdExportTo(ctx, core, rest);
				case "prune-transient":  return cmdPruneTransient(ctx, core);
				case "lock":             return cmdLock(ctx, core, rest);
				case "unlock":           return cmdUnlock(ctx, core);
				default:
					ctx.ui.notify(`vault: unknown subcommand "${sub}" — try add/list/get/remove/rotate/import/export/lock/unlock`, "warning");
			}
		},
	});
}
