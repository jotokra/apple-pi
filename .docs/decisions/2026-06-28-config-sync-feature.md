# apple-pi config sync — feature spec (Path C)

## Identity
- **Pitch:** ship multi-device `~/.pi` config sync as a first-class `apple-pi sync` feature, with pi-owned path classification as the security authority.
- **Scope (in):** `apple-pi sync` CLI subcommand + `/sync` TUI extension; classification engine; `.gitignore` + cross-platform Node secret hook generated from the classification; init/push/pull/status/doctor/consolidate; settings.json profile split; onboarding offer; docs.
- **Scope (out):** changing pi core's config file format (done via sync-time transform, not a pi-core change); supporting non-git backends; encrypting secrets for transport (secrets stay local by construction — never tracked).
- **Owner:** apple-pi (this repo). Shipped as a top-level `sync/` dir + `config/extensions/sync.ts`, mirroring the `vault/` pattern.

## Vision
The manual `.pi`-config-repo we built works but has six load-bearing weaknesses (classification knowledge is implicit and rots; allowlist rots; the hook is shell + per-clone; secret detection is shape-regex only; `settings.json` reconciliation is pushed onto the agent with no structural help; cognitive load is expert-only). The root fix: **pi owns the path classification** because pi wrote those files — git doesn't. Everything else (`.gitignore`, hook, export, consolidator) reads from one classification engine. The feature turns "expert does a manual repo" into `apple-pi sync init` → push/pull/consolidate, safe by construction.

## Use cases
1. **U1 (init):** on a fresh or existing install, `apple-pi sync init` sets up a private GH repo (or links an existing remote), writes the `.gitignore`, installs the hook, commits the portable set, pushes. One command, no git craft.
2. **U2 (daily):** `apple-pi sync push` commits portable changes; `apple-pi sync status` shows what's unpushed and confirms zero secrets staged. `pull` brings portable changes down.
3. **U3 (new device):** `apple-pi sync clone <repo>` checks the repo out into `~/.pi`, restores device-local files from templates/prompts, never touches local secrets, sets the `device/<host>` branch.
4. **U4 (consolidate):** `apple-pi sync consolidate device/phone` classifies the other device's diff into portable / device-local / secret, presents a cherry-pick picker, never auto-overwrites device-local, never merges secrets.
5. **U5 (health):** `apple-pi sync doctor` verifies remote reachable, hook active, classification current, **scans full git history for leaked key shapes**, no device-local accidentally tracked.

## Architecture

```
            ┌─────────────────────────────────────────┐
            │  sync/lib/paths.js  ← THE AUTHORITY      │   Card S-1
            │  classify(piDir) → {portable,            │
            │     deviceLocal, secret, deviceOnly}     │
            └─────────────┬───────────────────────────┘
                          │ read by everyone
          ┌───────────────┼───────────────────┬───────────────┐
          ▼               ▼                   ▼               ▼
   sync/lib/gitignore  sync/hook/         sync/lib/      sync/lib/classify
   + Node hook         pre-commit.cjs     profile.js     (diff→buckets)
   (S-2)               (S-2)              (S-6)          (S-7)
          │
          ▼
   sync/cli.js  ← dispatch: init/push/pull/status/doctor/consolidate/clone
   sync/lib/repo.js  ← gh detection + git ops            Cards S-3..S-5,S-7
          ▲
          │ bin/apple-pi:  case "sync": require("./sync/cli.js").run(rest)
          │
   config/extensions/sync.ts  ← /sync TUI commands (delegates to CLI)  Card S-8
```

The classification engine (`paths.js`) is pure, side-effect-free, and the only place that knows the path classes. It derives them from pi's actual layout (read `settings.json` for `sessionDir`; resolve `auth.json`, the vault, the browser profile) rather than a static list, so it stays correct when pi adds paths. `doctor` re-runs it and diffs against the committed `.gitignore` to detect drift.

## Stack
- **Node (CommonJS `.js`)** for `sync/` — matches `vault/cli.js`, `lifecycle/*.js`. `"use strict"`, `node:` built-in prefixes. No ESM, no deps (stdlib + `git`/`gh` via `child_process`).
- **TypeScript** for `config/extensions/sync.ts` — matches `voice.ts`/`n8n-bridge.ts`.
- **Bash** for `smoke/sync-*.sh` — matches the existing smoke suite; header/fail/ok from `smoke/_lib.sh`.
- **Why no deps:** the whole point is the feature ships enabled-by-default and never needs `npm install`. stdlib only.

## Phased plan → cards

| Card | What | Deps | Parallel |
|------|------|------|----------|
| **S-0** | This spec (no code) | — | — |
| **S-1** | `sync/lib/paths.js` classification engine + smoke | S-0 | yes (foundation) |
| **S-2** | `sync/lib/gitignore.js` + `sync/hook/pre-commit.cjs` (Node, cross-platform) + smoke | S-1 | yes |
| **S-3** | `apple-pi sync init` + `sync/lib/repo.js` + bin dispatch + smoke | S-1,S-2 | no (spine) |
| **S-4** | `apple-pi sync push|pull|status` + smoke | S-3 | no (spine) |
| **S-5** | `apple-pi sync doctor` (incl. history secret-scan) + smoke | S-1,S-2,S-3 | after S-4 |
| **S-6** | `sync/lib/profile.js` settings.json portable/device split + smoke | S-1 | after S-4 |
| **S-7** | `apple-pi sync consolidate <branch>` cherry-pick picker + smoke | S-1,S-6 | after S-6 |
| **S-8** | `config/extensions/sync.ts` `/sync` TUI + **structure.sh count 9→10** + smoke | S-4 | after S-4 |
| **S-9** | docs (README/HOWTO/commands/usage) + onboarding offer + skill | all | after S-8 |

**Critical path:** S-0 → S-1 → S-2 → S-3 → S-4. S-1..S-5 together = the shippable core that replaces the manual repo. S-6/S-7/S-8/S-9 are enhancements, each independently committable.

## Frozen decisions
| Decision | Rationale |
|-----------|-----------|
| Classification is **computed** from pi's layout, not a static manifest file | No stored file to rot; one source of truth in `paths.js`. The "pi ships a manifest" upstream idea is deferred — not worth blocking on a dep we don't control. |
| `.gitignore` is **default-deny** (ignore `*`, allowlist) | Secrets live in the same tree; allowlist is the only safe default when new files appear. |
| Secret hook is **Node**, not shell, installed via `core.hooksPath` | Cross-platform (works on the Windows/Termux targets pi already supports); the hook ships in the repo so a fresh clone is guarded once `core.hooksPath` is set (which `init`/`clone` do). |
| Device identity = `hostname`, branch = `device/<host>` (origin device on `main`) | No state file; git itself encodes who's-who. |
| `settings.json` split is a **sync-time transform** (tracked `settings.portable.json` + merge-on-pull), not a pi-core change | Avoids touching pi's own config reader; portable subset is the git-tracked artifact. |
| Secrets **never** leave the device by construction (gitignored + hook + classification refusal) | No encryption-for-transport needed; the feature's security model is "can't commit it" not "encrypted at rest in a repo." |
| Smoke tests are **count-neutral** unless the card explicitly bumps a tripwire | Only S-8 (adds the 10th extension) and S-9 (adds a skill → 9th) touch the `structure.sh` counts. Every other card adds files outside the counted globs. |
| Commit messages: `feat(sync): …` / `test(sync): …` / `docs(sync): …` | Matches repo convention (`feat(mcp):`, `test(voice):`). |

## Risks + open questions
- **R1 (classification completeness):** if pi adds a new secret path `paths.js` doesn't know, a new device could leak it before an apple-pi release catches up. **Mitigation:** shape-regex hook is the backstop; `doctor --deep` scans history; default-deny gitignore means a *new* path is ignored until explicitly allowlisted (so the failure mode is "stops syncing" not "leaks"). The default-deny is the real safety net.
- **R2 (settings.json split correctness):** the portable/device field partition must be exactly right or `pull` corrupts a device's config. **Mitigation:** explicit allowlist of device-specific fields (`sessionDir`, `shellPath`, `defaultModel`, `defaultProvider`, `_models`); everything else portable; merge preserves device fields byte-for-byte; smoke round-trips a synthetic settings.json.
- **R3 (`gh` not present / not authed):** `init` must degrade to "paste a remote URL" for Forgejo/self-hosted, and never paste a token. **Mitigation:** detect `gh`, else prompt for remote URL; never write tokens to git config.
- **R4 (history secret scan false positives):** shape-regex over all history may flag example keys in docs. **Mitigation:** skip comment/doc lines; report as WARNING not BLOCKER for historical finds; link to `/vault rotate`.
- **OQ1:** should `consolidate` auto-open a PR (via the `gh-fix-pr` flow) or just stage + print the command? — **DECIDED (user, 2026-06-29): stage + print.** No auto-PR. The consolidator stages the cherry-picked portable changes and prints the suggested `git commit` + `git push` commands for the user to review/run. (Frozen decision — do not re-litigate.)

## Conventions
- Commit messages: `feat(sync):` / `fix(sync):` / `test(sync):` / `docs(sync):` / `chore(sync):`.
- File layout: `sync/` (CLI + lib + hook), `config/extensions/sync.ts`, `smoke/sync-*.sh`.
- Test runner: the existing `bash smoke/run.sh` suite. Each card adds a `smoke/sync-<name>.sh` and registers it in `run.sh`'s loop. `node --check` for every new `.js`.
- pi dir resolution: `process.env.PI_CODING_AGENT_DIR || ~/.pi` (same as `vault/cli.js`).

## Reading order (for future agents executing remaining cards)
1. This file.
2. `vault/cli.js` — the dispatch + pi-dir pattern `sync/cli.js` mirrors.
3. `smoke/mcp-bridge.sh` — the feature-smoke shape `smoke/sync-*.sh` mirrors.
4. `smoke/structure.sh` — the tripwire counts (S-8 bumps 9→10 extensions, S-9 bumps 8→9 skills).
5. The card being executed (its REQ-N-M list is the contract).

## Progress (build log)

| Card | Status | Commit | Notes |
|------|--------|--------|-------|
| S-0  | ✅ done | `1d6fea7` | this spec (cherry-picked at resume; original `e3a078d` on the abandoned `feat/config-sync`) |
| S-1  | ✅ done | `c79433f` | `sync/lib/paths.js` classification engine; smoke green (S-1.1..1.6) |
| S-2  | ✅ done | `514127b` | gitignore generator + Node secret hook; smoke green (S-2.1..2.5) |
| S-3  | ✅ done | `b1ab96c` | `init` + repo wiring + bin dispatch; smoke green (S-3.1..3.5 incl. end-to-end commit-block). Two real bugs found+fixed by the smoke (hook shim PATH resolution; `hook-run` CWD via `git rev-parse --show-toplevel`). |
| S-4  | ✅ done | `5f86cbe` | `push`/`pull`/`status`; smoke green (S-4.1..4.6). One real bug found+fixed (hookrun `git()` ignored the `dir` arg — push pre-flight scanned the wrong repo). |
| S-5  | ✅ done | `85c9d14` (pre-rebase) | `doctor` (health + full-history secret-scan). Bug fixed: device-local check printed unconditional OK. |
| S-6  | ✅ done | `b13ada4` (pre-rebase) | `sync/lib/profile.js` settings.json split. settings.json → deviceOnly (gitignored); settings.portable.json tracked. mergePortable preserves device fields byte-for-byte. |
| S-7  | ✅ done | `109e226` (pre-rebase) | `consolidate <branch>` — stage + print (OQ1 frozen: no auto-PR). Three-dot diff, refuses secrets, skips device-local. |
| S-8  | ✅ done | `428fdaa` | `/sync` TUI extension. Bumps ext count 9→10. Deliberate subset of CLI (no clone/hook-run). |
| S-9  | ✅ done | (this commit) | `config-sync` skill (bumps skill count 9→10) + user docs (README, guide/commands). Onboarding offer DEFERRED — see Open follow-ups. |

**Branch:** `feat/config-sync-v2` rebased on `main` `2001394` (2026-06-29). All 8 sync smokes + structure.sh green; counts 10 skills / 10 extensions. **Feature complete for v1** (S-0..S-9). Not yet merged to `main`.

## Open follow-ups (post-merge)

- **Onboarding offer for sync** (deferred from S-9): a one-question prompt in the install/onboarding flow — "Sync your config to a private repo?" → `apple-pi sync init`. Touches `install.sh` / the onboarding flow, which has active parallel work; defer until that settles.
- **`apple-pi sync clone <repo>`** (stub returns notYet): fresh-device checkout onto `device/<host>`, restores device-local from templates, never touches local secrets. The other half of the multi-device UX.
- **Interactive TUI picker for consolidate** (currently stage + print; a richer `inquirer`-style picker could live behind `/sync consolidate`).

## Resume procedure (next session)

```bash
cd ~/.apple-pi
git fetch --all
git checkout feat/config-sync-v2
git log --oneline main..HEAD            # confirm S-0..S-4 present
bash smoke/run.sh                       # or: for s in sync-paths sync-gitignore sync-init sync-pushpull structure; do bash smoke/$s.sh; done
# All green → pick up at S-5 (doctor). Read the S-5 row above + this spec's
# Phased plan for the REQ hooks.
```

If `main` has advanced, `git rebase main` — the sync files are additive (new `sync/` dir, new smokes) so conflicts should only be in `smoke/run.sh` (shared registration loop); resolve by keeping the union of registrations.

## Version history
- v0.1.0 (2026-06-28) — initial spec. Cards S-1..S-9 defined; executing in dependency order.
- v0.2.0 (2026-06-29) — S-0..S-4 shipped + verified on `feat/config-sync-v2`. Added Progress + Resume sections. Next: S-5.
- v0.3.0 (2026-06-29) — S-5..S-9 shipped. **Feature complete for v1.** doctor (history scan), settings.json split, consolidate (stage+print), `/sync` extension, config-sync skill + docs. Onboarding offer + `clone` deferred (see Open follow-ups).
