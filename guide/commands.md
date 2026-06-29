# Commands

The everyday surface. The [README](https://github.com/jotokra/apple-pi#readme)
has the exhaustive list; this is the part you'll actually type.

## `pi` — the agent

| | |
|---|---|
| `pi` | start a session |
| `pi -c` | continue the most recent session |
| `pi --model <pattern>` | start on a model (`provider/id`, optional `:thinking`) |
| `pi --provider <p> --model <m>` | be explicit about both |
| `pi --list-models [query]` | list / fuzzy-search available models |
| `pi --no-context-files` | start without loading AGENTS.md context |

### In-session (TUI)

| | |
|---|---|
| `Ctrl+P` | cycle / pick a model |
| `Ctrl+Shift+V` or `/voice` | voice mode (type ⇄ talk) |
| `/branch` | checkpoint the current plan as a new branch |
| `/tree` | navigate the session tree |
| `/vault …` | key management (below) |
| `/sync …` | multi-device config sync (see below) |
| `/sources …` | bring APIs in as tools — MCP servers + OpenAPI (see below) |

## `/vault` — the credential vault

| | |
|---|---|
| `/vault add <id>` | add a key via the masked prompt |
| `/vault list` | list entries (names only — never secrets) |
| `/vault rotate <id>` | replace a key in place |
| `/vault get <id>` | reveal a secret (opt-in, warned) |
| `/vault remove <id>` | delete an entry |
| `/vault export <id>` | bridge into pi's `auth.json` |
| `/vault export-to <id>` | pipe to your own manager (`vault.exportCmd`) |
| `/vault lock` | forget the cached passphrase |
| `/vault import <file>` | bulk-import JSON; source is shredded after |

Headless equivalents use `apple-pi vault …` with the secret on **stdin**.

## `/sync` — multi-device config sync

Keep the portable part of `~/.pi` (skills, extensions, prompts, the agent
contract, learnings) in a private git repo so it moves between machines.
Secrets (`auth.json`, the vault, `sessions/`, the browser profile) **never
leave the device** — by construction (default-deny gitignore + a secret-
blocking pre-commit hook), not by discipline.

| | |
|---|---|
| `/sync status` | branch, remote, hook health, dirty portable, unpushed |
| `/sync push` | commit + push portable changes (pre-flight secret scan) |
| `/sync pull` | fetch + ff-only; merges portable settings, keeps device fields |
| `/sync doctor` | health + full-git-history secret scan |
| `/sync consolidate <branch>` | fold another device's branch in (stage + print) |

`/sync init` sets up the origin device (`main`). Other devices clone into
`~/.pi`, install the hook (`git config core.hooksPath .githooks`), and push.
`settings.json` is split: device-specific paths/model stay local; a portable
extract merges on pull. See the `config-sync` skill for the consolidation
workflow.

## `/sources` — bring APIs in as tools (MCP)

Any MCP server (GitHub, Slack, Postgres, the filesystem, … — the whole MCP
ecosystem) becomes a set of pi tools. `/sources add api` spins one up from any
OpenAPI spec for REST APIs without an existing server.

| | |
|---|---|
| `/sources` | list servers + live health (active/paused, trusted/UNTRUSTED) |
| `/sources add mcp <name> <cmd> [args…]` | register an MCP server |
| `/sources add api <name> <spec> [--base-url URL] [--header N:V]` | register from an OpenAPI spec |
| `/sources remove <name>` · `pause <name>` · `resume <name>` | manage |
| `/sources trust <name>` · `untrust <name>` | a new server is **UNTRUSTED** until trusted — review before trusting |

Servers run arbitrary code, so trust is explicit and per-server. Creds come
from the vault (`mcp.servers[].envFrom: vault:<id>`), never inline. Ingress
pollers (`ingress.pollers[]` in `settings.json`, scheduled via
`ingress/schedule.sh`) are configured in settings, not a command — see the
[Watch a feed](https://github.com/jotokra/apple-pi/blob/main/docs/HOWTO.md#watch-a-feed-ingress-bus)
how-to.

## `apple-pi` — the product CLI

| | |
|---|---|
| `apple-pi vault …` | vault operations (scriptable; secret on stdin) |
| `apple-pi sync …` | config sync (`init`/`status`/`push`/`pull`/`doctor`/`consolidate`) |
| `apple-pi update --check` | check for a new release (read-only) |
| `apple-pi update --all --yes` | apply a release update |
| `apple-pi review` | show the weekly self-improvement brief |
| `apple-pi apply --latest --yes` | apply a reviewed proposal |
| `apple-pi schedule install` | wire the daily/weekly cron (launchd on macOS) |
| `apple-pi schedule status` | show what's wired |

::: tip Nothing auto-applies
Both the release channel (`update`) and the self-improvement channel
(`apply`) require an explicit `--yes`. The weekly brief *proposes*; you read
the diff and decide.
:::
