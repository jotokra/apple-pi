---
name: config-sync
description: "Sync your ~/.pi config across devices with `apple-pi sync` (or `/sync` in the TUI). Multi-device: init on the origin device, clone on others, push/pull daily, consolidate to fold another device's branch in. Safe by construction — secrets (auth, vault, sessions, browser profile) never leave the device. Trigger phrases: sync my config, sync across devices, sync pi config, consolidate from another device, fold device branch, push config to github."
---

# config-sync

Keep the **portable** part of `~/.pi` (skills, extensions, prompts, the agent
contract, learnings, portable settings tuning) in a private git repo so it
moves between machines. Secrets never leave the device — by construction, not
discipline.

## The model: three path classes

`apple-pi sync` classifies every path via a computed authority
(`sync/lib/paths.js`):

- **portable** — syncs; merges cleanly. `skills/`, `extensions/`, `prompts/`,
  `agent/AGENTS.md`, `agent/self-assessment-*.md`, `voice/`,
  `agent/settings.portable.json` (the portable settings extract).
- **deviceLocal** — committed, reconcile per-device, **don't overwrite**.
  `agent/models.json`.
- **secret** — **NEVER tracked.** `auth.json`, `agent/auth.json`,
  `agent/credentials.vault`, `sessions/`, `browser-profile/`.
- **deviceOnly** — per-machine, not portable. `agent/settings.json` (has
  device paths/model), `caddy-root.crt`, `agent/trust.json`, `.apple-pi-source`.

settings.json is split (S-6): the device-specific original is gitignored; a
portable extract (`settings.portable.json`) is tracked and merged on pull
preserving device fields byte-for-byte.

## The commands

```bash
apple-pi sync init [--remote URL] [--no-push] [--name REPO] [--yes]
#   Origin device → main. git init, write the default-deny .gitignore, install
#   the secret hook, create/link a private GitHub repo (gh) or use --remote,
#   commit the portable set, push.

apple-pi sync status     # branch, remote, hook health, dirty portable, unpushed
apple-pi sync push       # pre-flight secret scan, commit dirty portable, push
apple-pi sync pull       # fetch + ff-only; merges portable settings, keeps device fields
apple-pi sync doctor     # health + FULL-GIT-HISTORY secret scan (catches pre-hook leaks)
apple-pi sync consolidate <branch>   # fold another device's branch in (STAGE + PRINT)
```

In the TUI: `/sync <status|push|pull|doctor|consolidate|init>`.

## The daily loop (one device)

```bash
apple-pi sync status     # see what's unpushed
apple-pi sync push       # commit + push portable changes
```

## Multi-device setup

1. **Origin device:** `apple-pi sync init` (creates the private repo, pushes `main`).
2. **Each other device:** clone the repo into `~/.pi`, `git config core.hooksPath
   .githooks`, set up that device's own secrets (auth via `/vault`/`pi --login`),
   then work on `main` or a `device/<host>` branch and `push`.

## Consolidating another device's config (the payoff)

When device B has portable improvements you want on device A:

```bash
# on device A (main):
apple-pi sync consolidate origin/device/B
```

It classifies the three-dot diff (what B changed since divergence) and:
- **stages** portable changes (new skills, updated extensions) into the index,
- **skips** device-local (A's models.json preserved),
- **refuses** any secret/unknown path (exit non-zero — a secret in the diff
  means B's gitignore is broken).

Then it **prints** the suggested `git commit` + `git push` — it does NOT
commit, push, or auto-PR (frozen decision: stage + print, review first).

Review with `git diff --cached`, then commit + push the printed commands.

## The safety model (why secrets can't leak)

Four layers, defense in depth:
1. **Computed classification** — one authority derives path classes from pi's
   actual layout.
2. **Default-deny `.gitignore`** — ignore everything, allowlist portable +
   deviceLocal. A new unknown file is never tracked.
3. **Cross-platform Node pre-commit hook** — refuses secret paths AND scans
   staged content for real provider key shapes (`sk-…`, `gho_…`, `AKIA…`,
   `xai-…`, `AIza…`). Fails closed if `apple-pi` is missing.
4. **`push` always pre-flights**, even on a clean tree — a force-staged secret
   can't slip through the "nothing to push" exit.

`doctor` adds the deep check: a **full-git-history** scan for key shapes —
catches secrets committed before the hook existed or force-pushed around it.
If it finds one, rotate the key and purge history (`git filter-repo` / BFG).

## Red line

If a provider key, token, or passphrase ever lands in a committed file,
**rotate it immediately.** The hook catches common shapes; treat any leak as
compromised.

## See also

- `sync/README.md` (in the apple-pi repo) — engineering docs for the feature.
- `.docs/decisions/2026-06-28-config-sync-feature.md` — the design spec +
  build log.
- `red-blue` — the secret-handling review this feature's safety model was
  built against.
