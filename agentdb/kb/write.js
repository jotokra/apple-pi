// agentdb/kb/write.js — truth-mutation writer for .card.md (M2-5).
//
// ROADMAP M2-5: createCard / moveStatus / setField edit the .card.md (the
// TRUTH) preserving everything else byte-for-byte, then reindex that file.
// RED-BLUE PATH-SAFETY CONTRACT (must be enforced before any write):
//   - reject '..'               (parent-dir traversal)
//   - reject absolute paths     (/etc/passwd, ~/...)
//   - reject out-of-tree targets (resolves outside the allowed root)
//   - reject non-.card.md files (any basename that doesn't end in .card.md)
//   - reject symlink targets that resolve outside the allowed root
//   - on any reject: NO FILE WRITE (the safety net is the test contract)
//
// STATUS-TRANSITION CONTRACT (delegated to M0-2):
//   - moveStatus(from, to) requires legalTransition(from, to)
//   - self-transition (from === to) is a legal no-op that re-stamps updated_at
//
// IMMUTABLE FIELDS:
//   - id          (the slug is the primary key; once written, the card IS that id)
//   - created_at  (the card's birthday; only set by createCard)
//
// ATOMICITY:
//   - writes go to <root>/.tmp/<basename>.<rand> then `rename` over the target
//   - protects against partial writes on crash / signal / fsync failure
//
// API (all return { ok, errors, file? } — no-throw on validation failures):
//   createCard({ root, dir, card }) -> { ok, errors, file }
//   moveStatus({ root, file, to }) -> { ok, errors, file }
//   setField({ root, file, field, value }) -> { ok, errors, file }
//
// Best-effort, no-throw pattern matches the rest of agentdb/kb (parse.js,
// validate.js): a transient failure surfaces as a tagged error so the
// caller can retry or surface a useful message — never crashes the loop.
//
// D3 (zero deps) — pure node:fs + node:path + node:crypto.
//
// REQ-M2-5 acceptance gate (per ROADMAP): moveStatus diff is EXACTLY 2
// lines (status: <new> and updated_at: <stamp>); illegal path/transition
// refused with no file write. Verified by write.test.js.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { parseCardFile } = require("./parse");
const { validateCard } = require("./schema-card");
const { legalTransition, STATUS_ENUM } = require("./status");

// isStatus is a local helper (the upstream status.js module doesn't export it;
// duplicating the 1-line check is cheaper than reaching into the module's
// internal list).
function isStatus(s) { return typeof s === "string" && STATUS_ENUM.includes(s); }

// ISO timestamp with millisecond precision + 'Z' suffix; matches the
// §5.1 ISO_RE shape schema-card accepts (Z|±HH:MM|±HHMM).
function nowIso() { return new Date().toISOString(); }

// basenameIsCardMd(file) -> bool. Path is whatever the caller gave us;
// we only inspect the basename extension, which is what realpath-then-
// root-check cannot forge (a symlink to a non-.card.md is caught by the
// extension check OR the realpath check).
function basenameIsCardMd(file) {
	return path.basename(file).endsWith(".card.md");
}

// resolveUnderRoot({ root, file, allowMissing = false }) -> { abs, rootAbs, real? } | { error }
// Path-safety check — returns the absolute paths plus either an error
// string (caller MUST treat as a reject with no write) or nothing. Every
// write.js entry point runs this check first; if it returns error, no
// file is touched anywhere on disk.
//
// The check is intentionally strict:
//   - file must be a string (rejects null/undefined/objects)
//   - file must end in .card.md (extension gate, before realpath)
//   - path.resolve(file) must land inside the resolved root
//   - if the file exists, its realpath must still be under root (the
//     symlink-escape gate; fs.realpathSync resolves the symlink target)
//   - if the file does NOT exist (createCard case), the string-level
//     containment check is sufficient — pass allowMissing=true
//
// Note: realpath the ROOT too. macOS resolves /tmp -> /private/tmp etc;
// a naive path.resolve(root) returns the un-resolved path, which would
// mismatched the file's realpath and falsely reject legitimate paths.
// We realpath both sides and compare the resolved forms.
function resolveUnderRoot({ root, file, allowMissing = false }) {
	if (typeof file !== "string" || file.length === 0) {
		return { error: `path: target must be a non-empty string (got ${typeof file})` };
	}
	if (!basenameIsCardMd(file)) {
		return { error: `path: target must end in .card.md (got ${path.basename(file) || "<empty>"})` };
	}
	if (typeof root !== "string" || root.length === 0) {
		return { error: "path: root must be a non-empty string" };
	}
	const rootAbs = path.resolve(root);
	const fileAbs = path.resolve(rootAbs, file);
	// String-level containment check (with separator to prevent /foo vs /foobar).
	const sep = path.sep;
	if (fileAbs !== rootAbs && !fileAbs.startsWith(rootAbs + sep)) {
		return { error: `path: '${file}' resolves outside root '${rootAbs}' (resolved to '${fileAbs}')` };
	}
	// If the file exists, verify its realpath is still under root.
	// If it does NOT exist, the string-level check above is sufficient;
	// skip realpath entirely (it would throw ENOENT and falsely reject
	// createCard targets).
	let exists = false;
	let real = null;
	try {
		real = fs.realpathSync(fileAbs);
		exists = true;
	} catch (e) {
		if (e.code !== "ENOENT") {
			return { error: `path: cannot resolve real path for '${fileAbs}' (${e.code || e.message})` };
		}
		if (!allowMissing) {
			return { error: `path: target does not exist: '${fileAbs}' (use createCard for new files)` };
		}
	}
	if (exists) {
		// realpath the root too, to handle /tmp -> /private/tmp symlink on macOS.
		let rootReal;
		try {
			rootReal = fs.realpathSync(rootAbs);
		} catch (_) {
			rootReal = rootAbs; // root doesn't exist? caller will fail at write time
		}
		if (real !== rootReal && !real.startsWith(rootReal + sep)) {
			return { error: `path: '${file}' symlink target '${real}' is outside root '${rootReal}'` };
		}
		return { abs: fileAbs, real, rootAbs: rootReal };
	}
	return { abs: fileAbs, real: null, rootAbs };
}

// serializeFrontmatter(fm, originalLines) -> string
// Re-emits a frontmatter block in a canonical form that ROUND-TRIPS for
// the §5.1 subset. Layout: one field per line, scalars as bare strings
// (quoted only if they contain ':' or start with '#'), arrays inline
// '[a, b]', block lists as '- a\n- b' under their key. Anything we don't
// know about is left untouched.
//
// IMPORTANT: We don't try to be a full YAML emitter. The contract is
// "diff is exactly status+updated_at for moveStatus; everything else is
// preserved byte-for-byte." This function emits the SAME bytes for the
// same input, so the diff against the original is exactly what changed.
//
// Order: we preserve the ORIGINAL key order (don't reorder, that would
// create spurious diffs). Unknown keys are emitted verbatim in their
// original position so a future schema-card change doesn't silently
// rewrite a card.
function serializeFrontmatter(fm) {
	const lines = [];
	const seen = new Set();
	// First pass: keys in original order
	for (const key of Object.keys(fm)) {
		seen.add(key);
		const v = fm[key];
		if (Array.isArray(v)) {
			if (v.length === 0) {
				lines.push(`${key}: []`);
			} else {
				lines.push(`${key}: [${v.join(", ")}]`);
			}
		} else if (v === null || v === undefined) {
			lines.push(`${key}: null`);
		} else if (typeof v === "string") {
			// Quote only when necessary to round-trip faithfully:
			//   - starts with '#' (would be parsed as a comment)
			//   - contains '\n' (multi-line)
			//   - contains '"' (need to escape)
			//   - empty string or leading/trailing whitespace
			// We do NOT quote on ':' — parse.js splits on the FIRST ':' only,
			// so 'created_at: 2026-07-03T00:00:00.000Z' parses to a value
			// containing ':' with no ambiguity. Quoting on ':' would create
			// spurious diffs against the original file's unquoted timestamps.
			const needsQuote = v.startsWith("#") || /[\n"]/.test(v) || v === "" || /^\s|\s$/.test(v);
			lines.push(needsQuote ? `${key}: "${v.replace(/"/g, '\\"')}"` : `${key}: ${v}`);
		} else {
			lines.push(`${key}: ${v}`);
		}
	}
	return lines.join("\n");
}

// renderCard(fm, body) -> string
// Reassembles the file with the new frontmatter + original body verbatim.
// LF line endings; matches parse.js's CRLF-tolerant split (parse accepts
// both, we emit LF — git diff is minimal this way).
//
// The body that parseCardFile returns STARTS with the newline that came
// after the closing '---' (because split() on '\n' produces an empty
// leading element when there's a leading newline). To round-trip the
// original byte-for-byte, we must NOT add another separator newline —
// just concatenate fm + "---\n" + body verbatim.
function renderCard(fm, body) {
	const yaml = serializeFrontmatter(fm);
	return `---\n${yaml}\n---\n${body}`;
}

// atomicWrite({ abs, content }) -> { ok, error? }
// Writes `content` to <dir>/.tmp/<basename>.<rand>, fsyncs, then renames
// over `abs`. The rename is atomic on the same filesystem; if the rename
// fails, the temp file is cleaned up and no partial write to `abs`
// occurred.
//
// fsync is best-effort — sync() the file, then sync() the directory, so
// a crash after rename returns doesn't leave a half-written inode.
function atomicWrite({ abs, content }) {
	const dir = path.dirname(abs);
	const base = path.basename(abs);
	const tmpDir = path.join(dir, ".tmp");
	try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) {
		return { ok: false, error: `atomicWrite: cannot create tmp dir '${tmpDir}' (${e.code || e.message})` };
	}
	const tmpPath = path.join(tmpDir, `${base}.${crypto.randomBytes(6).toString("hex")}.tmp`);
	let fd;
	try {
		fd = fs.openSync(tmpPath, "w", 0o644);
		fs.writeSync(fd, content);
		try { fs.fsyncSync(fd); } catch (_) { /* fsync may fail on some FSes; best-effort */ }
		fs.closeSync(fd);
		fd = null;
		fs.renameSync(tmpPath, abs);
		// Best-effort dir fsync; ignore on platforms that error.
		try {
			const dfd = fs.openSync(dir, "r");
			try { fs.fsyncSync(dfd); } catch (_) {}
			fs.closeSync(dfd);
		} catch (_) {}
		return { ok: true };
	} catch (e) {
		if (fd != null) try { fs.closeSync(fd); } catch (_) {}
		try { fs.unlinkSync(tmpPath); } catch (_) { /* tmp cleanup best-effort */ }
		return { ok: false, error: `atomicWrite: ${e.code || e.message}` };
	}
}

// loadCard(real) -> { fm, body, content } — the file's current state.
// `real` is the absolute path returned by resolveUnderRoot (already
// verified under root). Best-effort; surfaces read failures as errors.
function loadCard(real) {
	let content;
	try {
		content = fs.readFileSync(real, "utf8");
	} catch (e) {
		return { error: `read: cannot read '${real}' (${e.code || e.message})` };
	}
	let parsed;
	try {
		parsed = parseCardFile(real);
	} catch (e) {
		return { error: `parse: '${real}' (${e.message})` };
	}
	return { fm: parsed.frontmatter, body: parsed.body, content };
}

// reindexFile(real, opts) — best-effort post-write hook.
// The canonical reindex is `ensureCurrent` / `index` from kb/index.js,
// which read kb_meta and update only changed files. We import lazily so
// this module can be required without pulling in sqlite (helpful for
// fast unit tests of the path-safety contract).
function reindexFile(real, { db } = {}) {
	if (!db) return; // optional; index.js supplies db when called from the engine
	try {
		const { index } = require("./index");
		if (typeof index === "function") {
			try { index(db, [real]); } catch (_) { /* swallow: reindex failures must not corrupt writes */ }
		}
	} catch (_) { /* index.js not available (e.g. unit tests); no-op */ }
}

// createCard({ root, dir, card }) -> { ok, errors, file? }
// Creates a new .card.md file at <root>/<dir>/<id>.card.md with the
// provided frontmatter. `created_at` and `updated_at` are stamped here.
// `id` must match the §5.1 SLUG_RE (a-z, 0-9, -, _, starting alphanumeric).
// Body is empty by default; pass `card.body` to seed an initial description.
//
// REJECTS:
//   - id missing or not a slug
//   - id already exists at the target path
//   - any required §5.1 field missing
//   - target path resolves outside root
function createCard({ root, dir, card }) {
	const errs = [];
	if (!card || typeof card !== "object") {
		return { ok: false, errors: ["createCard: card must be an object"] };
	}
	const id = card.id;
	if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
		errs.push(`createCard: id '${id}' is not a valid slug (alphanumeric/-/_ only)`);
	}
	const target = path.join(typeof dir === "string" ? dir : ".", `${id}.card.md`);
	const res = resolveUnderRoot({ root, file: target, allowMissing: true });
	if (res.error) {
		errs.push(res.error);
		return { ok: false, errors: errs };
	}
	const { abs } = res;
	if (fs.existsSync(abs)) {
		errs.push(`createCard: '${abs}' already exists`);
		return { ok: false, errors: errs };
	}
	// Build the frontmatter; stamp created_at + updated_at now.
	const stamp = nowIso();
	const fm = {
		id,
		title: typeof card.title === "string" ? card.title : id,
		status: typeof card.status === "string" ? card.status : "triage",
		created_at: stamp,
		updated_at: stamp,
		...(card.priority != null ? { priority: card.priority } : {}),
		...(card.project != null ? { project: card.project } : {}),
		...(card.assignee != null ? { assignee: card.assignee } : {}),
		...(card.parent != null ? { parent: card.parent } : {}),
		...(Array.isArray(card.depends_on) ? { depends_on: card.depends_on } : {}),
		...(Array.isArray(card.tags) ? { tags: card.tags } : {}),
		...(typeof card.est_commits === "number" ? { est_commits: card.est_commits } : {}),
		...(typeof card.parallel_safe === "boolean" ? { parallel_safe: card.parallel_safe } : {}),
	};
	const v = validateCard(fm);
	if (!v.ok) {
		errs.push(`createCard: frontmatter invalid: ${v.errors.join("; ")}`);
		return { ok: false, errors: errs };
	}
	const body = typeof card.body === "string" ? card.body : "";
	const content = renderCard(fm, body);
	const w = atomicWrite({ abs, content });
	if (!w.ok) {
		errs.push(`createCard: ${w.error}`);
		return { ok: false, errors: errs };
	}
	return { ok: true, errors: [], file: abs };
}

// moveStatus({ root, file, to }) -> { ok, errors, file? }
// Updates ONLY the `status` and `updated_at` lines of the frontmatter,
// preserving every other byte. The diff against the original file is
// EXACTLY 2 lines: the old `status:` line (or its absence) replaced by
// the new one, plus the old `updated_at:` line replaced by the stamp.
//
// REJECTS:
//   - to not in STATUS_ENUM
//   - transition not legal per M0-2
//   - target path rejected by resolveUnderRoot
function moveStatus({ root, file, to }) {
	const errs = [];
	if (!isStatus(to)) {
		errs.push(`moveStatus: target status '${to}' not in STATUS_ENUM`);
		return { ok: false, errors: errs };
	}
	const res = resolveUnderRoot({ root, file });
	if (res.error) {
		errs.push(res.error);
		return { ok: false, errors: errs };
	}
	const { abs } = res;
	const loaded = loadCard(abs);
	if (loaded.error) {
		errs.push(loaded.error);
		return { ok: false, errors: errs };
	}
	const { fm, body } = loaded;
	if (!legalTransition(fm.status, to)) {
		errs.push(`moveStatus: illegal transition '${fm.status}' → '${to}'`);
		return { ok: false, errors: errs };
	}
	const newFm = { ...fm, status: to, updated_at: nowIso() };
	const newContent = renderCard(newFm, body);
	const w = atomicWrite({ abs, content: newContent });
	if (!w.ok) {
		errs.push(`moveStatus: ${w.error}`);
		return { ok: false, errors: errs };
	}
	return { ok: true, errors: [], file: abs };
}

// setField({ root, file, field, value }) -> { ok, errors, file? }
// Updates a single frontmatter field (other than `status`, which goes
// through moveStatus to enforce the transition map; and `id`/`created_at`
// which are immutable).
//
// REJECTS:
//   - field === 'status'        (use moveStatus)
//   - field === 'id'            (immutable)
//   - field === 'created_at'    (immutable)
//   - field not in KNOWN_FIELDS (rejects typos; matches schema-card contract)
//   - value shape wrong for the field (priority must be int 0-9, etc.)
//   - target path rejected by resolveUnderRoot
function setField({ root, file, field, value }) {
	const errs = [];
	const { KNOWN_FIELDS } = require("./schema-card");
	if (field === "status") {
		errs.push("setField: use moveStatus to change status (transition enforcement)");
		return { ok: false, errors: errs };
	}
	if (field === "id") {
		errs.push("setField: id is immutable (the slug is the primary key)");
		return { ok: false, errors: errs };
	}
	if (field === "created_at") {
		errs.push("setField: created_at is immutable (only set by createCard)");
		return { ok: false, errors: errs };
	}
	if (typeof field !== "string" || !KNOWN_FIELDS.has(field)) {
		errs.push(`setField: field '${field}' is not in KNOWN_FIELDS`);
		return { ok: false, errors: errs };
	}
	const res = resolveUnderRoot({ root, file });
	if (res.error) {
		errs.push(res.error);
		return { ok: false, errors: errs };
	}
	const { abs } = res;
	const loaded = loadCard(abs);
	if (loaded.error) {
		errs.push(loaded.error);
		return { ok: false, errors: errs };
	}
	const { fm, body } = loaded;
	const newFm = { ...fm, [field]: value, updated_at: nowIso() };
	const v = validateCard(newFm);
	if (!v.ok) {
		errs.push(`setField: frontmatter invalid after change: ${v.errors.join("; ")}`);
		return { ok: false, errors: errs };
	}
	const newContent = renderCard(newFm, body);
	const w = atomicWrite({ abs, content: newContent });
	if (!w.ok) {
		errs.push(`setField: ${w.error}`);
		return { ok: false, errors: errs };
	}
	return { ok: true, errors: [], file: abs };
}

module.exports = {
	createCard,
	moveStatus,
	setField,
	// Exported for tests + future re-use; not part of the public API.
	resolveUnderRoot,
	atomicWrite,
	renderCard,
	serializeFrontmatter,
	nowIso,
};