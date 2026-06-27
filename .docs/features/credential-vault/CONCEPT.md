# Credential Vault — user-facing concept

> One-pager for the README / landing page / in-TUI `/help vault` text.
> Plain language. No internal REQ numbers.

## The idea in one sentence

apple-pi gives you a `/vault` command inside the agent: paste a key once, it's
stored encrypted, and from then on the agent can use it without the key ever
sitting in a config file, an environment variable, or your shell history.

## What it replaces

Without the vault, people store API keys the way they always have — and every
way leaks:

| where people put keys today | how it leaks |
|-----------------------------|--------------|
| `~/.zshrc`, `~/.bashrc` | every spawned process sees it (`ps e`), crash dumps contain it |
| `.env` in a project | easy to `git add` by accident; shared in screenshots |
| pasted into chat to "give the agent the key" | lives forever in the session transcript; shipped if the session is exported |
| a plain text file on the desktop | no encryption, indexed by Spotlight, synced to iCloud |

The vault is **the safe path made the easy path**: type `/vault add`, paste,
done. Encrypted at rest, never echoed, never logged.

## The four things it promises

1. **Trace-free entry.** You type the key into a masked prompt — it never
   appears on your input line, so it can't end up in the session log.
2. **Encrypted at rest.** One file, `~/.pi/agent/credentials.vault`, locked
   with a passphrase you choose. Mode `0600` — only you can read it.
3. **You gate every reveal.** Listing shows names, not secrets. Seeing a key
   back is opt-in and warned. Most workflows never need to.
4. **Onboarding cleans up after itself.** The key you paste during install is
   marked "temporary" and is deleted the moment the connection is proven — but
   any keys you add yourself with `/vault add` stay until *you* remove them.

## The commands

```
/vault add [name]        paste + store a key (masked prompt)
/vault list              show names + metadata (never the secrets)
/vault remove <name>     delete one key
/vault get <name>        reveal a key  (opt-in; warned)
/vault rotate <name>     replace a key with a new one
/vault import <file>     bulk-load keys from JSON, then shred the source
/vault export <name>     write a key into auth.json (pi's native auth store)
/vault export-to <name>  run your `vault.exportCmd` with the key on stdin
/vault lock              forget the passphrase until next use
```

## What it is *not*

- Not a password manager (use 1Password / Bitwarden for those). It's for the
  machine-credentials an agent needs: API keys, gateway tokens.
- Not synced across machines. Each machine has its own vault.
- Not recoverable without the passphrase — there is no backdoor, on purpose.

## The honest threat model

The vault defends strongly against **accidental leakage** (logs, env, exports,
shell history) — which is how most keys actually get exposed. It is *defense in
depth*, not a sealed vault against a thief who has your laptop *and* your
passphrase. For that outer wall, turn on **FileVault** (macOS full-disk
encryption); the vault is the inner wall.
