# Using apple-pi

A normal session is just `pi`. Onboarding already tuned `settings.json` to
your model, so you start in a good config and talk to the agent.

## Your first session

```bash
pi
```

You're in the TUI. The agent works autonomously by default — it reads files,
runs commands, edits code, and verifies its own work, narrating as it goes.
A few things worth knowing on day one:

- **Skills are invoked by trigger phrases, not incantations.** Say "plan
  this" and it runs `plan-decompose`; "is this secure" runs `red-blue`. You
  don't need to memorize commands — describe the work.
- **`/vault`** manages keys. `add`, `rotate`, `list`, `export`, `lock`. The
  entry prompt is masked; secrets never print without an explicit reveal.
- **`Ctrl+P`** cycles models. **`Ctrl+Shift+V`** (or `/voice`) flips the session
  to voice mode.
- **`/branch`** checkpoints a plan; **`/tree`** navigates sessions. Pi
  sessions are tree-structured and shareable.

## The commands you'll reach for

| Command | What it does |
|---|---|
| `pi` | start a session |
| `pi -c` | continue the most recent session |
| `pi --model <id>` | start on a specific model |
| `pi --list-models <query>` | fuzzy-search available models |
| `/vault add\|list\|rotate\|export\|lock` | manage keys |
| `/voice` or `Ctrl+Shift+V` | voice mode (type ⇄ talk) |
| `/branch`, `/tree` | checkpoint + navigate sessions |
| `apple-pi update --check` | check for a new release (read-only) |
| `apple-pi review` | review the weekly self-improvement brief |
| `apple-pi apply --latest --yes` | apply a reviewed proposal |

See the [commands reference](./commands) for the full list, and the
[how-to guides](./howto) for task-oriented walkthroughs.

## Two channels of improvement

apple-pi improves on two channels — keep them straight:

- **Release updates** — new apple-pi / pivoice code from GitHub.
  `apple-pi update --check` is read-only; `update --all --yes` applies.
- **Self-improvement** — proposals derived from *your* session telemetry.
  `apple-pi review` shows the diff; `apply --latest --yes` writes it.

Neither ever auto-applies. You gate both. Wire the schedule with
`apple-pi schedule install` so the daily collect + weekly aggregate run
unattended.
