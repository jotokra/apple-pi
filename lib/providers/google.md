---
slug: google
display: Google (Gemini)
auth: google
env: GEMINI_API_KEY
api: google-generative-ai
models: gemini-2.5-pro, gemini-2.5-flash, gemini-2.0-flash
default: gemini-2.5-flash
base: https://generativelanguage.googleapis.com/v1beta
---

## Get a key
1. Go to https://aistudio.google.com/apikey (sign in with a Google account).
2. Click **Create API key** (first key may also create a project — that's fine).
3. Copy the key (a long string starting with `AIza…`).
4. Paste it at the apple-pi "API key" prompt.

## Dashboard
Keys: https://aistudio.google.com/apikey · Usage: Google Cloud console → billing (the AI Studio free tier is generous)

## Pricing
**Free tier exists** (rate-limited per minute/day) — great for trying apple-pi at no cost. Paid is pay-per-token above the free quota. `gemini-2.5-flash` is cheap and fast.

## Common errors
- **400 API key not valid / `API_KEY_INVALID`**: key copied wrong — re-copy the whole `AIza…` string.
- **429 quota exceeded**: you hit the free-tier rate limit; wait a minute, or enable billing.
- **403 permission denied**: the key's project doesn't have the Generative Language API enabled — create the key from AI Studio (it enables it automatically).

## Tip
Cheapest real path: free-tier `gemini-2.5-flash`. No card required to start.
