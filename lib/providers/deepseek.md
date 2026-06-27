---
slug: deepseek
display: DeepSeek
auth: deepseek
env: DEEPSEEK_API_KEY
api: openai-completions
models: deepseek-chat, deepseek-reasoner
default: deepseek-chat
base: https://api.deepseek.com
---

## Get a key
1. Go to https://platform.deepseek.com → sign in / register.
2. **API Keys → Create API Key**. Copy it (starts with `sk-`).
3. Paste it at the apple-pi "API key" prompt.
4. Top up credits at **Billing** (small prepaid balance; DeepSeek is very cheap).

## Dashboard
Keys: https://platform.deepseek.com/api_keys · Usage/Top-up: https://platform.deepseek.com/usage

## Pricing
Among the cheapest capable models. `deepseek-chat` (V3.x) is a strong, low-cost coder; `deepseek-reasoner` (R1-style) thinks longer for harder tasks. Pay-per-token, prepaid balance.

## Common errors
- **402 insufficient balance**: add credits at Top-up.
- **401 Authentication Fails**: key wrong/truncated — re-copy the `sk-…`.
- **region blocks**: if the global endpoint is unreachable, try the China endpoint (`https://api.deepseek.com` works for both; accounts differ).

## Tip
Excellent price/performance for coding. Start with `deepseek-chat`.
