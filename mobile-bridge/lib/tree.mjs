// mobile-bridge/lib/tree.mjs — T4: Session tree builder.
//
// Pure module: read a Pi session JSONL and return its message tree.
//
// Pi's session schema (v3, observed in the wild since 2026-06-26):
//   - First record is { type:"session", id, timestamp, cwd, version } — metadata
//     only, has NO parentId field at all.
//   - Every subsequent record is { id, parentId, timestamp, type, ... } where
//     type ∈ { "model_change", "thinking_level_change", "message", ... }.
//   - The first non-session record has parentId: null and is the tree root
//     (typically a "model_change" emitted at session start).
//   - All other records link upward via parentId, forming a DAG (not a
//     strict tree: forked /tree branches share ancestors).
//
// Output (the public contract this lib promises to bridge.mjs + smoke tests):
//   { schema_version: 1,
//     root: { id, parent_id: null, type, timestamp, role?, children: [...] },
//     nodes_by_id: { [id]: <node-without-children> },
//     stats: { total_nodes, max_depth, leaf_count, has_branches } }
//
// Legacy fallback: when NO record carries a parentId field (the pre-v3
// format), build a flat list { schema_version: 1, flat: [...], legacy: true }
// and log a warning. This keeps the route returning *something* instead of
// 500-ing on old data — see plan-01 Task 4.
//
// Single-pass: one read, one O(n) build, one O(n) depth pass at the end
// (the depth pass is needed only for stats.max_depth and is trivial).
//
// No Fastify dependency — this module is smoke-testable in isolation
// (smoke/tree.sh calls it via `node -e`), and bridge.mjs will import it
// when T1 lands Fastify + T2 adds the sessions route.

import { readFileSync } from "node:fs";

/**
 * Parse one JSONL line. Tolerates blank lines; throws on malformed JSON
 * with the line number so the caller can locate the bad record.
 *
 * @param {string} line
 * @param {number} idx  1-based line number, for error messages
 * @returns {object|null}
 */
function parseLine(line, idx) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`tree.mjs: malformed JSONL at line ${idx}: ${e.message}`);
  }
}

/**
 * Pick the public-facing fields off a record. Keep this small — the
 * JSONL carries a lot (toolCall args, content blocks, usage telemetry)
 * that the iOS viewer doesn't need in v0.1 and that would inflate the
 * response. We can loosen this later without breaking the schema_version.
 *
 * @param {object} rec
 * @returns {object}
 */
function project(rec) {
  const out = {
    id: rec.id,
    parent_id: rec.parentId ?? null,
    type: rec.type,
    timestamp: rec.timestamp,
  };
  // Pull through the message.role + a short content snippet for "message"
  // records so the UI can render the conversation shape without a second
  // call. Skip the full content blocks — those go through /raw NDJSON.
  if (rec.type === "message" && rec.message) {
    out.role = rec.message.role ?? null;
    out.content_preview = previewContent(rec.message.content);
  }
  // Pass through a couple of stable metadata fields for non-message nodes
  // so the UI can show "thinking level: high" etc. without a second call.
  if (rec.type === "thinking_level_change") {
    out.thinking_level = rec.thinkingLevel ?? null;
  }
  if (rec.type === "model_change") {
    out.provider = rec.provider ?? null;
    out.model_id = rec.modelId ?? null;
  }
  return out;
}

/**
 * Reduce a Pi content-array (typed blocks: text/thinking/toolCall) to a
 * short human-readable string for the tree view. Capped at ~120 chars to
 * keep the tree response small; full content stays in /raw.
 *
 * @param {unknown} content
 * @returns {string}
 */
function previewContent(content) {
  if (!Array.isArray(content) || content.length === 0) return "";
  const blocks = [];
  for (const b of content) {
    if (typeof b !== "object" || b === null) continue;
    if (b.type === "text" && typeof b.text === "string") {
      blocks.push(b.text);
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      blocks.push(`[thinking] ${b.thinking}`);
    } else if (b.type === "toolCall") {
      blocks.push(`[tool] ${b.name ?? "?"}`);
    }
  }
  const joined = blocks.join(" ").replace(/\s+/g, " ").trim();
  return joined.length > 120 ? joined.slice(0, 117) + "..." : joined;
}

/**
 * Build the tree from a parsed array of records (the form the smoke test
 * uses when it inlines JSONL via node -e).
 *
 * @param {object[]} records
 * @returns {object}  tree or { flat, legacy: true } when no parentId seen
 */
function buildFromRecords(records) {
  // Legacy detection: scan for ANY record that carries parentId. If none
  // do, this is the pre-v3 flat schema — return a flat list with a flag.
  const hasAnyParentId = records.some(
    (r) => r && Object.prototype.hasOwnProperty.call(r, "parentId"),
  );

  if (!hasAnyParentId) {
    const flat = records
      .filter((r) => r && r.type !== "session") // skip metadata header
      .map((r) => ({
        id: r.id,
        type: r.type,
        timestamp: r.timestamp,
        role: r.message?.role ?? null,
      }));
    return {
      schema_version: 1,
      legacy: true,
      flat,
      warning:
        "JSONL is missing parentId on every record — returning flat list. " +
        "This is the pre-v3 schema; trees require Pi session format v3+.",
    };
  }

  // Normal build: one pass to construct node objects, one to link.
  const nodes_by_id = Object.create(null);
  let rootId = null;

  for (const rec of records) {
    if (!rec || !rec.id) continue;
    // Skip the session header — it's metadata (no parentId, no role,
    // no message), and including it would force a synthetic second root.
    if (rec.type === "session") continue;
    const node = project(rec);
    nodes_by_id[rec.id] = { ...node, children: [] };
    if (rootId === null && rec.parentId === null) {
      rootId = rec.id;
    }
  }

  if (rootId === null) {
    // Shouldn't happen on real v3 data: every session has a model_change
    // with parentId:null. But defend against it — return what we have as
    // a flat list with a warning rather than crashing.
    return {
      schema_version: 1,
      legacy: true,
      flat: Object.values(nodes_by_id).map(({ children: _c, ...rest }) => rest),
      warning:
        "JSONL had parentId fields but no record with parentId:null — " +
        "no root found. Returning flat list.",
    };
  }

  // Second pass: link children → parents. Tolerate orphans (record whose
  // parentId doesn't resolve) by attaching them to the root rather than
  // dropping them — losing a message is worse than rendering it at the
  // wrong depth.
  let leafCount = 0;
  let maxDepth = 0;
  let hasBranches = false;

  for (const id of Object.keys(nodes_by_id)) {
    const node = nodes_by_id[id];
    if (id === rootId) continue;
    const parent = node.parent_id
      ? nodes_by_id[node.parent_id]
      : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      // Orphan: parent missing. Attach to root as a fallback.
      nodes_by_id[rootId].children.push(node);
      hasBranches = true;
    }
  }

  // Recursive sort: by timestamp ascending so the UI renders the tree
  // in chronological order without an extra sort.
  const sortRecursive = (n) => {
    if (n.children.length === 0) {
      leafCount++;
    } else {
      if (n.children.length > 1) hasBranches = true;
      n.children.sort((a, b) =>
        String(a.timestamp).localeCompare(String(b.timestamp)),
      );
      n.children.forEach(sortRecursive);
    }
  };
  const root = nodes_by_id[rootId];
  sortRecursive(root);

  // Depth pass (for stats.max_depth). Linear in total nodes.
  const computeDepth = (n, d) => {
    if (d > maxDepth) maxDepth = d;
    for (const c of n.children) computeDepth(c, d + 1);
  };
  computeDepth(root, 1);

  return {
    schema_version: 1,
    legacy: false,
    root,
    nodes_by_id,
    stats: {
      total_nodes: Object.keys(nodes_by_id).length,
      max_depth: maxDepth,
      leaf_count: leafCount,
      has_branches: hasBranches,
    },
  };
}

/**
 * Public entry point: build a tree from a JSONL file path.
 *
 * @param {string} jsonlPath
 * @returns {object}
 */
export function buildTreeFromFile(jsonlPath) {
  const text = readFileSync(jsonlPath, "utf8");
  const lines = text.split(/\r?\n/);
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    const r = parseLine(lines[i], i + 1);
    if (r !== null) records.push(r);
  }
  return buildFromRecords(records);
}

/**
 * Public entry point: build a tree from a pre-parsed array of records
 * (useful for tests, and for callers that already streamed/parsed the
 * JSONL themselves).
 *
 * @param {object[]} records
 * @returns {object}
 */
export function buildTree(records) {
  return buildFromRecords(records);
}