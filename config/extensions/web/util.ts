/**
 * util.ts — shared helpers: HTTP fetch, HTML→markdown, truncation.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseHtml } from "node-html-parser";
import {
	truncateHead,
	formatSize,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { config } from "./config.ts";

/** Simple fetch with timeout + browser UA. Returns {status, contentType, text}. */
export async function httpGet(
	url: string,
	opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ status: number; contentType: string; text: string; finalUrl: string }> {
	const ctrl = new AbortController();
	const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
	// Chain caller signal
	if (opts.signal) {
		if (opts.signal.aborted) ctrl.abort();
		else opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
	}
	try {
		const res = await fetch(url, {
			headers: { "User-Agent": config.userAgent, Accept: "text/html,application/xhtml+xml,*/*" },
			redirect: "follow",
			signal: ctrl.signal,
		});
		const contentType = res.headers.get("content-type") ?? "";
		const text = await res.text();
		return { status: res.status, contentType, text, finalUrl: res.url };
	} finally {
		clearTimeout(timeout);
	}
}

const SKIP = new Set([
	"script", "style", "noscript", "iframe", "svg", "canvas", "template",
	"head", "meta", "link",
]);

/** Walk a node-html-parser tree and emit markdown-ish text. */
function walk(node: any, out: string[]): void {
	if (!node) return;
	// Text node
	if (node.nodeType === 3 /* text */) {
		const t = (node.text ?? "").replace(/\s+/g, " ");
		if (t.trim()) out.push(t);
		return;
	}
	const tag = (node.tagName ?? "").toLowerCase();

	if (SKIP.has(tag)) return;

	switch (tag) {
		case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
			const level = Number(tag[1]);
			out.push("\n\n" + "#".repeat(level) + " ");
			for (const c of node.childNodes) walk(c, out);
			out.push("\n\n");
			return;
		}
		case "a": {
			const href = node.getAttribute?.("href") || "";
			const inner: string[] = [];
			for (const c of node.childNodes) walk(c, inner);
			const text = inner.join("").trim();
			if (!text) return;
			if (href && (href.startsWith("http") || href.startsWith("/")))
				out.push(`[${text}](${href})`);
			else out.push(text);
			return;
		}
		case "img": {
			const alt = node.getAttribute?.("alt") || "";
			const src = node.getAttribute?.("src") || "";
			if (alt || src) out.push(`![${alt}](${src})`);
			return;
		}
		case "br":
			out.push("\n");
			return;
		case "p":
			for (const c of node.childNodes) walk(c, out);
			out.push("\n\n");
			return;
		case "pre": {
			const code = (node.text ?? "").replace(/\n{3,}/g, "\n\n");
			out.push("\n\n```\n" + code.trim() + "\n```\n\n");
			return;
		}
		case "code": {
			const inner: string[] = [];
			for (const c of node.childNodes) walk(c, inner);
			out.push("`" + inner.join("").trim() + "`");
			return;
		}
		case "strong": case "b": {
			const inner: string[] = [];
			for (const c of node.childNodes) walk(c, inner);
			const t = inner.join("").trim();
			if (t) out.push(`**${t}**`);
			return;
		}
		case "em": case "i": {
			const inner: string[] = [];
			for (const c of node.childNodes) walk(c, inner);
			const t = inner.join("").trim();
			if (t) out.push(`_${t}_`);
			return;
		}
		case "blockquote": {
			const inner: string[] = [];
			for (const c of node.childNodes) walk(c, inner);
			const t = inner.join("").trim();
			if (t) out.push("\n> " + t.replace(/\n/g, "\n> ") + "\n\n");
			return;
		}
		case "ul": case "ol": {
			const items = node.querySelectorAll("li") ?? [];
			items.forEach((li: any, idx: number) => {
				const inner: string[] = [];
				for (const c of li.childNodes) walk(c, inner);
				const bullet = tag === "ol" ? `${idx + 1}. ` : "- ";
				out.push("\n" + bullet + inner.join("").trim());
			});
			out.push("\n\n");
			return;
		}
		case "tr": {
			const cells = node.querySelectorAll("th, td") ?? [];
			out.push("\n| " + cells.map((c: any) => (c.text ?? "").trim().replace(/\|/g, "\\|")).join(" | ") + " |");
			return;
		}
		default:
			for (const c of node.childNodes ?? []) walk(c, out);
	}
}

/** Convert an HTML string to compact markdown. */
export function htmlToMarkdown(html: string): string {
	try {
		const root = parseHtml(html);
		const out: string[] = [];
		walk(root, out);
		return out
			.join("")
			.replace(/\n{3,}/g, "\n\n")
			.replace(/[ \t]+\n/g, "\n")
			.trim();
	} catch {
		// Fallback: strip tags crudely
		return html
			.replace(/<script[\s\S]*?<\/script>/gi, "")
			.replace(/<style[\s\S]*?<\/style>/gi, "")
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}
}

export interface Truncated {
	text: string;
	truncated: boolean;
	totalBytes: number;
}

/** Truncate to fit context; write full output to a temp file when truncated. */
export function truncate(
	raw: string,
	opts: { maxBytes?: number; maxLines?: number; label?: string } = {},
): Truncated {
	const t = truncateHead(raw, {
		maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
		maxLines: opts.maxLines ?? DEFAULT_MAX_LINES,
	});
	if (!t.truncated) return { text: t.content, truncated: false, totalBytes: t.totalBytes };
	const file = join(tmpdir(), `pi-web-${Date.now()}.txt`);
	writeFileSync(file, raw);
	const note =
		`\n\n[Truncated ${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}. ` +
		`Full output saved to: ${file}]`;
	return { text: t.content + note, truncated: true, totalBytes: t.totalBytes };
}
