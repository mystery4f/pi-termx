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
            "  - Spawn: `termx pane spawn pi --model <model>`",
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
                `→ Reply: termx_ask(targetPaneId="${msg.from}", content="...", replyTo="${msg.id}", async=true)`,
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
    description: "Send a message to another pane. Default: blocks until reply. Set async=true to fire-and-forget. Set replyTo to reply to a message.",
    parameters: Type.Object({
      targetPaneId: Type.String({ description: "Target pane ID" }),
      content: Type.String({ description: "Message" }),
      async: Type.Optional(Type.Boolean({ description: "Return immediately (default: false, blocks until reply)" })),
      replyTo: Type.Optional(Type.String({ description: "Reply to this message ID" })),
    }),
    async execute(_id, params, signal) {
      // 选 endpoint
      const isAsync = params.async || params.replyTo;
      const endpoint = params.replyTo ? "/api/msg/reply" : isAsync ? "/api/msg/send" : "/api/msg/ask";

      const body: Record<string, unknown> = {
        token: TOKEN, paneId,
        targetPaneId: params.targetPaneId,
        content: params.content,
      };
      if (params.replyTo) body.msgId = params.replyTo;

      const result = await api(endpoint, body);
      if (!result.ok) return { content: [{ type: "text", text: `Error: ${result.error}` }] };

      // async / reply → 直接返回
      if (isAsync) {
        return { content: [{ type: "text", text: params.replyTo ? "Replied" : `Sent (id: ${(result.data as any)?.id})` }] };
      }

      // sync → 连 WS 等回复
      const msgId = (result.data as any)?.id;
      return new Promise((resolve) => {
        const wsAsk = new WebSocket(`ws://127.0.0.1:${PORT}/events`);
        const timer = setTimeout(() => {
          wsAsk.close();
          resolve({ content: [{ type: "text", text: "Timed out - no reply" }] });
        }, 300_000);

        signal?.addEventListener("abort", () => { clearTimeout(timer); wsAsk.close(); });

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
}
