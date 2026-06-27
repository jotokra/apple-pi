/**
 * browser.ts — Playwright manager. Lazily launches a persistent, headed
 * Chrome profile (so the user's logins/cookies persist and the user can
 * watch every action), or attaches to a running Chrome via CDP.
 *
 * Playwright is imported dynamically so the search/fetch tools keep
 * working even if playwright fails to load or install.
 */
import { config } from "./config.ts";

type AnyPage = any;
type AnyContext = any;

export interface Snapshot {
	url: string;
	title: string;
	text: string; // trimmed visible body text
}

export class BrowserManager {
	private ctx: AnyContext | null = null;
	private pw: any | null = null;
	private closed = false;

	private async loadPlaywright(): Promise<any> {
		if (this.pw) return this.pw;
		try {
			this.pw = await import("playwright");
		} catch (e) {
			throw new Error(
				"playwright is not installed. Run `npm install` in ~/.pi/extensions/web, " +
					"and if launching a bundled browser: `npx playwright install chromium`. " +
					`Original error: ${(e as Error).message}`,
			);
		}
		return this.pw;
	}

	async getContext(): Promise<AnyContext> {
		if (this.ctx) return this.ctx;
		const pw = await this.loadPlaywright();

		if (config.browser.cdpUrl) {
			const browser = await pw.chromium.connectOverCDP(config.browser.cdpUrl);
			this.ctx = browser.contexts()[0] ?? (await browser.newContext());
		} else {
			const launchOpts: any = {
				headless: config.browser.headless,
				viewport: config.browser.viewport,
				userAgent: config.userAgent,
				args: ["--disable-blink-features=AutomationControlled"],
			};
			if (config.browser.channel) launchOpts.channel = config.browser.channel;
			try {
				this.ctx = await pw.chromium.launchPersistentContext(config.browser.profile, launchOpts);
			} catch (e) {
				// Fall back to bundled chromium if the channel (e.g. 'chrome') is missing.
				if (config.browser.channel && /channel|chrome/i.test((e as Error).message)) {
					const fallback = { ...launchOpts };
					delete fallback.channel;
					this.ctx = await pw.chromium.launchPersistentContext(config.browser.profile, fallback);
				} else {
					throw e;
				}
			}
		}
		return this.ctx;
	}

	async getPage(): Promise<AnyPage> {
		const ctx = await this.getContext();
		const pages = ctx.pages();
		let page = pages.find((p: any) => !p.isClosed());
		if (!page) page = await ctx.newPage();
		return page;
	}

	async goto(url: string, waitUntil: "load" | "domcontentloaded" | "networkidle" = "domcontentloaded"): Promise<AnyPage> {
		const page = await this.getPage();
		await page.goto(url, { waitUntil });
		return page;
	}

	async tabs(): Promise<{ list: { index: number; url: string; title: string }[] }> {
		const ctx = await this.getContext();
		const pages = ctx.pages();
		const list = [];
		for (let i = 0; i < pages.length; i++) {
			list.push({
				index: i,
				url: pages[i].url(),
				title: await pages[i].title().catch(() => ""),
			});
		}
		return { list };
	}

	async selectTab(index: number): Promise<AnyPage> {
		const ctx = await this.getContext();
		const pages = ctx.pages();
		if (index < 0 || index >= pages.length) throw new Error(`tab index ${index} out of range (0..${pages.length - 1})`);
		await pages[index].bringToFront().catch(() => {});
		return pages[index];
	}

	async closeTab(index: number): Promise<void> {
		const ctx = await this.getContext();
		const pages = ctx.pages();
		if (index < 0 || index >= pages.length) throw new Error(`tab index ${index} out of range`);
		await pages[index].close().catch(() => {});
	}

	async snapshot(page: AnyPage, maxChars = 4000): Promise<Snapshot> {
		const text = (await page.evaluate(() => {
			const raw = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
			return raw;
		})) as string;
		return {
			url: page.url(),
			title: await page.title().catch(() => ""),
			text: (text ?? "").length > maxChars ? (text ?? "").slice(0, maxChars) + "\n…[truncated]" : (text ?? ""),
		};
	}

	async screenshot(page: AnyPage, fullPage: boolean): Promise<Buffer> {
		return page.screenshot({ fullPage, type: "png" });
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			if (this.ctx) {
				if (config.browser.cdpUrl) await this.ctx.browser()?.close().catch(() => {});
				else await this.ctx.close().catch(() => {});
			}
		} catch {
			/* swallow */
		}
		this.ctx = null;
	}
}

export const browserManager = new BrowserManager();
