# web extension

Gives apple-pi **eyes and hands on the web**: search, read pages, and drive the
user's real browser — click, type, check boxes, fill forms, take screenshots.

```
web_search ─▶ ranked results (title/url/snippet)
web_fetch  ─▶ URL → cleaned markdown (optionally JS-rendered)
browser_*  ─▶ persistent HEADED Chrome: navigate, snapshot refs, click/type/…
```

## Tools

| Tool | What it does |
|------|--------------|
| `web_search` | Search the public web (DuckDuckGo free; Tavily/Brave via key) |
| `web_fetch` | GET a URL → markdown (links preserved); `render:true` for SPAs |
| `browser_navigate` | Open a URL in the headed browser, wait, return text |
| `browser_snapshot` | Label every interactive element with `[N]` refs + inventory |
| `browser_click` | Click element by ref |
| `browser_type` | Type into a ref (append / clear / +Enter) |
| `browser_set_checkbox` | Check/uncheck a ref |
| `browser_select_option` | Pick an `<option>` by value or label |
| `browser_press_key` | Enter / Tab / Escape / … |
| `browser_hover` | Hover a ref (menus, tooltips) |
| `browser_wait` | Wait for text / selector / timeout |
| `browser_screenshot` | PNG of viewport or full page (returned as an image) |
| `browser_eval` | Run JS in the page (powerful — see guidance below) |
| `browser_tabs` | List / switch / close tabs |
| `browser_close` | Close the browser (saves the persistent profile) |

## How it works

- **Headed by default.** The browser is your real, persistent Chrome profile
  (`~/.pi/browser-profile`) — logins and cookies survive, and **you can watch
  every action**. That visibility is the transparency guardrail.
- **Refs, not CSS.** `browser_snapshot` injects `data-pi-ref="N"` onto every
  visible interactive element and returns an inventory. All click/type/check
  tools take a `ref`. Re-snapshot after navigation or DOM changes.
- **Lazy Playwright.** `playwright` is imported only when a browser tool runs,
  so `web_search`/`web_fetch` work even if Playwright isn't installed.

## Install (handled by apple-pi's `install.sh`)

```sh
npm install                       # playwright + node-html-parser
npx playwright install chromium   # bundled browser (only if no system Chrome)
```

## Configuration (env — no secrets in the repo)

| Var | Default | Meaning |
|-----|---------|---------|
| `PI_WEB_SEARCH_PROVIDER` | `ddg` | `ddg` \| `tavily` \| `brave` |
| `TAVILY_API_KEY` / `BRAVE_API_KEY` | — | key for the matching provider |
| `PI_BROWSER_HEADLESS` | `0` | `1` = headless (loses the visibility guardrail) |
| `PI_BROWSER_CDP_URL` | — | attach to a running Chrome (`--remote-debugging-port=9222`) |
| `PI_BROWSER_PROFILE` | `~/.pi/browser-profile` | userDataDir |
| `PI_BROWSER_CHANNEL` | `chrome` | `chrome` \| `chromium` \| empty (bundled) |
| `PI_WEB_USER_AGENT` | Chrome desktop | UA override for fetch/search |

## Verify it

```sh
node test/smoke.mjs                 # search + fetch + browser round-trip
PI_SMOKE_NO_NET=1 node test/smoke.mjs      # browser only, offline
PI_SMOKE_NO_BROWSER=1 node test/smoke.mjs  # search + fetch only
```

## Red / blue

- The browser drives **your real session** — it can do anything you can
  (authenticate, spend, delete). The agent's tool guidelines require it to
  **confirm before payments, deletions, or any irreversible action**, and to
  prefer visible, low-risk steps. Nothing auto-submits.
- `browser_eval` runs arbitrary JS in your page context (can read cookies, call
  page APIs). Kept because it's genuinely useful for scraping; flagged in its
  description and gated by the same consent rules.
- Network egress to the public web only. No inbound listeners. No secrets
  stored here — API keys are env-only.
