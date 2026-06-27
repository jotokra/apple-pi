---
slug: ollama
display: Ollama (local — no key, no cost)
auth: ollama
env: OLLAMA_API_KEY
api: openai-completions
models: llama3, qwen2.5, deepseek-r1, gemma3
default: qwen2.5
base: http://localhost:11434/v1
---

## Get a key
**No key needed.** Ollama runs models on your own machine.

1. Install Ollama: see https://ollama.com (macOS: download the app; Linux: the install script).
2. Start it (the macOS app auto-runs a server on port 11434).
3. Pull a model:  `ollama pull qwen2.5`  (or `llama3`, `deepseek-r1`, `gemma3`).
4. In apple-pi: leave the **API key blank** — when asked for a base URL it's already `http://localhost:11434/v1`.

## Dashboard
Manage models: `ollama list` / `ollama pull <model>` / `ollama rm <model>`. Docs: https://ollama.com/library

## Pricing
**Free** — it's your own hardware. Cost is electricity + RAM/VRAM. Models are sized to fit your machine; a 8B model runs on 16GB RAM.

## Common errors
- **connection refused / `localhost:11434`**: Ollama isn't running. Start the app or run `ollama serve`.
- **model not found**: `ollama pull <model>` first; the name must match (`qwen2.5`, not `qwen`).
- **slow / out of memory**: use a smaller model (`gemma3:4b`) or quit other apps.

## Tip
Zero-cost, fully private. Slower than cloud and needs your hardware — but nothing leaves your machine. Great first stop if you have no provider account yet.
