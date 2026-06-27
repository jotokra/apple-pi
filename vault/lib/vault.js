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

module.exports = {
	VAULT_VERSION,
	TRANSIENT_MAX_AGE_MS,
	vaultPath, piDir,
	readVault, writeVault, ensureVault, modifyVault,
	addEntry, listEntries, getEntry, removeEntry, pruneTransient,
	// exported for testing only (NOT for echoing secrets):
	_findEntryForTest: findEntry,
};
