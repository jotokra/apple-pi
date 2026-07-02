---
id: good-sample
title: A well-formed sample card
status: todo
priority: 3
project: apple-pi
assignee: coder
parent: root
depends_on: []
tags: [sample, fixture]
est_commits: 2
parallel_safe: true
created_at: 2026-07-02T22:00:00Z
updated_at: 2026-07-02T22:00:00Z
---
# Body

This is a fixture card used by the M1-1 parser tests. Its frontmatter must
validate against `agentdb/kb/schema-card.js`. Note: there is **no `blocks`
field** — reverse edges are derived from `depends_on` (decision D6).
