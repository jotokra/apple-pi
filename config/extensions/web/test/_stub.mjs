// Local stub for @earendil-works/pi-coding-agent, used only by test/smoke.mjs.
// Provides the truncation helpers util.ts imports, with semantics close enough
// to the real ones for the smoke to exercise the network + browser paths
// without resolving the full pi package. The real agent loads the real package.
export function truncateHead(raw, opts = {}) {
	const maxBytes = opts.maxBytes ?? 50_000;
	const maxLines = opts.maxLines ?? 2000;
	const encoder = new TextEncoder();
	let bytes = 0;
	const lines = [];
	for (const line of raw.split("\n")) {
		const b = encoder.encode(line).length + 1;
		if (bytes + b > maxBytes || lines.length >= maxLines) {
			return { content: lines.join("\n"), truncated: true, totalBytes: encoder.encode(raw).length, outputBytes: bytes };
		}
		bytes += b;
		lines.push(line);
	}
	return { content: raw, truncated: false, totalBytes: encoder.encode(raw).length, outputBytes: bytes };
}
export function formatSize(n) {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
export const DEFAULT_MAX_BYTES = 50_000;
export const DEFAULT_MAX_LINES = 2000;
