---
id: feat-credential-vault
title: "Credential Vault — reusable, encrypted, trace-free secret store"
status: review
parent: root
depends_on: []
blocks: []
parallel_safe: true
est_commits: 6
---

# Credential Vault — roadmap card

Promote the onboarding vault from a throwaway to a first-class, persistent,
encrypted, trace-free credential store, writable from a `/vault` prompt in the
pi TUI. Spec: `SPEC.md`. Security model: `SECURITY.md`. User concept:
`CONCEPT.md`.

## Child cards (one commit each)

| id | title | deps | parallel? |
|----|-------|------|-----------|
| cv-core | vault file open/read/write/encrypt (pure fns) + `bin/apple-pi vault` CLI | — | yes |
| cv-tui | `/vault` slash-command extension (add/list/remove/get/lock); masked input; arg refusal | cv-core | no (builds on cv-core) |
| cv-tracefree-test | REQ-CV-7 marker-secret grep over sessions/telemetry/logs | cv-core, cv-tui | no |
| cv-onboarding | install.sh dual-lifetime: transient entry, prune-only-transient on confirm | cv-core | yes (with cv-telemetry) |
| cv-telemetry-safety | collector denylist + persona AGENTS.md rule | — | yes |
| cv-rotate-import-export | `/vault rotate`/`import`/`export` convenience subcommands | cv-tui | no (builds on cv-tui) |

## Suggested merge order

`cv-core → cv-tui → cv-tracefree-test → (cv-onboarding ‖ cv-telemetry-safety) → cv-rotate-import-export → PR to main`

## Acceptance (gate to merge)

- [x] `smoke/vault-roundtrip.sh` green (V-1)
- [x] `smoke/vault-tracefree.sh` green — **zero** marker hits (V-2, REQ-CV-7)
- [x] `smoke/vault-onboarding.sh` green — transient pruned, persistent survives (V-3)
- [x] `smoke/sanitize.sh` + `smoke/structure.sh` green; `*.vault` gitignored (V-4)
- [x] `SECURITY.md` red-team R1–R8 each re-read and either mitigated or explicitly accepted (incl. the rotate/import/export addendum)
- [x] `CONCEPT.md` text mirrored into README "Credential Vault" section

All six child cards committed on `feat/credential-vault`; all 8 smokes green.
Ready to PR to `main`.

## Out of scope (separate cards, later)

- Passphrase rotation
- Cross-machine sync
- OAuth token storage
- Web/GUI view
