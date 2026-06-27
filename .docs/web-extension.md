# web extension — feature spec (apple-pi)

> A marquee capability for apple-pi: **search the web, read pages, and drive
> the user's real browser** (click, type, check boxes, fill forms) — so the
> agent can act on the live web, not just the local filesystem.

## Why

apple-pi's persona is "never ask permission, use the best viable way," but
until now it had no eyes or hands on the web. The agent could `bash curl` a
page but couldn't render JS, fill a form, check a box, or see what it was
doing. This extension closes that gap with three capabilities:

1. **`web_search`** — ranked web results (title/url/snippet). Free default
   (DuckDuckGo HTML), optional Tavily/Brave via API key.
2. **`web_fetch`** — fetch a URL → cleaned markdown (links preserved); optional
   JS-render via the browser for SPAs.
3. **`browser_*`** (13 tools) — drive a **persistent, headed** Chrome profile
   so the user's logins/cookies persist and the user can watch every action.
   Element refs (`data-pi-ref`) make click/type/check deterministic without
   fragile CSS selectors. Screenshots return an image the model can see.

## Architecture

- **Env-driven config, zero secrets in repo** (`config.ts`): provider, API keys,
  headless flag, CDP attach, profile dir, browser channel, UA.
- **Playwright imported lazily** so `web_search`/`web_fetch` work even if
  Playwright isn't installed; the browser tools give a actionable error.
- **Ref-based interaction** (the playwright-mcp / computer-use pattern):
  `browser_snapshot` labels visible interactive elements with `[N]` refs; all
  click/type/check/select tools take a `ref`. Re-snapshot after navigation.
- **Headed by default** — the transparency guardrail. The browser is the user's
  real session; every action is visible. Headless is opt-in via env.

## Files

`config/extensions/web/`: `index.ts` (entry, registers 15 tools), `config.ts`,
`util.ts` (httpGet, html→markdown, truncate), `search.ts`, `fetch.ts`,
`browser.ts` (Playwright manager), `snapshot.ts` (labeling/inventory),
`package.json` (deps: `playwright`, `node-html-parser`; `pi.extensions`
manifest → `./index.ts`).

## Wiring into apple-pi

- **install.sh**: copy via existing `_install_tree extensions`; then best-effort
  `npm install` in the web dir (warn, don't fail, if Node/npm absent). New
  placeholder `__APPLEPI_EXT_WEB__` → `$PI_DIR/extensions/web`.
- **settings.json.template**: register the extension by default
  (`extensions: [sysinfo, web]`) and add the 15 tool names to `tools.allow`
  (the allowlist would otherwise filter them out). Requires no creds, so
  default-on is consistent with sysinfo-guard.
- **structure.sh**: count only top-level `config/extensions/*.ts` (=7); add a
  dedicated assertion that the web bundle (`index.ts` + valid `package.json`)
  is present; add `__APPLEPI_EXT_WEB__` to required placeholders + render test.
- **sanitize.sh**: the web dir is under `config/` so it's already scanned —
  docs/code must stay free of forbidden tokens (no provider names, no personal
  identifiers).

## Red/blue

- Browser drives the user's **real session** → can do anything the user can
  (auth, spend). Mitigations: headed-by-default (visible), snapshot-first
  workflow (acts only on visible refs), tool-level `promptGuidelines` telling
  the agent to confirm destructive/financial/irreversible actions, no
  auto-anything.
- `browser_eval` = arbitrary JS in the page context. Kept (genuinely useful for
  scraping), flagged in its description + guidelines; the persona's autonomy
  rules already bar reckless use.
- Network egress to public web only (search/fetch). No inbound listeners.
- No secrets in repo. API keys via env only.

## Verification

- `npm install` resolves `playwright` + `node-html-parser`.
- Logic smoke (`web/_smoke.mjs`-style): `web_search` returns results;
  `web_fetch` returns markdown; `browser_navigate` → `browser_snapshot` →
  `browser_click` round-trip on a static page; `browser_screenshot` returns a
  PNG.
- **Integration (ground truth already established this session):** with the dir
  registered in `settings.extensions`, `createAgentSession` reports **19 tools**
  = 4 built-in + 15 web (13 `browser_*` + `web_fetch` + `web_search`); zero
  `extension_error` events.
- `smoke/structure.sh` + `smoke/sanitize.sh` pass with the new bundle.

## Non-goals

- No headless-by-default. No control-plane/network reconfiguration. No secret
  storage in the repo.
- Not auto-enabled for the optional service extensions (n8n/forgejo/etc.) —
  those stay on-demand; the web bundle needs no external service, so it's on by
  default.
