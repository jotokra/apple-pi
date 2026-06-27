---
slug: minimax
display: MiniMax
auth: minimax
env: MINIMAX_API_KEY
api: openai-completions
models: MiniMax-M3, MiniMax-M2, abab6.5s-chat
default: MiniMax-M3
base: https://api.minimax.io/anthropic
---

## Get a key
1. Go to https://platform.minimaxi.com (MiniMax open platform) → sign in / register.
2. Open **API Keys** and create a key. Copy it.
3. Paste it at the apple-pi "API key" prompt.
4. Check your account has credits / a valid plan.

## Dashboard
Keys + billing: https://platform.minimaxi.com  (global). For the China endpoint use the MiniMax 海螺/MiniMax China portal and `MINIMAX_CN_API_KEY`.

## Pricing
MiniMax-M3 is a strong hybrid-reasoning model at competitive pricing. Pay-per-token; check the platform for current credit/plan terms.

## Common errors
- **401 invalid key**: re-copy the full key from the platform.
- **wrong base URL**: MiniMax is **Anthropic-compatible** at `https://api.minimax.io/anthropic` — the wizard normalises this for you; just paste `api.minimax.io/anthropic` if asked for a base URL. Using the bare `api.minimax.io` will 404.
- **region**: if `api.minimax.io` is blocked, use the China provider (`minimax-cn`) and its endpoint.

## Tip
MiniMax-M3 is the current flagship. The wizard writes the correct Anthropic-style base URL automatically.
