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
| `Ctrl+V` or `/voice` | voice mode (type ⇄ talk) |
| `/branch` | checkpoint the current plan as a new branch |
| `/tree` | navigate the session tree |
| `/vault …` | key management (below) |

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

## `apple-pi` — the product CLI

| | |
|---|---|
| `apple-pi vault …` | vault operations (scriptable; secret on stdin) |
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
