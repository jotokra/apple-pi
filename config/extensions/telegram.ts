/**
 * telegram.ts — apple-pi tool for posting to a Telegram chat/topic.
 *
 * Tool:
 *   telegram_send_to_topic → POST a message to a chat (optionally a forum
 *                             topic thread).
 *
 * Configuration (env vars — NO defaults baked in):
 *   TELEGRAM_BOT_TOKEN  — bot token from @BotFather
 *   TELEGRAM_CHAT_ID    — target chat (group id starts with -100)
 *   TELEGRAM_THREAD_ID  — optional forum topic thread id
 *
 * Enabled on demand. Useful when apple-pi is driven from a Telegram bot and
 * needs to reply in-thread. The token must never be committed.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BOT_TOKEN = (process.env as Record<string, string | undefined>)["TELEGRAM_BOT_TOKEN"] ?? "";
const CHAT_ID = (process.env as Record<string, string | undefined>)["TELEGRAM_CHAT_ID"] ?? "";
const THREAD_ID = (process.env as Record<string, string | undefined>)["TELEGRAM_THREAD_ID"] ?? "";

function configError(): string {
	return "telegram extension not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in your environment.";
}

const sendTool = defineTool({
	name: "telegram_send_to_topic",
	label: "Telegram Send to Topic",
	description: "Send a message to a Telegram chat (and optional forum topic thread). Requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.",
	parameters: Type.Object({
		text: Type.String({ description: "Message text (markdown supported)" }),
	}),
	async execute(_id, p) {
		if (!BOT_TOKEN || !CHAT_ID) {
			return { content: [{ type: "text", text: configError() }], details: { ok: false } };
		}
		const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
		const body: Record<string, unknown> = {
			chat_id: CHAT_ID,
			text: p.text,
			parse_mode: "Markdown",
		};
		if (THREAD_ID) body.message_thread_id = Number(THREAD_ID);
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const txt = await res.text();
		if (!res.ok) {
			return { content: [{ type: "text", text: `telegram error ${res.status}: ${txt.slice(0, 400)}` }], details: { status: res.status } };
		}
		const parsed = JSON.parse(txt);
		return {
			content: [{ type: "text", text: `Sent to Telegram: message_id=${parsed?.result?.message_id}` }],
			details: { message_id: parsed?.result?.message_id, chat_id: CHAT_ID, thread_id: THREAD_ID || null },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(sendTool);
}
