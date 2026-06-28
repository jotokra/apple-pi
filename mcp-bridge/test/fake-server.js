// mcp-bridge/test/fake-server.js — a minimal MCP server for smokes.
//
// Speaks just enough JSON-RPC/stdio: initialize, notifications/initialized,
// tools/list (one "echo" tool), tools/call (echos args back as text), shutdown.
// Run: node fake-server.js   (reads JSON-RPC on stdin, writes on stdout)
"use strict";

let buf = "";
let initialized = false;

const TOOLS = [
	{
		name: "echo",
		description: "Echo back the arguments as JSON. (test tool)",
		inputSchema: {
			type: "object",
			properties: { msg: { type: "string", description: "message to echo" } },
			required: ["msg"],
		},
	},
];

function send(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(req) {
	if (!req || req.jsonrpc !== "2.0") return;
	const { id, method, params } = req;

	// notifications (no id) — acknowledge by state change only
	if (id === undefined || id === null) {
		if (method === "notifications/initialized") initialized = true;
		return;
	}

	switch (method) {
		case "initialize":
			send({
				jsonrpc: "2.0", id,
				result: {
					protocolVersion: "2025-11-25",
					serverInfo: { name: "fake-mcp", version: "0.0.1" },
					capabilities: { tools: {} },
				},
			});
			break;
		case "tools/list":
			send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
			break;
		case "tools/call": {
			const name = params && params.name;
			const args = (params && params.arguments) || {};
			if (name === "echo") {
				send({
					jsonrpc: "2.0", id,
					result: { content: [{ type: "text", text: JSON.stringify(args) }] },
				});
			} else {
				send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool: ${name}` } });
			}
			break;
		}
		case "shutdown":
			send({ jsonrpc: "2.0", id, result: {} });
			break;
		default:
			send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } });
	}
}

process.stdin.on("data", (d) => {
	buf += d.toString("utf8");
	let nl;
	while ((nl = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, nl).replace(/\r$/, "");
		buf = buf.slice(nl + 1);
		if (!line.trim()) continue;
		try { handle(JSON.parse(line)); }
		catch { /* skip non-JSON */ }
	}
});
process.stdin.on("end", () => process.exit(0));
// keep alive until stdin closes
setInterval(() => {}, 1 << 30);
