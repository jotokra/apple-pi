---
name: n8n-workflow-author
description: "When asked to design or modify an n8n workflow, follow the canonical pattern: trigger → steps → creds → test recipe → docs sidecar. apple-pi's agent is the canonical n8n author. Trigger phrases: build an n8n workflow for X, automate Y with n8n, create a workflow, design a workflow."
---

# n8n-workflow-author

n8n is the workflow engine. The agent is the canonical author; the
n8n UI is for one-off debugging and visual tweaks. This skill
encodes the design + delivery pattern.

## Where things live (parameterised — set these for your install)

- **Live engine**: `$N8N_BASE_URL` (e.g. `https://n8n.example.com`).
- **API**: `$N8N_BASE_URL/api/v1` — bearer-token auth via
  `$N8N_API_KEY`.
- **Canonical JSON**: `<your workflows repo>/workflows/<name>.json`.
- **Sidecar docs**: `<your workflows repo>/docs/<name>.md`.
- **Sync scripts**: `<your workflows repo>/scripts/sync-to-n8n.sh`
  (push) and `sync-from-n8n.sh` (pull), if you maintain one.

If you don't yet have an n8n instance or a workflows repo, the
**n8n workflow offer** in onboarding stands them up with you.

## The pattern: 5 sections

Every workflow has 5 sections in its design. Use them in order.

### 1. Trigger

What's the entry point? Choose one (or compose):

- **Webhook** (`n8n-nodes-base.webhook`) — for HTTP-triggered flows.
- **Schedule** (`n8n-nodes-base.scheduleTrigger`) — cron-style.
- **Telegram message** (`n8n-nodes-base.telegram`) — bot-triggered.
- **Email** (`n8n-nodes-base.emailReadImap`) — IMAP-triggered.
- **Polling** (`n8n-nodes-base.rssFeedRead`, etc.) — feed-driven.

State: HTTP method (if webhook), path, expected input schema,
auth (none / header / HMAC), rate limit.

### 2. Steps

The directed graph of nodes. Express it as a list:

```
[Trigger] → [Validate input] → [Enrich] → [Branch on X]
                                          ├→ [Path A] → [Aggregate] → [Send]
                                          └→ [Path B] → [Aggregate] ↗
```

Each node: id, type, position, params, and the input/output
schema it produces.

Avoid:

- Hidden side effects (writing files without declaring it in
  the sidecar).
- Branching without a documented merge.
- Long-running subflows without a timeout.

### 3. Credentials

What the workflow needs to call out:

- Which n8n credential **type** (e.g. `telegramApi`,
  `httpHeaderAuth`, `oAuth2Api`).
- Which **named credential** in n8n's DB (e.g. `Telegram Bot`).
- Where the secret lives (encrypted in n8n's SQLite DB, keyed by
  its encryption key).
- How to create the credential if it doesn't exist (URL + steps).

**Never put credentials in the workflow JSON.** n8n references
them by name. If you do, you have shipped a secret to a repo.

### 4. Test recipe

A reproducible manual test:

```bash
# 1. (set up state, if needed)
curl -s "$N8N_BASE_URL/..."

# 2. Trigger the workflow
curl -s -X POST "$N8N_BASE_URL/webhook/<id>" \
    -H "content-type: application/json" \
    -d '{"hello": "world"}'

# 3. Assert the side effect
sleep 5
curl -s "$N8N_BASE_URL/..."
# expect: ...

# 4. (optional) clean up
```

State the **expected result** for each step. "Expect a message
within 5s containing 'hello'" beats "expect success."

### 5. Docs sidecar

`docs/<name>.md` is what the next agent reads when picking up
the workflow. Include:

- **Purpose** — one paragraph.
- **Trigger** — type, schema, auth.
- **Steps** — node-by-node (id, what it does, why).
- **Inputs / Outputs** — concrete JSON examples.
- **Credentials** — type, name, where to create.
- **Test recipe** — the manual steps above.
- **Blast radius** — what this workflow can touch (filesystem?
  network? outbound?). Anything outside the engine is flagged.
- **Last verified** — date + who ran the verification.

## Deploy

```bash
# 1. Write the workflow JSON to <repo>/workflows/
# 2. Write the sidecar to <repo>/docs/
# 3. Commit
cd <your workflows repo>
git add workflows/<name>.json docs/<name>.md
git commit -m "feat(workflow): <name> — <one line>"

# 4. Push + deploy (adapt to your sync mechanism)
git push
./scripts/sync-to-n8n.sh <name>   # or the n8n-bridge create/update tool

# 5. Verify
curl -s "$N8N_BASE_URL/healthz"   # → 200
```

If you edit a workflow in the n8n UI, run the pull script and
commit so the repo stays canonical.

## Anti-patterns

- "I'll write the JSON, the docs can come later." — docs are
  the contract. The next agent reads them, not the JSON.
- A workflow that writes to the user's home directly — flag in
  the sidecar's blast radius.
- A workflow that calls another workflow by ID — IDs can be
  stable per convention, but document the dep.
- A workflow that hardcodes a credential — encrypt it in n8n's
  DB; the JSON refers to it.
- A workflow with no test recipe — every workflow gets one.

## Quick-reference API

```bash
# List workflows
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
    "$N8N_BASE_URL/api/v1/workflows" | jq

# Get one
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
    "$N8N_BASE_URL/api/v1/workflows/<id>" | jq

# Create
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
    -H "content-type: application/json" \
    -d @workflows/<name>.json \
    "$N8N_BASE_URL/api/v1/workflows"

# Update
curl -s -X PUT -H "X-N8N-API-KEY: $N8N_API_KEY" \
    -H "content-type: application/json" \
    -d @workflows/<name>.json \
    "$N8N_BASE_URL/api/v1/workflows/<id>"
```

(The `n8n-bridge` extension wraps these as Pi tools when enabled.)

## See also

- `verify-own-work` — the test recipe is the workflow's close.
- `red-blue` — review inbound webhooks + creds before deploy.
