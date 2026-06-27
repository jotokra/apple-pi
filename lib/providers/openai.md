---
slug: openai
display: OpenAI
auth: openai
env: OPENAI_API_KEY
api: openai-completions
models: gpt-5, gpt-5-mini, gpt-4o, gpt-4o-mini, o3, o4-mini
default: gpt-5
base: https://api.openai.com/v1
---

## Get a key
1. Go to https://platform.openai.com/api-keys (sign in with your OpenAI account).
2. Click **Create new secret key** → give it a name (e.g. "apple-pi").
3. Copy the key immediately — it starts with `sk-` and is shown only once.
4. Paste it at the apple-pi "API key" prompt.
5. If you have no account: https://platform.openai.com/signup (new accounts get a small free credit).

## Dashboard
Usage + billing: https://platform.openai.com/usage · Add credits: https://platform.openai.com/settings/organization/billing

## Pricing
Pay-per-token. gpt-4o-mini is the cheapest real model (~$0.15/M in). New accounts get trial credit; after that you must add a card. Set a monthly spend limit in Billing to avoid surprises.

## Common errors
- **401 Incorrect API key / `sk-...` truncated**: the key was copied incompletely. Re-copy the whole `sk-...` string.
- **429 Rate limit / quota**: out of credits or hit the rate limit. Add credits at Billing, or wait.
- **403 Country not supported**: OpenAI blocks some regions. Use a gateway like OpenRouter instead.

## Tip
Cheapest way to try apple-pi on OpenAI: `gpt-4o-mini`. Switch to `gpt-5` once it's working.
