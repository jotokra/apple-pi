---
slug: groq
display: Groq (fast inference)
auth: groq
env: GROQ_API_KEY
api: openai-completions
models: llama-3.3-70b-versatile, llama-3.1-8b-instant, openai/gpt-oss-120b
default: llama-3.3-70b-versatile
base: https://api.groq.com/openai/v1
---

## Get a key
1. Go to https://console.groq.com → sign in (Google/GitHub/email).
2. **API Keys → Create API Key**. Copy it (`gsk_…`).
3. Paste it at the apple-pi "API key" prompt.

## Dashboard
Keys: https://console.groq.com/keys · Playground/usage: https://console.groq.com

## Pricing
**Generous free tier** for development (rate-limited requests/day). Groq runs open models (Llama, etc.) on custom hardware — extremely fast. Paid tier raises the limits.

## Common errors
- **401 invalid API key**: re-copy the full `gsk_…`.
- **429 rate limit / `tokens per minute`**: you hit the free-tier limit; slow down or upgrade.
- **model decommissioned**: Groq rotates models — use `llama-3.3-70b-versatile` as the stable default.

## Tip
Cheapest+fastest way to try apple-pi end-to-end: free-tier Groq with `llama-3.3-70b-versatile`. No card required.
