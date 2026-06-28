// mcp-bridge/lib/openapi-server.js — a transient MCP server generated from an
// OpenAPI spec (REQ-A-7). Speaks the same JSON-RPC/stdio contract as any MCP
// server, so the existing mcp-bridge loads it with zero special-casing.
//
// Given an OpenAPI/Spec spec (URL or file path), it exposes each operation that
// has an operationId as a tool: `mcp__<name>__<operationId>`. Calling the tool
// runs the HTTP request (method + path, with params → query/path/body) and
// returns the response body as text content.
//
//   Usage as an MCP server:
//     node openapi-server.js <spec-url-or-path> [--base-url URL] [--header NAME:VAL]
//
// Auth: pass via --header (e.g. --header "Authorization: Bearer $TOKEN") — the
// /sources env machinery can inject vault creds into the env, and a wrapper
// reads $OPENAPI_AUTH_HEADER. Kept simple for Phase A.
//
// Scope (Phase A): OpenAPI 3.x, JSON or YAML, operationId-keyed, JSON request/
// response bodies. No streaming, no multipart, no OAuth dance. That's enough to
// make "any REST API → tools" real; the rough edges get smoothed in Phase D.

"use strict";

const http = require("node:http");
const https = require("node:https");
const { readFileSync } = require("node:fs");

// ── minimal MCP stdio server (same shape as test/fake-server.js) ───────────
let buf = "";
const TOOLS = [];

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

function handle(req) {
	if (!req || req.jsonrpc !== "2.0" || req.id === undefined) return;
	switch (req.method) {
		case "initialize":
			send({ jsonrpc: "2.0", id: req.id, result: {
				protocolVersion: "2025-11-25",
				serverInfo: { name: "openapi-bridge", version: "0.1.0" },
				capabilities: { tools: {} },
			}});
			break;
		case "tools/list":
			send({ jsonrpc: "2.0", id: req.id, result: { tools: TOOLS } });
			break;
		case "tools/call":
			callOperation(req.id, req.params).then(
				(result) => send({ jsonrpc: "2.0", id: req.id, result }),
				(err) => send({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: err.message } }),
			);
			break;
		case "shutdown":
			send({ jsonrpc: "2.0", id: req.id, result: {} });
			break;
		default:
			send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `unknown method: ${req.method}` } });
	}
}

process.stdin.on("data", (d) => {
	buf += d.toString("utf8");
	let nl;
	while ((nl = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, nl).replace(/\r$/, "");
		buf = buf.slice(nl + 1);
		if (!line.trim()) continue;
		try { handle(JSON.parse(line)); } catch { /* skip */ }
	}
});
process.stdin.on("end", () => process.exit(0));
process.stdout.on("error", () => process.exit(0));
setInterval(() => {}, 1 << 30);

// ── spec loading ───────────────────────────────────────────────────────────
function loadSpec(source) {
	let raw;
	if (/^https?:\/\//.test(source)) {
		// synchronous fetch via execFileSync is simplest for a CLI entry
		raw = require("node:child_process").execFileSync(
			"curl", ["-fsSL", "--max-time", "20", source],
			{ encoding: "utf8" },
		);
	} else {
		raw = readFileSync(source, "utf8");
	}
	// JSON fast-path; YAML via the tiny parser below (no dep).
	const trimmed = raw.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(raw);
	return parseYaml(raw);
}

// Minimal YAML parser — handles only the subset OpenAPI specs use for our
// purposes (indentation-based maps/arrays, scalars, no anchors/flow). If a spec
// needs full YAML, convert it to JSON first. Kept dependency-free for portability.
function parseYaml(text) {
	const lines = text.split("\n");
	const root = {};
	const stack = [{ indent: -1, node: root }];
	for (const raw of lines) {
		if (!raw.trim() || raw.trim().startsWith("#")) continue;
		const indent = raw.length - raw.trimStart().length;
		const line = raw.trim();
		while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
		const parent = stack[stack.length - 1].node;
		if (line.startsWith("- ")) {
			const value = parseScalar(line.slice(2).trim());
			if (Array.isArray(parent)) parent.push(value);
			continue;
		}
		const idx = line.indexOf(":");
		if (idx < 0) continue;
		const key = line.slice(0, idx).trim();
		const rest = line.slice(idx + 1).trim();
		if (rest === "") {
			const child = {};
			parent[key] = child;
			stack.push({ indent, node: child });
		} else {
			parent[key] = parseScalar(rest);
		}
	}
	return root;
}

function parseScalar(s) {
	if (s === "true") return true;
	if (s === "false") return false;
	if (s === "null" || s === "~") return null;
	if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
	return s;
}

// ── build tools from spec paths ────────────────────────────────────────────
function buildTools(spec, opts) {
	const baseUrl = opts.baseUrl || spec.servers?.[0]?.url || "";
	const paths = spec.paths || {};
	for (const [path, methods] of Object.entries(paths)) {
		for (const [method, op] of Object.entries(methods)) {
			if (!op || typeof op !== "object") continue;
			const opId = op.operationId;
			if (!opId || !/^[a-zA-Z0-9_]+$/.test(opId)) continue;
			const parameters = (op.parameters || []).map((p) => ({
				name: p.name, in: p.in, required: !!p.required,
				description: p.description || "", schema: p.schema || { type: "string" },
			}));
			const reqBody = op.requestBody?.content?.["application/json"]?.schema || null;
			// build a JSON-Schema inputSchema for the tool: path/query/header params + body
			const properties = {};
			const required = [];
			for (const p of parameters) {
				properties[p.name] = withDesc(p.schema || { type: "string" }, p.description || (p.in === "path" ? "(path)" : "(query)"));
				if (p.required) required.push(p.name);
			}
			if (reqBody) {
				properties.body = withDesc(reqBody, "(request body, JSON)");
				required.push("body");
			}
			TOOLS.push({
				name: opId,
				description: `${method.toUpperCase()} ${path}${op.summary ? " — " + op.summary : ""}`,
				inputSchema: { type: "object", properties, required },
				_meta: { method, path, baseUrl, parameters, hasBody: !!reqBody },
			});
		}
	}
}

function withDesc(schema, description) {
	return { ...(schema || { type: "string" }), description };
}

// ── execute an operation as an HTTP request ────────────────────────────────
function callOperation(id, params) {
	return new Promise((resolve, reject) => {
		const tool = TOOLS.find((t) => t.name === params.name);
		if (!tool) return reject(new Error(`unknown operation: ${params.name}`));
		const meta = tool._meta;
		const args = params.arguments || {};
		let path = meta.path;
		const query = {};
		const headers = { ...(globalThis.__authHeaders || {}) };
		for (const p of meta.parameters) {
			if (args[p.name] === undefined) continue;
			if (p.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(args[p.name]));
			else if (p.in === "query") query[p.name] = args[p.name];
			else if (p.in === "header") headers[p.name] = String(args[p.name]);
		}
		let body;
		if (meta.hasBody && args.body !== undefined) {
			body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
			headers["Content-Type"] = headers["Content-Type"] || "application/json";
		}
		if (Object.keys(query).length) {
			const qs = new URLSearchParams(query).toString();
			path += (path.includes("?") ? "&" : "?") + qs;
		}
		const url = (meta.baseUrl || "") + path;
		const u = new URL(url);
		const lib = u.protocol === "https:" ? https : http;
		const req = lib.request(url, { method: meta.method.toUpperCase(), headers }, (res) => {
			let data = "";
			res.on("data", (c) => (data += c));
			res.on("end", () => {
				resolve({
					content: [{ type: "text", text: `HTTP ${res.statusCode}\n${data.slice(0, 4000)}${data.length > 4000 ? "\n…[truncated]" : ""}` }],
					isError: res.statusCode >= 400,
				});
			});
		});
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

// ── entry ──────────────────────────────────────────────────────────────────
(function main() {
	const argv = process.argv.slice(2);
	if (!argv[0] || argv[0] === "--help") {
		process.stderr.write("usage: openapi-server.js <spec-url-or-path> [--base-url URL] [--header NAME:VAL]\n");
		process.exit(2);
	}
	const specPath = argv[0];
	const opts = { baseUrl: "", headers: {} };
	for (let i = 1; i < argv.length; i++) {
		if (argv[i] === "--base-url") opts.baseUrl = argv[++i];
		else if (argv[i] === "--header") {
			const h = argv[++i];
			const idx = h.indexOf(":");
			if (idx > 0) opts.headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
		}
	}
	globalThis.__authHeaders = opts.headers;
	const spec = loadSpec(specPath);
	buildTools(spec, opts);
	process.stderr.write(`[openapi-bridge] loaded ${TOOLS.length} operations from ${specPath}\n`);
})();
