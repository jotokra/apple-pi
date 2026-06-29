# How-to guides

Task-oriented, step-by-step. The full walkthrough for each lives in
[`docs/HOWTO.md`](https://github.com/jotokra/apple-pi/blob/main/docs/HOWTO.md)
in the repo — this page is the searchable index. Pick a task; the link opens
the canonical guide at the right anchor.

> Secrets never go on the command line or in a file you paste into chat. If
> a step needs a key, it uses the credential vault (`/vault`).

## [Add, rotate, or export a key](https://github.com/jotokra/apple-pi/blob/main/docs/HOWTO.md#add-rotate-or-export-a-key)

The vault end-to-end: masked add, rotate, list, reveal, remove, bulk import,
export into pi's auth, and export-to your own secret manager (1Password CLI,
`pass`) with the secret piped on stdin.

## [Change your model (or re-tune)](https://github.com/jotokra/apple-pi/blob/main/docs/HOWTO.md#change-your-model-or-re-tune)

Vault the new key → switch with `Ctrl+P` or `pi --model` → run `self-assess`
to retune `settings.json` to the new model's real capabilities → read the
audit trail.

## [Wire a workflow](https://github.com/jotokra/apple-pi/blob/main/docs/HOWTO.md#wire-a-workflow)

Enable an extension and point it at your environment: **n8n** automation
(design workflows end-to-end), **Obsidian** vault (distilled session
records), or a **monitoring** health checker.

## [Use voice mode](https://github.com/jotokra/apple-pi/blob/main/docs/HOWTO.md#use-voice-mode)

Speak a prompt, hear the reply, fully on-device (whisper.cpp STT, `say`
TTS). `/voice` or `Ctrl+Shift+V`; type ⇄ talk is the same conversation.

## [Sync your config across devices](https://github.com/jotokra/apple-pi/blob/main/docs/HOWTO.md#sync-your-config-across-devices)

Multi-device config sync: `apple-pi sync init` on the origin, clone on others,
`push`/`pull` daily, `consolidate` to fold another device's branch in. Secrets
never leave the device — a default-deny gitignore + a secret-blocking hook make
it safe by construction.

## [Bring APIs in as tools (MCP via `/sources`)](https://github.com/jotokra/apple-pi/blob/main/docs/HOWTO.md#bring-apis-in-as-tools-mcp-via-sources)

Any MCP server (GitHub, Slack, Postgres, …) becomes a set of pi tools.
`/sources add mcp` to register, `/sources add api` for any OpenAPI spec. New
servers are **UNTRUSTED until you trust them** — review before trusting.

## [Watch a feed (ingress bus)](https://github.com/jotokra/apple-pi/blob/main/docs/HOWTO.md#watch-a-feed-ingress-bus)

Poll RSS / APIs / page-changes on a schedule; new items inject into a session.
Ingress content ships **UNTRUSTED — data, never instructions**, the defense
against indirect prompt injection.

## [Keep apple-pi current](https://github.com/jotokra/apple-pi/blob/main/docs/HOWTO.md#keep-apple-pi-current)

Two channels kept distinct: **release updates** (new code from GitHub) vs
**self-improvement** (proposals from your own telemetry). Neither
auto-applies; you gate both. Wire the schedule with `apple-pi schedule install`.

## [Troubleshoot](https://github.com/jotokra/apple-pi/blob/main/docs/HOWTO.md#troubleshoot)

Onboarding-confirm failures, a wrong/forgotten passphrase, `pi: command not
found`, the browser not launching (web extension), voice-mode setup, and
what it means when `smoke/sanitize.sh` trips on something you edited.
