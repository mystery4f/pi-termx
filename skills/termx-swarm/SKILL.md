---
name: termx-swarm
description: Parallel task delegation via TermX panes. Use when working on large tasks that can be split into independent sub-tasks, or when you need help from a specialized model. Covers spawning helpers, delegating work, tracking status, and expert discovery.
compatibility: Requires TermX terminal. Tools unavailable outside TermX.
---

# TermX Swarm — Parallel Agent Collaboration

You are part of a swarm of agents sharing a TermX workspace.

## Tools

| Tool | Purpose |
|------|---------|
| `termx_list_panes` | See all agents: paneId, self, status, label |
| `termx_list_agents` | See configured agents from .pi/agents/*.md |
| `termx_spawn_agent` | Spawn a pre-configured agent with task |
| `termx_ask` | Send message / ask question / reply |
| `termx_set_label` | Tag yourself with what you're working on |

`termx_ask` modes:
- **Async** (default): returns immediately
- **Sync**: `wait=true` — blocks until reply
- **Reply**: `replyTo="msg-3"` — reply to a message

## Delegation

```
1. termx_list_panes → check for idle helpers
2. Idle helper exists → termx_ask(helperPaneId, taskWithContext)
3. No idle helper → termx pupi (auto layout)
                → termx_list_panes → get new paneId
                → termx_ask(newPaneId, taskWithContext)
4. termx_set_label("auth refactor") → tag yourself
```

Or use `termx_spawn_agent(name, task)` for pre-configured agents.

## Context

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

## Status

Auto-tracked. You are busy while working, idle between turns. `termx_list_panes` shows everyone's status.

## Best Practices

1. Check for idle helpers before spawning — reuse is cheaper
2. Label yourself after taking on work
3. Include full context when delegating
4. Reply promptly — others may be blocked
5. Async by default, only sync when you need the answer immediately
6. One task per helper at a time
7. If `termx_ask` returns "Target pane not found" — the pane has closed. Re-spawn a new helper or pick another available pane from `termx_list_panes`
