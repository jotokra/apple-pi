// mcp-bridge/lib/mcp-client.js — a minimal MCP (Model Context Protocol) client.
//
// Speaks JSON-RPC 2.0 over stdio to a child server process. Implements just
// the slice the bridge needs: initialize handshake → tools/list → tools/call,
// plus shutdown. No external deps — pure node, so the bridge stays portable
// and unit-testable with a fake server.
//
// Spec: https://modelcontextprotocol.io/specification/2025-11-25
// Transport: stdio (newline-delimited JSON). (HTTP/SSE is a later phase.)
//
// Error posture (red/blue):
//   - every request has a timeout (default 10s); a hung server can't wedge the agent.
//   - a crashed server (child 'exit') rejects any in-flight call and marks the
//     client closed so the bridge can skip it on the next discovery pass.
//   - the secret/credential story lives in the bridge (envFrom → vault), NOT
//     here; this module only knows how to talk to a server once spawned.

"use strict";

const { spawn } = require("node:child_process");

const PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_TIMEOUT_MS = 10_000;

class McpClient {
	/**
	 * @param {{ command: string, args?: string[], env?: Record<string,string>, cwd?: string }} cfg
	 *   The server launch config. `env` is the FINAL env (the bridge resolves
	 *   vault refs before calling here — this module never touches the vault).
	 */
	constructor(cfg) {
		if (!cfg || typeof cfg.command !== "string" || !cfg.command) {
			throw new Error("McpClient requires cfg.command");
		}
		this.command = cfg.command;
		this.args = Array.isArray(cfg.args) ? cfg.args : [];
		this.env = cfg.env || undefined;
		this.cwd = cfg.cwd || undefined;
		this.child = null;
		this._reqId = 0;
		this._pending = new Map();        // id -> {resolve, reject, timer}
		this._buf = "";
		this._closed = false;
		this._initPromise = null;
		this.serverInfo = null;
		this.tools = [];
	}

	// ── lifecycle ────────────────────────────────────────────────────
	/** Spawn the server + run the initialize handshake. Idempotent. */
	async connect(timeoutMs = DEFAULT_TIMEOUT_MS) {
		if (this._initPromise) return this._initPromise;
		this._initPromise = this._connect(timeoutMs);
		return this._initPromise;
	}

	async _connect(timeoutMs) {
		if (this._closed) throw new Error("McpClient: already closed");
		this.child = spawn(this.command, this.args, {
			stdio: ["pipe", "pipe", "inherit"],
			env: this.env,
			cwd: this.cwd,
		});
		this.child.on("error", (e) => this._failAll(new Error(`mcp server spawn failed: ${e.message}`)));
		this.child.on("exit", (code, sig) => {
			const msg = `mcp server '${this.command}' exited (code=${code} sig=${sig})`;
			this._failAll(new Error(msg));
			this._closed = true;
		});
		this.child.stdout.on("data", (d) => this._onData(d));

		const result = await this._request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "apple-pi-mcp-bridge", version: "0.1.0" },
		}, timeoutMs);
		this.serverInfo = result.serverInfo || { name: "unknown", version: "?" };
		// notify initialized (no response expected)
		this._notify("notifications/initialized", {});
		// eagerly discover tools so listTools() is instant + cached
		try {
			const r = await this._request("tools/list", {}, timeoutMs);
			this.tools = Array.isArray(r.tools) ? r.tools : [];
		} catch {
			this.tools = []; // non-fatal: server may not implement tools
		}
		return this;
	}

	/** List the server's tools: [{name, description, inputSchema}]. Cached after connect. */
	async listTools(timeoutMs = DEFAULT_TIMEOUT_MS) {
		await this.connect(timeoutMs);
		if (this.tools.length || this._listed) return this.tools;
		const r = await this._request("tools/list", {}, timeoutMs);
		this.tools = Array.isArray(r.tools) ? r.tools : [];
		this._listed = true;
		return this.tools;
	}

	/** Call a tool. Returns the raw MCP result: {content: [{type,text,...}], isError?}. */
	async callTool(name, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
		await this.connect(timeoutMs);
		return this._request("tools/call", { name, arguments: args }, timeoutMs);
	}

	/** Graceful shutdown: send the MCP shutdown notification, then kill the child. */
	async shutdown() {
		if (this._closed) return;
		this._closed = true;
		try { this._notify("shutdown", {}); } catch { /* ignore */ }
		// give it a beat to flush, then force
		setTimeout(() => { try { this.child && this.child.kill("SIGKILL"); } catch { /* */ } }, 200);
		try { this.child && this.child.kill("SIGTERM"); } catch { /* */ }
		this._failAll(new Error("mcp client shutting down"));
	}

	// ── JSON-RPC plumbing ────────────────────────────────────────────
	_onData(d) {
		this._buf += d.toString("utf8");
		let nl;
		while ((nl = this._buf.indexOf("\n")) >= 0) {
			const line = this._buf.slice(0, nl).replace(/\r$/, "");
			this._buf = this._buf.slice(nl + 1);
			if (!line.trim()) continue;
			let msg;
			try { msg = JSON.parse(line); }
			catch { continue; /* not JSON — skip (server chatter) */ }
			this._onMessage(msg);
		}
	}

	_onMessage(msg) {
		// Responses have an id matching a pending request. Notifications have none.
		if (msg && (typeof msg.id === "string" || typeof msg.id === "number")) {
			const slot = this._pending.get(msg.id);
			if (!slot) return;
			clearTimeout(slot.timer);
			this._pending.delete(msg.id);
			if (msg.error) slot.reject(new Error(msg.error.message || `mcp error ${JSON.stringify(msg.error)}`));
			else slot.resolve(msg.result);
		}
	}

	_request(method, params, timeoutMs) {
		return new Promise((resolve, reject) => {
			if (this._closed) return reject(new Error("McpClient: closed"));
			const id = `c${++this._reqId}`;
			const timer = setTimeout(() => {
				this._pending.delete(id);
				reject(new Error(`mcp '${method}' timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this._pending.set(id, { resolve, reject, timer });
			const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
			try {
				this.child.stdin.write(payload);
			} catch (e) {
				clearTimeout(timer);
				this._pending.delete(id);
				reject(new Error(`mcp '${method}': server stdin closed: ${e.message}`));
			}
		});
	}

	_notify(method, params) {
		if (this._closed || !this.child) return;
		const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
		this.child.stdin.write(payload);
	}

	_failAll(err) {
		for (const [, slot] of this._pending) {
			clearTimeout(slot.timer);
			slot.reject(err);
		}
		this._pending.clear();
	}
}

module.exports = { McpClient, PROTOCOL_VERSION, DEFAULT_TIMEOUT_MS };
