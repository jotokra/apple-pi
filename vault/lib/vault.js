// vault/lib/vault.js — credential vault core (pure functions, no TUI).
//
// Implements REQ-CV-2: an encrypted, versioned-JSON credential store at
// ~/.pi/agent/credentials.vault (mode 0600), using the SAME cipher as the
// v1 onboarding vault (D2): openssl enc -aes-256-cbc -pbkdf2 -iter 600000.
// No new crypto, no node-crypto dependency — openssl is invoked via
// child_process, so the extension + CLI stay portable.
//
// Security notes (see .docs/features/credential-vault/SECURITY.md):
//   - the passphrase is passed to openssl on STDIN (-pass stdin), never as an
//     argv flag, so it does not appear in `ps e` / process listings.
//   - writes are atomic (temp file + fsync + rename) and serialized behind a
//     file lock (R5). Unknown JSON fields are preserved on rewrite (forward-compat).
//
// This module NEVER logs a secret. Callers (CLI/TUI) are responsible for not
// echoing secrets; listEntries() returns full entry objects so the caller can
// decide what to show — the convention is "metadata only" at the UI layer.

"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const VAULT_VERSION = 1;
const TRANSIENT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // R6: reap stale onboarding entries after 24h

// ── paths ──────────────────────────────────────────────────────────────
function piDir() {
	return process.env.PI_CODING_AGENT_DIR || `${process.env.HOME || os.homedir()}/.pi`;
}
function vaultPath() {
	return process.env.CREDENTIALS_VAULT || `${piDir()}/agent/credentials.vault`;
}
function lockPath() {
	return `${vaultPath()}.lock`;
}

// ── crypto: thin openssl wrappers (D2 cipher) ──────────────────────────
// Both take/return the passphrase on stdin so it never hits argv.
function encrypt(plaintext, passphrase) {
	return execFileSync(
		"openssl",
		["enc", "-aes-256-cbc", "-pbkdf2", "-iter", "600000", "-salt", "-pass", "stdin"],
		{ input: Buffer.concat([Buffer.from(passphrase), Buffer.from("\n"), Buffer.from(plaintext)]) },
	);
}
function decrypt(ciphertext, passphrase) {
	return execFileSync(
		"openssl",
		["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "600000", "-pass", "stdin"],
		{ input: Buffer.concat([Buffer.from(passphrase), Buffer.from("\n"), Buffer.from(ciphertext)]) },
	);
}

// ── file lock (O_EXCL + PID staleness; portable, dependency-free) ──────
// R5: serialize the read-modify-write so concurrent /vault calls can't corrupt
// the file. Mirrors the intent of pi's FileAuthStorageBackend.withLock without
// needing pi's native binding.
function withLock(fn) {
	const lp = lockPath();
	fs.mkdirSync(path.dirname(lp), { recursive: true });
	const deadline = Date.now() + 5000; // 5s is plenty for a human-paced op
	let firstErr = null;
	for (;;) {
		try {
			// O_EXCL creation = atomic acquire on POSIX.
			const h = fs.openSync(lp, "wx", 0o600);
			fs.writeSync(h, String(process.pid));
			fs.closeSync(h);
			break;
		} catch (e) {
			firstErr = firstErr || e;
			if (e.code !== "EEXIST") throw e;
			// Stale lock? (holder PID no longer alive)
			try {
				const holderPid = parseInt(fs.readFileSync(lp, "utf8").trim(), 10);
				if (Number.isFinite(holderPid)) {
					try { process.kill(holderPid, 0); } // throws if no such process
					catch { fs.unlinkSync(lp); continue; } // stale → reclaim
				} else {
					fs.unlinkSync(lp); continue; // corrupt lockfile → reclaim
				}
			} catch { /* read failed; maybe raced away */ }
			if (Date.now() > deadline) {
				throw new Error(`vault: could not acquire lock ${lp} after 5s (held by another process?)`);
			}
			// backoff
			const end = Date.now() + 50;
			while (Date.now() < end) { /* spin briefly */ }
		}
	}
	let unlockErr = null;
	try {
		return fn();
	} finally {
		try { fs.unlinkSync(lp); }
		catch (e) { if (e.code !== "ENOENT") unlockErr = e; }
	}
	if (unlockErr) throw unlockErr;
}

// ── envelope read/write ────────────────────────────────────────────────
function emptyEnvelope() {
	return { version: VAULT_VERSION, created: new Date().toISOString(), entries: [] };
}

// Read + decrypt + parse. Returns the envelope object. Throws on wrong
// passphrase (openssl exits non-zero) or corrupt JSON.
function readVault(passphrase) {
	const vp = vaultPath();
	let ciphertext;
	try { ciphertext = fs.readFileSync(vp); }
	catch (e) {
		if (e.code === "ENOENT") return null; // no vault yet
		throw e;
	}
	const json = decrypt(ciphertext, passphrase).toString("utf8");
	const env = JSON.parse(json);
	// defensive defaults so old/empty vaults still work
	if (!Array.isArray(env.entries)) env.entries = [];
	return env;
}

// Atomic, locked write. obj is the full envelope. Preserves any unknown
// fields the caller carried through (forward-compat, REQ-CV-2).
// Public callers use writeVault(); modifyVault() calls the _Unlocked variant
// inside its own lock to avoid a re-entrant-lock deadlock.
function _writeVaultUnlocked(env, passphrase) {
	const vp = vaultPath();
	const dir = path.dirname(vp);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${vp}.tmp.${process.pid}`;
	const ciphertext = encrypt(Buffer.from(JSON.stringify(env, null, 2), "utf8"), passphrase);
	const h = fs.openSync(tmp, "w", 0o600);
	fs.writeSync(h, ciphertext);
	fs.fsyncSync(h); // R5: durability before the rename
	fs.closeSync(h);
	fs.renameSync(tmp, vp); // atomic on POSIX
	fs.chmodSync(vp, 0o600); // belt + suspenders: rename may relax perms
}
function writeVault(passphrase, env) {
	return withLock(() => _writeVaultUnlocked(env, passphrase));
}

// Initialize an empty vault if none exists. Idempotent. Does NOT clobber.
function ensureVault(passphrase) {
	withLock(() => {
		if (readVault(passphrase) === null) _writeVaultUnlocked(emptyEnvelope(), passphrase);
	});
}

// read-modify-write under ONE lock; fn mutates the envelope in place and may
// return a result. The write uses the _Unlocked variant so we don't try to
// re-acquire the lock we already hold.
function modifyVault(passphrase, fn) {
	return withLock(() => {
		const env = readVault(passphrase) || emptyEnvelope();
		const result = fn(env);
		_writeVaultUnlocked(env, passphrase);
		return result;
	});
}

// ── entry CRUD ─────────────────────────────────────────────────────────
function findEntry(env, id) { return env.entries.find((e) => e.id === id) || null; }

// addEntry: returns {created:true} | {created:false, overwritten:true}.
// Always sets createdAt fresh on a new entry; preserves createdAt on overwrite.
function addEntry(passphrase, { id, kind = "api_key", provider, secret, note = "", lifetime = "persistent" }) {
	if (!id) throw new Error("vault: addEntry requires an id");
	if (typeof secret !== "string") throw new Error("vault: addEntry requires a string secret");
	let created = true;
	modifyVault(passphrase, (env) => {
		const existing = findEntry(env, id);
		const now = new Date().toISOString();
		const entry = {
			...(existing || {}), // forward-compat: preserve unknown fields
			id, kind, provider: provider || id,
			secret, note, lifetime,
			createdAt: existing?.createdAt || now,
			updatedAt: now,
		};
		if (existing) created = false;
		env.entries = env.entries.filter((e) => e.id !== id).concat(entry);
	});
	return { created, overwritten: !created };
}

function listEntries(passphrase) {
	const env = readVault(passphrase);
	if (!env) return [];
	// return metadata only — NEVER the secret (REQ-CV-5 list contract).
	// getEntry() is the privileged path that returns the secret.
	return env.entries.map((e) => ({
		id: e.id, kind: e.kind, provider: e.provider,
		createdAt: e.createdAt, updatedAt: e.updatedAt,
		note: e.note, lifetime: e.lifetime,
	}));
}

function getEntry(passphrase, id) {
	const env = readVault(passphrase);
	if (!env) return null;
	return findEntry(env, id); // full entry INCLUDING secret — privileged
}

function removeEntry(passphrase, id) {
	let removed = false;
	modifyVault(passphrase, (env) => {
		const before = env.entries.length;
		env.entries = env.entries.filter((e) => e.id !== id);
		removed = env.entries.length < before;
	});
	return removed;
}

// R6: reap transient entries older than maxAgeMs (default 24h). Onboarding
// should finish in minutes; a transient entry still present after a day means
// the confirm step crashed. Safe to reap. Returns count removed.
function pruneTransient(passphrase, maxAgeMs = TRANSIENT_MAX_AGE_MS) {
	let removed = 0;
	const cutoff = Date.now() - maxAgeMs;
	modifyVault(passphrase, (env) => {
		const keep = [];
		for (const e of env.entries) {
			if (e.lifetime === "transient") {
				const ts = Date.parse(e.updatedAt || e.createdAt || "");
				if (Number.isFinite(ts) && ts < cutoff) { removed++; continue; }
			}
			keep.push(e);
		}
		env.entries = keep;
	});
	return removed;
}

// ── argument-refusal heuristic (REQ-CV-3; shared with the TUI extension) ──
// True when a token looks like a pasted credential rather than an id/flag.
// Used by the /vault add command to REFUSE secrets passed as arguments (the
// argument is what the session transcript records). Conservative: a 20+ char
// opaque token or a known key prefix is treated as a secret.
const SECRET_PREFIXES = ["sk-", "ghp_", "gho_", "github_pat_", "AIza", "xai-", "gsk_", "sk-ant-", "sk-or-"];
function looksLikeSecret(s) {
	if (typeof s !== "string") return false;
	// A known key PREFIX is a strong signal even for a short token (a truncated
	// sk-ant-… is still obviously a key, not an id). Prefix match bypasses the
	// length floor; the opaque-token regex still needs 20+ chars to avoid false
	// positives on short ids.
	if (SECRET_PREFIXES.some((p) => s.startsWith(p))) return true;
	if (s.length < 16) return false;
	return /^[A-Za-z0-9_\-]{20,}$/.test(s);
}

// ── rotate / import / export (REQ-CV-1 remainder; cv-rotate-import-export) ──
//
// rotate: replace an existing entry's secret (re-encrypted under a fresh
// salt via the same write path). Refuses if the entry does not exist —
// "rotate" implies the credential is already stored; `add` creates.
function rotateEntry(passphrase, { id, secret, note }) {
	if (!id) throw new Error("vault: rotateEntry requires an id");
	if (typeof secret !== "string") throw new Error("vault: rotateEntry requires a string secret");
	let rotated = false;
	modifyVault(passphrase, (env) => {
		const existing = findEntry(env, id);
		if (!existing) return; // not found → rotated stays false
		rotated = true;
		const entry = {
			...existing, // preserve id/kind/provider/createdAt/lifetime/unknown fields
			secret,
			note: note !== undefined ? note : existing.note,
			updatedAt: new Date().toISOString(),
		};
		env.entries = env.entries.filter((e) => e.id !== id).concat(entry);
	});
	return { rotated };
}

// parseImportFile: read + JSON.parse a migration file into an entries array.
// Accepts the two natural shapes:
//   - { entries: [ ... ] }   (the vault's own envelope shape)
//   - [ ... ]                (a bare array of entry objects)
// Throws on unreadable / unparseable / unknown shape. Does NOT accept pi's
// auth.json shape ({provider:{type,key}}) — that reverse bridge is out of
// scope for this card (export goes vault→auth.json; the reverse is a later
// convenience). Each entry is validated by importEntries.
function parseImportFile(filePath) {
	const raw = fs.readFileSync(filePath, "utf8");
	const data = JSON.parse(raw);
	let entries;
	if (Array.isArray(data)) entries = data;
	else if (data && Array.isArray(data.entries)) entries = data.entries;
	else throw new Error("import file must be a JSON array or { entries: [...] }");
	return entries;
}

// importEntries: bulk add. Each entry needs at least { id, secret }.
// addEntry semantics (overwrites a same-id entry). One bad entry does not
// abort the batch — it's recorded in errors[]. Returns { imported, errors }.
function importEntries(passphrase, entries) {
	if (!Array.isArray(entries)) throw new Error("vault: importEntries requires an array");
	let imported = 0;
	const errors = [];
	for (const e of entries) {
		try {
			if (!e || typeof e !== "object") throw new Error("entry is not an object");
			if (!e.id) throw new Error("missing id");
			if (typeof e.secret !== "string") throw new Error("missing or non-string secret");
			addEntry(passphrase, {
				id: e.id, secret: e.secret,
				kind: e.kind || "api_key",
				provider: e.provider || e.id,
				note: e.note || "",
				lifetime: e.lifetime === "transient" ? "transient" : "persistent",
			});
			imported++;
		} catch (err) {
			errors.push({ id: (e && e.id) || "?", error: err.message });
		}
	}
	return { imported, errors };
}

// shredFile: best-effort secure delete (overwrite with zeros + fsync + unlink).
// HONEST CAVEAT: on SSDs / APFS copy-on-write, wear-leveling means this is NOT
// a forensic guarantee — remnants may persist. The goal is "don't leave the
// plaintext source lying around after import", not "defeat disk recovery".
// Real at-rest protection is FileVault (recommended in SECURITY.md A4), not
// shred. Returns true if the file was removed.
function shredFile(filePath) {
	let st;
	try { st = fs.lstatSync(filePath); }
	catch { return false; }
	// Refuse to follow a symlink: openSync("r+") + writeSync would overwrite the
	// TARGET, while unlinkSync removes only the link itself — silent data loss
	// of an unrelated file. Return false so the caller tells the user to remove
	// it manually. (Reads via parseImportFile still follow the link, which is
	// fine; it's only the destructive shred that must not.)
	if (st.isSymbolicLink()) return false;
	try {
		const sz = st.size;
		if (sz > 0) {
			const h = fs.openSync(filePath, "r+");
			fs.writeSync(h, Buffer.alloc(sz, 0), 0, sz, 0);
			fs.fsyncSync(h);
			fs.closeSync(h);
		}
	} catch { /* best-effort; fall through to unlink */ }
	try { fs.unlinkSync(filePath); return true; }
	catch { return false; }
}

// exportToAuth: the vault → auth.json bridge (SPEC §D). Writes the entry's
// secret into ~/.pi/agent/auth.json under `provider` (default: entry.provider,
// then id) in pi's native { type:"api_key", key } shape. Merges with the
// existing auth.json (other providers preserved). REFUSES to clobber an
// existing provider entry that is not api_key-shaped (e.g. an OAuth token) —
// returns { wrote:false, reason } so the caller surfaces it. Atomic write at
// 0600. The secret transits memory → auth.json only; it is never echoed.
function authJsonPath() {
	return `${piDir()}/agent/auth.json`;
}
function exportToAuth(passphrase, id, opts = {}) {
	const entry = getEntry(passphrase, id);
	if (!entry) return { wrote: false, reason: `no entry '${id}'` };
	const provider = opts.provider || entry.provider || id;
	let auth = {};
	try { auth = JSON.parse(fs.readFileSync(authJsonPath(), "utf8")); }
	catch { /* missing or invalid → start fresh */ }
	if (!auth || typeof auth !== "object" || Array.isArray(auth)) auth = {};
	const existing = auth[provider];
	if (existing && (typeof existing !== "object" || existing.type !== "api_key")) {
		return { wrote: false, reason: `auth.json['${provider}'] is not api_key-shaped (refusing to clobber an OAuth/other token)` };
	}
	auth[provider] = { type: "api_key", key: entry.secret };
	const p = authJsonPath();
	fs.mkdirSync(path.dirname(p), { recursive: true });
	const tmp = `${p}.tmp.${process.pid}`;
	const h = fs.openSync(tmp, "w", 0o600);
	fs.writeSync(h, JSON.stringify(auth, null, 2));
	fs.fsyncSync(h);
	fs.closeSync(h);
	fs.renameSync(tmp, p);
	fs.chmodSync(p, 0o600); // belt + suspenders (rename may relax perms)
	return { wrote: true, provider };
}

// ── masked-entry render helper (F1; shared by the TUI overlay + smoke) ──
// Pure: compute the single rendered line for a masked secret field. Returns
// the DOT ROW only (no label) so the caller controls framing. The contract
// is "never emits more than `width` visible columns" — pi's TUI crashes if a
// rendered line exceeds the viewport width (verified in the TUI source), so
// this is the load-bearing invariant (R-F1a), unit-tested in the smoke.
//
// `visibleLen(prompt)` accounts for the prompt + a separating space; the dot
// budget is whatever remains. Never returns a negative dot count.
function maskedDotRow(prompt, bufferLen, width) {
	if (typeof width !== "number" || !Number.isFinite(width) || width < 0) return "";
	const promptLen = typeof prompt === "string" ? prompt.length : 0;
	// reserve prompt + 1 space; never go below 0 dots.
	const dotBudget = Math.max(0, Math.floor(width) - promptLen - 1);
	return "•".repeat(Math.min(Math.max(0, bufferLen | 0), dotBudget));
}

// ── F2: generic external export (vault.exportCmd) ────────────────────
// Runs a USER-CONFIGURED command, piping the secret to its STDIN. Mirrors pi's
// own `apiKey: "!command"` resolution + git's credential.helper: the user owns
// the command (their secret manager — 1Password CLI, pass, bitwarden, a custom
// helper); apple-pi is sanitized so NO specific store is hardcoded.
//
// LOAD-BEARING SAFETY (red/blue R-F2a/b/c, re-derived after first draft):
//   - the SECRET is piped to the child's STDIN only — never argv, never env,
//     never interpolated into the command string (so `ps e` can't see it).
//   - NON-SECRET metadata ($VAULT_ID/PROVIDER/KIND/NOTE) is passed as ENV
//     VARS, NOT string-interpolated into the command — so a malicious note
//     (e.g. "; rm -rf ~") can't break out of the command's argv. The command
//     string is static user config; only $VAULT_* env vars are read.
//   - stdin is ended immediately after the write; a 10s timeout kills a hung
//     child. Non-zero exit is surfaced (exit code), the secret NOT re-exposed.
function exportToCommand(passphrase, id, opts = {}) {
	const cmd = opts.exportCmd;
	if (!cmd || typeof cmd !== "string" || !cmd.trim()) {
		return Promise.resolve({ ok: false, reason: "no vault.exportCmd configured (set it in settings.json to enable /vault export-to)" });
	}
	const entry = getEntry(passphrase, id);
	if (!entry) return Promise.resolve({ ok: false, reason: `no entry '${id}'` });
	// metadata-only env (NON-SECRET). The secret is NEVER an env var.
	const childEnv = {
		...process.env,
		VAULT_ID: String(entry.id || ""),
		VAULT_PROVIDER: String(entry.provider || entry.id || ""),
		VAULT_KIND: String(entry.kind || "api_key"),
		VAULT_NOTE: String(entry.note || ""),
	};
	return new Promise((resolve) => {
		let child;
		try {
			// shell:true so the user's command can use pipes/quotes as intended.
			// The command is static user config (no secret interpolation), so shell
			// metacharacters are the user's explicit intent.
			child = require("node:child_process").spawn(cmd, [], {
				shell: true, stdio: ["pipe", "inherit", "inherit"], env: childEnv,
			});
		} catch (e) {
			resolve({ ok: false, reason: `could not spawn export command: ${e && e.message || String(e)}` });
			return;
		}
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try { child.kill("SIGKILL"); } catch { /* already dead */ }
		}, 10000);
		let stderrTail = "";
		if (child.stderr) {
			child.stderr.on("data", (d) => {
				// keep a short tail for diagnostics; the secret is on STDIN, never stderr.
				stderrTail = (stderrTail + d.toString()).slice(-512);
			});
		}
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ ok: false, reason: `export command failed to start: ${e.message}` });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (timedOut) { resolve({ ok: false, reason: "export command timed out (10s) and was killed" }); return; }
			if (code === 0) resolve({ ok: true });
			else resolve({ ok: false, reason: `export command exited ${code}${signal ? " (" + signal + ")" : ""}${stderrTail ? ": " + stderrTail.trim() : ""}` });
		});
		// THE secret transits ONLY here: vault → child.stdin. Then close stdin.
		try {
			child.stdin.write(entry.secret);
			child.stdin.end();
		} catch (e) {
			clearTimeout(timer);
			try { child.kill("SIGKILL"); } catch { /* */ }
			resolve({ ok: false, reason: `could not write secret to command stdin: ${e && e.message || String(e)}` });
		}
	});
}

module.exports = {
	VAULT_VERSION,
	TRANSIENT_MAX_AGE_MS,
	vaultPath, piDir, authJsonPath,
	readVault, writeVault, ensureVault, modifyVault,
	addEntry, rotateEntry, listEntries, getEntry, removeEntry, pruneTransient,
	importEntries, parseImportFile, shredFile, exportToAuth, exportToCommand,
	looksLikeSecret, maskedDotRow,
	// exported for testing only (NOT for echoing secrets):
	_findEntryForTest: findEntry,
};
