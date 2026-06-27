/**
 * sysinfo-guard.ts — Red/blue defaults. The one extension apple-pi
 * enables by default in every install.
 *
 * Blocks:
 *   - bash commands that match destructive patterns (rm -rf /,
 *     chmod -R 777 /, writes to /etc, dd to a block device, sudo
 *     without explicit intent, curl|sh).
 *   - write/edit to system + secret paths (/etc, /usr/local,
 *     ~/Library, ~/.ssh, ~/.aws, the agent auth store, etc.).
 *   - reads of private-key / cert material.
 *
 * The user can override a destructive bash command per-call via an
 * explicit confirm prompt (interactive mode). Non-interactive runs
 * block by default. Every block names its reason.
 *
 * Always-on. Sourced from settings.json `extensions`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
	{ re: /\brm\s+(-[a-zA-Z]*[rfFR]+|--force|--recursive).*[\s\u0027"`](\/|\$HOME|\~|\.\.|\.\$)/, reason: "rm with -r/-f targeting root, $HOME, or relative paths" },
	{ re: /\bchmod\s+-R\s+[0-7]{3,4}\s+\//, reason: "chmod -R on absolute path" },
	{ re: /\bchmod\s+[0-7]{3,4}\s+\/etc\b/, reason: "chmod on /etc" },
	{ re: /\bdd\s+.*of=\/dev\/(disk|nvme|ada|sd|nvme)/, reason: "dd to a block device" },
	{ re: /\bmkfs(\.[a-z0-9]+)?\s+\/dev\//, reason: "mkfs on a device" },
	{ re: /\bsudo\b/, reason: "sudo (requires explicit intent)" },
	{ re: /\bcurl\b.*\|\s*(ba)?sh\b/, reason: "curl piped to shell" },
	{ re: /\bwget\b.*\|\s*(ba)?sh\b/, reason: "wget piped to shell" },
	{ re: />\s*\/etc\//, reason: "redirect into /etc" },
	{ re: />\s*\/System\//, reason: "redirect into /System" },
	{ re: />\s*\/private\/etc\//, reason: "redirect into /private/etc" },
	{ re: />\s*\/boot\//, reason: "redirect into /boot" },
];

const PROTECTED_WRITE_PATHS: RegExp[] = [
	/^\/etc\//,
	/^\/System\//,
	/^\/private\/etc\//,
	/^\/usr\/local\//,
	/^\/usr\/lib\//,
	/^\/Library\//,
	/^~\/Library\//,
	/^~\/\.ssh\//,
	/^~\/\.gnupg\//,
	/^~\/\.aws\//,
	/^~\/\.kube\//,
	/^~\/\.docker\//,
	/^~\/\.config\/(gh|git|hub)/,
	/^~\/\.npmrc$/,
	/^~\/\.netrc$/,
	/^~\/\.pi\/agent\/auth\.json$/,
	/^~\/\.pi\/onboarding\.vault/,
];

const PROTECTED_READ_HINTS: Array<{ re: RegExp; reason: string }> = [
	{ re: /id_ed25519\b/, reason: "SSH private key material" },
	{ re: /id_rsa\b/, reason: "SSH private key material" },
	{ re: /id_ecdsa\b/, reason: "SSH private key material" },
	{ re: /\.pem\b/, reason: "PEM-encoded key/cert" },
	{ re: /\.keystore\b/, reason: "keystore" },
];

function isProtectedPath(p: string): { protected: boolean; reason?: string } {
	for (const re of PROTECTED_WRITE_PATHS) {
		if (re.test(p)) return { protected: true, reason: `path matches ${re.source}` };
	}
	for (const hint of PROTECTED_READ_HINTS) {
		if (hint.re.test(p)) return { protected: true, reason: hint.reason };
	}
	return { protected: false };
}

function matchesDestructive(cmd: string): string | null {
	for (const p of DESTRUCTIVE_PATTERNS) {
		if (p.re.test(cmd)) return p.reason;
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			const cmd = String(event.input?.command ?? "");
			const reason = matchesDestructive(cmd);
			if (reason) {
				if (ctx.hasUI) {
					const ok = await ctx.ui.confirm(
						"Destructive bash command",
						`Reason: ${reason}\n\nCommand:\n${cmd.slice(0, 400)}\n\nAllow?`,
					);
					if (!ok) {
						return { block: true, reason: `Blocked by sysinfo-guard: ${reason}` };
					}
				} else {
					return { block: true, reason: `Blocked by sysinfo-guard (non-interactive): ${reason}` };
				}
			}
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			const target = String(event.input?.path ?? "");
			const check = isProtectedPath(target);
			if (check.protected) {
				return { block: true, reason: `Protected path blocked by sysinfo-guard: ${check.reason}` };
			}
		}

		if (event.toolName === "read") {
			const target = String(event.input?.path ?? "");
			const check = isProtectedPath(target);
			if (check.protected && (check.reason?.includes("private key") || check.reason?.includes("PEM") || check.reason?.includes("keystore"))) {
				return { block: true, reason: `Read blocked by sysinfo-guard: ${check.reason}` };
			}
		}

		return undefined;
	});
}
