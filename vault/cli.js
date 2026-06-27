// vault/cli.js — headless/scripted access to the credential vault.
//
//   apple-pi vault add <id> [--provider P] [--note N] [--lifetime persistent|transient]
//     reads the SECRET FROM STDIN (no echo, never an argv). This is the
//     trace-free path for headless setup (REQ-CV-3 holds: no secret in argv,
//     no secret in shell history, no secret logged).
//   apple-pi vault list                 metadata only (never secrets)
//   apple-pi vault get <id>             privileged — prints the secret (warned)
//   apple-pi vault remove <id>
//   apple-pi vault prune-transient      reap stale onboarding entries (R6)
//
// The passphrase is read from the CREDENTIALS_VAULT_PASS env var, or prompted
// on the tty if absent. (Headless callers set the env var for the duration of
// the call; it is never logged here.)

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {
	ensureVault, addEntry, rotateEntry, listEntries, getEntry, removeEntry,
	pruneTransient, importEntries, parseImportFile, shredFile, exportToAuth,
	exportToCommand, vaultPath,
} = require("./lib/vault");

// Read vault.exportCmd from pi's settings.json (the documented home for vault.*
// settings). Returns "" if unset. (The TUI reads the same key from ctx but the
// CLI has no ctx; it reads the file the user edited.)
function readExportCmd() {
	const piDir = process.env.PI_CODING_AGENT_DIR || `${process.env.HOME || os.homedir()}/.pi`;
	try {
		const s = JSON.parse(fs.readFileSync(path.join(piDir, "settings.json"), "utf8"));
		const v = s && s.vault && s.vault.exportCmd;
		return typeof v === "string" ? v : "";
	} catch { return ""; }
}

function readSecretFromStdin() {
	// Read one line from stdin with echo OFF when stdin is a tty. For piped
	// input (the scripted path) we just read the line. We never log it.
	if (process.stdin.isTTY) {
		// best-effort echo-off via raw stty; restore on exit
		const { spawnSync } = require("node:child_process");
		spawnSync("stty", ["-echo"], { stdio: "inherit" });
		process.stderr.write("secret (hidden): ");
		let buf = "";
		const fd = fs.openSync("/dev/stdin", "r");
		const b = Buffer.alloc(1);
		for (;;) {
			const n = fs.readSync(fd, b, 0, 1, null);
			if (n === 0) break;
			const ch = b[0];
			if (ch === 0x0a || ch === 0x0d) break; // \n or \r
			buf += String.fromCharCode(ch);
		}
		fs.closeSync(fd);
		spawnSync("stty", ["echo"], { stdio: "inherit" });
		process.stderr.write("\n");
		return buf;
	}
	// piped: read first line, trim trailing newline only (NOT inner whitespace,
	// keys are exact). Keep a single trailing \r if present stripped.
	let data = "";
	try { data = fs.readFileSync(0, "utf8"); } catch { return ""; }
	const nl = data.indexOf("\n");
	return (nl >= 0 ? data.slice(0, nl) : data).replace(/\r$/, "");
}

function getPassphrase() {
	if (process.env.CREDENTIALS_VAULT_PASS) return process.env.CREDENTIALS_VAULT_PASS;
	if (!process.stdin.isTTY) {
		process.stderr.write("vault: passphrase required — set CREDENTIALS_VAULT_PASS or run on a tty.\n");
		process.exit(2);
	}
	const { spawnSync } = require("node:child_process");
	spawnSync("stty", ["-echo"], { stdio: "inherit" });
	process.stderr.write("vault passphrase: ");
	let buf = "";
	const fd = fs.openSync("/dev/stdin", "r");
	const b = Buffer.alloc(1);
	for (;;) {
		const n = fs.readSync(fd, b, 0, 1, null);
		if (n === 0) break;
		const ch = b[0];
		if (ch === 0x0a || ch === 0x0d) break;
		buf += String.fromCharCode(ch);
	}
	fs.closeSync(fd);
	spawnSync("stty", ["echo"], { stdio: "inherit" });
	process.stderr.write("\n");
	return buf;
}

function usage() {
	process.stderr.write(`apple-pi vault — credential vault (headless access)

  vault add <id> [--provider P] [--note N] [--lifetime persistent|transient]
      secret is read from STDIN (hidden). Never pass the secret as an arg.
  vault list                       metadata only (never the secret)
  vault get <id>                   prints the secret to stdout  (privileged)
  vault remove <id>
  vault prune-transient            reap transient entries older than 24h (R6)
  vault rotate <id>                replace an existing entry's secret (stdin)
  vault import <file>              bulk-load entries from JSON, then shred source
  vault export <id> [--provider P] write the secret into auth.json (api_key shape)
  vault export-to <id>      run vault.exportCmd with the secret on STDIN (F2)

Passphrase: set CREDENTIALS_VAULT_PASS for non-interactive use, or it is
prompted on the tty. Vault: ${vaultPath()}
`);
}

function parseFlags(args, known) {
	const out = { positional: [], flags: {} };
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith("--")) {
			const k = a.slice(2);
			if (known.has(k)) {
				out.flags[k] = args[++i];
			} else {
				process.stderr.write(`vault: unknown flag --${k}\n`);
				process.exit(2);
			}
		} else out.positional.push(a);
	}
	return out;
}

function run(argv) {
	const [sub, ...rest] = argv;
	if (!sub || sub === "-h" || sub === "--help" || sub === "help") { usage(); return 0; }

	const pass = getPassphrase();
	try { ensureVault(pass); }
	catch (e) { process.stderr.write(`vault: could not open vault: ${e.message}\n`); return 1; }

	switch (sub) {
		case "add": {
			const { positional, flags } = parseFlags(rest, new Set(["provider", "note", "lifetime"]));
			const id = positional[0];
			if (!id) { process.stderr.write("vault add: id required\n"); return 2; }
			const secret = readSecretFromStdin();
			if (!secret) { process.stderr.write("vault add: secret was empty\n"); return 2; }
			const lifetime = ["persistent", "transient"].includes(flags.lifetime) ? flags.lifetime : "persistent";
			const r = addEntry(pass, {
				id, secret,
				provider: flags.provider, note: flags.note || "", lifetime,
			});
			// deliberately do NOT echo the secret back; created/overwritten only.
			process.stdout.write(`${r.created ? "added" : "updated"} vault entry: ${id}\n`);
			return 0;
		}
		case "list": {
			const rows = listEntries(pass);
			if (!rows.length) { process.stdout.write("(vault is empty)\n"); return 0; }
			for (const e of rows) {
				process.stdout.write(
					`${e.id}\t${e.kind}\t${e.provider}\t${e.lifetime}\t${e.createdAt}${e.note ? "\t" + e.note : ""}\n`,
				);
			}
			return 0;
		}
		case "get": {
			// privileged — the CLI is explicit headless tooling, so we print.
			// (The TUI path gates this behind allowReveal; the CLI assumes the
			// operator knows what they're doing.)
			const id = rest[0];
			if (!id) { process.stderr.write("vault get: id required\n"); return 2; }
			const e = getEntry(pass, id);
			if (!e) { process.stderr.write(`vault: no entry '${id}'\n`); return 1; }
			process.stdout.write(`${e.secret}\n`); // trailing newline is shell-conventional
			return 0;
		}
		case "remove": {
			const id = rest[0];
			if (!id) { process.stderr.write("vault remove: id required\n"); return 2; }
			const ok = removeEntry(pass, id);
			process.stdout.write(`${ok ? "removed" : "not found"}: ${id}\n`);
			return ok ? 0 : 1;
		}
		case "prune-transient": {
			const n = pruneTransient(pass);
			process.stdout.write(`pruned ${n} stale transient entr${n === 1 ? "y" : "ies"}\n`);
			return 0;
		}
		case "rotate": {
			const { positional } = parseFlags(rest, new Set([]));
			const id = positional[0];
			if (!id) { process.stderr.write("vault rotate: id required\n"); return 2; }
			// rotate implies the entry already exists; refuse early (before consuming
			// stdin) so the user isn't prompted for a secret they can't use.
			if (!getEntry(pass, id)) {
				process.stderr.write(`vault rotate: no entry '${id}' (use 'add' to create)\n`);
				return 1;
			}
			const secret = readSecretFromStdin();
			if (!secret) { process.stderr.write("vault rotate: secret was empty\n"); return 2; }
			const r = rotateEntry(pass, { id, secret });
			process.stdout.write(`${r.rotated ? "rotated" : "could not rotate"} vault entry: ${id}\n`);
			return r.rotated ? 0 : 1;
		}
		case "import": {
			const { positional } = parseFlags(rest, new Set([]));
			const file = positional[0];
			if (!file) { process.stderr.write("vault import: file path required\n"); return 2; }
			const resolved = path.resolve(file);
			let entries;
			try { entries = parseImportFile(resolved); }
			catch (e) { process.stderr.write(`vault import: ${e.message}\n`); return 2; }
			const r = importEntries(pass, entries);
			const shredded = shredFile(resolved);
			process.stdout.write(
				`imported ${r.imported} entr${r.imported === 1 ? "y" : "ies"}` +
					(r.errors.length ? ` (${r.errors.length} error${r.errors.length === 1 ? "" : "s"})` : "") +
					(shredded ? "; source shredded" : "; WARNING: could not shred source — remove it manually") + "\n",
			);
			return r.errors.length ? 1 : 0;
		}
		case "export": {
			const { positional, flags } = parseFlags(rest, new Set(["provider"]));
			const id = positional[0];
			if (!id) { process.stderr.write("vault export: id required\n"); return 2; }
			const r = exportToAuth(pass, id, { provider: flags.provider });
			if (!r.wrote) { process.stderr.write(`vault export: ${r.reason}\n`); return 1; }
			process.stdout.write(`exported '${id}' → auth.json['${r.provider}']\n`);
			return 0;
		}
		case "export-to": {
			// F2: run the user-configured vault.exportCmd with the secret on STDIN.
			const { positional } = parseFlags(rest, new Set([]));
			const id = positional[0];
			if (!id) { process.stderr.write("vault export-to: id required\n"); return 2; }
			const exportCmd = readExportCmd();
			if (!exportCmd) {
				process.stderr.write("vault export-to: no vault.exportCmd configured.\n");
				process.stderr.write("  Set it in ~/.pi/settings.json, e.g.\n");
				process.stderr.write('    { "vault": { "exportCmd": "op item create --category=\'API Key\' $VAULT_PROVIDER" } }\n');
				process.stderr.write("  The secret is piped to the command's STDIN; metadata via $VAULT_ID/PROVIDER/KIND/NOTE env vars.\n");
				return 2;
			}
			// exportToCommand is async (spawns the child). The CLI is sync elsewhere;
			// await via .then at the top-level run() boundary.
			return exportToCommand(pass, id, { exportCmd }).then((r) => {
				if (!r.ok) { process.stderr.write(`vault export-to: ${r.reason}\n`); return 1; }
				process.stdout.write(`exported '${id}' via vault.exportCmd\n`);
				return 0;
			});
		}
		default:
			process.stderr.write(`vault: unknown subcommand '${sub}'\n`);
			usage();
			return 2;
	}
}

module.exports = { run };
