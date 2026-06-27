---
slug: mistral
display: Mistral
auth: mistral
env: MISTRAL_API_KEY
api: openai-completions
models: mistral-large-latest, codestral-latest, mistral-small-latest
default: mistral-large-latest
base: https://api.mistral.ai/v1
---

## Get a key
1. Go to https://console.mistral.ai → sign in / sign up.
2. **API Keys → Create new API key**. Copy it.
3. Paste it at the apple-pi "API key" prompt.
4. Add a payment method / check the free tier under **Billing / Console**.

## Dashboard
Keys: https://console.mistral.ai/api-keys · Billing: https://console.mistral.ai/billing

## Pricing
`mistral-small` is cheap; `codestral` is tuned for code; `mistral-large` is the flagship. A limited free tier exists on the console for experimentation.

## Common errors
- **401 Unauthorized**: key wrong/truncated — re-copy.
- **403 / no access to model**: some models need plan/region enablement; try `mistral-small-latest` first.

## Tip
For coding work, `codestral-latest` is purpose-built; for general tasks, `mistral-large-latest`.
