/**
 * sync.ts — apple-pi config-sync TUI bridge.
 *
 * Registers `/sync <status|push|pull|doctor|consolidate|init>` so you can
 * drive multi-device config sync from inside the pi TUI. Delegates to the
 * `apple-pi sync` CLI (sync/cli.js) by spawning it with stdio inherited —
 * same model voice.ts uses for pivoice. The classification authority, secret
 * hook, and all logic live in the CLI; this extension is a thin TUI surface.
 *
 * TUI-only. In RPC/print mode `/sync` is a no-op with a clear message.
 *
 * Resolving `apple-pi`: PATH first, then ~/.apple-pi/bin/apple-pi (where the
 * installer puts it). Mirrors the sync/hook/pre-commit resolution so a machine
 * with no global `apple-pi` on PATH still works.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SUBCOMMANDS = ["status", "push", "pull", "doctor", "consolidate", "init", "help"] as const;

function applePiBin(): string | null {
	if (process.env.APPLE_PI_BIN && existsSync(process.env.APPLE_PI_BIN)) return process.env.APPLE_PI_BIN;
	const path = (spawnSync("command", ["-v", "apple-pi"], { encoding: "utf8" }).stdout || "").trim();
	if (path && existsSync(path)) return path;
	const install = join(homedir(), ".apple-pi", "bin", "apple-pi");
	if (existsSync(install)) return install;
	return null;
}

async function runSync(args: string[], ctx: ExtensionContext): Promise<void> {
	const bin = applePiBin();
	if (!bin) {
		await ctx.ui.notify(
			"apple-pi not found on PATH or at ~/.apple-pi/bin/apple-pi. Run the apple-pi installer.",
			"error",
		);
		return;
	}
	// Hand stdio to `apple-pi sync ...`. It owns the terminal until it exits,
	// then control returns here. Same foreground-exec model as /voice.
	spawnSync(bin, ["sync", ...args], { stdio: "inherit", env: process.env });
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("sync", {
		description: "Config sync: /sync <status|push|pull|doctor|consolidate|init> — multi-device ~/.pi sync",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				await ctx.ui.notify("`/sync` is available in the interactive TUI only.", "warning");
				return;
			}
			const sub = (args[0] || "status") as typeof SUBCOMMANDS[number];
			if (!SUBCOMMANDS.includes(sub)) {
				await ctx.ui.notify(
					`Unknown /sync subcommand '${sub}'. Try: ${SUBCOMMANDS.join(", ")}.`,
					"warning",
				);
				return;
			}
			await runSync(args, ctx);
		},
	});
}
