/**
 * search.ts — provider-agnostic web search.
 *
 * Providers:
 *   ddg    — DuckDuckGo HTML (free, no key). Default.
 *   tavily — POST api.tavily.com (needs TAVILY_API_KEY)
 *   brave  — GET api.search.brave.com (needs BRAVE_API_KEY)
 */
import { config } from "./config.ts";
import { httpGet } from "./util.ts";

export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResult {
	provider: string;
	hits: SearchHit[];
}

function decodeDdgHref(href: string): string {
	// DDG wraps links as //duckduckgo.com/l/?uddg=<encoded>
	try {
		const u = new URL(href.startsWith("http") ? href : "https:" + href);
		const uddg = u.searchParams.get("uddg");
		return uddg ? decodeURIComponent(uddg) : href;
	} catch {
		return href;
	}
}

async function searchDdg(query: string, max: number): Promise<SearchHit[]> {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const { text } = await httpGet(url);
	// Each result block: <div class="result ..."> ... <a class="result__a" href=...>TITLE</a>
	// ... <a class="result__snippet" ...>SNIPPET</a>
	const hits: SearchHit[] = [];
	const blockRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
	const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
	const titles: Array<{ url: string; title: string }> = [];
	let m: RegExpExecArray | null;
	while ((m = blockRe.exec(text)) && titles.length < max) {
		titles.push({
			url: decodeDdgHref(m[1]),
			title: m[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim(),
		});
	}
	// Re-run snippetRe across the whole doc and pair by order
	const snippets: string[] = [];
	while ((m = snippetRe.exec(text)) && snippets.length < titles.length) {
		snippets.push(m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim());
	}
	for (let i = 0; i < titles.length; i++) {
		hits.push({ ...titles[i], snippet: snippets[i] ?? "" });
	}
	return hits;
}

async function searchTavily(query: string, max: number): Promise<SearchHit[]> {
	if (!config.tavilyKey) throw new Error("TAVILY_API_KEY not set");
	const res = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ api_key: config.tavilyKey, query, max_results: max }),
	});
	if (!res.ok) throw new Error(`tavily ${res.status}: ${await res.text()}`);
	const data: any = await res.json();
	return (data.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
}

async function searchBrave(query: string, max: number): Promise<SearchHit[]> {
	if (!config.braveKey) throw new Error("BRAVE_API_KEY not set");
	const u = new URL("https://api.search.brave.com/res/v1/web/search");
	u.searchParams.set("q", query);
	u.searchParams.set("count", String(max));
	const res = await fetch(u, { headers: { "X-Subscription-Token": config.braveKey, Accept: "application/json" } });
	if (!res.ok) throw new Error(`brave ${res.status}: ${await res.text()}`);
	const data: any = await res.json();
	return (data.web?.results ?? []).map((r: any) => ({
		title: r.title,
		url: r.url,
		snippet: (r.description ?? "").replace(/<[^>]+>/g, ""),
	}));
}

export async function webSearch(query: string, max = 8): Promise<SearchResult> {
	const provider = config.searchProvider;
	let hits: SearchHit[];
	switch (provider) {
		case "tavily": hits = await searchTavily(query, max); break;
		case "brave": hits = await searchBrave(query, max); break;
		case "ddg":
		default: hits = await searchDdg(query, max); break;
	}
	return { provider, hits };
}

/** Format hits as compact text for the LLM. */
export function formatHits(r: SearchResult): string {
	if (!r.hits.length) return `No results (${r.provider}).`;
	return r.hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? "\n   " + h.snippet : ""}`).join("\n\n");
}
