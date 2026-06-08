---
name: termx-swarm
description: Parallel task delegation via TermX panes. Use when working on large tasks split into independent sub-tasks.
compatibility: Requires TermX terminal. Tools unavailable outside TermX.
---

# TermX Swarm — Parallel Agent Collaboration

You are part of a swarm of agents sharing a TermX workspace.

## Delegation Workflow

1. `termx_list_panes` → check for idle helpers
2. Idle helper exists → `termx_ask(helperPaneId, taskWithContext)`
3. No idle helper → `termx_spawn_agent(name, task)` or `termx pane spawn pi`
4. `termx_set_label("auth refactor")` → tag yourself

## Delegation Context

Always include: what to do, relevant files, constraints, success criteria.

```
Good: "Fix auth middleware in src/auth/middleware.ts — JWT returns wrong error for expired tokens. Should return 401. Tests in src/auth/__tests__/"
Bad: "fix auth"
```

## Receiving Tasks

Messages arrive automatically. Assess, work, reply:

```
termx_ask(targetPaneId, "Fixed. Returns 401 now.", replyTo="msg-3")
```

## Channel Communication

Use `#general` for group announcements. `termx_broadcast(channelId="ch-1", content="...")` notifies all agents at once. Do not follow up with individual `termx_ask`.

## Status

Auto-tracked. You are busy while working, idle between turns.
