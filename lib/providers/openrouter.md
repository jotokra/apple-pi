---
slug: openrouter
display: OpenRouter (one key → many models)
auth: openrouter
env: OPENROUTER_API_KEY
api: openai-completions
models: anthropic/claude-sonnet-4.5, openai/gpt-5, google/gemini-2.5-flash, deepseek/deepseek-chat, x-ai/grok-4
default: anthropic/claude-sonnet-4.5
base: https://openrouter.ai/api/v1
---

## Get a key
1. Go to https://openrouter.ai → sign in.
2. **Keys → Create Key**. Copy it (`sk-or-…`).
3. Paste it at the apple-pi "API key" prompt.
4. Add credits at **Credits** (prepaid, single bill across all providers).

## Dashboard
Keys: https://openrouter.ai/keys · Credits: https://openrouter.ai/credits · Models + live prices: https://openrouter.ai/models

## Pricing
Aggregator: one prepaid balance, pay-per-token, real prices shown per model at openrouter.ai/models. Slight markup over direct providers; you get one bill and access to models blocked in your region.

## Common errors
- **401 invalid key**: re-copy the `sk-or-…`.
- **402 insufficient credits**: add credits at the Credits page.
- **model id format**: OpenRouter uses `provider/model` (e.g. `anthropic/claude-sonnet-4.5`). The wizard accepts that string directly.

## Tip
**Best fallback if a direct provider blocks your region or wants a separate bill.** One key, hundreds of models. Start with `google/gemini-2.5-flash` (cheap) or `anthropic/claude-sonnet-4.5`.
