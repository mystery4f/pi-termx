---
name: termx-swarm
description: Parallel task delegation via TermX panes. Use when working on large tasks that can be split into independent sub-tasks, or when you need help from a specialized model. Covers spawning helpers, delegating work, tracking status, and expert discovery.
compatibility: Requires TermX terminal. Tools unavailable outside TermX.
---

# TermX Swarm — Parallel Agent Collaboration

You are part of a swarm of agents sharing a TermX workspace. You can spawn helpers, delegate work, and coordinate via messages.

## Tools

| Tool | When to use |
|------|-------------|
| `termx_list_panes` | See all agents: their paneId, self/not-self, status (idle/busy), label |
| `termx_ask` | Send/ask/reply to another agent |
| `termx_set_label` | Tag yourself with what you're working on (helps others find you) |

`termx_ask` modes:
- **Async** (default): `termx_ask(targetPaneId, content)` — returns immediately
- **Sync**: `termx_ask(targetPaneId, content, wait=true)` — blocks until reply
- **Reply**: `termx_ask(targetPaneId, content, replyTo="msg-3")` — reply to a message

## When to Delegate

Recognize these patterns and **proactively** delegate:

1. **Parallelizable sub-tasks**: "Fix auth tests" + "Update API docs" can run in parallel
2. **Heavy computation**: Model A explores, Model B verifies
3. **Specialized work**: Use lighter/cheaper models for simple tasks, stronger models for complex reasoning

## Delegation Workflow

```
1. termx_list_panes → check for idle helpers (status: idle)
   ↓
2a. Idle helper found → termx_ask(helperPaneId, taskWithContext)
   ↓
2b. No idle helper → `termx pane spawn pi --model <model>` (bash)
                    → wait for pane to appear
                    → termx_list_panes → get new paneId
                    → termx_ask(newPaneId, taskWithContext)
   ↓
3. termx_set_label("auth module refactor") → tag yourself
4. Wait for replies (arrive automatically via trigger)
```

## Layout Management

Avoid cramming too many panes into one tab:
- **First helper**: `termx pane spawn pi --dir down`
- **Second helper**: `termx pane spawn pi --dir right`
- **Third+ helper**: `termx tab new` then `termx pane spawn pi --dir down` (fresh tab)
- Never have more than 2-3 panes per tab — use new tabs for more helpers.
- Use `--from <paneId>` to split from a wide empty pane rather than your own.

## Context When Delegating

Always include in your ask:
- What exactly needs to be done
- Relevant file paths
- Any constraints or known issues
- A clear success criteria

```typescript
// Good delegation:
termx_ask(targetPaneId, "Fix auth middleware in src/auth/middleware.ts — the JWT verification fails for expired tokens. Should return 401 with clear error message. Tests in src/auth/__tests__/middleware.test.ts.")

// Bad delegation:
termx_ask(targetPaneId, "fix auth")
```

## Receiving Tasks

When you receive a message (triggered automatically):
1. Assess the task — can you handle it immediately?
2. If yes: work on it, then reply with results
3. If no: reply explaining why, suggest who might help

```typescript
// Replying to a received message (msg-3):
termx_ask(targetPaneId, "Fixed. JWT now returns 401 with 'Token expired' message.", replyTo="msg-3")
```

## Expert Discovery

If you need expertise on a specific topic:
1. `termx_list_panes` → look at labels
2. Find agent with matching label → `termx_ask` them directly
3. They already have context from their earlier work

Set your own label so others can find you: `termx_set_label("auth module refactor")`

## Model Selection

When spawning a helper, pi uses your default model. To discover available models, read `~/.pi/agent/settings.json` — check `providers` and `models` fields.

```bash
terminal pane spawn pi                              # uses default
terminal pane spawn pi --model <configured-model>   # only if you've confirmed it exists in settings
```

Never guess model names. If you want a specific capability (cheaper, faster, vision), read settings first to find a configured provider that supports it.

## Status Management

- You are `busy` when you have an unanswered ask (someone is waiting for you)
- You become `idle` when you reply (automatically inferred)
- `termx_list_panes` shows current status for all agents

## Best Practices

1. **Always check for idle helpers before spawning** — reuse is cheaper
2. **Label yourself after taking on work** — helps expert discovery
3. **Include context when delegating** — don't make helpers guess
4. **Reply promptly** — other agents may be blocked waiting for you
5. **Async by default. Use wait=true to block for replies** — don't block yourself unnecessarily
6. **One task per helper** — let them finish before assigning more
