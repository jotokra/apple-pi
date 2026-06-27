/**
 * fetch.ts — web_fetch tool implementation.
 *
 * Default: HTTP GET → markdown (fast, no browser).
 * render:true: use the browser to load JS-heavy pages, then extract text.
 */
import { httpGet, htmlToMarkdown, truncate } from "./util.ts";
import { browserManager } from "./browser.ts";

export interface FetchOptions {
	render?: boolean;
	maxBytes?: number;
	timeoutMs?: number;
}

export async function webFetch(url: string, opts: FetchOptions = {}): Promise<{ text: string; truncated: boolean; url: string; rendered: boolean }> {
	if (opts.render) {
		const page = await browserManager.goto(url, "networkidle");
		const snap = await browserManager.snapshot(page, Number.MAX_SAFE_INTEGER);
		const body = `# ${snap.title}\nURL: ${snap.url}\n\n${snap.text}`;
		const t = truncate(body, { maxBytes: opts.maxBytes });
		return { text: t.text, truncated: t.truncated, url: snap.url, rendered: true };
	}

	const { status, contentType, text, finalUrl } = await httpGet(url, { timeoutMs: opts.timeoutMs });
	if (status >= 400) {
		const t = truncate(text, { maxBytes: opts.maxBytes, label: "body" });
		return { text: `HTTP ${status} ${finalUrl}\n\n${t.text}`, truncated: t.truncated, url: finalUrl, rendered: false };
	}

	let body: string;
	if (/html/i.test(contentType) || /^\s*<(?:!doctype|html)/i.test(text)) {
		body = htmlToMarkdown(text);
	} else {
		body = text;
	}
	const header = `URL: ${finalUrl}\n\n`;
	const t = truncate(header + body, { maxBytes: opts.maxBytes });
	return { text: t.text, truncated: t.truncated, url: finalUrl, rendered: false };
}
