/**
 * TermX Extension — 消息收发 + Agent 协作
 *
 * 工具:
 *   termx_set_label    — 标记当前工作内容
 *   termx_list_panes   — 列出所有 pane
 *   termx_list_agents  — 列出 .pi/agents/*.md 配置
 *   termx_spawn_agent  — 生成新 agent
 *   termx_ask          — 1v1 消息（同步/异步/回复）
 *   termx_channel      — 频道管理
 *   termx_broadcast    — 频道/定向广播
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

// ── 常量 ──

const PORT = process.env.TERMX_PORT || "";
const TOKEN = process.env.TERMX_TOKEN || "";
const PANE_ID = process.env.TERMX_PANE_ID || "";
const TERMX_TAB_ID = process.env.TERMX_TAB_ID || "";
const IS_TERMX = !!(PORT && TOKEN && PANE_ID);

const PI_TERMX_EXTENSION = __filename;

// ── 类型定义 ──

/** HTTP API 统一响应 */
interface ApiResponse<T = unknown> { ok: boolean; data?: T; error?: string; }

/** WS 信封 — 统一解析类型 */
interface WsEnvelope {
  type: string;
  message?: { id: string; from: string; to: string; content: string; type?: string; status?: string; replyTo?: string; reply?: string; timestamp?: number };
  channelId?: string;
  channelMessage?: { id: string; from: string; content: string; type: "broadcast" | "ask"; isSelf?: boolean };
  msgId?: string;
  reply?: { from: string; content: string };
}

/** 工具返回值简写 */
type ToolResult = { content: [{ type: "text"; text: string }] };

// ── 辅助函数 ──

/** 构造文本工具返回 */
function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** 构造错误工具返回 */
function errorResult(error?: string): ToolResult {
  return textResult(`Error: ${error || "Unknown error"}`);
}

/** 截取 paneId 前缀 */
function short(id: string): string {
  return id.slice(0, 8);
}

/** HTTP POST 到 TermX CliServer */
function api(endpoint: string, body: Record<string, unknown>): Promise<ApiResponse> {
  const postData = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: parseInt(PORT, 10),
        path: endpoint,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
        timeout: 5000,
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => { data += c; });
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error("Invalid response")); }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(postData);
    req.end();
  });
}

/**
 * 同步等待 WS 回复的通用辅助。
 * 处理 WS 生命周期（创建/超时/取消/错误），调用方只需提供 onMessage 匹配逻辑。
 */
function openSyncWs(opts: {
  listenType: "listen" | "listen-channel";
  timeoutMs: number;
  signal?: AbortSignal;
  onTimeout: string;
  onError: string;
  onMessage: (raw: string, finish: (text: string) => void) => void;
}): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/events`);
    const finish = (text: string) => { clearTimeout(timer); ws.close(); resolve(text); };
    const timer = setTimeout(() => { ws.close(); resolve(opts.onTimeout); }, opts.timeoutMs);

    opts.signal?.addEventListener("abort", () => finish("Cancelled"));

    ws.on("open", () => ws.send(JSON.stringify({ type: opts.listenType, paneId: PANE_ID, token: TOKEN })));
    ws.on("message", (raw) => opts.onMessage(raw.toString(), finish));
    ws.on("error", () => { clearTimeout(timer); resolve(opts.onError); });
  });
}

// ── 频道名缓存与解析 ──

const channelIdNameMap = new Map<string, string>();
let cachedTabChannelId: string | null = null;

/** 格式化频道标签: name (id) 或 id */
function chLabel(chId: string): string {
  const name = channelIdNameMap.get(chId);
  return name ? `${name} (${chId})` : chId;
}

/** 刷新频道名缓存 */
async function refreshChannelNames(): Promise<void> {
  try {
    const result = await api("/api/channel/list", { token: TOKEN, paneId: PANE_ID });
    if (result.ok && result.data) {
      for (const c of (result.data as { channels: { id: string; name: string }[] }).channels) {
        channelIdNameMap.set(c.id, c.name);
      }
    }
  } catch { /* ignore */ }
}

/**
 * 将 channelId 或名称解析为内部 ID。
 * - 已是 ch-* 格式 → 直接返回
 * - 给了名称 → 按名称查找
 * - 未指定 → 返回 tab 频道 ID（默认广播目标）
 * 返回 null 表示无法解析。
 */
async function resolveChannelId(channelIdOrName?: string): Promise<string | null> {
  // 显式 ID
  if (channelIdOrName?.startsWith("ch-")) return channelIdOrName;

  // 默认 tab 频道：优先用缓存，避免多余 API 调用
  if (!channelIdOrName && cachedTabChannelId) return cachedTabChannelId;

  // 需要频道列表（名称查找或 tab 频道首次解析）
  const result = await api("/api/channel/list", { token: TOKEN, paneId: PANE_ID });
  if (!result.ok || !result.data) return null;

  const channels = (result.data as { channels: { id: string; name: string }[] }).channels;
  for (const c of channels) channelIdNameMap.set(c.id, c.name); // 顺便刷新缓存

  // 名称查找
  if (channelIdOrName) {
    const found = channels.find((c) => c.name === channelIdOrName);
    return found ? found.id : null;
  }

  // 默认：tab 频道
  const tabChName = `tab-${TERMX_TAB_ID.slice(0, 8)}`;
  const tabCh = channels.find((c) => c.name === tabChName);
  if (tabCh) { cachedTabChannelId = tabCh.id; return tabCh.id; }

  return null;
}

// ── 扩展入口 ──

export default function termxExtension(pi: ExtensionAPI) {
  if (!IS_TERMX) return; // 不在 TermX 中，静默跳过

  // 收集本扩展注册的工具名，用于 spawn 时注入 --tools 白名单
  const registeredToolNames: string[] = [];
  const origRegister = pi.registerTool.bind(pi);
  pi.registerTool = (def) => {
    registeredToolNames.push(def.name);
    return origRegister(def);
  };

  let ws: WebSocket | null = null;

  // ── WS 收消息 ──

  pi.on("session_start", async () => {
    // 刷新频道名 + 缓存 tab 频道 ID
    await refreshChannelNames();
    const tabChName = `tab-${TERMX_TAB_ID.slice(0, 8)}`;
    for (const [id, name] of channelIdNameMap) {
      if (name === tabChName) { cachedTabChannelId = id; break; }
    }

    try {
      ws = new WebSocket(`ws://127.0.0.1:${PORT}/events`);
      ws.on("open", () => {
        ws!.send(JSON.stringify({ type: "listen", paneId: PANE_ID, token: TOKEN }));
        ws!.send(JSON.stringify({ type: "listen-channel", paneId: PANE_ID, token: TOKEN }));
      });
      ws.on("message", (raw) => {
        let envelope: WsEnvelope;
        try { envelope = JSON.parse(raw.toString()) as WsEnvelope; }
        catch { return; }

        // ── 频道消息 ──
        if (envelope.type === "channel-message" && envelope.channelMessage && envelope.channelId) {
          const chMsg = envelope.channelMessage;
          const isSelf = chMsg.isSelf;
          const tag = chMsg.type === "ask" ? " (reply expected)" : "";
          const prefix = isSelf ? "📤" : "📢";
          const fromLabel = isSelf ? "You" : short(chMsg.from);
          const replyHint = isSelf
            ? "→ Waiting for replies via WS"
            : `→ Reply: termx_broadcast(channelId="${envelope.channelId}", content="...")`;
          pi.sendMessage(
            {
              customType: "termx-message",
              content: [
                `${prefix} ${chLabel(envelope.channelId)} ${fromLabel} [${chMsg.id}]${tag}`,
                `"${chMsg.content}"`,
                replyHint,
              ].join("\n"),
              display: true,
              details: envelope,
            },
            { triggerTurn: !isSelf },
          );
          return;
        }

        // ── 频道回复 ──
        if (envelope.type === "channel-reply" && envelope.reply && envelope.channelId && envelope.msgId) {
          pi.sendMessage(
            {
              customType: "termx-message",
              content: `📢 ${chLabel(envelope.channelId)} ${short(envelope.reply.from)} [${envelope.msgId}] reply: "${envelope.reply.content}"`,
              display: true,
              details: envelope,
            },
            { triggerTurn: true },
          );
          return;
        }

        // ── 自己发送的 1v1 消息回显 ──
        if (envelope.type === "message-sent" && envelope.message) {
          const sent = envelope.message;
          pi.sendMessage(
            {
              customType: "termx-message",
              content: [
                `📤 You → ${short(sent.to)} [${sent.id}]${sent.type === "ask" ? " (ask)" : ""}`,
                `"${sent.content}"`,
              ].join("\n"),
              display: true,
              details: sent,
            },
            { triggerTurn: false },
          );
          return;
        }

        // ── 1v1 消息 ──
        if (envelope.type === "message" && envelope.message && envelope.message.to === PANE_ID) {
          const msg = envelope.message;
          pi.sendMessage(
            {
              customType: "termx-message",
              content: [
                `📩 ${short(msg.from)} [${msg.id}]`,
                `"${msg.content}"`,
                `→ Reply: termx_ask(targetPaneId="${msg.from}", content="...", replyTo="${msg.id}")`,
              ].join("\n"),
              display: true,
              details: msg,
            },
            { triggerTurn: true },
          );
        }
      });
    } catch { /* WS failed */ }
  });

  pi.on("session_shutdown", async () => {
    if (ws) { ws.close(); ws = null; }
  });

  // ── 自动状态追踪 ──

  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function setBusy(): void {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    api("/api/pane/label", { token: TOKEN, paneId: PANE_ID, targetPaneId: PANE_ID, status: "busy" }).catch(() => {});
  }

  function setIdleDelayed(): void {
    idleTimer = setTimeout(() => {
      api("/api/pane/label", { token: TOKEN, paneId: PANE_ID, targetPaneId: PANE_ID, status: "idle" }).catch(() => {});
      idleTimer = null;
    }, 5000);
  }

  // ── 系统提示词注入 ──

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
    "  3. Always prefer async — omit waitMin/wait. Replies arrive automatically via WS. Only block when you MUST wait for a response.",
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
    setBusy();
    return { systemPrompt: event.systemPrompt + TERMX_USAGE_BLOCK };
  });
  pi.on("turn_end", async () => {
    // 延迟 5s——如果新一轮马上开始就取消，否则才标 idle
    setIdleDelayed();
  });

  // ════════════════════════════════════════
  //  工具注册
  // ════════════════════════════════════════

  // ── termx_set_label ──

  pi.registerTool({
    name: "termx_set_label",
    label: "Set Your Label",
    description: "Set a label describing what you are currently working on. This helps other agents discover you as an expert on this topic.",
    parameters: Type.Object({
      label: Type.String({ description: "What you are working on (e.g., 'auth module refactor')" }),
    }),
    async execute(_id, params) {
      const result = await api("/api/pane/label", { token: TOKEN, paneId: PANE_ID, targetPaneId: PANE_ID, label: params.label });
      return result.ok ? textResult(`Label set: ${params.label}`) : errorResult(result.error);
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
      const body: Record<string, unknown> = { token: TOKEN, paneId: PANE_ID };
      if (params.allTabs) body.allTabs = true;
      if (params.tabIndex !== undefined) body.tabIndex = params.tabIndex;
      const result = await api("/api/pane/list", body);
      return result.ok ? textResult(JSON.stringify(result.data, null, 2)) : errorResult(result.error);
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
      const isSync = params.wait && !params.replyTo;
      const endpoint = params.replyTo ? "/api/msg/reply" : isSync ? "/api/msg/ask" : "/api/msg/send";

      const body: Record<string, unknown> = {
        token: TOKEN, paneId: PANE_ID,
        targetPaneId: params.targetPaneId,
        content: params.content,
      };
      if (params.replyTo) body.msgId = params.replyTo;

      const result = await api(endpoint, body);
      if (!result.ok) return errorResult(result.error);

      // reply / async → 直接返回
      if (!isSync) {
        if (params.replyTo) {
          return textResult(`Replied to ${params.replyTo}: "${params.content}"`);
        }
        const msgId = (result.data as { id?: string })?.id;
        return textResult(`📤 You → ${short(params.targetPaneId)} [${msgId}]\n"${params.content}"`);
      }

      // sync → 连 WS 等回复
      const msgId = (result.data as { id?: string })?.id;
      const timeoutMs = params.timeout || 120_000;
      const reply = await openSyncWs({
        listenType: "listen",
        timeoutMs,
        signal,
        onTimeout: `Timed out after ${timeoutMs / 1000}s — no reply`,
        onError: "Ask failed",
        onMessage: (raw, finish) => {
          try {
            const m = JSON.parse(raw) as WsEnvelope;
            if (m.type === "message" && m.message && m.message.replyTo === msgId) {
              finish(`Reply: ${m.message.content}`);
            }
          } catch { /* ignore */ }
        },
      });
      return textResult(reply);
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
      return textResult(JSON.stringify(agents, null, 2));
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
      if (!agent) return errorResult(`Agent "${params.name}" not found. Use termx_list_agents to see available agents.`);

      // 解析 model
      let model = agent.model;
      if (!model || model === "default") {
        try {
          const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
          const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
          model = settings.defaultModel;
        } catch { /* use default */ }
      }

      // 构建 spawn 命令
      const { command, args, tempDir } = buildSpawnCommand({
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
        termxSkills: [join(__dirname, "..", "skills", "termx-swarm")],
        termxTools: registeredToolNames,
      });

      // 构建 shell 命令字符串
      const cwd = (agent.cwd || process.env.TERMX_CWD || process.cwd()).replace(/\\/g, "/");
      const cmdStr = [command, ...args]
        .map((s) => /[ \"']/.test(s) ? `"${s}"` : s)
        .join(" ");
      const fullCmd = cwd ? `cd "${cwd}" && ${cmdStr}` : cmdStr;

      console.log("[pi-termx] spawn command:", fullCmd);

      // 创建 pane
      const spawnResult = await api("/api/pane/spawn", { token: TOKEN, paneId: PANE_ID, command: fullCmd });
      cleanupTempDir(tempDir);

      if (!spawnResult.ok) return errorResult(spawnResult.error);
      const targetPaneId = (spawnResult.data as { paneId?: string })?.paneId;
      if (!targetPaneId) return textResult("Spawned but no paneId returned");

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
      const base: Record<string, unknown> = { token: TOKEN, paneId: PANE_ID };

      switch (params.action) {
        case "create": {
          if (!params.name) return errorResult("name is required for create");
          base.name = params.name;
          if (params.mode) base.mode = params.mode;
          const result = await api("/api/channel/create", base);
          if (!result.ok) return errorResult(result.error);
          const data = result.data as { channelId: string; name: string; mode: string };
          return textResult(`Channel created: ${data.channelId} (#${data.name}, ${data.mode} mode)`);
        }
        case "join": {
          if (!params.channelId) return errorResult("channelId is required for join");
          const result = await api("/api/channel/join", { ...base, channelId: params.channelId });
          return result.ok ? textResult(`Joined channel ${params.channelId}`) : errorResult(result.error);
        }
        case "leave": {
          if (!params.channelId) return errorResult("channelId is required for leave");
          const result = await api("/api/channel/leave", { ...base, channelId: params.channelId });
          return result.ok ? textResult(`Left channel ${params.channelId}`) : errorResult(result.error);
        }
        case "list": {
          const result = await api("/api/channel/list", base);
          if (!result.ok) return errorResult(result.error);
          return textResult(JSON.stringify((result.data as { channels: unknown }).channels, null, 2));
        }
        case "info": {
          if (!params.channelId) return errorResult("channelId is required for info");
          const result = await api("/api/channel/info", { ...base, channelId: params.channelId });
          return result.ok ? textResult(JSON.stringify(result.data, null, 2)) : errorResult(result.error);
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
      // ── 临时广播：targetPaneIds 模式 ──
      if (params.targetPaneIds && params.targetPaneIds.length > 0) {
        let sent = 0;
        for (const targetId of params.targetPaneIds) {
          const result = await api("/api/msg/send", { token: TOKEN, paneId: PANE_ID, targetPaneId: targetId, content: params.content });
          if (result.ok) sent++;
        }
        return textResult(`📤 Broadcast to ${sent}/${params.targetPaneIds.length} panes:\n"${params.content}"`);
      }

      // ── 频道广播 ──
      const channelId = await resolveChannelId(params.channelId);
      if (!channelId) return errorResult("no tab channel found, provide channelId explicitly");

      const result = await api("/api/channel/broadcast", {
        token: TOKEN, paneId: PANE_ID,
        channelId,
        content: params.content,
        type: params.waitMin && params.waitMin > 0 ? "ask" : "broadcast",
      });
      if (!result.ok) return errorResult(result.error);

      const msgId = (result.data as { msgId?: string })?.msgId;

      // 异步模式
      if (!params.waitMin || params.waitMin <= 0) {
        return textResult(`📤 Broadcast to ${chLabel(channelId)} [${msgId}]\n"${params.content}"`);
      }

      // 同步等待回复
      const timeoutMs = params.timeout || 30_000;
      const replies: string[] = [];
      const replyText = await openSyncWs({
        listenType: "listen-channel",
        timeoutMs,
        signal,
        onTimeout: `Timed out after ${timeoutMs / 1000}s waiting for replies`,
        onError: "Broadcast wait failed",
        onMessage: (raw, finish) => {
          try {
            const m = JSON.parse(raw) as WsEnvelope;
            if (m.type === "channel-reply" && m.channelId === channelId && m.msgId === msgId && m.reply) {
              replies.push(`${short(m.reply.from)}: ${m.reply.content}`);
              if (replies.length >= params.waitMin!) {
                finish(`Received ${replies.length}/${params.waitMin} replies:\n${replies.join("\n")}`);
              }
            }
          } catch { /* ignore */ }
        },
      });
      return textResult(replyText);
    },
  });
}
