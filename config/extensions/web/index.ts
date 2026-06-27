/**
 * index.ts — apple-pi web extension entry point.
 *
 * Registers:
 *   web_search        — provider-agnostic web search (DuckDuckGo default)
 *   web_fetch         — fetch URL → markdown (optionally JS-rendered)
 *   browser_*         — drive the user's real, persistent, headed Chrome:
 *                       navigate, snapshot (refs), click, type, checkbox,
 *                       select, press, hover, wait, screenshot, eval, tabs.
 *
 * All config is env-driven (see config.ts). No secrets in this repo.
 * The browser is headed by default so the user can watch every action.
 */
import { Type, StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "./config.ts";
import { webSearch, formatHits } from "./search.ts";
import { webFetch } from "./fetch.ts";
import { browserManager } from "./browser.ts";
import { inventory, formatInventory, refSelector } from "./snapshot.ts";

const BROWSER_GUIDELINES = [
	"Use browser_snapshot before browser_click/type/set_checkbox/select_option — it returns labeled element refs like [12] you pass back as the `ref` arg. Re-snapshot after navigation or DOM changes.",
	"Browser actions run in the user's real, headed browser session (logins persist). Confirm with the user before submitting payments, deleting data, or any irreversible action. Prefer visible, low-risk steps.",
	"If browser_snapshot shows no useful refs for a visual layout task, call browser_screenshot to actually see the page.",
];

// ── web_search ──────────────────────────────────────────────────────────
const webSearchTool = defineTool({
	name: "web_search",
	label: "Web Search",
	description:
		`Search the public web and return ranked results (title, url, snippet). ` +
		`Provider: ${config.searchProvider} (set PI_WEB_SEARCH_PROVIDER=tavily|brave and the matching *_API_KEY for key providers). ` +
		`Use this for current information you don't already have.`,
	promptSnippet: "Search the public web for current information",
	parameters: Type.Object({
		query: Type.String({ description: "Search query" }),
		max_results: Type.Optional(Type.Number({ description: "Max results (default 8)" })),
	}),
	async execute(_id, params, signal) {
		const r = await webSearch(params.query, params.max_results ?? 8).catch((e) => {
			throw new Error(`web_search failed: ${(e as Error).message}`);
		});
		if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
		return {
			content: [{ type: "text", text: `[${r.provider}]\n` + formatHits(r) }],
			details: { provider: r.provider, count: r.hits.length },
		};
	},
});

// ── web_fetch ───────────────────────────────────────────────────────────
const webFetchTool = defineTool({
	name: "web_fetch",
	label: "Web Fetch",
	description:
		"Fetch a single URL and return its content as cleaned markdown (headings, links with hrefs, lists, code preserved). " +
		"Use render=true for JavaScript-heavy/SPA pages (loads via the browser). " +
		"Output is truncated to fit; the full text is saved to a temp file path noted at the end.",
	promptSnippet: "Fetch and read a web page as markdown",
	parameters: Type.Object({
		url: Type.String({ description: "Absolute URL to fetch" }),
		render: Type.Optional(Type.Boolean({ description: "Render via browser for JS/SPA pages (default false)" })),
		max_bytes: Type.Optional(Type.Number({ description: "Soft cap on returned bytes (default ~50KB)" })),
	}),
	async execute(_id, params, signal) {
		const r = await webFetch(params.url, { render: params.render, maxBytes: params.max_bytes }).catch((e) => {
			throw new Error(`web_fetch failed: ${(e as Error).message}`);
		});
		if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
		return {
			content: [{ type: "text", text: r.text }],
			details: { url: r.url, rendered: r.rendered, truncated: r.truncated },
		};
	},
});

// ── browser_navigate ────────────────────────────────────────────────────
const browserNavigateTool = defineTool({
	name: "browser_navigate",
	label: "Browser Navigate",
	description: "Open a URL in the user's persistent headed browser and wait. Returns page url + title + trimmed text. Always follow with browser_snapshot to get element refs.",
	promptSnippet: "Open a URL in the headed browser",
	promptGuidelines: BROWSER_GUIDELINES,
	parameters: Type.Object({
		url: Type.String({ description: "Absolute URL" }),
		wait_until: Type.Optional(StringEnum(["load", "domcontentloaded", "networkidle"])),
	}),
	async execute(_id, params, signal) {
		const page = await browserManager.goto(params.url, params.wait_until ?? "domcontentloaded");
		if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
		const snap = await browserManager.snapshot(page);
		return {
			content: [{ type: "text", text: `Navigated to: ${snap.url}\nTitle: ${snap.title}\n\n${snap.text}` }],
			details: { url: snap.url, title: snap.title },
		};
	},
});

// ── browser_snapshot ────────────────────────────────────────────────────
const browserSnapshotTool = defineTool({
	name: "browser_snapshot",
	label: "Browser Snapshot",
	description:
		"Label every visible interactive element on the current page with a stable ref ([N]) and return the inventory: ref, tag/role, label/text, value, checked state, select options. " +
		"Pass these refs to browser_click/type/set_checkbox/select_option/hover. Also returns url, title, and trimmed visible text.",
	promptSnippet: "List interactive elements with refs for clicking/typing",
	promptGuidelines: BROWSER_GUIDELINES,
	parameters: Type.Object({
		screenshot: Type.Optional(Type.Boolean({ description: "Also return a screenshot (default false)" })),
	}),
	async execute(_id, params, signal) {
		const page = await browserManager.getPage();
		const snap = await browserManager.snapshot(page);
		const items = await inventory(page);
		if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
		const blocks = [
			`URL: ${snap.url}`,
			`Title: ${snap.title}`,
			"",
			"Interactive elements:",
			formatInventory(items),
			"",
			"Visible text:",
			snap.text,
		];
		const content: any[] = [{ type: "text", text: blocks.join("\n") }];
		if (params.screenshot) {
			const png = await browserManager.screenshot(page, false);
			content.push({ type: "image", source: { type: "base64", mediaType: "image/png", data: png.toString("base64") } });
		}
		return { content, details: { url: snap.url, elementCount: items.length } };
	},
});

// helper used by ref-based tools
async function locatorFor(ref: string | number) {
	const page = await browserManager.getPage();
	const loc = page.locator(refSelector(ref)).first();
	await loc.waitFor({ state: "attached", timeout: 5000 }).catch(() => {});
	const count = await loc.count();
	if (count === 0) throw new Error(`No element with ref [${ref}]. Call browser_snapshot to refresh refs.`);
	return { page, loc };
}

// ── browser_click ───────────────────────────────────────────────────────
const browserClickTool = defineTool({
	name: "browser_click",
	label: "Browser Click",
	description: "Click the element with the given ref (from browser_snapshot).",
	promptGuidelines: BROWSER_GUIDELINES,
	parameters: Type.Object({ ref: Type.String({ description: "Element ref, e.g. '12'" }) }),
	async execute(_id, params, signal) {
		const { loc } = await locatorFor(params.ref);
		await loc.click();
		if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled (click may have fired)" }] };
		return { content: [{ type: "text", text: `Clicked [${params.ref}]` }], details: {} };
	},
});

// ── browser_type ────────────────────────────────────────────────────────
const browserTypeTool = defineTool({
	name: "browser_type",
	label: "Browser Type",
	description: "Type text into the input/textarea/contenteditable element with the given ref. append=true to keep existing text; otherwise the field is cleared first.",
	promptGuidelines: BROWSER_GUIDELINES,
	parameters: Type.Object({
		ref: Type.String(),
		text: Type.String({ description: "Text to type" }),
		append: Type.Optional(Type.Boolean({ description: "Append instead of clearing (default false)" })),
		submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing (default false)" })),
	}),
	async execute(_id, params, signal) {
		const { loc } = await locatorFor(params.ref);
		if (params.append) await loc.press("End").catch(() => {});
		else await loc.fill("");
		await loc.type(params.text, { delay: 5 });
		if (params.submit) await loc.press("Enter");
		if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
		return { content: [{ type: "text", text: `Typed ${JSON.stringify(params.text)} into [${params.ref}]${params.submit ? " + Enter" : ""}` }], details: {} };
	},
});

// ── browser_set_checkbox ────────────────────────────────────────────────
const browserCheckboxTool = defineTool({
	name: "browser_set_checkbox",
	label: "Browser Set Checkbox",
	description: "Check or uncheck the checkbox/radio with the given ref. Set checked=true to check, false to uncheck.",
	promptGuidelines: BROWSER_GUIDELINES,
	parameters: Type.Object({
		ref: Type.String(),
		checked: Type.Boolean({ description: "true = check, false = uncheck" }),
	}),
	async execute(_id, params, signal) {
		const { loc } = await locatorFor(params.ref);
		if (params.checked) await loc.check();
		else await loc.uncheck();
		if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
		return { content: [{ type: "text", text: `[${params.ref}] ${params.checked ? "checked" : "unchecked"}` }], details: {} };
	},
});

// ── browser_select_option ───────────────────────────────────────────────
const browserSelectTool = defineTool({
	name: "browser_select_option",
	label: "Browser Select Option",
	description: "Choose an <option> in the <select> element with the given ref. Match by value or visible label (label is case-insensitive substring).",
	promptGuidelines: BROWSER_GUIDELINES,
	parameters: Type.Object({
		ref: Type.String(),
		value: Type.Optional(Type.String({ description: "Option value to select" })),
		label: Type.Optional(Type.String({ description: "Option visible label to select (used if value omitted)" })),
	}),
	async execute(_id, params, signal) {
		const { loc } = await locatorFor(params.ref);
		const target = params.value ?? params.label;
		if (!target) throw new Error("Provide value or label");
		await loc.selectOption(params.value ? { value: params.value } : { label: params.label });
		if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
		return { content: [{ type: "text", text: `Selected ${JSON.stringify(target)} in [${params.ref}]` }], details: {} };
	},
});

// ── browser_press_key ───────────────────────────────────────────────────
const browserPressTool = defineTool({
	name: "browser_press_key",
	label: "Browser Press Key",
	description: "Press a key on the focused element (or body). Examples: 'Enter', 'Tab', 'Escape', 'ArrowDown', 'Control+a'.",
	promptGuidelines: BROWSER_GUIDELINES,
	parameters: Type.Object({
		key: Type.String({ description: "Playwright key name, e.g. Enter, Tab, Escape" }),
		ref: Type.Optional(Type.String({ description: "Ref to focus first (default: focused element)" })),
	}),
	async execute(_id, params, signal) {
		const page = await browserManager.getPage();
		if (params.ref) {
			const { loc } = await locatorFor(params.ref);
			await loc.focus();
			await loc.press(params.key);
		} else {
			await page.keyboard.press(params.key);
		}
		if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
		return { content: [{ type: "text", text: `Pressed ${params.key}` }], details: {} };
	},
});

// ── browser_hover ───────────────────────────────────────────────────────
const browserHoverTool = defineTool({
	name: "browser_hover",
	label: "Browser Hover",
	description: "Hover the element with the given ref (useful for menus/tooltips).",
	promptGuidelines: BROWSER_GUIDELINES,
	parameters: Type.Object({ ref: Type.String() }),
	async execute(_id, params, signal) {
		const { loc } = await locatorFor(params.ref);
		await loc.hover();
		if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
		return { content: [{ type: "text", text: `Hovered [${params.ref}]` }], details: {} };
	},
});

// ── browser_wait ────────────────────────────────────────────────────────
const browserWaitTool = defineTool({
	name: "browser_wait",
	label: "Browser Wait",
	description: "Wait for a condition on the current page: a text to appear, a CSS selector, or just a timeout. Returns whether the condition was met.",
	promptGuidelines: BROWSER_GUIDELINES,
	parameters: Type.Object({
		text: Type.Optional(Type.String({ description: "Wait until this text appears in the body" })),
		selector: Type.Optional(Type.String({ description: "Wait until this CSS selector matches" })),
		timeout_ms: Type.Optional(Type.Number({ description: "Timeout in ms (default 10000)" })),
	}),
	async execute(_id, params, signal) {
		const page = await browserManager.getPage();
		const timeout = params.timeout_ms ?? 10_000;
		let met = true;
		try {
			if (params.text) {
				await page.waitForFunction((t: string) => (document.body?.innerText || "").includes(t), params.text, { timeout });
			} else if (params.selector) {
				await page.waitForSelector(params.selector, { timeout });
			} else {
				await page.waitForTimeout(Math.min(timeout, 30000));
			}
		} catch {
			met = false;
		}
		if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
		return { content: [{ type: "text", text: met ? "Condition met" : "Timed out" }], details: { met } };
	},
});

// ── browser_screenshot ──────────────────────────────────────────────────
const browserScreenshotTool = defineTool({
	name: "browser_screenshot",
	label: "Browser Screenshot",
	description: "Take a PNG screenshot of the current page and return it as an image you can see. Use full_page=true for the whole scrollable page (default: viewport only).",
	promptSnippet: "See the current browser page as an image",
	promptGuidelines: BROWSER_GUIDELINES,
	parameters: Type.Object({
		full_page: Type.Optional(Type.Boolean({ description: "Capture full scrollable page (default false)" })),
	}),
	async execute(_id, params, signal) {
		const page = await browserManager.getPage();
		const png = await browserManager.screenshot(page, params.full_page ?? false);
		if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
		return {
			content: [
				{ type: "text", text: `Screenshot of ${page.url()} (${params.full_page ? "full page" : "viewport"})` },
				{ type: "image", source: { type: "base64", mediaType: "image/png", data: png.toString("base64") } },
			],
			details: { url: page.url() },
		};
	},
});

// ── browser_eval ────────────────────────────────────────────────────────
const browserEvalTool = defineTool({
	name: "browser_eval",
	label: "Browser Eval",
	description:
		"Run arbitrary JavaScript in the current page and return JSON.stringify'd result. POWERFUL: runs in the user's real session (can read cookies, call page APIs). " +
		"Use only for scraping/automation that refs can't cover, and never to bypass the user's consent for an action.",
	promptGuidelines: BROWSER_GUIDELINES,
	parameters: Type.Object({
		script: Type.String({ description: "JavaScript to evaluate. Return a JSON-serializable value." }),
	}),
	async execute(_id, params, signal) {
		const page = await browserManager.getPage();
		const result = await page.evaluate(params.script);
		if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
		let text: string;
		try {
			text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
		} catch {
			text = String(result);
		}
		if (text.length > 50000) text = text.slice(0, 50000) + "\n…[truncated]";
		return { content: [{ type: "text", text }], details: {} };
	},
});

// ── browser_tabs ────────────────────────────────────────────────────────
const browserTabsTool = defineTool({
	name: "browser_tabs",
	label: "Browser Tabs",
	description: "List browser tabs, switch to one (select), or close one. Omit action to list.",
	promptGuidelines: BROWSER_GUIDELINES,
	parameters: Type.Object({
		action: Type.Optional(StringEnum(["list", "select", "close"])),
		index: Type.Optional(Type.Number({ description: "Tab index for select/close" })),
	}),
	async execute(_id, params, signal) {
		const action = params.action ?? "list";
		if (action === "list") {
			const { list } = await browserManager.tabs();
			if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
			return {
				content: [{ type: "text", text: list.map((t) => `[${t.index}] ${t.title}\n    ${t.url}`).join("\n") || "(no tabs)" }],
				details: { count: list.length },
			};
		}
		if (params.index === undefined) throw new Error("index required for select/close");
		if (action === "select") {
			const page = await browserManager.selectTab(params.index);
			const snap = await browserManager.snapshot(page);
			return { content: [{ type: "text", text: `Switched to tab ${params.index}: ${snap.title}\n${snap.url}` }], details: {} };
		}
		await browserManager.closeTab(params.index);
		return { content: [{ type: "text", text: `Closed tab ${params.index}` }], details: {} };
	},
});

// ── browser_close ───────────────────────────────────────────────────────
const browserCloseTool = defineTool({
	name: "browser_close",
	label: "Browser Close",
	description: "Close the browser (and save the persistent profile). Use when done to free resources.",
	parameters: Type.Object({}),
	async execute() {
		await browserManager.close();
		return { content: [{ type: "text", text: "Browser closed." }], details: {} };
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(webSearchTool);
	pi.registerTool(webFetchTool);
	pi.registerTool(browserNavigateTool);
	pi.registerTool(browserSnapshotTool);
	pi.registerTool(browserClickTool);
	pi.registerTool(browserTypeTool);
	pi.registerTool(browserCheckboxTool);
	pi.registerTool(browserSelectTool);
	pi.registerTool(browserPressTool);
	pi.registerTool(browserHoverTool);
	pi.registerTool(browserWaitTool);
	pi.registerTool(browserScreenshotTool);
	pi.registerTool(browserEvalTool);
	pi.registerTool(browserTabsTool);
	pi.registerTool(browserCloseTool);

	pi.on("session_shutdown", async () => {
		await browserManager.close();
	});
}
