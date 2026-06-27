/**
 * kanban-bridge.ts — apple-pi tools for a SQLite-backed task store.
 *
 * Tools:
 *   kanban_list_cards   → list tasks (default 50, optional status filter)
 *   kanban_get_card     → fetch one task by id
 *   kanban_create_card  → create a task in the 'triage' lane
 *
 * Target schema (a common SQLite task-store layout; configurable):
 *   table KANBAN_TABLE (default "tasks")
 *   columns: id, title, body, assignee, status, priority, created_at,
 *            started_at, completed_at
 *   status values: triage, in_progress, blocked, review, done
 *
 * Configuration (env vars — NO defaults baked in):
 *   KANBAN_DB_PATH  — absolute path to the SQLite DB
 *   KANBAN_TABLE    — table name (default "tasks")
 *   KANBAN_ACTOR    — created_by value on insert (default "apple-pi")
 *
 * Read-mostly. If your task store has a different schema, either adapt the
 * column lists below or point KANBAN_DB_PATH at a compatible view. Tools
 * degrade gracefully: a missing column is reported, not silently ignored.
 */

import { DatabaseSync } from "node:sqlite";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DB_PATH = (process.env as Record<string, string | undefined>)["KANBAN_DB_PATH"] ?? "";
const TABLE = (process.env as Record<string, string | undefined>)["KANBAN_TABLE"] ?? "tasks";
const ACTOR = (process.env as Record<string, string | undefined>)["KANBAN_ACTOR"] ?? "apple-pi";

const SELECT_COLS = "id, title, body, status, priority, assignee, created_at, started_at, completed_at";

function configError(): string {
	return "kanban-bridge not configured. Set KANBAN_DB_PATH to your task-store SQLite file in your environment.";
}

function openDb(): DatabaseSync {
	if (!DB_PATH) throw new Error(configError());
	return new DatabaseSync(DB_PATH, { readOnly: false });
}

interface TaskRow {
	id: string; title: string; body: string | null; status: string;
	priority: number; assignee: string | null; created_at: number;
	started_at: number | null; completed_at: number | null;
}

const listCards = defineTool({
	name: "kanban_list_cards",
	label: "Kanban List Cards",
	description: "List tasks from the configured SQLite task store. Default 50, sorted by created_at desc. Optionally filter by status (triage, in_progress, blocked, review, done).",
	parameters: Type.Object({
		status: Type.Optional(Type.String({ description: "Filter by status (triage, in_progress, blocked, review, done)" })),
		limit: Type.Optional(Type.Number({ description: "Max tasks (default 50)" })),
	}),
	async execute(_id, p) {
		let db: DatabaseSync;
		try { db = openDb(); } catch (e: any) {
			return { content: [{ type: "text", text: `kanban: ${e?.message ?? String(e)}` }], details: { ok: false } };
		}
		try {
			const limit = p.limit ?? 50;
			let sql = `SELECT ${SELECT_COLS} FROM ${TABLE} WHERE 1=1`;
			const params: any[] = [];
			if (p.status) { sql += " AND status = ?"; params.push(p.status); }
			sql += " ORDER BY created_at DESC LIMIT ?";
			params.push(limit);
			const rows = db.prepare(sql).all(...params) as unknown as TaskRow[];
			const summary = rows.map((r) => ({
				id: r.id, title: r.title, status: r.status, priority: r.priority,
				assignee: r.assignee, created_at: r.created_at,
			}));
			return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }], details: { count: summary.length } };
		} catch (e: any) {
			return { content: [{ type: "text", text: `kanban db error: ${e?.message ?? String(e)}` }], details: { ok: false } };
		} finally {
			db.close();
		}
	},
});

const getCard = defineTool({
	name: "kanban_get_card",
	label: "Kanban Get Card",
	description: "Fetch one task by id, full body included.",
	parameters: Type.Object({
		id: Type.String({ description: "Task id" }),
	}),
	async execute(_id, p) {
		let db: DatabaseSync;
		try { db = openDb(); } catch (e: any) {
			return { content: [{ type: "text", text: `kanban: ${e?.message ?? String(e)}` }], details: { ok: false } };
		}
		try {
			const row = db.prepare(`SELECT ${SELECT_COLS} FROM ${TABLE} WHERE id = ?`).get(p.id) as unknown as TaskRow | undefined;
			if (!row) return { content: [{ type: "text", text: `task ${p.id} not found` }], details: { ok: false } };
			return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }], details: { id: row.id, title: row.title } };
		} catch (e: any) {
			return { content: [{ type: "text", text: `kanban db error: ${e?.message ?? String(e)}` }], details: { ok: false } };
		} finally {
			db.close();
		}
	},
});

const createCard = defineTool({
	name: "kanban_create_card",
	label: "Kanban Create Card",
	description: "Create a new task in the 'triage' lane. Requires the table to have id/title/body/status/priority/assignee/created_by/created_at columns."
	parameters: Type.Object({
		title: Type.String({ description: "Task title" }),
		body: Type.String({ description: "Task body (markdown)" }),
		priority: Type.Optional(Type.Number({ description: "Priority 0-9 (default 5)" })),
		assignee: Type.Optional(Type.String({ description: "Assignee slug" })),
	}),
	async execute(_id, p) {
		let db: DatabaseSync;
		try { db = openDb(); } catch (e: any) {
			return { content: [{ type: "text", text: `kanban: ${e?.message ?? String(e)}` }], details: { ok: false } };
		}
		try {
			const priority = p.priority ?? 5;
			const id = `t_${Math.random().toString(36).slice(2, 12)}`;
			const now = Date.now();
			db.prepare(
				`INSERT INTO ${TABLE} (id, title, body, status, priority, assignee, created_by, created_at)
				 VALUES (?, ?, ?, 'triage', ?, ?, ?, ?)`,
			).run(id, p.title, p.body, priority, p.assignee ?? null, ACTOR, now);
			return { content: [{ type: "text", text: `Created task ${id}: ${p.title}` }], details: { id, status: "triage" } };
		} catch (e: any) {
			return { content: [{ type: "text", text: `kanban db error: ${e?.message ?? String(e)} (does your table have a created_by column?)` }], details: { ok: false } };
		} finally {
			db.close();
		}
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(listCards);
	pi.registerTool(getCard);
	pi.registerTool(createCard);
}
