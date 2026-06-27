// Standalone smoke for the web extension's logic + browser path.
// Bypasses index.ts (whose pi-ai schema types already load under pi) and
// exercises the real network + Playwright code.
//
// Run after `npm install` in this directory:
//   node test/smoke.mjs
//
// Env:
//   PI_SMOKE_NO_NET=1     skip web_search/web_fetch (offline CI)
//   PI_SMOKE_NO_BROWSER=1 skip the browser round-trip (no display / no browsers)
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// --- locate pi's node_modules so jiti + pi packages resolve -----------------
function findPiNodeModules() {
	const candidates = [
		process.env.PI_NODE_MODULES,
		"/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules",
		"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules",
	];
	for (const c of candidates) if (c) return c;
	return undefined;
}
const PI_NM = findPiNodeModules();
if (!PI_NM) {
	console.error("Could not locate pi's node_modules. Set PI_NODE_MODULES=<pi>/node_modules");
	process.exit(2);
}
// jiti ships bundled with pi; import it via its file path (bare "jiti" won't
// resolve from this checkout).
const { createJiti } = await import(pathToFileURL(join(PI_NM, "jiti", "lib", "jiti.mjs")).href);

// Minimal stub for the few helpers util.ts imports from pi-coding-agent, so
// the smoke runs without the full package resolved (pi itself already proves
// those load under the real agent). Mirrors the real semantics closely enough.
const stubUrl = fileURLToPath(new URL("./_stub.mjs", import.meta.url));

const jiti = createJiti(import.meta.url, {
	moduleDirectories: ["node_modules", PI_NM].filter(Boolean),
	alias: { "@earendil-works/pi-coding-agent": stubUrl },
	interopDefault: true,
});

const { webSearch, formatHits } = await jiti.import("../search.ts");
const { webFetch } = await jiti.import("../fetch.ts");
const { browserManager } = await jiti.import("../browser.ts");
const { inventory, formatInventory } = await jiti.import("../snapshot.ts");

let pass = 0,
	fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
	}
};

// 1) web_search ----------------------------------------------------------------
if (process.env.PI_SMOKE_NO_NET) {
	console.log("— web_search: skipped (PI_SMOKE_NO_NET)");
} else {
	console.log("— web_search: 'node.js event loop'");
	const r = await webSearch("node.js event loop explained", 3);
	check("returns a provider", !!r.provider, `got ${r.provider}`);
	check("returns >=1 hit", r.hits.length >= 1, `got ${r.hits.length}`);
	check("hits have url+title", r.hits.every((h) => h.url && h.title));
}

// 2) web_fetch -----------------------------------------------------------------
if (process.env.PI_SMOKE_NO_NET) {
	console.log("— web_fetch: skipped (PI_SMOKE_NO_NET)");
} else {
	console.log("— web_fetch: https://example.com");
	const f = await webFetch("https://example.com");
	check("returns final url", /^http/.test(f.url));
	check("not rendered (plain GET)", f.rendered === false);
	check("body mentions Example", /Example Domain/i.test(f.text), f.text.slice(0, 80));
}

// 3) browser round-trip (headless bundled chromium) ---------------------------
if (process.env.PI_SMOKE_NO_BROWSER) {
	console.log("— browser: skipped (PI_SMOKE_NO_BROWSER)");
} else {
	console.log("— browser: navigate + snapshot + screenshot (headless)");
	process.env.PI_BROWSER_HEADLESS = "1";
	process.env.PI_BROWSER_CHANNEL = ""; // bundled chromium
	try {
		const page = await browserManager.goto("https://example.com", "domcontentloaded");
		const snap = await browserManager.snapshot(page);
		check("navigated + titled", /example/i.test(snap.title || ""), snap.title);
		const items = await inventory(page);
		check("snapshot labeled >=1 element", items.length >= 1, `${items.length} elements`);
		console.log("    " + formatInventory(items).slice(0, 200).replace(/\n/g, "\n    "));
		const png = await browserManager.screenshot(page, false);
		const out = join(tmpdir(), "pi-web-smoke.png");
		writeFileSync(out, png);
		check("screenshot is a non-trivial PNG", png.length > 1000, `${png.length} bytes → ${out}`);
		await browserManager.close();
	} catch (e) {
		check("browser round-trip", false, e.message.slice(0, 120));
		check(
			"hint",
			false,
			"install browsers: npx playwright install chromium  (from this directory)",
		);
	}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
