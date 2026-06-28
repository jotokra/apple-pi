// ingress/lib/poller.js — pure-ish poller core (REQ-B-1).
//
// runPoller(spec) fetches a source, computes new items vs the last run's stored
// state, returns { items, error? }. Each item: { id, title, url, summary }.
//
// Supported source kinds (Phase B-1):
//   rss      — RSS 2.0 / Atom feed → items are entries (guid/link = id)
//   json     — a JSON URL; --jp picks an array via a tiny JSONPath (a.b.c)
//   webdiff  — a URL; "items" = whether the body hash changed (0 or 1 item)
//
// State (what's been seen) lives in the SQLite store (state.js) keyed by
// poller name + item id. This module takes a `store` object with get/set/seen
// so it's unit-testable with an in-memory fake.
//
// Security: this module only FETCHES. It does not inject anything (see inject.js)
// and does not parse the content as instructions. Item text is passed through
// verbatim to the caller (inject.js wraps + strips it). No eval, no shell.

"use strict";

const https = require("node:https");
const http = require("node:http");

// fetchText(url) → {status, contentType, text, finalUrl} (30s timeout, redirects)
function fetchText(url, opts = {}) {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const lib = u.protocol === "https:" ? https : http;
		const req = lib.get(url, { headers: { "User-Agent": opts.userAgent || "apple-pi-ingress/0.1 (+https://github.com/jotokra/apple-pi)" }, timeout: 30000 }, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				// follow one redirect (sufficient for feeds)
				return resolve(fetchText(new URL(res.headers.location, url).toString(), opts));
			}
			let data = "";
			res.on("data", (c) => (data += c));
			res.on("end", () => resolve({ status: res.statusCode, contentType: res.headers["content-type"] || "", text: data, finalUrl: url }));
		});
		req.on("error", reject);
		req.on("timeout", () => { req.destroy(new Error(`fetch timeout: ${url}`)); });
	});
}

// ── RSS/Atom parsing (regex-based, no dep; tolerant of messy feeds) ─────────
function parseRss(xml) {
	const items = [];
	// RSS 2.0: <item>...<title>..</title><link>..</link><guid>..</guid><description>..</description></item>
	const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
	const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi; // Atom
	const grab = (block, tag) => {
		const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(block);
		return m ? m[1].trim() : "";
	};
	const grabLink = (block) => {
		// RSS <link>text</link>; Atom <link href="..."/>
		const rss = grab(block, "link");
		if (rss) return rss;
		const m = /<link\b[^>]*\bhref=["']([^"']+)["']/i.exec(block);
		return m ? m[1] : "";
	};
	const blocks = [];
	let m;
	while ((m = itemRe.exec(xml))) blocks.push(m[1]);
	while ((m = entryRe.exec(xml))) blocks.push(m[1]);
	for (const b of blocks) {
		const title = stripTags(grab(b, "title")) || "(untitled)";
		const link = stripTags(grabLink(b));
		const id = stripTags(grab(b, "guid")) || link || title;
		const summary = stripTags(grab(b, "description") || grab(b, "summary") || "").slice(0, 300);
		items.push({ id, title, url: link, summary });
	}
	return items;
}

function stripTags(s) {
	return (s || "")
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")   // unwrap CDATA
		.replace(/<[^>]+>/g, " ")                        // drop tags
		.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&apos;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

// ── JSON: pick an array via a dotted path (a.b.c → obj.a.b.c; * = first array) ─
function pickJsonPath(obj, jp) {
	if (!jp) return Array.isArray(obj) ? obj : [];
	let cur = obj;
	for (const part of jp.split(".")) {
		if (cur == null) return [];
		if (part === "*") {
			// find the first array under cur
			if (Array.isArray(cur)) { cur = cur; break; }
			const arrKey = Object.keys(cur).find((k) => Array.isArray(cur[k]));
			cur = arrKey ? cur[arrKey] : [];
			break;
		}
		cur = cur[part];
	}
	return Array.isArray(cur) ? cur : [];
}

// ── main entry ──────────────────────────────────────────────────────────────
async function runPoller(spec, store, _fetchText) {
	// _fetchText is an optional override (for tests); defaults to the module's fetchText.
	const fetch = _fetchText || fetchText;
	if (!spec || !spec.name || !spec.kind || !spec.url) {
		return { items: [], error: "spec needs name, kind, url" };
	}
	try {
		const r = await fetch(spec.url, { userAgent: spec.userAgent });
		if (r.status >= 400) return { items: [], error: `HTTP ${r.status}` };
		let rawItems;
		if (spec.kind === "rss") rawItems = parseRss(r.text);
		else if (spec.kind === "json") {
			const data = JSON.parse(r.text);
			const arr = pickJsonPath(data, spec.jsonpath);
			rawItems = arr.map((x) => ({
				id: String(x.id || x.guid || x.url || JSON.stringify(x).slice(0, 64)),
				title: String(x.title || x.name || "(item)"),
				url: String(x.url || x.link || ""),
				summary: String(x.summary || x.description || x.text || "").slice(0, 300),
			}));
		} else if (spec.kind === "webdiff") {
			const hash = require("node:crypto").createHash("sha256").update(r.text).digest("hex").slice(0, 16);
			const changed = store.getSeen(spec.name) !== hash;
			if (changed) {
				store.setSeen(spec.name, hash);
				return { items: [{ id: hash, title: `${spec.name} changed`, url: spec.url, summary: "" }] };
			}
			return { items: [] };
		} else {
			return { items: [], error: `unknown kind: ${spec.kind}` };
		}

		// diff vs state: keep only items whose id we haven't seen
		const newItems = rawItems.filter((it) => !store.hasSeen(spec.name, it.id));
		// record the new ids as seen (so the next run dedupes them)
		for (const it of newItems) store.markSeen(spec.name, it.id);
		return { items: newItems };
	} catch (e) {
		return { items: [], error: e.message };
	}
}

module.exports = { runPoller, fetchText, parseRss, pickJsonPath, stripTags };
