# 🥧 apple-pi

> **Delicious and warm. Better than other pi's.**

A refined, self-tuning distribution of the [Pi Coding Agent](https://pi.dev).
You bring a model and a key; apple-pi boots, **proves the model works,
destroys the bootstrap secrets**, then tunes its own config to that model's
real capabilities — and offers to wire in a workflow.

It packages a senior-engineer / red-blue-teamer **persona**, a methodology
**skill set** (spec-first, decompose, verify-own-work, red-blue,
self-improvement), and a privacy-respecting **onboarding wizard** into one
clone-and-run repo. **Zero personal information is shipped** — the
`smoke/sanitize.sh` tripwire enforces it.

---

## Why apple-pi

Most ways of giving an agent a key leak: `~/.zshrc` sprays it into every
process's env (`ps e`, crash dumps); `.env` gets `git add`'d by accident;
pasting it into chat lives forever in the session transcript. And most agent
configs are written for **one** model — switch models and you hand-tune the
knobs yourself, or you adopt a cloud agent that's easy to start but comes
with a vendor account, one model family, and telemetry.

apple-pi is the bet that there's a better middle:

- **The safe path is the easy path for keys.** `/vault` stores a key
  encrypted, enters it through a masked prompt that never touches your input
  line, and leaves **no trace** in sessions, telemetry, logs, or shell
  history. You stop pasting keys anywhere else because you don't need to.
- **It tunes itself to *your* model.** On install, and any time your stack
  changes, the `self-assess` ritual reads your model's **real** capabilities
  from the pi-ai catalog (context window, thinking model, vision, cost) and
  rewrites `settings.json` for it — from the code path, not from prose. Bring
  any model; the harness adapts.
- **Methodology arrives as skills, not opinions baked into the binary.**
  Spec-first planning, verify-your-own-work, red/blue review, decomposition —
  eight reusable skills you can read, run, edit, or remove. The agent is
  opinionated about *how* to work; you keep the right to disagree.
- **You own it.** Zero telemetry, zero vendor lock-in, MIT. Nothing phones
  home — `smoke/sanitize.sh` enforces that no personal data ships, on every
  change. It's a pi config plus a persona, not a service.

If you want raw `pi` with none of the opinions, use `pi` directly. If you
want a one-vendor cloud agent, use one. apple-pi is for the person who wants
the opinionated, privacy-first, self-tuning middle — and wants to own it.

---

## Quick start

**One line:**

```bash
curl -fsSL https://raw.githubusercontent.com/jotokra/apple-pi/main/install.sh | bash
```

…or clone-and-run:

```bash
git clone https://github.com/jotokra/apple-pi.git
cd apple-pi
bash install.sh
```

You'll need: a POSIX shell, `openssl`, and the `pi` binary
(`npm install -g --ignore-scripts @earendil-works/pi-coding-agent` — the
installer offers to do this).

Then answer four questions: **which model**, **which provider**, **your API
key** (or skip for an OAuth/subscription provider), and **a passphrase**
for the onboarding vault. That's it.

## What the onboarding wizard does

```
P0  WELCOME      greet + consent
P1  ONBOARD      model (ANY input accepted) → key → ENCRYPT → config → auth
                 → ONE confirm call → on success, DESTROY vault + scratch
                 → hand off to the agent
P2  DISCOVERY    the agent ASKS PERMISSION, then scans your environment
                 (read-only, secrets-free)
P3  SELF-IMPROVE the agent reads your model's REAL capabilities from the
                 pi-ai catalog and runs the self-assess ritual to retune
                 settings.json for THAT model
P4  INTEGRATED   announces readiness + tuned-config summary
P5  OFFER        offers ONE workflow: n8n / obsidian vault / monitoring
```

The split is deliberate: **bash bootstraps, the agent recognizes.** A
hardcoded model menu would defeat "any input accepted." The wizard stores
your free-form model string verbatim and the agent (running on that model
once confirmed) resolves it against ground truth — making a genuine attempt
on whatever you typed.

---

## Using apple-pi

### Your first session

```bash
pi
```

That's it. The persona loads (a senior-engineer / red-blue-teamer contract),
the skills auto-discover, and you're talking to your model. Try:

- `/decompose build a CLI tool that does X` — breaks the goal into
  independent tasks with verification hooks (the `plan-decompose` skill).
- `/spec design an n8n workflow for Y` — drafts a full spec without writing
  code (`/spec` + `/design` prompts).
- `/redteam review my last change` — finds every way it can break
  (the `red-blue` skill).

Re-run any time: `pi -p "…"` for a one-shot, `pi -r` to resume, `pi -c` to
continue after a voice session. Sessions are tree-structured — branch a
plan, navigate back.

### Commands

**In the TUI (`pi`):**

| Command | What it does |
|---|---|
| `/vault add` · `list` · `get` · `remove` · `rotate` · `lock` | encrypted, trace-free credential store (see [Credential Vault](#credential-vault)) |
| `/vault export <id>` · `export-to <id>` | bridge a key into `auth.json` or your own `vault.exportCmd` |
| `/voice` (or **Ctrl+Shift+V**) | type ⇄ talk, on-device (see [Voice mode](#voice-mode-type--talk)) |
| `/decompose` · `/spec` · `/redteam` · `/design` | the four methodology prompts |
| `/skill:self-assess` | re-tune the config to your current model |

**On the shell (`apple-pi …`):**

| Command | What it does |
|---|---|
| `apple-pi vault …` | headless vault access (`add` reads the secret from stdin) |
| `apple-pi collect` · `aggregate` | the autoresearch daily/weekly jobs (run by the schedule) |
| `apple-pi review` · `apply --latest --yes` | review then apply a self-improvement proposal |
| `apple-pi update --check` · `--all --yes` | check for / install apple-pi + pivoice updates |
| `apple-pi schedule install` | wire the daily+weekly jobs (launchd on macOS, cron elsewhere) |

### Skills at a glance

| Skill | When it runs |
|---|---|
| `plan-decompose` | breaking a big goal into independent, verifiable tasks |
| `read-docs-first` | before touching any repo — the pre-flight reading order |
| `verify-own-work` | after every concrete change — test, lint, smoke, diff |
| `red-blue` | security review of anything touching auth/secrets/paths/listeners |
| `self-assess` | the recurring tune-the-config-to-the-model ritual |
| `session-record` | save/resume distilled session records across days |
| `long-horizon-compaction` | tree-structured sessions + deliberate compaction |
| `n8n-workflow-author` | design an n8n workflow end-to-end |
| `autonomous-execution` | the apple-pi default — agents run tools without approval prompts; hard guards (sysinfo-guard) are the only exception |

### How-to guides

Task-oriented step-by-step guides live in [`docs/HOWTO.md`](docs/HOWTO.md):

- [Add, rotate, or export a key](docs/HOWTO.md#add-rotate-or-export-a-key)
- [Change your model (or re-tune for a new one)](docs/HOWTO.md#change-your-model-or-re-tune)
- [Wire a workflow (n8n / obsidian / monitoring)](docs/HOWTO.md#wire-a-workflow)
- [Use voice mode](docs/HOWTO.md#use-voice-mode)
- [Keep apple-pi current](docs/HOWTO.md#keep-apple-pi-current)
- [Troubleshoot](docs/HOWTO.md#troubleshoot)

---

## Privacy posture

- Your credential is captured, encrypted with your passphrase
  (`openssl aes-256-cbc -pbkdf2 -iter 600000`) into the credential vault.
  The onboarding entry is marked *transient* and **pruned the moment the
  model is confirmed**; the vault itself persists for any keys you add later
  (see [Credential Vault](#credential-vault)).
- The surviving runtime copy lives in `~/.pi/agent/auth.json` — Pi's own
  mode-0600 auth store, which you manage via `/login`. Pass `--purge-auth-too`
  to remove even that at purge (then re-authorise with `/login`).
- Plaintext creds live in-memory only; scratch is `rm -P`'d / shred.
- The shipped config tree contains **no** hostnames, IPs, paths, or tokens
  from the author — `smoke/sanitize.sh` grep-enforces it on every change.

## Credential Vault

apple-pi ships a `/vault` command — an encrypted, trace-free store for the
machine-credentials your agent needs (API keys, gateway tokens). It exists so
the safe path is the easy path: the alternative — pasting a key into `~/.zshrc`,
a `.env`, or the chat — leaks it into process env, crash dumps, shell history,
and session transcripts.

- **Trace-free entry.** Paste a key into a masked `/vault add` prompt; it never
  touches your input line, so it can't end up in the session log.
- **Encrypted at rest.** One file, `~/.pi/agent/credentials.vault`, locked with
  a passphrase you choose, mode `0600`.
- **You gate every reveal.** `/vault list` shows names, not secrets. Seeing a
  key back is opt-in and warned.
- **Onboarding cleans up after itself.** The key you paste at install is marked
  *temporary* and pruned the moment the connection is proven — but keys you add
  yourself stay until *you* remove them.

```
/vault add [name]              paste + store a key (masked prompt)
/vault list                    names + metadata (never the secrets)
/vault get <name>              reveal a key  (opt-in; warned)
/vault rotate <name>           replace a key with a new one
/vault import <file>           bulk-load from JSON, then shred the source
/vault export <name>           write a key into auth.json (pi's native auth)
/vault export-to <name>        run your `vault.exportCmd` with the key on stdin
/vault remove <name> · /vault lock
```

The honest threat model: the vault defends strongly against **accidental
leakage** (logs, env, exports) — how most keys actually get exposed. It is
*defense in depth*, not a sealed vault against a thief who has your laptop
**and** your passphrase. For that outer wall, turn on **FileVault**. Full
design + attacker model:
[`.docs/features/credential-vault/`](.docs/features/credential-vault/).

## What's in the box

| Surface | Count | What |
|---|---|---|
| Persona | 1 | `config/agent/AGENTS.md` — the contract every session loads |
| Skills | 9 | plan-decompose, read-docs-first, verify-own-work, red-blue, long-horizon-compaction, **self-assess**, session-record, n8n-workflow-author, **autonomous-execution** |
| Prompts | 4 | `/decompose`, `/spec`, `/redteam`, `/design` |
| Extensions | 9 | sysinfo-guard (always on), **web** (search/fetch/browser, default on), **voice** (`/voice` ↔ pivoice), **credential-vault** (on demand, env-configured), n8n/forgejo/netbird/llm/kanban/telegram (on demand) |
| Wizard | 1 | `install.sh` + `lib/` (P0–P1 + handoff) |
| Handoff | 1 | `lib/handoff.md` — drives the agent through P2–P5 |
| Smoke | 8 | sanitize · structure · onboard-sandbox · vault-roundtrip · vault-tracefree · vault-telemetry-safe · vault-rotate-import-export · vault-onboarding |

The **self-assess** skill is the heart of "tune yourself to my model" — a
recurring 3-iteration ritual (discovery → red/blue → apply+reevaluate) that
aligns the config with the model's *real* capabilities, verified from the
catalog and request-shaping code rather than from prose. Re-run it any time
your model, tooling, or hardware changes.

## Web & browser control

apple-pi ships a **web extension** (on by default) that gives the agent eyes
and hands on the live web — so "use the best viable way" reaches beyond your
filesystem:

- **`web_search`** — ranked results (title / url / snippet). Free default
  (DuckDuckGo); optional Tavily / Brave via API key.
- **`web_fetch`** — fetch a URL → cleaned markdown (links preserved); render
  JavaScript-heavy SPAs through the browser when needed.
- **`browser_*`** (13 tools) — drive **your own persistent, headed Chrome**:
  navigate, snapshot, click, type, check boxes, fill forms, take screenshots,
  switch tabs. Logins and cookies survive between runs.

The browser is **headed by default** — you can watch every click. Element
references (`[N]` refs from `browser_snapshot`) make interactions deterministic
without fragile CSS selectors, and the tool guidelines require the agent to
confirm before any payment, deletion, or other irreversible action.

Configure with env vars (`PI_BROWSER_HEADLESS`, `PI_WEB_SEARCH_PROVIDER`,
`PI_BROWSER_CDP_URL`, …). No secrets ship in the repo — keys are env-only.
See [`config/extensions/web/README.md`](config/extensions/web/README.md) and the
[spec](.docs/web-extension.md).

## The three workflow offers (P5)

After self-improvement, apple-pi offers **one** of:

1. **n8n automation** — enable `n8n-bridge` (`N8N_BASE_URL` + `N8N_API_KEY`)
   and build a first workflow with the `n8n-workflow-author` skill + `/design`.
2. **obsidian vault** — wire the `session-record` skill to your vault
   (`APPLEPI_VAULT_SESSIONS`) and save the onboarding session as the first record.
3. **monitoring** — a health/status extension parameterised to your
   environment (NetBird if you run it, else a loopback-service checker).

The others stay available as skills/extensions for later.

## Voice mode (type ⇄ talk)

apple-pi bundles **pivoice** — speak a prompt, hear the reply, fully
on-device (whisper.cpp + `say`). Type in the pi TUI, flip to voice, flip
back — **same conversation**:

- In any `pi` session, type **`/voice`** (or press **Ctrl+Shift+V**). apple-pi
  launches pivoice on the current session; voice turns append to the same
  JSONL.
- Talk. Press `q` to exit voice mode.
- Resume the TUI: **`pi -c`** — the voice turns appear in the session tree.

See [`config/voice/README.md`](config/voice/README.md).

**Setup (opt-in, one command):** onboarding offers to enable voice (downloads
~465MB model + brew packages). Decline and it's still one command later:

```sh
bash ~/.apple-pi/lifecycle/voice-enable.sh          # interactive
bash ~/.apple-pi/lifecycle/voice-enable.sh --check  # status only
```

If you try `/voice` before enabling, apple-pi prints that command instead of
launching a dead session.

## `install.sh` flags

| Flag | Effect |
|---|---|
| `--purge-auth-too` | Also delete `auth.json` at purge (re-authorise via `/login` after). Off by default — you need runtime auth. |
| `--sandbox <dir>` | Use `<dir>` as the Pi config dir (testing; never touches `~/.pi`). |
| `--skip-confirm` | Skip the live model-confirm call (air-gapped / OAuth flows). |
| `--no-handoff` | Stop after P1+purge; print the handoff command. |

## The autoresearch lifecycle (keeps improving)

apple-pi improves on **two distinct channels**. They're kept separate on
purpose so you always know what's *your behavior changing itself* vs what's
*new code arriving*:

| Channel | What it is | How it surfaces | How it applies |
|---|---|---|---|
| **Self-improvement** (`source: autoresearch`) | Changes proposed from *your own session telemetry* — tool-discipline drift, compaction pressure, error rates | Weekly brief at `~/.pi/agent/proposals/<date>.md` | `apple-pi review` → `apply --latest --yes`. **You gate it.** |
| **Release updates** (`source: release`) | New code: new apple-pi / pivoice versions from GitHub | `apple-pi update --check` (read-only); also folded into the weekly brief | `apple-pi update --all --yes` (or `--voice`). **Never auto-installs.** |

### Self-improvement loop

An internal self-improvement loop runs alongside the interactive `self-assess`
ritual:

- **Daily** — `apple-pi collect` parses session telemetry into a local SQLite
  store. LLM-free, zero quota.
- **Weekly** — `apple-pi aggregate` writes a brief of proposed improvements
  (each tagged `source: autoresearch`) to
  `~/.pi/agent/proposals/<date>.md`. It also runs a read-only release check
  and tags any behind-repo `source: release`.
- **Review → apply** — `apple-pi review` shows the diff; `apple-pi apply
  --latest --yes` writes self-improvement proposals. **Nothing applies until
  you say yes.**

### Release updates

```bash
apple-pi update --check        # read-only: local vs GitHub releases
apple-pi update --all --yes    # gated: pi update --all + pull + sync pivoice
apple-pi update --voice --yes  # gated: re-sync just the pivoice bundle
```

Install the schedule with `apple-pi schedule install` (launchd on macOS, cron
elsewhere). See [PUBLISHING.md](PUBLISHING.md) and
[.docs/decisions/2026-06-27-autoresearch-lifecycle.md](.docs/decisions/2026-06-27-autoresearch-lifecycle.md).

## Verify it

```bash
bash smoke/run.sh              # all
bash smoke/run.sh sanitize     # no personal info shipped
bash smoke/run.sh onboard-sandbox  # full P1 flow + purge in a temp dir
```

## Install as a Pi package (advanced)

apple-pi is also a valid Pi package — get the skills/prompts/extensions
without the wizard:

```bash
pi install git:github.com/<your-user>/apple-pi
```

## Philosophy

apple-pi inherits Pi's: **adapt the harness to your workflows, not the
other way around.** Everything opinionated is a skill, prompt, or extension
you can read, edit, and remove. The persona is a contract, not a cage.

## License

MIT. See [LICENSE](LICENSE).
