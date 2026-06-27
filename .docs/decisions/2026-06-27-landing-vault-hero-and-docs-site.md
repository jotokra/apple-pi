# Landing vault-hero + rendered docs site (2026-06-27)

> Decisions doc for two post-doc-pass polish deliverables the user green-lit
> ("Go!"): (A) a hero treatment of the credential vault on the landing page,
> and (B) a rendered docs site. Branches `docs/landing-vault-hero` (A) and
> `docs/rendered-guide-site` (B); one PR each. The headline decision is the
> **B toolchain** (mkdocs vs VitePress) — that is the part the user
> explicitly delegated ("both genuinely your call").

## A — vault hero on the landing page

### Diagnosis
F3 (PR #2) placed the vault callout as one item in the bottom "In the box"
grid (`docs/index.html` `.box`), beside the persona/skills/extensions items.
That's accurate but underweights the product's single most differentiated
feature: the pitch opens with *"Most AI tools ask for your API key and leave
it sitting in a file forever"* — the vault is the answer to that thesis, and
it should read as such, not as a grid cell at the bottom.

### Decision (D-polish-1)
Add a dedicated, full-width `#vault` section **immediately after the four
pillars** (narratively: thesis → four advantages → *where your keys live* →
onboarding lifecycle). It is NOT folded into the hero (the 🥧 + install box
is the marketing front door; displacing it hurts conversion) and NOT left in
the bottom grid (kept there too, as the detailed bullets — the hero section
is the *elevator pitch*, the grid item is the *spec*).

Visual treatment: a prominent lockup card (lock icon + bold headline + the
four promises as a tight row + the honest threat-model footnote), distinct
from `.pillar`/`.loop` so it reads as a feature spotlight, not another tile.
Reuses the existing palette (no new CSS variables).

### Out of scope (A)
- Touching the hero itself (install box / CTAs) — the hero is the front
  door; the vault hero is a *section*, not a takeover.
- Replacing the bottom grid vault item — it stays as the detailed spec; the
  new section is the elevator pitch. (Two treatments of the same feature at
  different altitudes is correct, not duplication.)

## B — rendered docs site

### Options considered (the delegated call)
| Option | Toolchain | Notes |
|---|---|---|
| **mkdocs-material** | Python (build) | The de-facto standard; instant recognition; but introduces a Python build tool to an otherwise Python-free-at-runtime project. |
| **VitePress** | Node (build) | Modern default theme (search, dark mode, sidebar) out of the box; node toolchain matches the project. |
| Docsify | none (runtime JS) | No build; but poor SEO (client-rendered) and a step down in polish. |
| Port landing into a generator's home | — | Replaces the hand-crafted landing; rejected (see D-polish-2). |

### Decision (D-polish-2): VitePress, served at `/guide/`, landing stays at `/`
- **Toolchain cohesion is the deciding factor.** This project has gone out
  of its way to be Python-free at runtime — the autoresearch lifecycle uses
  `node:sqlite` *specifically* to avoid a Python dependency (decisions doc
  `2026-06-27-autoresearch-lifecycle.md`). A node-based docs generator
  (VitePress) keeps the maintainer's `npm`-everywhere workflow consistent;
  mkdocs would be the lone Python build tool in a node/bash repo. The build
  runs in CI only — zero runtime impact either way — but a contributor who
  `npm install`s the project can also `npm run docs:build` without a second
  language runtime. (The voice bridge's `pivoice.py` is a small STT shim in
  the whisper.cpp ecosystem, not a general Python toolchain dependency; it
  doesn't change this calculus.)
- **VitePress's default theme is best-in-class for a modern product** — dark
  mode, local search, sidebar nav, edit-this-page link, responsive — with
  near-zero config. mkdocs-material is comparable; the differentiator here is
  toolchain fit, not theme quality.
- **Subpath, not takeover.** The marketing landing (`docs/index.html`) is a
  deliberate, polished artifact (🥧 hero, pillars, flow, loops). A docs-site
  generator naturally wants to own `/`; fighting it risks the landing's
  bespoke design. Serving the guide at `/guide/` (the standard "marketing at
  root, docs at subpath" pattern) preserves the landing untouched and gives
  the docs their own navigable home. The landing gets a new **"Read the
  docs"** CTA → `/guide/`; the guide links back Home → `/`.

### Architecture (D-polish-3)
- New top-level `guide/` dir = VitePress srcDir (`guide/.vitepress/config.ts`,
  `guide/index.md`, topic pages).
- New root `package.json` (devDep `vitepress`, scripts `docs:dev` /
  `docs:build`). Kept minimal; does not touch the shipped product config.
- VitePress `base: '/apple-pi/guide/'` (repo-name-prefixed, the Pages
  convention) so asset paths resolve on GitHub Pages.
- CI (`.github/workflows/pages.yml`) reworked: build VitePress → assemble the
  Pages artifact as `docs/index.html` (+ assets) at the artifact **root** and
  the built guide at `guide/`. Single deploy step; the landing URL is
  unchanged.
- **Anti-drift:** the guide's substantive pages source from the canonical
  repo files rather than re-typing them — the how-to page renders
  `docs/HOWTO.md` (one source of truth via a CI copy + frontmatter, or
  VitePress's markdown include if it renders cleanly). Dense reference pages
  (commands, skills) summarize + link to the GitHub README anchors (canonical
  for the repo front door) rather than duplicating verbatim. Principle: the
  guide's value is navigation + search + theming, not a second copy of the
  text.

### Verification (B)
- `npm run docs:build` succeeds locally; output inspected (home, howto, nav,
  search, dark mode).
- Deployed Pages site: landing at `/` unchanged; guide reachable at `/guide/`
  with working nav + cross-links both directions.
- `smoke/sanitize.sh` still green (guide copy contains no personal info — it
  only references repo files). Add `guide` to `SCAN_PATHS`.
- A new `smoke/docs-build.sh` asserts `npm run docs:build` exits 0 (so a
  broken guide can't ship silently).

### Out of scope (B)
- Versioning the docs (VitePress/Crowdin-style i18n / versioned snapshots) —
  one canonical latest, for now.
- A custom VitePress theme — the default theme is the point; brand-matching
  (warm palette) is a later polish if the default feels too generic.
- Search beyond VitePress's built-in local search (no Algolia).

## Sequencing
A first (small, content-only, fast win, no CI risk), merge, then B
(infrastructure). The two are independent; ordering is risk-management, not
dependency. This decisions doc rides the A branch (it documents both so the
toolchain rationale lands in `main` before B implements it).
