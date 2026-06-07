# pi-termx

Pi Extension for TermX — agent communication and parallel task delegation within a TermX workspace.

## Features

- **`termx_list_panes`**: Discover other agents with self/status/label
- **`termx_ask`**: Sync/async/reply messaging between agents
- **`termx_set_label`**: Tag yourself for expert discovery
- **Auto-status**: Busy/idle inferred from message state
- **WS messaging**: Real-time message delivery via TermX CliServer

## Requirements

- [TermX](https://github.com/mystery4f/TermX) terminal multiplexer
- Pi agent running inside a TermX pane (auto-detects `TERMX_PORT`/`TERMX_TOKEN`)

## Install

### Via Git Submodule (recommended)

```bash
git submodule add https://github.com/mystery4f/pi-termx.git .pi/extensions/pi-termx
```

### Manual

```bash
mkdir -p .pi/extensions/pi-termx
curl -o .pi/extensions/pi-termx/index.ts https://raw.githubusercontent.com/mystery4f/pi-termx/main/index.ts
```

## Usage

Once installed, the extension auto-loads when pi starts inside TermX. No configuration needed.

```
# List all agents
termx_list_panes()

# Ask another agent a question (blocks until reply)
termx_ask(targetPaneId="abc12345", content="Fix auth middleware?")

# Fire-and-forget notification
termx_ask(targetPaneId="abc12345", content="Auth fixed.", async=true)

# Reply to a received message
termx_ask(targetPaneId="abc12345", content="Done.", replyTo="msg-3", async=true)

# Set your label for expert discovery
termx_set_label(label="auth module refactor")
```

## Skill

Pair with the `termx-swarm` skill (`.pi/skills/termx-swarm/SKILL.md` in TermX) for swarm collaboration best practices.
