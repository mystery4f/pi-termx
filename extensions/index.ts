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
import { buildSpawnCommand, cleanupTempDir } from "./spawn";

// 当前 extension 入口路径，用于注入到新 pi 实例
const PI_TERMX_EXTENSION = __filename;
// pi-termx package 根目录
const PI_TERMX_ROOT = join(__dirname, "..");

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

  // 收集本扩展注册的工具名，用于 spawn 时注入 --tools 白名单
  const registeredToolNames: string[] = [];
  const origRegister = pi.registerTool.bind(pi);
  pi.registerTool = (def) => {
    registeredToolNames.push(def.name);
    return origRegister(def);
  };

  let ws: WebSocket | null = null;
  let paneId = PANE_ID;
  let cachedTabChannelId: string | null = null;
  const TERMX_TAB_ID = process.env.TERMX_TAB_ID || '';

  // ── WS 收消息 ──

  pi.on("session_start", async () => {
    // 缓存 tab 频道 ID
    try {
      const listResult = await api("/api/channel/list", { token: TOKEN, paneId });
      if (listResult.ok) {
        const tabChName = `tab-${TERMX_TAB_ID.slice(0, 8)}`;
        const tabCh = (listResult.data as any).channels.find((c: any) => c.name === tabChName);
        if (tabCh) cachedTabChannelId = tabCh.id;
      }
    } catch { /* ignore */ }
    try {
      ws = new WebSocket(`ws://127.0.0.1:${PORT}/events`);
      ws.on("open", () => {
        ws!.send(JSON.stringify({ type: "listen", paneId, token: TOKEN }));
        ws!.send(JSON.stringify({ type: "listen-channel", paneId, token: TOKEN }));
      });
      ws.on("message", (raw) => {
        try {
          const envelope = JSON.parse(raw.toString()) as { type: string; message?: Record<string, unknown>; channelId?: string; channelMessage?: { id: string; from: string; content: string }; msgId?: string; reply?: { from: string; content: string } };

          // 频道消息
          if (envelope.type === "channel-message" && envelope.channelMessage) {
            const chMsg = envelope as typeof envelope & { channelMessage: { id: string; from: string; content: string; type: 'broadcast' | 'ask' } };
            const tag = chMsg.channelMessage.type === 'ask' ? " (reply expected)" : "";
            pi.sendMessage(
              {
                customType: "termx-message",
                content: [
                  `📢 #${chMsg.channelId} ${chMsg.channelMessage.from.slice(0, 8)} [${chMsg.channelMessage.id}]${tag}`,
                  `"${chMsg.channelMessage.content}"`,
                  `→ Reply: termx_broadcast(channelId="${chMsg.channelId}", content="...", ...)`,
                ].join("\n"),
                display: true,
                details: chMsg,
              },
              { triggerTurn: true },
            );
            return;
          }

          // 频道回复
          if (envelope.type === "channel-reply" && envelope.reply) {
            const chReply = envelope as typeof envelope & { channelId: string; msgId: string; reply: { from: string; content: string } };
            pi.sendMessage(
              {
                customType: "termx-message",
                content: `📢 #${chReply.channelId} ${chReply.reply.from.slice(0, 8)} [${chReply.msgId}] reply: "${chReply.reply.content}"`,
                display: true,
                details: chReply,
              },
              { triggerTurn: true },
            );
            return;
          }

          // 1v1 消息
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

  // 自动标状态
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  // 静态 TermX 使用说明（每次都相同 → 系统提示词 hash 不变 → 缓存有效）
  const TERMX_USAGE_BLOCK = [
    "",
    "## TermX Workspace",
    "You are in a TermX workspace with other agents. You have two auto-joined channels:",
    "  - tab channel (same-tab agents) — PRIMARY channel for coordination.",
    "  - global — ALL agents across ALL tabs. Only use when you need cross-tab coordination.",
    "",
    "CRITICAL RULES:",
    "  1. Always prefer your tab channel for broadcasting. termx_broadcast() defaults to it.",
    "  2. Use global ONLY when you need to reach agents in other tabs.",
    "  3. Prefer async messaging — omit waitMin. Replies arrive automatically.",
    "  4. After broadcasting, do NOT follow up with individual termx_ask. Broadcast IS the notification.",
    "  5. Do NOT create channels unless explicitly asked.",
    "",
    "TOOLS:",
    '  termx_broadcast(content="...") — broadcast to your tab channel (default)',
    '  termx_broadcast(channelId="global", content="...") — broadcast to all agents',
    '  termx_broadcast(targetPaneIds=[...], content="...") — temporary broadcast to specific panes',
    "  termx_channel(action='list') — see all channels",
    "  termx_list_panes — see all agents (status/idle/busy/label)",
    "  termx_ask(targetPaneId, content) — 1v1 send/ask/reply",
    "  termx_spawn_agent(name, task) — spawn agent in new pane",
    "  termx_set_label(label) — tag yourself",
  ].join("\n");

  pi.on("before_agent_start", async (event) => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    api("/api/pane/label", { token: TOKEN, paneId, targetPaneId: paneId, status: "busy" }).catch(() => {});
    return { systemPrompt: event.systemPrompt + TERMX_USAGE_BLOCK };
  });
  pi.on("turn_end", async () => {
    // 延迟 5s——如果新一轮马上开始就取消，否则才标 idle
    idleTimer = setTimeout(() => {
      api("/api/pane/label", { token: TOKEN, paneId, targetPaneId: paneId, status: "idle" }).catch(() => {});
      idleTimer = null;
    }, 5000);
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
    description: "List all configured agents from .pi/agents/*.md files. Each agent has a name, description, model, thinking, cwd, and source.",
    parameters: Type.Object({}),
    async execute() {
      const agents = discoverAgents().map((a) => ({
        name: a.name,
        description: a.description,
        model: a.model || "(default)",
        thinking: a.thinking || "(default)",
        tools: a.tools || [],
        skills: a.skills || [],
        extensions: a.extensions || [],
        inheritSkills: a.inheritSkills,
        systemPromptMode: a.systemPromptMode,
        cwd: a.cwd || "(default)",
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

      // 构建 spawn 命令 (借鉴 pi-subagents 的 buildPiArgs)
      const piTermxRoot = join(__dirname, "..");
      const { spawn: spawnSpec, tempDir } = buildSpawnCommand({
        model,
        thinking: agent.thinking,
        tools: agent.tools,
        extensions: agent.extensions,
        skills: agent.skills,
        inheritSkills: agent.inheritSkills,
        systemPromptMode: agent.systemPromptMode,
        systemPrompt: agent.systemPrompt || undefined,
        systemPromptFile: agent.systemPrompt ? agent.file : undefined,
        task: params.task || "Awaiting instructions.",
        cwd: agent.cwd || process.env.TERMX_CWD || process.cwd(),
        // TermX 基础设施：始终注入
        termxExtension: PI_TERMX_EXTENSION,
        termxSkills: [join(piTermxRoot, "skills", "termx-swarm")],
        termxTools: registeredToolNames,
      });

      // 构建 shell 命令字符串
      const cwd = (agent.cwd || process.env.TERMX_CWD || process.cwd()).replace(/\\/g, "/");
      const cmdStr = [spawnSpec.command, ...spawnSpec.args]
        .map((s) => /[ \"']/.test(s) ? `"${s}"` : s)
        .join(" ");
      const fullCmd = cwd ? `cd "${cwd}" && ${cmdStr}` : cmdStr;

      console.log("[pi-termx] spawn command:", fullCmd);

      // 创建 pane
      const spawnResult = await api("/api/pane/spawn", {
        token: TOKEN, paneId,
        command: fullCmd,
      });

      cleanupTempDir(tempDir);

      if (!spawnResult.ok) return { content: [{ type: "text", text: `Error spawning: ${spawnResult.error}` }] };
      const targetPaneId = (spawnResult.data as any)?.paneId;
      if (!targetPaneId) return { content: [{ type: "text", text: "Spawned but no paneId returned" }] };

      return {
        content: [{
          type: "text",
          text: `Spawned ${params.name}${agent.model ? ` (${agent.model})` : ""} at pane ${targetPaneId}. Use this full ID for termx_ask.`,
        }],
        details: { paneId: targetPaneId, agent: params.name },
      };
    },
  });

  // ── termx_channel ──

  pi.registerTool({
    name: "termx_channel",
    label: "Channel Management",
    description: "Manage group chat channels. Actions: create, join, leave, list, info. You are auto-joined to 'global' (all agents) and your tab channel (same-tab agents).",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("create", { description: "Create a new channel" }),
        Type.Literal("join", { description: "Join an existing channel" }),
        Type.Literal("leave", { description: "Leave a channel" }),
        Type.Literal("list", { description: "List all channels" }),
        Type.Literal("info", { description: "Get channel details and recent messages" }),
      ]),
      channelId: Type.Optional(Type.String({ description: "Channel ID (required for join/leave/info)" })),
      name: Type.Optional(Type.String({ description: "Channel name (required for create)" })),
      mode: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("pubsub")], { description: "Visibility mode: full=all members see replies, pubsub=only sender sees replies. Default: full" })),
    }),
    async execute(_id, params) {
      const body: Record<string, unknown> = { token: TOKEN, paneId };

      switch (params.action) {
        case "create": {
          if (!params.name) return { content: [{ type: "text", text: "Error: name is required for create" }] };
          body.name = params.name;
          if (params.mode) body.mode = params.mode;
          const result = await api("/api/channel/create", body);
          if (!result.ok) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
          const data = result.data as { channelId: string; name: string; mode: string };
          return { content: [{ type: "text", text: `Channel created: ${data.channelId} (#${data.name}, ${data.mode} mode)` }] };
        }
        case "join": {
          if (!params.channelId) return { content: [{ type: "text", text: "Error: channelId is required for join" }] };
          body.channelId = params.channelId;
          const result = await api("/api/channel/join", body);
          if (!result.ok) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
          return { content: [{ type: "text", text: `Joined channel ${params.channelId}` }] };
        }
        case "leave": {
          if (!params.channelId) return { content: [{ type: "text", text: "Error: channelId is required for leave" }] };
          body.channelId = params.channelId;
          const result = await api("/api/channel/leave", body);
          if (!result.ok) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
          return { content: [{ type: "text", text: `Left channel ${params.channelId}` }] };
        }
        case "list": {
          const result = await api("/api/channel/list", body);
          if (!result.ok) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
          return { content: [{ type: "text", text: JSON.stringify((result.data as any).channels, null, 2) }] };
        }
        case "info": {
          if (!params.channelId) return { content: [{ type: "text", text: "Error: channelId is required for info" }] };
          body.channelId = params.channelId;
          const result = await api("/api/channel/info", body);
          if (!result.ok) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
          return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
        }
      }
    },
  });

  // ── termx_broadcast ──

  pi.registerTool({
    name: "termx_broadcast",
    label: "Broadcast to Channel or Panes",
    description: "Send a message to your tab channel (default), a specific channel, or specific panes (temporary broadcast). Async by default — omit waitMin. Only set waitMin if you MUST block until replies arrive.",
    parameters: Type.Object({
      channelId: Type.Optional(Type.String({ description: "Target channel. Default: your tab channel (same-tab agents). Set to 'global' for all agents across all tabs." })),
      targetPaneIds: Type.Optional(Type.Array(Type.String(), { description: "Pane IDs for temporary broadcast (mutually exclusive with channelId)" })),
      content: Type.String({ description: "Message content" }),
      waitMin: Type.Optional(Type.Number({ description: "AVOID unless necessary. Minimum replies to block for (omit = async)." })),
      timeout: Type.Optional(Type.Number({ description: "Max wait time in ms (default: 30000)" })),
    }),
    async execute(_id, params, signal) {
      // 临时广播：targetPaneIds 模式
      if (params.targetPaneIds && params.targetPaneIds.length > 0) {
        let sent = 0;
        for (const targetId of params.targetPaneIds) {
          const result = await api("/api/msg/send", {
            token: TOKEN, paneId,
            targetPaneId: targetId,
            content: params.content,
          });
          if (result.ok) sent++;
        }
        return { content: [{ type: "text", text: `Broadcast sent to ${sent}/${params.targetPaneIds.length} panes` }] };
      }

      // 频道广播：支持按名称查找（如 "global"），默认用 tab 频道
      let channelId = params.channelId;
      if (channelId && !channelId.startsWith('ch-')) {
        // 按名称查找频道
        const listResult = await api("/api/channel/list", { token: TOKEN, paneId });
        if (listResult.ok) {
          const found = (listResult.data as any).channels.find((c: any) => c.name === channelId);
          if (found) channelId = found.id;
        }
      }
      if (!channelId) {
        if (cachedTabChannelId) {
          channelId = cachedTabChannelId;
        } else {
          // fallback: 查找 tab 频道
          const listResult = await api("/api/channel/list", { token: TOKEN, paneId });
          if (listResult.ok) {
            const tabChName = `tab-${TERMX_TAB_ID.slice(0, 8)}`;
            const tabCh = (listResult.data as any).channels.find((c: any) => c.name === tabChName);
            if (tabCh) { channelId = tabCh.id; cachedTabChannelId = tabCh.id; }
          }
        }
        if (!channelId) {
          return { content: [{ type: "text", text: "Error: no tab channel found, provide channelId explicitly" }] };
        }
      }

      const result = await api("/api/channel/broadcast", {
        token: TOKEN, paneId,
        channelId,
        content: params.content,
        type: params.waitMin && params.waitMin > 0 ? "ask" : "broadcast",
      });
      if (!result.ok) return { content: [{ type: "text", text: `Error: ${result.error}` }] };

      const msgId = (result.data as any)?.msgId;

      // 异步模式
      if (!params.waitMin || params.waitMin <= 0) {
        return { content: [{ type: "text", text: `Broadcast sent to ${channelId} (msg: ${msgId})\n${params.content}` }] };
      }

      // 同步等待回复
      const timeoutMs = params.timeout || 30_000;
      return new Promise((resolve) => {
        const wsBroadcast = new WebSocket(`ws://127.0.0.1:${PORT}/events`);
        const timer = setTimeout(() => {
          wsBroadcast.close();
          resolve({ content: [{ type: "text", text: `Timed out after ${timeoutMs / 1000}s waiting for replies` }] });
        }, timeoutMs);
        const replies: string[] = [];

        signal?.addEventListener("abort", () => { clearTimeout(timer); wsBroadcast.close(); resolve({ content: [{ type: "text", text: "Cancelled" }] }); });

        wsBroadcast.on("open", () => wsBroadcast.send(JSON.stringify({ type: "listen-channel", paneId, token: TOKEN })));
        wsBroadcast.on("message", (raw) => {
          try {
            const m = JSON.parse(raw.toString()) as { type: string; channelId?: string; msgId?: string; reply?: { from: string; content: string } };
            if (m.type === "channel-reply" && m.channelId === channelId && m.msgId === msgId && m.reply) {
              replies.push(`${m.reply.from.slice(0, 8)}: ${m.reply.content}`);
              if (replies.length >= params.waitMin!) {
                clearTimeout(timer);
                wsBroadcast.close();
                resolve({ content: [{ type: "text", text: `Received ${replies.length}/${params.waitMin} replies:\n${replies.join("\n")}` }] });
              }
            }
          } catch { /* ignore */ }
        });
        wsBroadcast.on("error", () => { clearTimeout(timer); resolve({ content: [{ type: "text", text: "Broadcast wait failed" }] }); });
      });
    },
  });
}
