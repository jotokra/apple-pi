/**
 * snapshot.ts — label interactive elements with stable refs so the
 * agent can click/type/check by number instead of fragile CSS.
 *
 * Mirrors the proven playwright-mcp / computer-use pattern:
 *   1. inject data-pi-ref="N" onto every visible interactive element
 *   2. return an inventory (ref, tag, role, label, text, value, ...)
 * Refs are valid until the DOM changes (navigation re-labels on demand).
 *
 * NOTE: page.evaluate is given REAL function references (not strings)
 * so closures and escaping are unambiguous.
 */

export interface ElementInfo {
	ref: string;
	tag: string;
	role?: string | null;
	type?: string | null;
	name?: string | null;
	text: string;
	href?: string | null;
	checked?: boolean | null;
	value?: string | null;
	options?: string[];
}

/** Runs in the page. Idempotent per-navigation (window flag resets on nav).
 *  Selector is inlined because page.evaluate serializes only the
 *  function body, not its lexical closure. */
function labelInPage(): number {
	const w = window as any;
	if (w.__piLabeled) return w.__piCount || 0;
	const SEL =
		'a[href], button, input, textarea, select, ' +
		'[role="button"], [role="link"], [role="checkbox"], [role="radio"], ' +
		'[role="combobox"], [role="tab"], [role="menuitem"], [role="option"], ' +
		'[contenteditable=""], [contenteditable="true"], summary';
	const els = Array.from(document.querySelectorAll(SEL));
	let i = 1;
	for (const el of els) {
		const r = (el as HTMLElement).getBoundingClientRect();
		const style = window.getComputedStyle(el);
		if (
			r.width === 0 ||
			r.height === 0 ||
			style.visibility === "hidden" ||
			style.display === "none" ||
			el.getAttribute("aria-hidden") === "true"
		)
			continue;
		el.setAttribute("data-pi-ref", String(i));
		i++;
	}
	w.__piLabeled = true;
	w.__piCount = i - 1;
	return w.__piCount;
}

/** Runs in the page. Collects metadata for every labeled element. */
function inventoryInPage(): any[] {
	const norm = (s: unknown) => (s == null ? "" : String(s).trim());
	return Array.from(document.querySelectorAll("[data-pi-ref]")).map((el) => {
		const html = el as HTMLElement;
		const tag = html.tagName.toLowerCase();
		const anyEl = el as any;
		const info: any = {
			ref: html.getAttribute("data-pi-ref"),
			tag,
			role: html.getAttribute("role"),
			type: html.getAttribute("type"),
			name:
				html.getAttribute("aria-label") ||
				html.getAttribute("title") ||
				html.getAttribute("name") ||
				html.getAttribute("placeholder"),
			text: norm(html.innerText || html.textContent || anyEl.value || ""),
			href: tag === "a" ? html.getAttribute("href") : null,
			checked:
				tag === "input" && (anyEl.type === "checkbox" || anyEl.type === "radio")
					? !!anyEl.checked
					: null,
			value: tag === "input" || tag === "textarea" || tag === "select" ? anyEl.value : null,
			options: null,
		};
		if (tag === "select") {
			info.options = Array.from(anyEl.options).map((o: any) => o.value + "::" + norm(o.text));
		}
		if (info.text.length > 80) info.text = info.text.slice(0, 77) + "...";
		return info;
	});
}

export async function labelPage(page: any): Promise<number> {
	return page.evaluate(labelInPage);
}

export async function inventory(page: any): Promise<ElementInfo[]> {
	await labelPage(page);
	return (await page.evaluate(inventoryInPage)) as ElementInfo[];
}

/** Compact, line-per-element text for the LLM. */
export function formatInventory(items: ElementInfo[]): string {
	if (!items.length) return "(no interactive elements found)";
	const lines: string[] = [];
	for (const it of items) {
		const parts: string[] = [`[${it.ref}]`];
		parts.push(`<${it.tag}${it.role ? ":" + it.role : ""}${it.type ? ":" + it.type : ""}>`);
		const label = it.name || it.text || it.href || "";
		if (label) parts.push(JSON.stringify(label).slice(0, 90));
		if (it.value) parts.push(`value=${JSON.stringify(it.value).slice(0, 60)}`);
		if (it.checked !== null) parts.push(it.checked ? "✓checked" : "☐unchecked");
		if (it.options) parts.push("options=" + it.options.slice(0, 12).join(" | "));
		lines.push(parts.join(" "));
	}
	return lines.join("\n");
}

export function refSelector(ref: string | number): string {
	return `[data-pi-ref="${ref}"]`;
}
