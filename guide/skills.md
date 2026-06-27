# Skills

Skills are reusable methodologies, not prompts. Each ships a `SKILL.md` that
the agent loads when a trigger phrase matches. You can read, run, edit, or
remove any of them.

## The eight skills

| Skill | Trigger | What it gives you |
|---|---|---|
| **plan-decompose** | "plan X", "decompose", "break this down" | a parent spec + N independent sibling tasks, each with verification hooks |
| **read-docs-first** | names a repo, "in repo X" | the pre-flight reading order before touching any code |
| **verify-own-work** | "is this done", "verify", "smoke test" | closed-loop self-test after every change |
| **red-blue** | "is this secure", "review for security" | find every way a change can be broken, exploited, or silently fail |
| **self-assess** | "self-assess", "tune yourself to my model" | re-derive config from the model's real capabilities; audit trail |
| **session-record** | "save this session", "resume work on X" | distill sessions to the vault; reload prior records |
| **long-horizon-compaction** | "continue working on X", multi-day work | tree-branch + compaction discipline |
| **n8n-workflow-author** | "build an n8n workflow for X" | trigger → steps → creds → test recipe → docs sidecar |

## How they're invoked

You don't call skills by name (though you can, with `/skill:<name>`).
Describe the work — "red-team this auth change", "plan the next phase" — and
the matching skill's `SKILL.md` is loaded as context. The trigger phrases in
the table are the natural-language handles.

## Editing skills

Skills live in `config/skills/<name>/SKILL.md`. They're plain markdown with
frontmatter. Edit freely — they're part of your config, not a sealed binary.
Removed skills simply stop matching; added ones are discovered on next
session start.
