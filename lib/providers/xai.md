---
slug: xai
display: xAI (Grok)
auth: xai
env: XAI_API_KEY
api: openai-completions
models: grok-4, grok-4-fast, grok-code-fast-1
default: grok-4-fast
base: https://api.x.ai/v1
---

## Get a key
1. Go to https://console.x.ai → sign in.
2. **API Keys → Create**. Copy it (`xai-…`).
3. Paste it at the apple-pi "API key" prompt.
4. Load credits at **Billing / Console** (prepaid).

## Dashboard
Keys + billing: https://console.x.ai

## Pricing
`grok-4-fast` is the value tier; `grok-4` is the flagship; `grok-code-fast-1` is cheap and code-focused. Pay-per-token, prepaid balance.

## Common errors
- **401 invalid api key**: re-copy the full `xai-…`.
- **402 / insufficient credits**: add credits in the console.
- **model name**: use the exact id (`grok-4-fast`, with the hyphen).

## Tip
For coding on xAI, `grok-code-fast-1` is cheap; for general strength, `grok-4-fast`.
