# apple-pi — Product Spec (v1.0.0)

> Frozen spec. Edits require a version bump + a note in `.docs/decisions/`.
> Tagline: **"apple-pi — delicious and warm. Better than other pi's."**

## What this is

**apple-pi** is a refined, self-tuning **Pi Coding Agent** distribution. It
packages a senior-engineer / red-blue-teamer persona, a methodology skill
set (spec-first, decompose, verify-own-work, red-blue, self-improvement),
and a privacy-respecting onboarding wizard into a single GitHub repo that
any user can clone and run.

It is the productized form of one author's hand-tuned Pi harness, with
**all personal information stripped** and every environment-specific value
parameterized. The user brings their own model and credentials; apple-pi
boots, proves the model works, **destroys the bootstrap secrets**, then
hands control to the agent which discovers the environment, tunes its own
config to the chosen model's real capabilities, and offers to wire in a
workflow.

## What is NOT shipped (the sanitization contract)

The shipped config tree contains **zero** personal information. Concretely,
the following are ABSENT from every file under `config/` and `lib/`:

- author names, usernames, handles
- hostnames, IPs, LAN domains (`*.lan`, overlay IPs)
- service endpoints (git/n8n/llm/hermes hosts) — replaced by env-var
  placeholders resolved at onboarding time
- Telegram chat/thread IDs and bot tokens
- specific provider/model names in `settings.json` (the user picks the
  model; the wizard writes it)
- absolute filesystem paths (all paths are `$HOME`-relative or resolved
  at install)
- references to sibling agents from the author's setup (apple-pi is
  standalone)

**What IS shipped intact:** the persona (generalized), the working +
coding rules (read-first, spec-first, decompose, build-small,
verify-own-work, red-blue, tool-discipline), all 8 skills, all 4 prompt
templates, the self-improvement ritual, and the smoke harness. These are
methodology, not personal data.

## The 6-phase onboarding flow

```
┌─────────────────────────────────────────────────────────────┐
│ install.sh  (bash — bootstrap; no agentic reasoning here)   │
│                                                             │
│  P0 WELCOME → greet, explain, consent to begin              │
│  P1 MODEL   → free-form model string (ANY input accepted)   │
│  P1 CREDS   → capture, encrypt → ~/.pi/onboarding.vault     │
│  P1 CONFIG  → write sanitized settings.json (model only)    │
│  P1 AUTH    → seed ~/.pi/agent/auth.json (0600) from vault  │
│  P1 CONFIRM → one real model call ("reply OK"); gate        │
│  P1 PURGE   → on confirm: delete vault + scratch + temp cfg │
│               (auth.json PERSISTS — see D1)                 │
│                                                             │
│  HANDOFF    → exec a Pi session on the confirmed model      │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ pi agent session (the confirmed model + shipped skills)     │
│                                                             │
│  P2 DISCOVER     → ask permission, then scan the env        │
│                    (os, shell, pkg mgrs, repos, services)   │
│  P3 SELF-IMPROVE → scan the model's REAL capabilities from  │
│                    the pi-ai catalog; run the self-assess    │
│                    ritual; retune settings.json for IT      │
│  P4 INTEGRATED   → announce readiness + tuned-config summary│
│  P5 OFFER        → offer ONE workflow:                      │
│                    n8n / obsidian vault / monitoring        │
└─────────────────────────────────────────────────────────────┘
```

### Why the split

The **bash** layer can't "recognize" a model — it has no reasoning. So it
does only what bash can: capture, encrypt, write files, make one test
call, purge. The **agent** layer (running on the now-confirmed model, with
the shipped skills loaded) does the smart parts: agentic model
recognition, capability-grounded config tuning, environment discovery,
and the workflow offer. This is what makes "any input accepted" real —
the *agent* recognizes the model, not a hardcoded menu.

## Phase contracts (REQ-N)

### P1 — Onboarding (bash)

- **REQ-1-1** `install.sh` accepts a free-form model string and stores it
  verbatim. No validation against any provider/model list.
- **REQ-1-2** Credentials are captured (API key, optional base URL,
  optional OAuth note) and encrypted with a user-supplied passphrase to
  `~/.pi/onboarding.vault` using `openssl enc -aes-256-cbc -pbkdf2
  -iter 600000`. The passphrase is never written to disk.
- **REQ-1-3** A sanitized `settings.json` is written with the model
  choice + safe defaults; it contains NO personal info.
- **REQ-1-4** `~/.pi/agent/auth.json` (mode 0600) is seeded from the
  decrypted creds in Pi's native format. (`auth.json` is Pi's runtime
  auth store, not onboarding scratch.)
- **REQ-1-5** A single confirmation call is made
  (`pi -p "Reply with the single word OK." --no-tools`). Non-`OK`/error
  → the user is offered retry or abort. No purge on failure.
- **REQ-1-6** On confirm: the vault and the onboarding scratch dir are
  deleted (`rm -P` / shred where supported). The seed `settings.json` is
  **retained as internal scaffolding** (it carries `"_applepi_seed": true`)
  because Pi needs it to run P3 at all — but it is NOT the user's config
  yet. P3 rewrites it into the user's clean config (REQ-3-5). The encrypted
  credential is gone at this point; only `auth.json` (Pi's runtime store)
  holds the key.
  `auth.json` PERSISTS (the user's runtime auth); `--purge-auth-too` is
  the opt-in that also removes it.
- **REQ-1-7** The script then hands off to a Pi agent session that reads
  `lib/handoff.md` to drive phases P2–P5.

### P2 — Discovery (agent, with permission)

- **REQ-2-1** The agent explicitly asks for permission before scanning.
  No scan until the user consents.
- **REQ-2-2** The scan is read-only and limited to: OS, shell, package
  managers, an existing `~/.pi` if present, project/repo directories the
  user points at (or a safe default like `$HOME`), git identity
  (`user.name`/`user.email` — for commit attribution), and any obvious
  local services on loopback. It does NOT read SSH keys, browser data,
  keychains, or dotfile secrets.
- **REQ-2-3** Findings are written to `~/.pi/discovery.json` and the
  handoff continues.

### P3 — Self-improvement (agent)

- **REQ-3-1** The agent resolves the user's model string (via
  `pi --list-models`, the catalog, or by guiding a custom-model add to
  `~/.pi/agent/models.json`). "Agentic recognition" — any input gets a
  genuine attempt, not a reject.
- **REQ-3-2** The agent reads the model's REAL capabilities from the
  pi-ai catalog + request-shaping adapter (context window, thinking
  format = effort vs budget, vision, max tokens, cost) — NOT from prose.
- **REQ-3-3** The agent runs the `self-assess` ritual (3-iteration loop,
  verify-don't-assume, audit trail) and retunes `settings.json` for the
  confirmed model (thinking levels mapped to the model's real tiers,
  compaction reserve scaled to its context window, favorites set to
  runnable models, dead config removed).
- **REQ-3-4** A decisions doc is written to
  `~/.pi/agent/self-assessment-<date>.md` (audit trail).
- **REQ-3-5** **The agent rewrites `settings.json` into the USER'S CLEAN
  CONFIG** — strips the `_applepi_seed` marker and every `_comment` /
  `_*_comment` field, keeps only real Pi keys tuned to the model. After
  this, `~/.pi/agent/settings.json` reads like the user wrote it for
  their model; nothing betrays that apple-pi authored it. This is the
  second half of D1: the internal onboarding config is wiped (by
  transformation), the user is left with their own config living
  alongside `auth.json`.

### P4 — Integrated

- **REQ-4-1** The agent announces it is fully integrated and prints a
  summary: confirmed model + key capabilities, tuned-config highlights,
  skills/prompts/extensions available.

### P5 — Workflow offer

- **REQ-5-1** The agent offers exactly ONE of three workflows and waits:
  1. **n8n automation** — instantiate the `n8n-workflow-author` skill +
     `n8n-bridge` extension parameterized to the user's n8n (or help them
     stand one up).
  2. **obsidian vault** — wire the `session-record` skill to the user's
     vault path (docs-in/docs-out bridge).
  3. **monitoring** — a status/health extension parameterized to the
     services the discovery phase found (NetBird-style if present, else a
     generic loopback-service health checker).
- **REQ-5-2** Each workflow is its own follow-up; apple-pi does not
  auto-install all three.

## Decisions (the "why")

| ID | Decision | Rationale |
|----|----------|-----------|
| D1 | Two-phase config lifecycle. During onboarding (until model confirmed + P3 tunes), apple-pi uses an INTERNAL seed config (`settings.json` carrying `_applepi_seed: true`) — scaffolding, not the user's config. On model confirm the encrypted vault is deleted and the scratch wiped; the seed is **retained only so P3 can run**. P3 then **rewrites `settings.json` into the user's clean config** (strips the seed marker + every `_comment` field, tunes to the model) — the internal onboarding config is wiped by transformation. What persists is the user's own config + `auth.json` + skills/prompts/extensions. `auth.json` is kept (runtime auth); `--purge-auth-too` opts into removing it too. | The user's intent: "wipe the internal onboarding/agentic-guidance config once the model is set up; the user is left with only their own config alongside auth.json." Deleting `settings.json` outright is wrong — Pi needs it to run P3, and the user needs a tuned config afterward. Rewriting it clean satisfies both "wipe the scaffolding" and "user keeps their own config." (Revised from the original v1.0.0 D1 after user clarification 2026-06-27.) |
| D2 | `openssl enc -aes-256-cbc -pbkdf2 -iter 600000` for the vault | Zero deps on macOS/Linux. The vault is transient (deleted within minutes of creation), so this is defense-in-depth during bootstrap, not long-term storage. `age` is a documented future option. |
| D3 | Build at `~/Projects/apple-pi/`, remote prepped for GitHub | User said "github repo." Remote set with a placeholder username; push is a one-liner. LAN-forgejo option noted. |
| D4 | Bash bootstraps; agent does recognition + tuning | Makes "any input accepted" genuine — a hardcoded model menu would contradict it. |
| D5 | Sanitization is enforced + smoke-tested | `smoke/sanitize.sh` greps the shipped tree for the author's personal tokens; CI-shape without CI. |
| D6 | apple-pi is ALSO a valid Pi package (`package.json` + `pi` manifest) | Advanced users can `pi install git:github.com/<user>/apple-pi` to get skills/prompts/extensions without the wizard; `install.sh` remains the blessed first-run path. |

## Risks + open questions

- **"Any model" that doesn't resolve:** the agent guides a custom add
  (`~/.pi/agent/models.json` for OpenAI/Anthropic/Google-compatible APIs,
  or a custom-provider extension). The wizard never hard-fails on a model
  string; worst case it lands in a guided manual-config loop.
- **Encryption strength of openssl pbkdf2:** adequate for a
  minutes-lifetime transient file holding creds that ALSO live in the
  0600 `auth.json`. Not a long-term secrets store.
- **`auth.json` format varies by provider:** the wizard writes the
  OpenAI/Anthropic-style `{provider: {apiKey: ...}}`; OAuth-based
  providers (ChatGPT/Copilot/Claude subscriptions) are better handled via
  `/login` post-bootstrap, and the wizard says so.
- **Nested Pi session in P2–P5:** the handoff `exec`s a new `pi` on the
  confirmed model. Tested that the command composes correctly; a full
  nested live run needs the user's real key.

## Verification (REQ-V)

- **V-1** `bash smoke/sanitize.sh` → exit 0 (no personal tokens in tree).
- **V-2** `bash smoke/onboard-sandbox.sh` → runs the full P1 flow against
  a throwaway `PI_CODING_AGENT_DIR`, confirms vault creation + purge,
  never touches the real `~/.pi`. (Model-confirm step is stubbed since
  the sandbox has no key.)
- **V-3** `bash smoke/structure.sh` → all expected files present, JSON
  valid, skills/prompts/extensions counted.
- **V-4** `bash smoke/run.sh` → the suite.

## Reading order (for future agents)

1. `README.md` — storefront.
2. `.docs/PLAN.md` — this file.
3. `install.sh` + `lib/` — the wizard.
4. `config/agent/AGENTS.md` — the persona every session loads.
5. `config/skills/self-assess/SKILL.md` — the ritual P3 runs.

## Version history

- **v1.0.0** — 2026-06-27. Initial product: sanitized persona + 8 skills
  + 4 prompts + 7 extension templates + 6-phase onboarding wizard + smoke
  suite.
