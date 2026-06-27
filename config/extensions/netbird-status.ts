/**
 * netbird-status.ts — apple-pi tools for the NetBird overlay (read-only).
 *
 * Tools:
 *   netbird_status     → runs `netbird status --json` on the local daemon
 *   netbird_list_peers → parses local status, returns compact peer list
 *
 * Read-only — never reconfigures the overlay. Requires the `netbird` CLI
 * installed and a daemon running locally. If you don't use NetBird, leave
 * this extension disabled; it's offered as part of the monitoring workflow.
 *
 * The control-plane API is intentionally NOT exposed here — only the
 * local daemon's view. Reconfiguring an overlay is the operator's job.
 */

import { spawn } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

function runNetbird(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn("netbird", args);
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (b) => (stdout += b.toString()));
		proc.stderr.on("data", (b) => (stderr += b.toString()));
		proc.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
		proc.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
	});
}

const statusTool = defineTool({
	name: "netbird_status",
	label: "NetBird Status",
	description: "Run `netbird status --json` on the local daemon. Returns management state, peer count, signal state, FQDN. Requires the netbird CLI.",
	parameters: Type.Object({}),
	async execute() {
		const r = await runNetbird(["status", "--json"]);
		if (r.code !== 0) {
			return { content: [{ type: "text", text: `netbird error: ${r.stderr.slice(0, 400)}` }], details: { code: r.code } };
		}
		try {
			const parsed = JSON.parse(r.stdout);
			return { content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }], details: { fqdn: parsed?.fqdn, state: parsed?.state } };
		} catch {
			return { content: [{ type: "text", text: r.stdout }], details: { raw: true } };
		}
	},
});

const peersTool = defineTool({
	name: "netbird_list_peers",
	label: "NetBird List Peers",
	description: "Parse `netbird status --json` and return a compact peer list: fqdn, ip, state, last handshake, conn type.",
	parameters: Type.Object({}),
	async execute() {
		const r = await runNetbird(["status", "--json"]);
		if (r.code !== 0) {
			return { content: [{ type: "text", text: `netbird error: ${r.stderr.slice(0, 400)}` }], details: { code: r.code } };
		}
		const parsed = JSON.parse(r.stdout);
		const peers = (parsed?.peers ?? []).map((p: any) => ({
			fqdn: p.fqdn,
			ip: p.state?.peer?.state === "Connected" ? p.ips?.[0] : null,
			state: p.state?.peer?.state,
			last_handshake: p.state?.lastWireguardHandshake,
			conn_type: p.connType,
		}));
		return { content: [{ type: "text", text: JSON.stringify(peers, null, 2) }], details: { count: peers.length } };
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(statusTool);
	pi.registerTool(peersTool);
}
