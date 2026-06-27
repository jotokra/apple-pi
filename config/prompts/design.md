---
name: design
description: "Design a workflow / automation for X (n8n by default). Output is the workflow definition + sidecar docs ready for your automation repo."
---

# /prompt:design

Design a workflow (n8n by default; adapt to your engine) for the
following goal. Output is a workflow file (JSON for n8n) plus a
markdown sidecar (the docs).

## Step 1 — Trigger

What's the entry point?

- Webhook (HTTP): method, path, auth, rate limit, expected input.
- Schedule (cron): cron expression, timezone.
- Telegram: bot, chat_id (or pattern), allowed senders.
- Email (IMAP): folder, filter.
- Polling: feed URL, frequency.

## Step 2 — Steps

Express the node graph. For each node:

- `id`: stable snake_case.
- `type`: `n8n-nodes-base.<kind>` (or your engine's equivalent).
- `position`: `{x, y}` (rough layout for the UI).
- `params`: the params the node needs.
- Input schema (what fields it reads).
- Output schema (what fields it produces).

## Step 3 — Credentials

List every external service the workflow calls. For each:

- Type (`telegramApi`, `httpHeaderAuth`, etc.).
- Named credential in the engine (or "create as `<name>`").
- Where the secret lives (encrypted in the engine's DB, keyed by
  its encryption key).
- Steps to create if missing.

**Never put credentials in the workflow JSON.** Reference by name.

## Step 4 — Test recipe

A reproducible manual test, step by step:

```bash
# 1. (set up)
# 2. (trigger)
# 3. (assert)
# 4. (cleanup)
```

## Step 5 — Sidecar

Markdown with: purpose, trigger, steps, inputs/outputs,
credentials, test recipe, blast radius, last verified.

## Output

Two files (paths adapt to your automation repo):

1. `<your workflows repo>/workflows/<name>.json` — the workflow
   (engine export format).
2. `<your workflows repo>/docs/<name>.md` — the sidecar.

Use the `n8n-bridge` extension tools
(`n8n_create_workflow_json`) if available; otherwise write to disk
and run your sync script after commit.

## Goal

$ARGUMENTS
