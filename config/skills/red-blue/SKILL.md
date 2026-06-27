---
name: red-blue
description: "When a change touches auth, secrets, file paths outside the workdir, network listeners, sudo, file permissions, or anything that can be silently broken: run a red/blue review pass. Find every way it can be broken, exploited, or silently fail. Trigger phrases: is this secure, review for security, or any change touching the surfaces listed above."
---

# red-blue

Two passes, both required:

- **Blue team** (defender): what does this change *protect*, and
  does it actually protect it?
- **Red team** (attacker): how would I break this if I were
  hostile? What's the smallest action that produces the worst
  outcome?

## Trigger surface (review if any of these apply)

- Authentication / authorization code or config.
- Secret material (API keys, tokens, encryption keys, SSH keys,
  `.env`, `auth.json`, any `*_KEY` / `*_TOKEN` env var).
- File paths outside the working directory (`~`, `/tmp`, `/etc`,
  `/usr/local`, system dotfiles).
- Network listeners (any port, any interface).
- `sudo` / setuid / LaunchDaemons / cron / systemd running as
  root or another user.
- File permissions (chmod, chown, mode bits).
- Symlinks (especially cross-profile, cross-user, or absolute).
- Webhooks / inbound HTTP endpoints.
- Anything that runs unattended (cron, LaunchDaemon, systemd
  unit, GitHub Action, n8n schedule).
- Install scripts that write into the user's home / dotfiles.

## Blue team checklist

- [ ] Principle of least privilege: does the code run with
  exactly the permissions it needs?
- [ ] Secrets out of repo: no key in any committed file; secret
  in env var or gitignored file with mode 600/400.
- [ ] Input validation: every external input (user, network,
  file, env) is checked at the boundary, not deep in the call
  stack.
- [ ] Output encoding: any user-controlled string rendered to
  shell, HTML, SQL, or filesystem is escaped/sanitized.
- [ ] Fail closed: when auth/permission is uncertain, deny. Not
  "allow with a warning" — deny.
- [ ] Audit trail: every state-changing operation logs *who*,
  *what*, *when* — not just success.
- [ ] Idempotency: re-running the same operation doesn't
  double-charge, double-write, or double-notify.
- [ ] Rotation path: if this credential or key is compromised,
  what's the kill switch? Document it.

## Red team checklist

For each item in the change, ask: "What's the smallest input
that produces the worst output?"

- [ ] Path traversal: can `../` escape the workdir in any user-
  supplied path?
- [ ] Command injection: any string concatenated into a shell
  command where the user (or external input) controls part of
  it? Use `execve` with argv, not `system()` with a string.
- [ ] SQL injection: any string concatenated into a query?
- [ ] SSRF: any URL fetched where the user controls the host?
- [ ] Privilege escalation: does this code run with more
  privilege than it needs?
- [ ] Race / TOCTOU: any "check, then act" sequence without a
  lock?
- [ ] Symlink attack: any write to a predictable path under
  `/tmp` or a shared dir where an attacker could plant a
  symlink?
- [ ] Replay: any nonced request that doesn't actually validate
  the nonce?
- [ ] Default-deny: what's the default if a config field is
  missing or malformed? It should be "refuse to start," not
  "start with permissive defaults."
- [ ] Logging secrets: does any log line include a token, key,
  password, or PII? Grep your own diff.

## Portable failure modes worth memorising

(Recurring across many environments; consult before deciding a
change is safe.)

- **`.env` / secret files are gitignored.** Don't `git add` them,
  even with `--force`. If a cron or watcher enforces the
  gitignore, force-adding won't save you anyway.
- **Token leakage in shell commands.** A token pasted into a
  `sed`/`echo` expansion gets redacted in *output* but the
  *command* still runs with the unredacted value, and may land
  in shell history. Read secrets from a file via a real read,
  not via string interpolation.
- **Credentials never in workflow/config JSON.** Automation
  engines store creds encrypted in their own DB, keyed by an
  encryption key. A workflow that needs a cred references it by
  name only; the sidecar docs explain how to create it.
- **Agent auth files are mode 0600, gitignored, and never in a
  repo.** The harness writes its own auth store from `/login` or
  an env var.
- **`sudo` without confirm is a red flag.** Any script that runs
  `sudo` non-interactively should be gated behind explicit user
  consent, and its blast radius documented.
- **Inbound webhooks need an auth check.** A webhook reachable
  on any interface without a shared secret / HMAC / signature
  check is an open command-injection surface.

## Output

A red/blue review produces:

1. A 1-paragraph threat model: "This change <does X>, protects
   <Y>, and trusts <Z>."
2. A list of findings, each rated:
   - **BLOCKER**: must fix before commit.
   - **WARNING**: fix or document the residual risk.
   - **NIT**: clean-up, optional.
3. The mitigations applied, listed by commit.

Findings + mitigations go in the commit body. The threat model
goes in the spec (parent plan) under "Risks" or "Frozen
decisions."

## See also

- `verify-own-work` — the close-loop the review runs inside.
- `read-docs-first` — read the existing security contract before
  reviewing.
