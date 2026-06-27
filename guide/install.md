# Install

**One line:**

```bash
curl -fsSL https://raw.githubusercontent.com/jotokra/apple-pi/main/install.sh | bash
```

…or clone-and-run:

```bash
git clone https://github.com/jotokra/apple-pi.git
cd apple-pi
bash install.sh
```

## Prerequisites

- A POSIX shell, and `openssl` (for the onboarding vault).
- The `pi` binary — `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`
  (the installer offers to do this for you).
- A model + its API key (or skip the key for an OAuth/subscription provider,
  or use a local model with Ollama — no key, no cost).

::: tip Air-gapped or OAuth providers
`install.sh --skip-confirm` skips the live "prove the connection" call. You'll
verify on first use instead. Useful for subscription providers or machines
with no outbound network at install time.
:::

## What the wizard asks

Four questions, then it builds your config:

1. **Which model** (any name, any provider).
2. **Which provider** (OpenAI, Anthropic, Google, DeepSeek, MiniMax, Mistral,
   Groq, OpenRouter, xAI, Ollama, …).
3. **Your API key** — or skip for OAuth/local. The key is captured through a
   masked prompt, encrypted, used for one confirmation call, then the
   onboarding copy is **destroyed**.
4. **A passphrase** for the onboarding vault.

After that the agent runs `self-assess` to tune `settings.json` to your
model's real capabilities, offers you one workflow to wire (n8n / obsidian /
monitoring), and you're done.

::: warning The key is gone before you start using the agent
The encrypted vault exists only to seed your config. The moment the
connection is confirmed, the onboarding key is pruned. What's left is your
config and Pi's own standard auth store (`~/.pi/agent/auth.json`) — exactly
like a normal install, but proven working. See [the credential vault
how-to](./howto#add-rotate-or-export-a-key) for adding keys you keep.
:::

---

Stuck on getting a key? The built-in **key guide** walks you through ten
providers with pricing, free tiers, and the errors you'll actually hit —
works with zero credentials. See the [README](https://github.com/jotokra/apple-pi#readme)
for the full feature list.
