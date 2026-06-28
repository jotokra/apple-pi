# apple-pi — how-to guides

Task-oriented, step-by-step. The [README](../README.md) is the front door
(why, install, the command reference); this file is for "I want to do *X*."
Each section is self-contained — jump straight to the anchor you need.

> Secrets never go on the command line or in a file you paste into chat. If a
> step needs a key, it uses the credential vault (`/vault`) — see
> [Add, rotate, or export a key](#add-rotate-or-export-a-key) first.

---

## Add, rotate, or export a key

The vault is one encrypted file (`~/.pi/agent/credentials.vault`, mode `0600`)
holding your machine-credentials (API keys, gateway tokens). The passphrase is
set from `CREDENTIALS_VAULT_PASS` (headless) or prompted on the tty.

**Add a key** (masked prompt — the secret never hits your input line or history):

```text
/vault add openai
# → paste the key into the masked prompt; dots show as you type; Enter to store
```

Headless / scripted (secret on **stdin**, never an argument):

```bash
printf '%s' "sk-…" | apple-pi vault add openai --provider openai --note "personal"
```

**List** (metadata only — never the secret): `/vault list`

**Rotate** (key compromised or expired — replaces in place, re-encrypted):

```text
/vault rotate openai
# → paste the NEW key into the masked prompt
```

**Reveal** (opt-in, warned — most workflows never need this): `/vault get openai`

**Remove**: `/vault remove openai`

**Bulk import** (loads a JSON file, then shreds the source):

```bash
echo '{"entries":[{"id":"anthropic","secret":"sk-ant-…"},{"id":"gateway","secret":"…"}]}' > /tmp/keys.json
apple-pi vault import /tmp/keys.json   # → source is securely deleted after import
```

**Export into pi's runtime auth** (so a provider works in `pi` without
re-onboarding) — the bridge into `~/.pi/agent/auth.json`:

```text
/vault export anthropic            # → writes auth.json["anthropic"] = {type:"api_key",key:…}
```

**Export to your own secret manager** (1Password CLI, `pass`, a custom helper).
Set `vault.exportCmd` in `~/.pi/settings.json` — the secret is piped to the
command's **stdin**; metadata arrives as `$VAULT_ID` / `$VAULT_PROVIDER` /
`$VAULT_KIND` / `$VAULT_NOTE` env vars (never interpolated into the command
string, so a stray note can't inject):

```jsonc
// ~/.pi/settings.json
{ "vault": { "exportCmd": "op item create --category='API Key' $VAULT_PROVIDER" } }
```

```text
/vault export-to openai           # → runs the command; key on stdin
```

**Lock** (forget the cached passphrase; re-prompts next use): `/vault lock`

**Forgot the passphrase?** There is no recovery — the vault is unrecoverable
without it, by design (no backdoor). Remove the file and re-add your keys:

```bash
rm ~/.pi/agent/credentials.vault
```

(Turn on FileVault for the outer wall; the vault is defense-in-depth against
accidental leakage, not a sealed store against a disk thief.)

---

## Change your model (or re-tune)

apple-pi tuned `settings.json` to your **install-time** model. When you switch
models — or when a model's real capabilities shift — re-tune so the thinking
levels, compaction reserves, and favourites match the new model.

1. **Give pi the new model's key** (if it's a new provider):
   ```text
   /vault add deepseek
   /vault export deepseek          # → into auth.json, so pi can call it
   ```
   (For an OAuth/subscription provider, use `/login` instead.)

2. **Switch to the model** — in the TUI press **Ctrl+P** (the model picker), or
   start pi with it:
   ```bash
   pi --provider deepseek --model deepseek-chat
   pi --list-models deepseek        # fuzzy-search to confirm the exact id
   ```

3. **Re-tune the config** — run the self-assess ritual, which reads the new
   model's **real** capabilities from the pi-ai catalog (context window,
   thinking model, vision, cost — from the code path, not prose) and rewrites
   `settings.json`:
   ```text
   /skill:self-assess
   ```

4. **Check the audit trail** it wrote: `~/.pi/agent/self-assessment-<date>.md`
   (findings, invalidated hypotheses, what was deliberately left alone).

Re-run self-assess any time your model, tooling, or hardware changes — that's
the whole point of "tune yourself to my model."

---

## Wire a workflow

At the end of onboarding apple-pi offers **one** of three workflows. You can
also wire any of them later — they're skills/extensions, not one-shot installs.

### n8n automation

1. Enable the `n8n-bridge` extension. Set the endpoint + key (use the vault —
   never paste into a config you might share):
   ```text
   /vault add n8n
   /vault export n8n                # into auth.json (pi resolves $-env keys)
   ```
   Then in `~/.pi/settings.json`:
   ```jsonc
   { "extensions": { "n8n-bridge": "/path/to/n8n-bridge.ts" },
     "env": { "N8N_BASE_URL": "https://your-n8n.example/api/v1", "N8N_API_KEY": "$auth:n8n" } }
   ```
2. Design a workflow with the skill + prompt:
   ```text
   /design a workflow that watches an RSS feed and posts new items to a webhook
   ```
   The `n8n-workflow-author` skill drives trigger → steps → creds → test recipe.

(No n8n yet? Ask the agent to help stand one up — it's a normal Docker/PM2 task.)

### Obsidian vault (session records)

Wire the `session-record` skill so distilled session summaries land in your
Obsidian vault (and sync to your phone). Point it at your vault's sessions dir:

```jsonc
// ~/.pi/settings.json
{ "env": { "APPLEPI_VAULT_SESSIONS": "/path/to/your-vault/Sessions" } }
```

The skill writes `YYYY-MM/YYYY-MM-DD_<slug>.md` records there. Save the current
session as your first record by asking the agent to "save this session to the
vault."

### Monitoring

A health/status extension parameterised to your environment. If you run
NetBird, enable the `netbird-status` extension (read-only overlay status).
Otherwise, ask the agent to build a small loopback-service health checker for
the ports you care about — it'll use the same pattern (curl on a schedule).

---

## Use voice mode

apple-pi bundles **pivoice** — speak a prompt, hear the reply, fully on-device
(whisper.cpp for STT, `say` for TTS). Nothing leaves the machine.

**One-time setup** (the installer offers the brew step):

```bash
brew install whisper-cpp
mkdir -p ~/.pi/voice/models
curl -L -o ~/.pi/voice/models/ggml-small-en.bin \
  https://huggingface.co/ggerganoff/whisper.cpp/resolve/main/ggml-small-en.bin
```

**Use it** — in any `pi` session:

| Action | Key |
|---|---|
| Start voice mode | `/voice` or **Ctrl+Shift+V** |
| Quit voice mode | `q` or Ctrl-C |

Voice turns append to the **same** session JSONL — type ⇄ talk is the same
conversation. To resume the TUI and see the voice turns in the tree:

```bash
pi -c
```

Tune the model / device via `PIVOICE_MODEL`, `PIVOICE_DEVICE` etc. — see
[`config/voice/README.md`](../config/voice/README.md).

---

## Keep apple-pi current

apple-pi improves on **two channels** — keep them straight:

| Channel | Check | Apply |
|---|---|---|
| **Release updates** (new apple-pi / pivoice code from GitHub) | `apple-pi update --check` | `apple-pi update --all --yes` (or `--voice` for just pivoice) |
| **Self-improvement** (proposals from your own session telemetry) | `apple-pi review` | `apple-pi apply --latest --yes` |

Neither ever auto-applies — you gate both.

**Wire the schedule** so the daily collect + weekly aggregate run unattended:

```bash
apple-pi schedule install      # launchd on macOS, cron elsewhere
apple-pi schedule status       # see what's wired
```

The weekly aggregate also folds a read-only release check into the brief at
`~/.pi/agent/proposals/<date>.md` (tagged `source: release`), so one review
covers both channels.

---

## Troubleshoot

**Onboarding failed at the model-confirm step.** The one confirm call didn't
succeed — usually a wrong key, a model id that doesn't resolve, or no network.
Re-run `bash install.sh`. Confirm the model id with `pi --list-models
<provider>`. For OAuth/subscription providers or air-gapped installs, use
`install.sh --skip-confirm` (skips the live call; you'll verify on first use).

**"Wrong passphrase" / can't open the vault.** No recovery exists — by design.
Remove the vault file and re-add your keys (see
[Add, rotate, or export a key](#add-rotate-or-export-a-key)).

**`pi: command not found` after install.** Install the binary (the installer
offers this):
```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

**The browser won't launch (web extension).** The browser tools drive your own
Chrome/Chromium. Try:
- `PI_BROWSER_CHANNEL=chromium pi …` if you don't have Chrome,
- `PI_BROWSER_HEADLESS=1 pi …` to run headless (you lose the "watch every click"
  guardrail),
- `PI_BROWSER_CDP_URL=http://localhost:9222 pi …` to attach to a Chrome you
  started with `--remote-debugging-port=9222`.

See [`config/extensions/web/README.md`](../config/extensions/web/README.md).

**Voice mode: "whisper not found".** Install the STT dependency + a model (see
[Use voice mode](#use-voice-mode)).

**`smoke/sanitize.sh` fails after you edited something.** You added a token the
no-personal-info tripwire catches (hostnames, IPs, paths, names from the
author's machine). The failure message names the token and the file. Either
remove the personal info (preferred — the repo ships clean) or, if it's a
legitimate new identifier of your own, add it to the `FORBIDDEN` list only if
you're sure it should be allowed to ship (it almost certainly shouldn't).

**A smoke other than sanitize fails.** Each `smoke/*.sh` is self-documenting at
the top. Run it directly for full output: `bash smoke/vault-tracefree.sh`.
The structure smoke catches count drift (skills/prompts/extensions) — if you
added a skill, bump the expected count in `smoke/structure.sh`.

---

## See also

- [README](../README.md) — the front door: why, install, command reference.
- [`.docs/features/credential-vault/`](../.docs/features/credential-vault/) — full vault spec + security model.
- [`config/extensions/web/README.md`](../config/extensions/web/README.md) — the web/browser extension.
- [`config/voice/README.md`](../config/voice/README.md) — voice mode details.
- [PUBLISHING.md](../PUBLISHING.md) — release process (for maintainers).
