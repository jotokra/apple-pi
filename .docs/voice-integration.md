# voice integration — feature spec (apple-pi × pivoice)

> Bundle **pivoice** (the voice front-end we built at `~/pivoice`) into apple-pi
> as a first-class capability: type in the pi TUI, flip to voice, talk, flip
> back — **same conversation**. Plus an update story that distinguishes
> *self-improvement* from *release updates*.

## Why

The user works with apple-pi both ways — keyboard for precision, voice for
flow. Today those are two separate sessions in two separate processes with no
shared memory. The goal: **one continuous conversation** that you can drive
either way, on demand, without copy-paste.

## Architecture (verified against ground truth)

### Session handoff — the crux

pi sessions are **append-only JSONL with a tree structure**, stored under
`~/.pi/sessions/`. Confirmed flags:

- `pi --session <path|id>` — resume a **specific session file**.
- `pi -c` — continue most recent.
- RPC `get_state` returns `sessionFile`; the extension API exposes
  `ctx.sessionManager.getSessionFile()`.

So **pivoice can open the very file the TUI was using.** Voice turns append to
it; when the TUI resumes, the tree shows them. That *is* "take the session into
voice mode and bring it back" — it's the same file.

### Why not a pure in-process TUI handover

An extension command handler runs **inside the pi TUI process**, which owns the
terminal (raw mode, alt screen, render loop). pi exposes **no
terminal-suspend/leave-alt-screen primitive** to extensions. Two TUIs can't
share one TTY safely. Therefore `/voice` is a **launcher/bridge**, not a
live in-process overlay:

- It reads the active `sessionFile` (or continues recent if ephemeral).
- It spawns `pivoice` against that file in **the foreground**, inheriting the
  TTY. (On macOS the cleanest UX is "leave the TUI, enter voice, return"; the
  command prints the exact exec line + offers a one-key launch.)
- `pivoice` opens the session via `pi --mode rpc --session <path>`, does voice
  turns (appended to the file), exits on `q`.
- The user resumes the TUI (`pi -c` or `/resume` → pick the same session); the
  tree now contains the voice turns. `session_start {reason:"reload"}` fires.

This is honest about the constraint and fully delivers the intent.

## Components

### C1 — bundle pivoice as a pi package

`config/voice/` ships the pivoice app as a standalone, installable pi package:
- `pivoice.py` — the app (moved in, path-portable).
- `bin/pivoice` — thin launcher (so `pivoice` works on PATH after install).
- `package.json` — pi package manifest (`pi.extensions: ["./voice.ts"]`) +
  `pi.bin` so `pi run pivoice` / `npx` work.
- `README.md` — standalone usage (mirrors the `~/pivoice/HOWTO`).
- python3 + ffmpeg + whisper.cpp + `say` are **runtime deps**, documented; the
  installer offers `brew install` for them (best-effort, never fail).

`config/extensions/voice.ts` — the bridge extension:
- Registers `/voice` command + `Ctrl+V` shortcut (TUI only, `ctx.mode==="tui"`).
- Handler: resolve session file → if none, continue-recent → print the launch
  line + `ctx.ui.confirm` to exec now; on confirm, `child_process.spawn` pivoice
  with `stdio: "inherit"` against the session, await it; on return, notify +
  suggest `/resume`.
- `PIVOICE_SESSION` env var passed to pivoice so it resumes instead of starting
  fresh.

pivoice change (in the bundled copy): `PiBridge.start` adds `--session <path>`
when `PIVOICE_SESSION` is set (resume) instead of always `-n voice` (fresh).

### C2 — wiring (install.sh + settings + smoke)

- `install.sh`: copy `config/voice` → `$PI_DIR/voice`; symlink `bin/pivoice`
  into a PATH dir (or document adding `$PI_DIR/voice/bin` to PATH); best-effort
  `brew install` of ffmpeg + whisper-cpp + python3 (warn-only). New placeholder
  `__APPLEPI_VOICE_DIR__`.
- `settings.json.template`: register the bridge extension
  (`__APPLEPI_EXT_VOICE__`) + the `/voice` command's tool (none needed — it's a
  command, not a tool; just the extension entry).
- `smoke/structure.sh`: assert the voice package is present
  (`config/voice/pivoice.py` + valid manifest); add `__APPLEPI_VOICE_DIR__` to
  placeholder + render tests.
- `smoke/sanitize.sh`: voice tree already under `config/` → auto-scanned.

### C3 — update + versioning story

Two **distinct** change channels, made explicit in docs:

1. **Self-improvement** (the autoresearch loop): behavioral/config drift
   detected from *your own session telemetry*, proposed weekly, **you review +
   apply**. `apple-pi review` / `apply`. Tagged in the brief as `source: autoresearch`.
2. **Release updates** (new code): new apple-pi / pivoice / extension versions
   from GitHub. `apple-pi update` wraps `pi update --all` **+ a pivoice-specific
   version check**. Weekly (folded into the existing Monday aggregate job) it
   also runs a non-interactive `apple-pi update --check` that records "new
   version available" into the brief as `source: release`.

Deliverables:
- `bin/apple-pi update [--check|--all|--voice]` subcommand:
  - `--check`: fetch latest release tags from GitHub (apple-pi, pivoice) via
    `gh api` or raw `https://api.github.com/repos/.../releases/latest`; compare
    against a `config/VERSION` / recorded version; print a human diff.
  - `--all`: `pi update --all` + git-pull apple-pi + reinstall pivoice deps.
  - `--voice`: just the pivoice package.
- `config/voice/VERSION` + `config/VERSION` — single source of truth.
- `lifecycle/aggregate-week.js` gains a hook: before writing the brief, run
  `apple-pi update --check` and append a `source: release` section. Brief
  clearly labels each proposal by source.

### C4 — docs + landing page

- README: "Voice mode" section + "Two kinds of improvement" section
  (self-improvement vs release updates).
- `docs/index.html`: voice card + an "improves two ways" explainer.
- `config/voice/README.md`: standalone usage (the `~/pivoice/HOWTO` content).

## Verification (per card)

- **C1**: `pi -e config/extensions/voice.ts` loads; `/voice` resolves; pivoice
  launches against a temp session file and appends a turn; session file grew.
  Headless: simulate the spawn without a TTY (assert command construction).
- **C2**: full `smoke/run.sh` green; install dry-run renders the bridge into
  settings; `apple-pi` (the CLI) boots.
- **C3**: `apple-pi update --check` runs offline-safe (no network → clear
  message, exit 0); against a stubbed releases endpoint returns a clean diff;
  aggregate brief includes a `source: release` block.
- **C4**: HTML balanced; one-liner tripwire intact; smoke green.

## Non-goals

- No live in-process voice overlay (terminal-ownership constraint; see above).
- No automatic release installation (always user-gated; `--check` is read-only).
- No new Python deps (pivoice stays stdlib-only).
- pivoice's standalone repo (`jotokra/pivoice`) remains the upstream; the
  bundled copy is a vendored snapshot kept in sync by `apple-pi update --voice`.
