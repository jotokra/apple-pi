# Documentation — vision, usability, how-to (2026-06-27)

> Decisions doc for a doc-only pass: make the **vision** (why apple-pi),
> **usability** (how to use it day-to-day), and **how-to** (task guides)
> genuinely clear. The README had grown piecemeal (vault/voice/web/autoresearch
> sections stacked on top of an install quickstart) and never had a thesis.
> Branch `docs/vision-usability-howto`; one commit per deliverable; PR to main.

## The three gaps (diagnosis)

1. **Vision.** The README opens with mechanics ("boots, proves, destroys,
   tunes") but states no *bet*. A visitor can't say why they'd pick apple-pi
   over vanilla `pi` (powerful but you write all config + methodology) or a
   cloud agent like Claude Code (easy start but vendor account, one model
   family, telemetry). The landing page HAS a thesis ("Most AI tools ask for
   your API key and leave it sitting in a file forever"); the README — the
   canonical front door — doesn't.
2. **Usability.** "Using apple-pi after install" was 3 lines. The post-install
   picture was fragmented across 6 stacked feature sections. No first-session
   walkthrough, no consolidated slash-command reference, skills listed by name
   only.
3. **How-to.** Install + flags covered. No task guides for: add a second key,
   change model / re-tune, wire a workflow, use voice, keep current,
   troubleshoot.

## The structure decision (D-doc-1)

Three layers, each with one job, no duplication:

| Layer | File | Job |
|---|---|---|
| Storefront + vision + quickstart + usability | `README.md` | the front door: why, install, day-1 use, command reference, skill glossary |
| Task guides | `docs/HOWTO.md` | anchored how-tos, linked from README's "How-to guides" index |
| Landing (marketing hook) | `docs/index.html` | unchanged — it already has a thesis; just must not contradict README |

**Why one `docs/HOWTO.md` and not a `docs/guides/*.md` tree:** at this scope
(~6 tasks) a single file is greppable, one-thing-to-maintain, and anchor links
give deep-linking from the README index. If a section outgrows, split later.

## Sanitize hygiene fix (D-doc-2)

`smoke/sanitize.sh` scanned `(config lib install.sh README.md LICENSE .docs)`
— **`docs/` was excluded**, so the new `docs/HOWTO.md` wouldn't be tripwired
for personal-info leaks. Add `docs` to `SCAN_PATHS` so the whole shipped tree
(config + lib + docs + .docs + README + install.sh + LICENSE) is covered. The
landing `docs/index.html` already shipped personal-info-free by inspection;
this just enforces it going forward.

## Deliverables (one commit each)

1. **spec** — this decisions note.
2. **smoke** — add `docs` to sanitize `SCAN_PATHS` (+ assert `docs/HOWTO.md`
   exists in `structure.sh` so it can't be silently deleted).
3. **README** — new "Why apple-pi" (vision) near the top; restructure
   "Using apple-pi" into first-session walkthrough + consolidated command
   reference + skills-at-a-glance; add "How-to guides" index linking to
   `docs/HOWTO.md` anchors.
4. **docs/HOWTO.md** — the task guides: keys, model change/re-tune, workflows,
   voice, updates, troubleshooting.

## Verification

- `bash smoke/run.sh` green (sanitize now covers `docs/`; structure asserts
  HOWTO.md exists; all vault/other smokes unchanged).
- Manual read-through: a fresh visitor can answer, from the README alone:
  "why this?", "how do I start a session?", "what do I type?", and jump to a
  how-to for a specific task.
- No personal-info leak (sanitize grep); no contradiction with the landing
  page thesis.

## Out of scope

- Rewriting the landing page (`docs/index.html`) — its thesis is already
  strong; aligning it to the README's new vision is a separate marketing pass.
- A rendered docs site (mkdocs / gitbook). Markdown rendered on github.com is
  the channel; a rendered site is a later product decision.
- Per-skill deep-dive pages — the skills ship their own `SKILL.md`; the README
  glossary links conceptually, not to each (one line each is enough at this
  level).
