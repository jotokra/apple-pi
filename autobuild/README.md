# autobuild — autonomous TDD builder for apple-pi

> Goal: **full autonomy.** Arm it once and it drives a project to completion —
> one atomic, tested, committed task at a time — halting only on a real problem.
> Pair with `schedule.sh` for an unattended launchd job that runs batches to
> completion while you sleep.

`autobuild/orchestrator.js` is a **project-agnostic autonomous TDD loop**. Give
it a task queue (`autobuild.tasks.json`) + a worker (an agent CLI, default `pi`)
+ an optional regression command, and it builds the whole thing for you:
TDD-first, fix-loops on failure, regression-gated, one commit per task, with a
live progress dashboard.

## The model: deterministic judge + agent worker + hard gates

The orchestrator is a **judge** (plain Node, no LLM). It does **not** trust the
worker's self-report — after the worker finishes a task, the judge **re-runs the
task's `verify` command itself** and believes only that exit code. That is what
makes autonomy safe:

1. **Pick** the next task whose `depends_on` are all done (queue order).
2. **Spawn** a fresh-context worker (`pi -a -p "<focused TDD prompt>"`) per task.
3. **Judge**: re-run `verify`.
   - **green** → orchestrator commits (clean even if the worker forgot) →
     regression gate (every previously-green test must stay green) → dashboard → next.
   - **red** → feed the failure back to the worker, retry (cap `AUTOBUILD_RETRY_CAP`,
     default 3) → if still red, mark **blocked** and **HALT**.
4. Stop when nothing is pending, or HALT on: blocked task, regression, or a
   `needs_review` task (security-sensitive — waits for a human).

The worker gets a *fresh context per task* (no drift across a long build), and
is told: TDD (test first, run it red, implement, run green), **don't commit**
(the judge commits), **don't edit outside the work tree**, stop on green.

## Why this is "full autonomy" and not reckless

Full autonomy is the goal; the **hard halts are what make it responsible**:
- **Retry cap** — a task that can't go green after N tries is *blocked*, not
  spun on forever, and the loop stops rather than building on a broken base.
- **Regression gate** — a new task that breaks an old test HALTS immediately.
- **`needs_review`** — tasks you flag (auth, truth-mutation, destructive ops)
  halt for a human before committing. Autonomous build, gated apply — same
  philosophy as apple-pi's autoresearch lifecycle.
- **One commit per task** — every step is bisectable and revertable; git log is
  the durable progress trail.

The residual risk (a silent semantic bug the tests don't cover) is mitigated by
TDD-first; if a behavior matters, write its test first so the gate enforces it.

## Configure (all env, all optional)

| Var | Default | Meaning |
|---|---|---|
| `AUTOBUILD_TASKS` | `./autobuild.tasks.json` | the task queue (truth) |
| `AUTOBUILD_STATE` | `./.autobuild` | progress/logs/lock/BUILD.md (gitignore this) |
| `AUTOBUILD_WORKER` | `pi -a -p "$(cat $AUTOBUILD_PROMPT_FILE)"` | the worker; override to use another agent or a fake worker in tests |
| `AUTOBUILD_REGRESSION` | `""` (skip) | a command run after each green task; non-zero exit HALTS (e.g. `node --test`, `make test`) |
| `AUTOBUILD_RETRY_CAP` | `3` | fix-loop attempts before a task is blocked |

The orchestrator passes the worker `AUTOBUILD_PROMPT_FILE`, `AUTOBUILD_TASK_ID`,
`AUTOBUILD_VERIFY` as env, so a custom worker can be as smart as you like.

## Use

```bash
# one-off
node autobuild/orchestrator.js --dry-run        # what's next? (no spawn)
node autobuild/orchestrator.js --once           # one task
node autobuild/orchestrator.js                  # until done / HALT
node autobuild/orchestrator.js --module M0      # restrict to a module tag

# full autonomy — a launchd job that runs batches to completion
bash autobuild/schedule.sh install 3 10 "$(pwd)"   # 3 tasks, every 10 min
bash autobuild/schedule.sh status
bash autobuild/schedule.sh run-now                 # one batch, foreground
bash autobuild/schedule.sh uninstall
```

Track progress live: `.autobuild/BUILD.md` (✅/🟡/⬜ per task), `.autobuild/logs/<task>.<attempt>.log`,
and `git log`. The orchestrator is **resumable + idempotent** — each run reads
`.autobuild/progress.json` and picks up exactly where it left off.

## Task schema (`autobuild.tasks.json`)

```jsonc
{ "tasks": [
  { "id": "T-1", "module": "M0", "title": "...",
    "spec": "what to build", "req": "REQ-T-1: ...",
    "verify": "node --test test/t-1.test.js",   // shell, cwd=project root, exit 0 = pass
    "commit": "feat(scope): ... (T-1)",
    "depends_on": [], "needs_review": false }
] }
```

See `autobuild.tasks.example.json` for a runnable 2-task example.

## Status

Mechanics **proven**: the judge logic (task selection, verify-judging,
commit-on-green, retry→block, regression gate, resumability) is exercised by a
deterministic, **LLM-free** smoke (`smoke/autobuild-judge.sh`) using fake
workers. The default `pi` worker is the live-agent path; validate it on one
real task in your project before arming the schedule unattended.

## See also

- `smoke/autobuild-judge.sh` — deterministic test of the judge (no LLM).
- `autobuild.tasks.example.json` — runnable example queue.
- apple-pi `lifecycle/` — the sibling "autoresearch" module (autonomous
  self-improvement); autobuild is the autonomous-*build* counterpart.
