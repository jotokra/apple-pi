# apple-pi everywhere — vision & feature research

> **Vision (user-stated):** a platform that *lives everywhere the user has an
> action point* — phone, laptop, voice. **Every stream of information points
> into one target: the agentic harness.** The user can add any data source
> they wish. Tools needed: web scrapers + dynamic API wrappers ("one code,
> one agent, all APIs").
>
> This doc is the research + strategy pass. It reframes the vision precisely,
> surveys the state of the art, proposes concrete features ranked by leverage,
> and ends with a phased plan. It is **not** a build spec — pick a phase,
> write a SPEC.md, then build.

## Status
Research / proposal. Not committed to a release. Discussion doc.

---

## 1. Reframing the vision precisely

The user's vision has **three orthogonal axes**, and conflating them is the
main risk. Separate them:

| Axis | Direction | Question |
|------|-----------|----------|
| **Ingress** | world → harness | How does data from N sources *enter* the agent's awareness? |
| **Adapters** | harness ↔ service | How does the agent *talk to* N APIs without N hand-written extensions? |
| **Surfaces** | harness → world | From how many *action points* (phone/laptop/voice/…) can the user drive it? |

The unifying principle, in one sentence:

> **apple-pi becomes the user's single agentic core. Every external thing —
> a feed, an API, a device — is either a *source* that flows in, an *adapter*
> it can call, or a *surface* it can be reached from. One harness, three
> kinds of plumbing.**

This maps cleanly onto what already exists:

- **Surfaces** already partly exist: laptop (`pi` TUI), voice (`/voice` →
  pivoice), chat (Telegram bridge). **Phone-as-a-surface** is the gap.
- **Adapters** exist as one-off extensions (n8n, forgejo, telegram, netbird,
  kanban, web). **The "one code, all APIs" layer is the gap.**
- **Ingress** barely exists — Telegram is the only push-in path. **An ingress
  bus (webhooks/pollers → session) is the gap.**

So the vision is not "build 50 integrations." It's "build the **three
primitives** that make 50 integrations trivial and uniform."

---

## 2. State of the art (research)

### 2a. The "one agent, all APIs" standard: **MCP**

**Model Context Protocol** (Anthropic-origin, now open, late-2024) is *exactly*
the user's "one code, one agent, all APIs" ask, standardized:

- An **MCP server** exposes *tools / resources / prompts* over a JSON-RPC
  transport (stdio or HTTP+SSE). One server per service (GitHub, Slack,
  Postgres, the filesystem, …). Hundreds already exist; there's a **Registry**.
- An **MCP client** (the agent) discovers and calls them generically — no
  per-service code in the agent.
- Broad adoption: Claude Desktop, Cursor, Windsurf, Cline, Zed, OpenAI
  Agents SDK, etc.

**Decisive fact for apple-pi:** pi's own docs state
*"It intentionally does not include built-in MCP … You can build or install
those workflows as extensions or packages."* So:

- The right move is **NOT** to hand-roll a "dynamic API wrapper" framework
  from scratch. That reinvents MCP poorly.
- The right move **IS** to build (or adopt) an **`mcp-bridge` extension** that
  makes any MCP server a set of pi tools — then the entire MCP ecosystem
  becomes apple-pi adapters overnight. This is the single highest-leverage
  feature in this whole doc.

### 2b. Dynamic API wrapping (when no MCP server exists)

For APIs with no MCP server, the modern pattern is **OpenAPI/Swagger → tools**:
feed an OpenAPI spec to a generator → get typed tools (path, params, auth).
Roughly: `openapi-to-mcp-server` or `openapi-to-tools`. Combined with the
MCP bridge, this covers ~any REST API. GraphQL has equivalents.

### 2c. Scraping as a first-class source

- Structured: site → RSS/Atom (universal, cheap) → ingress poller.
- Semi-structured: the existing `web_fetch` (HTML→markdown) + `browser_*`
  (JS-render + interact) already cover this. What's missing is a
  **scheduler** ("fetch X daily, diff, notify") — which is ingress.

### 2d. Multi-surface platforms (how others do "lives everywhere")

- **Telegram/Signal bots** — phone-native, push + pull, no app install. The
  telegram bridge exists; it just needs to be a first-class *surface* (full
  duplex: agent can ask the user questions, not just reply).
- **PWA / mobile web** — installable, no app-store, works offline-ish. Good
  "real" mobile surface without native dev.
- **Push (APNs)** — only worth it for a native app; out of scope for now.

---

## 3. Feature candidates (ranked by leverage × fit)

Each is rated **leverage** (how much it unlocks), **risk** (security/blast
radius), **effort**, and whether it's a **primitive** (unlocks many things)
vs a **point feature** (one thing).

### 🥇 P1 — `mcp-bridge` (the "one agent, all APIs" primitive)
**Leverage: huge · Risk: medium · Effort: medium · Primitive**

An extension that reads a list of MCP servers from settings, spawns/Connects
to each (stdio or HTTP), discovers their tools, and **re-exports them as pi
tools** — automatically named, typed, and described. Auth per server via the
vault (creds never in settings).

- Overnight, apple-pi gains GitHub, Slack, Postgres, filesystem, Linear,
  Sentry, … — everything in the MCP ecosystem + Registry.
- This *is* the user's "dynamic API wrapper, one code all APIs" — built on
  the open standard instead of reinvented.
- Companion: an **`/mcp add <openapi-url>`** command that spins up a throwaway
  openapi→MCP server for any REST API without an existing server.
- Red/blue must-run: MCP servers run arbitrary code; bridge must sandbox,
  require explicit allowlist, and never auto-trust a server. This is the
  highest-risk feature in the doc — see §5.

### 🥈 P2 — **ingress bus** (the "every stream points in" primitive)
**Leverage: huge · Risk: high · Effort: medium · Primitive**

A unified way for external events to **enter the agent's awareness** without
the user manually prompting. Today every prompt is human-typed. Ingress
changes the model to "things happen in the world → the agent notices → acts
or surfaces." Concretely:

- **Pollers**: `cron`-like jobs (extend the autoresearch scheduler) that pull
  RSS/Atom, an API endpoint, a webpage-diff, a mailbox, then inject a
  `user`-role message into a target session ("📦 3 new GitHub issues matching
  X").
- **Webhooks**: a local HTTP endpoint (or a Cloudflare Worker / n8n inbound
  bridge for NAT-traversal) that receives events → injects. Authenticated
  (HMAC) and rate-limited.
- **Debounce + digest**: configurable so the agent isn't spammed; a morning
  digest is the friendly default.
- This + MCP = the classic "agent that watches your stack and acts." Red/blue
  must-run: ingress is the biggest attack surface in the doc — see §5.

### 🥉 P3 — **datasource registry** (`/sources`)
**Leverage: high · Risk: low · Effort: small-medium · Primitive (UX layer)**

A single command/UI for the user to **add any data source** ("add all data
sources the user wishes"), unifying MCP servers, ingress pollers, and vault
creds under one mental model:

```
/sources                          # list, with health (last fetch, last error)
/sources add rss https://…        # → creates an ingress poller
/sources add mcp github           # → registers an MCP server (via vault cred)
/sources add api openapi.json     # → openapi→tools adapter
/sources add scrape https://… "selector"  # → web_fetch on a schedule
/sources remove <id>
/sources pause <id>
```

This is the user-facing tip of P1+P2. Without it, those are power-user-only.

### P4 — **phone surface** (Telegram-first, then PWA)
**Leverage: medium-high · Risk: medium · Effort: small (TG), large (PWA) · Surface**

Make the phone a real action point:

- **Phase 1 (cheap, high-impact):** promote the existing Telegram bridge from
  "outbound replies" to a **full-duplex surface** — the user prompts from
  their phone, the agent can ask back via `ctx.ui`-equivalent (select/confirm
  over chat), results stream. This is *the* phone surface for ~zero effort.
- **Phase 2 (later):** a PWA (`/m`) with a small backend that proxies to the
  harness over the ingress bus. Real "app" feel without app stores.

### P5 — **dynamic API wrapper** (fallback for non-MCP APIs)
**Leverage: medium · Risk: medium · Effort: medium · Point feature, but folds into P1**

The user explicitly named this. Reality check: **MCP + OpenAPI→tools (P1
companion) covers ~all of it.** The only gap is bespoke scrapers for sites
with no API and no MCP server — and the web extension already does that
manually; what's missing is *scheduling* (which is P2). So this feature is
**mostly subsumed by P1+P2**. Don't build a parallel "dynamic wrapper"
framework — build P1, then add an openapi-loader.

### P6 — **unified notification egress**
**Leverage: medium · Risk: low · Effort: small · Surface**

One `notify()` primitive the agent calls; settings route it to whatever
surfaces the user has (Telegram, macOS notification, a webhook, email).
Means "the agent reaches me wherever I am" without per-channel code.

### P7 — **session-as-mailbox / async turns**
**Leverage: medium · Risk: low · Effort: medium · Enabler for P2/P4**

Let an ingress event or a phone prompt target a *specific session* by id,
and let turns run in the background (the harness is single-threaded today).
Without this, ingress + multi-surface fight each other for the foreground.

---

## 4. The unifying architecture (target state)

```
                         ┌─────────────────────────────────────┐
   SOURCES (ingress)     │            apple-pi harness          │   SURFACES (egress)
   RSS/Atom poller  ───▶ │  ┌──────────────────────────────┐   │ ◀─── pi TUI (laptop)
   webhook inbound  ───▶ │  │   one agent, one session tree │   │ ◀─── /voice (pivoice)
   mailbox watcher  ───▶ │  │   any model you bring         │   │ ◀─── Telegram (phone)
   scrape-on-cron   ───▶ │  └──────────────┬───────────────┘   │ ◀─── PWA /m (later)
                         │                 │                   │ ───▶ notify() → any channel
   ADAPTERS (call out)   │     tools ──────┤                   │
   MCP servers      ◀─── │  (auto-discovered, vault-authed)    │
   OpenAPI→tools    ◀─── │  web/browser · vault · n8n · forgejo│
   web/browser      ◀─── │  …                                  │
                         └─────────────────────────────────────┘
                  creds for all of the above live in the 🔐 credential vault
```

Three primitives (P1 adapters, P2 ingress, P3 registry UX) + two surface
upgrades (P4 phone, P6 notify) get the user to the vision. P5 is subsumed.
P7 is the enabling refactor.

---

## 5. Red/blue — the vision's threat model (read before building)

This is the highest-risk direction apple-pi has taken. Call it out now:

- **MCP servers run arbitrary code.** A malicious or buggy server can do
  anything the user can. Mitigations: explicit allowlist in settings, per-
  server consent on first use, sandbox/container option, never auto-trust a
  server from the Registry. Treat MCP servers like `npm install` — review
  before running.
- **Ingress = an inbound attack surface.** A webhook reachable from the
  internet that injects `user`-role messages is, functionally, remote code
  execution via prompt injection. Mitigations: HMAC-signed events only,
  rate-limit, allowlist source IPs/hostnames, **ingress messages carry an
  untrusted-marker** and the persona must treat them as data-not-instruction
  (the existing red-blue skill gets a new rule). This is the single most
  important security decision in the whole plan.
- **Credential blast radius grows.** Today the vault holds a few API keys.
  Post-vision it holds keys for *everything the user owns*. The vault's
  existing design (encrypted, trace-free, gated reveal) is the right
  foundation; add per-entry scoping ("this key only usable by MCP server X")
  and an audit log of reveals.
- **Prompt-injection from scraped/web content.** `web_fetch` and scrapers
  ingest attacker-controlled text. The persona already has a "treat external
  content as data" rule from the red-blue skill; ingress + scrapers make it
  load-bearing. Reinforce it; consider a content-quarantine tool wrapper.
- **Phone surface = the agent acts when you're not at the keyboard.** Destructive
  actions from the phone need a *higher* confirm bar, not lower. The persona's
  "confirm before irreversible" rule must be surface-aware.

Net: the vision is achievable **only if** the security model is upgraded in
lockstep — untrusted-ingress marking, MCP-server consent, vault scoping. This
is not a polish item; it's a prerequisite. Roughly 30% of the effort of any
phase here is the red/blue work, not the feature.

---

## 6. Phased plan (leverage-ordered, each phase independently shippable)

**Phase A — Adapters (the "all APIs" win, biggest bang).**
P1 (`mcp-bridge`) + the openapi-loader companion + P3 (`/sources` UX, MCP
slice only). Ship this and "one agent, all APIs" is real, backed by the open
standard. Red/blue: MCP consent + vault auth + sandbox option.

**Phase B — Ingress (the "every stream points in" win).**
P2 (ingress bus: pollers + authenticated webhooks + debounce/digest) + P7
(session-as-mailbox so ingress doesn't fight the foreground). Red/blue:
untrusted-marker on ingress messages, HMAC auth, rate-limit, persona rule
update. **Do not ship before the untrusted-marker exists.**

**Phase C — Surfaces (the "lives everywhere" win).**
P4 phone surface (Telegram-first full-duplex, then PWA) + P6 unified notify.
Builds on A+B (the agent finally has things to surface and ways to be reached).

**Phase D — Polish & ecosystem.**
P5 (fold any remaining scrape/API gaps into the registry), an MCP-Registry
browser (`/mcp browse`), cookbook recipes, the security-audit-log for vault
reveals.

Each phase is a parent card with its own SPEC.md + REQ-N-M hooks (per the
plan-decompose skill). Phase A is the recommended starting point — it
delivers the headline feature on the open standard and its red/blue work
(MCP consent) generalizes to B and C.

---

## 7. Decisions to make before any code

1. **MCP-first vs. roll-your-own adapters?** Recommendation: MCP-first
   (don't reinvent; ride the ecosystem). This is the load-bearing strategic
   call.
2. **Ingress trust model.** Is ingress content ever allowed to issue
   instructions, or always data-only? Recommendation: **always data-only**
   with a hard untrusted-marker; the agent surfaces it but treats it as
   evidence, never command.
3. **Phone = Telegram now, PWA later, or native never?** Recommendation:
   Telegram now, PWA if it proves limiting, native never (not worth it).
4. **Does apple-pi host inbound webhooks, or proxy via n8n/Cloudflare?**
   Recommendation: proxy by default (no open port on the user's machine),
   direct local only as an opt-in advanced mode.

---

## 8. What this doc deliberately does NOT do

- It does not pick technologies for the PWA, the MCP SDK, or the webhook
  auth scheme — those belong in each phase's SPEC.md.
- It does not estimate timelines — leverage-ordered, not time-ordered.
- It does not duplicate the existing extension inventory (web/vault/voice/
  n8n/forgejo/telegram/netbird/kanban are the starting point, not repeated
  here).
- It is not a build spec. Next step: pick Phase A, write
  `.docs/features/everywhere/PHASE-A-SPEC.md`, decompose to cards.

## See also
- `.docs/features/credential-vault/` — the credential foundation all adapters need
- `.docs/web-extension.md`, `.docs/voice-integration.md` — existing adapter/surface precedents
- pi docs: "no built-in MCP … build as extensions" (`docs/usage.md`) — the green light for P1
- MCP: https://modelcontextprotocol.io · Registry: https://modelcontextprotocol.io/registry/about
