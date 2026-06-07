/**
 * TermX Extension - 消息收发
 *
 * termx_list_panes: 找其他 pane
 * termx_ask: 发消息(同步等回复 / 异步 / 回复)
 * WS 收消息自动触发 turn
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import WebSocket from "ws";
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { discoverAgents, getAgent } from "./agents";

const PORT = process.env.TERMX_PORT;
const TOKEN = process.env.TERMX_TOKEN;
const PANE_ID = process.env.TERMX_PANE_ID || "";

const IS_TERMX = !!(PORT && TOKEN && PANE_ID);

function api(endpoint: string, body: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const postData = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1", port: parseInt(PORT!, 10), path: endpoint, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
        timeout: 5000,
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => { data += c; });
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid response")); } });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { reject(new Error("Timeout")); req.destroy(); });
    req.write(postData);
    req.end();
  });
}

export default function termxExtension(pi: ExtensionAPI) {
  if (!IS_TERMX) return; // 不在 TermX 中,静默跳过
  let ws: WebSocket | null = null;
  let paneId = PANE_ID;

  // ── WS 收消息 ──

  pi.on("session_start", async () => {
    try {
      ws = new WebSocket(`ws://127.0.0.1:${PORT}/events`);
      ws.on("open", () => {
        ws!.send(JSON.stringify({ type: "listen", paneId, token: TOKEN }));

        // 注入:告诉模型可以并行派活
        pi.sendMessage({
          customType: "termx-init",
          content: [
            "[TermX] You can delegate work to helper agents:",
            "  - termx_list_panes: see all helpers (status: idle/busy, label: what they do)",
            "  - Use idle helpers first, spawn more only when needed",
            "  - Spawn: `termx pane spawn pi` (uses default model, add --dir down/right)",
            "  - Tag: `termx pane label <paneId> <label>` to mark what a helper works on",
            "  - Delegate: termx_ask(targetPaneId, content) - include relevant code/context",
            "  - Replies arrive automatically",
          ].join("\n"),
          display: false,
        }, { triggerTurn: false });
      });
      ws.on("message", (raw) => {
        try {
          const envelope = JSON.parse(raw.toString()) as { type: string; message?: Record<string, unknown> };
          if (envelope.type !== "message" || !envelope.message || envelope.message.to !== paneId) return;
          const msg = envelope.message as { id: string; from: string; content: string; replyTo?: string };

          pi.sendMessage(
            {
              customType: "termx-message",
              content: [
                `📩 ${msg.from.slice(0, 8)} [${msg.id}]`,
                `"${msg.content}"`,
                `→ Reply: termx_ask(targetPaneId="${msg.from}", content="...", replyTo="${msg.id}")`,
              ].join("\n"),
              display: true,
              details: msg,
            },
            { triggerTurn: true },
          );
        } catch { /* ignore */ }
      });
    } catch { /* WS failed */ }
  });

  pi.on("session_shutdown", async () => {
    if (ws) { ws.close(); ws = null; }
  });

  // ── termx_set_label ──

  pi.registerTool({
    name: "termx_set_label",
    label: "Set Your Label",
    description: "Set a label describing what you are currently working on. This helps other agents discover you as an expert on this topic.",
    parameters: Type.Object({
      label: Type.String({ description: "What you are working on (e.g., 'auth module refactor')" }),
    }),
    async execute(_id, params) {
      const result = await api("/api/pane/label", { token: TOKEN, paneId, targetPaneId: paneId, label: params.label });
      if (result.ok) return { content: [{ type: "text", text: `Label set: ${params.label}` }] };
      return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    },
  });

  // ── termx_list_panes ──

  pi.registerTool({
    name: "termx_list_panes",
    label: "List TermX Panes",
    description: "List all panes and tabs.",
    parameters: Type.Object({
      allTabs: Type.Optional(Type.Boolean()),
      tabIndex: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      const body: Record<string, unknown> = { token: TOKEN, paneId };
      if (params.allTabs) body.allTabs = true;
      if (params.tabIndex !== undefined) body.tabIndex = params.tabIndex;
      const result = await api("/api/pane/list", body);
      if (result.ok) return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
      return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    },
  });

  // ── termx_ask ──

  pi.registerTool({
    name: "termx_ask",
    label: "Send / Ask / Reply",
    description: "Send a message to another pane. Async by default (returns immediately). Set wait=true to block until reply. Set replyTo to reply to a message.",
    parameters: Type.Object({
      targetPaneId: Type.String({ description: "Target pane ID" }),
      content: Type.String({ description: "Message" }),
      wait: Type.Optional(Type.Boolean({ description: "Block until reply (default: false)" })),
      timeout: Type.Optional(Type.Number({ description: "Max wait time in ms (default: 120000 = 2 min)" })),
      replyTo: Type.Optional(Type.String({ description: "Reply to this message ID" })),
    }),
    async execute(_id, params, signal) {
      // 选 endpoint
      const isSync = params.wait && !params.replyTo;
      const endpoint = params.replyTo ? "/api/msg/reply" : isSync ? "/api/msg/ask" : "/api/msg/send";

      const body: Record<string, unknown> = {
        token: TOKEN, paneId,
        targetPaneId: params.targetPaneId,
        content: params.content,
      };
      if (params.replyTo) body.msgId = params.replyTo;

      const result = await api(endpoint, body);
      if (!result.ok) return { content: [{ type: "text", text: `Error: ${result.error}` }] };

      // reply / async → 直接返回
      if (!isSync) {
        return { content: [{ type: "text", text: params.replyTo ? "Replied" : `Sent (id: ${(result.data as any)?.id})` }] };
      }

      // sync → 连 WS 等回复
      const msgId = (result.data as any)?.id;
      const timeoutMs = params.timeout || 120_000;
      return new Promise((resolve) => {
        const wsAsk = new WebSocket(`ws://127.0.0.1:${PORT}/events`);
        const timer = setTimeout(() => {
          wsAsk.close();
          resolve({ content: [{ type: "text", text: `Timed out after ${timeoutMs / 1000}s — no reply` }] });
        }, timeoutMs);

        signal?.addEventListener("abort", () => { clearTimeout(timer); wsAsk.close(); resolve({ content: [{ type: "text", text: "Cancelled" }] }); });

        wsAsk.on("open", () => wsAsk.send(JSON.stringify({ type: "listen", paneId, token: TOKEN })));
        wsAsk.on("message", (raw) => {
          try {
            const m = JSON.parse(raw.toString()) as { type: string; message?: { replyTo?: string; content: string } };
            if (m.type === "message" && m.message?.replyTo === msgId) {
              clearTimeout(timer); wsAsk.close();
              resolve({ content: [{ type: "text", text: `Reply: ${m.message.content}` }] });
            }
          } catch { /* ignore */ }
        });
        wsAsk.on("error", () => { clearTimeout(timer); resolve({ content: [{ type: "text", text: "Ask failed" }] }); });
      });
    },
  });

  // ── termx_list_agents ──

  pi.registerTool({
    name: "termx_list_agents",
    label: "List Available Agents",
    description: "List all configured agents from .pi/agents/*.md files. Each agent has a name, description, and optional model/thinking settings.",
    parameters: Type.Object({}),
    async execute() {
      const agents = discoverAgents().map((a) => ({
        name: a.name,
        description: a.description,
        model: a.model || "(default)",
        thinkingLevel: a.thinkingLevel || "(default)",
        source: a.source,
      }));
      return { content: [{ type: "text", text: JSON.stringify(agents, null, 2) }] };
    },
  });

  // ── termx_spawn_agent ──

  pi.registerTool({
    name: "termx_spawn_agent",
    label: "Spawn Agent",
    description: "Spawn a configured agent in a new TermX pane and optionally send a task. The agent's model, thinking level, and system prompt are read from .pi/agents/*.md.",
    parameters: Type.Object({
      name: Type.String({ description: "Agent name from termx_list_agents" }),
      task: Type.Optional(Type.String({ description: "Task to send to the agent after spawning" })),
      direction: Type.Optional(Type.String({ description: "Split direction: right or down (default: right)" })),
    }),
    async execute(_id, params) {
      const agent = getAgent(params.name);
      if (!agent) return { content: [{ type: "text", text: `Agent "${params.name}" not found. Use termx_list_agents to see available agents.` }] };

      // 解析 model
      let model = agent.model;
      if (!model || model === "default") {
        try {
          const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
          const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
          model = settings.defaultModel;
        } catch { /* use settings default */ }
      }

      // 构建 pi 命令
      const piArgs: string[] = ["pi"];
      if (model) piArgs.push("--model", model);
      if (agent.thinkingLevel) piArgs.push("--thinking", agent.thinkingLevel);
      if (agent.tools?.length) piArgs.push("--tools", agent.tools.join(","));
      if (agent.systemPrompt) piArgs.push("--append-system-prompt", JSON.stringify(agent.systemPrompt));

      // 1. 创建 pane
      const dir = params.direction || 'down';
      const spawnResult = await api("/api/pane/spawn", {
        token: TOKEN, paneId,
        command: piArgs.join(" "),
        direction: (dir === 'up' || dir === 'down') ? 'vertical' : 'horizontal',
      });
      if (!spawnResult.ok) return { content: [{ type: "text", text: `Error spawning: ${spawnResult.error}` }] };
      const targetPaneId = (spawnResult.data as any)?.paneId;
      if (!targetPaneId) return { content: [{ type: "text", text: "Spawned but no paneId returned" }] };

      // 2. 等 shell 启动
      await new Promise((r) => setTimeout(r, 2500));

      // 3. 发任务
      if (params.task) {
        const askResult = await api("/api/msg/send", {
          token: TOKEN, paneId,
          targetPaneId,
          content: params.task,
        });
        if (!askResult.ok) {
          return { content: [{ type: "text", text: `Spawned ${params.name} at ${targetPaneId.slice(0, 8)}, but failed to send task: ${askResult.error}` }] };
        }
      }

      return {
        content: [{
          type: "text",
          text: `Spawned ${params.name}${agent.model ? ` (${agent.model})` : ""} at pane ${targetPaneId.slice(0, 8)}${params.task ? ` with task` : ""}`,
        }],
        details: { paneId: targetPaneId, agent: params.name },
      };
    },
  });
}
