---
slug: anthropic
display: Anthropic (Claude)
auth: anthropic
env: ANTHROPIC_API_KEY
api: anthropic-messages
models: claude-opus-4, claude-sonnet-4-5, claude-haiku-4
default: claude-sonnet-4-5
base: https://api.anthropic.com
---

## Get a key
1. Go to https://console.anthropic.com → sign in / create account.
2. **Settings → API Keys → Create Key**. Name it (e.g. "apple-pi").
3. Copy the key — it starts with `sk-ant-` and is shown once.
4. Paste it at the apple-pi "API key" prompt.
5. New accounts: add a small prepaid credit at **Settings → Billing** (Anthropic gives no free trial tokens).

## Dashboard
Keys: https://console.anthropic.com/settings/keys · Usage/billing: https://console.anthropic.com/settings/billing

## Pricing
Pay-per-token. `claude-haiku-4` is the cheap tier; `claude-sonnet-4-5` is the sweet spot for coding; `claude-opus-4` is the premium. No free trial — preload ~$5 to start.

## Common errors
- **401 invalid x-api-key**: key truncated or stale — re-copy the full `sk-ant-…` string.
- **402 credit balance too low / `your credit balance is too low`**: add credits at Billing.
- **429 rate-limit / overloaded**: wait and retry; Sonnet can be busy at peak.

## Tip
Best coding value on Anthropic: `claude-sonnet-4-5`. Verify with haiku first if you're watching spend.
