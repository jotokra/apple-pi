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

## Privacy posture

- Your credential is captured, encrypted with your passphrase
  (`openssl aes-256-cbc -pbkdf2 -iter 600000`) into a transient vault, and
  **destroyed the moment the model is confirmed.**
- The only surviving copy lives in `~/.pi/agent/auth.json` — Pi's own
  mode-0600 auth store, which you manage via `/login`. Pass `--purge-auth-too`
  to remove even that at purge (then re-authorise with `/login`).
- Plaintext creds live in-memory only; scratch is `rm -P`'d / shred.
- The shipped config tree contains **no** hostnames, IPs, paths, or tokens
  from the author — `smoke/sanitize.sh` grep-enforces it on every change.

## What's in the box

| Surface | Count | What |
|---|---|---|
| Persona | 1 | `config/agent/AGENTS.md` — the contract every session loads |
| Skills | 8 | plan-decompose, read-docs-first, verify-own-work, red-blue, long-horizon-compaction, **self-assess**, session-record, n8n-workflow-author |
| Prompts | 4 | `/decompose`, `/spec`, `/redteam`, `/design` |
| Extensions | 7 + web | sysinfo-guard (always on), **web** (search/fetch/browser, default on), n8n/forgejo/netbird/llm/kanban/telegram (on demand) |
| Wizard | 1 | `install.sh` + `lib/` (P0–P1 + handoff) |
| Handoff | 1 | `lib/handoff.md` — drives the agent through P2–P5 |
| Smoke | 4 | sanitize · structure · onboard-sandbox · run |

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

## Using apple-pi after install

```bash
pi                         # interactive, on your model
pi -p "decompose 'build X'"   # one-shot
pi -r                       # resume a session
```

The skills auto-load. Use `/decompose`, `/spec`, `/redteam`, `/design` for
the prompts, and `/skill:self-assess` to re-tune when your stack changes.

## `install.sh` flags

| Flag | Effect |
|---|---|
| `--purge-auth-too` | Also delete `auth.json` at purge (re-authorise via `/login` after). Off by default — you need runtime auth. |
| `--sandbox <dir>` | Use `<dir>` as the Pi config dir (testing; never touches `~/.pi`). |
| `--skip-confirm` | Skip the live model-confirm call (air-gapped / OAuth flows). |
| `--no-handoff` | Stop after P1+purge; print the handoff command. |

## The autoresearch lifecycle (keeps improving)

An internal self-improvement loop runs alongside the interactive `self-assess`
ritual:

- **Daily** — `apple-pi collect` parses session telemetry into a local SQLite
  store. LLM-free, zero quota.
- **Weekly** — `apple-pi aggregate` writes a brief of proposed improvements
  (tool-discipline drift, compaction pressure, error rates) to
  `~/.pi/agent/proposals/<date>.md`.
- **Review → apply** — `apple-pi review` shows the diff; `apple-pi apply
  --latest --yes` writes it. **Nothing applies until you say yes.**

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
