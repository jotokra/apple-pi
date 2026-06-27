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
TTS). `/voice` or `Ctrl+V`; type ⇄ talk is the same conversation.

## [Keep apple-pi current](https://github.com/jotokra/apple-pi/blob/main/docs/HOWTO.md#keep-apple-pi-current)

Two channels kept distinct: **release updates** (new code from GitHub) vs
**self-improvement** (proposals from your own telemetry). Neither
auto-applies; you gate both. Wire the schedule with `apple-pi schedule install`.

## [Troubleshoot](https://github.com/jotokra/apple-pi/blob/main/docs/HOWTO.md#troubleshoot)

Onboarding-confirm failures, a wrong/forgotten passphrase, `pi: command not
found`, the browser not launching (web extension), voice-mode setup, and
what it means when `smoke/sanitize.sh` trips on something you edited.
