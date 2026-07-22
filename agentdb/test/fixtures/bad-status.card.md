---
id: bad-status-sample
title: A card with an invalid status
status: wip
priority: 3
project: apple-pi
parent: root
depends_on: []
created_at: 2026-07-02T22:00:00Z
updated_at: 2026-07-02T22:00:00Z
---
# Body

`status: wip` is not in the enum
{triage,backlog,todo,in_progress,blocked,review,done}, so this card must FAIL
validation with a field-specific error.
