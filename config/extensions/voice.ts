/**
 * voice.ts — apple-pi voice-mode bridge.
 *
 * Registers `/voice` (+ Ctrl+V) so you can flip the ongoing pi TUI session
 * into pivoice: same conversation, voice turns append to the same session
 * JSONL, and you resume the TUI with `pi -c` when done.
 *
 * Architecture constraint (verified against the pi extension API): an
 * extension command runs IN the TUI process, which owns the terminal. pi
 * exposes no "suspend screen / hand TTY to subprocess" primitive, so the
 * "switch" model is implemented by EXEC-ing pivoice in the foreground: the
 * handler confirms, then spawns pivoice with stdio inherited against the
 * active session file. pivoice owns the TTY exclusively until it exits.
 *
 * TUI-only. In RPC/print mode `/voice` is a no-op with a clear message.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Where the bundled pivoice lives after install.sh copies config/voice.
function pivoiceBin(): string {
	const candidates = [
		process.env.PIVOICE_BIN,
		join(homedir(), ".pi", "voice", "bin", "pivoice"),
		join(homedir(), ".pi", "extensions", "voice", "bin", "pivoice"),
	];
	for (const c of candidates) if (c && existsSync(c)) return c!;
	return join(homedir(), ".pi", "voice", "bin", "pivoice"); // default for the error message
}

async function launchVoice(ctx: ExtensionContext): Promise<void> {
	const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? null;

	const bin = pivoiceBin();
	if (!existsSync(bin)) {
		await ctx.ui.notify(
			`pivoice not found at ${bin}. Run apple-pi install, or set PIVOICE_BIN.`,
			"error",
		);
		return;
	}

	// Dep guard: if the whisper model is missing, voice won't transcribe.
	// Run the read-only check and, if anything's missing, point the user at the
	// one-command enable script instead of launching a dead pivoice.
	const modelPath = join(homedir(), ".pi", "voice", "models", "ggml-small.en.bin");
	const enableScript = join(homedir(), ".apple-pi", "lifecycle", "voice-enable.sh");
	if (!existsSync(modelPath)) {
		const msg = existsSync(enableScript)
			? `Voice deps not installed (no whisper model). Enable with one command:\n  bash ${enableScript}\nThen /voice again.`
			: `Voice deps not installed (no whisper model at ${modelPath}). See config/voice/README.md.`;
		await ctx.ui.notify(msg, "warning");
		return;
	}

	const target = sessionFile ?? "(continue most recent)";
	const confirm = await ctx.ui.confirm(
		"Enter voice mode?",
		`Launch pivoice on this session: ${target}\n\nVoice turns append to the same conversation. Press q in pivoice to exit, then 'pi -c' to resume here.`,
	);
	if (!confirm) return;

	// Hand the TTY to pivoice. It runs until the user quits; control returns here.
	const env = { ...process.env };
	if (sessionFile) env.PIVOICE_SESSION = sessionFile;
	if (sessionFile) env.PIVOICE_PI_CWD = env.PIVOICE_PI_CWD || process.cwd();

	await new Promise<void>((resolve) => {
		// stdio inherit = pivoice takes over the terminal (raw mode, its own TUI).
		const child = spawn(bin, [], {
			stdio: "inherit",
			env,
			cwd: process.cwd(),
		});
		child.on("exit", () => resolve());
		child.on("error", (e) => {
			ctx.ui.notify(`pivoice failed to start: ${e.message}`, "error");
			resolve();
		});
	});

	await ctx.ui.notify(
		`Voice mode ended. Voice turns are in the session. Run \`pi -c\` (or /resume) to see them.`,
		"info",
	);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("voice", {
		description: "Enter voice mode — flip this session to pivoice (same conversation)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				await ctx.ui.notify("`/voice` is available in the interactive TUI only.", "warning");
				return;
			}
			await launchVoice(ctx);
		},
	});

	// Ctrl+V shortcut — same as /voice (TUI only).
	pi.registerShortcut("ctrl+v", {
		description: "Enter voice mode (pivoice) on the current session",
		handler: async (_event, ctx) => {
			if (ctx.mode !== "tui") return;
			await launchVoice(ctx);
		},
	});
}
