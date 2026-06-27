/**
 * config.ts — env-driven configuration. Never hardcode secrets.
 */
import { homedir } from "node:os";
import { join } from "node:path";

function bool(name: string, def: boolean): boolean {
	const v = process.env[name];
	if (v === undefined) return def;
	return v === "1" || v === "true" || v === "yes";
}

export const config = {
	searchProvider: (process.env.PI_WEB_SEARCH_PROVIDER ?? "ddg").toLowerCase(),
	tavilyKey: process.env.TAVILY_API_KEY,
	braveKey: process.env.BRAVE_API_KEY,

	userAgent:
		process.env.PI_WEB_USER_AGENT ??
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
			"(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",

	browser: {
		headless: bool("PI_BROWSER_HEADLESS", false),
		cdpUrl: process.env.PI_BROWSER_CDP_URL || undefined,
		profile: process.env.PI_BROWSER_PROFILE || join(homedir(), ".pi", "browser-profile"),
		channel: process.env.PI_BROWSER_CHANNEL ?? "chrome",
		viewport: { width: 1280, height: 900 },
	},
};

export type Config = typeof config;
