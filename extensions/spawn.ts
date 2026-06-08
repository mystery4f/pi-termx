// Simplified buildPiArgs for TermX agent spawning
// Based on pi-subagents/src/runs/shared/pi-args.ts, stripped of:
//   - parent/child env (nested path, intercom, control)
//   - fanout, structured output, MCP direct tools
//   - session management
// Kept:
//   - model + thinking
//   - tools (builtin + extension tools)
//   - extensions (--no-extensions + explicit list)
//   - skills (--skill / --no-skills)
//   - system prompt (write temp file or use path)
//   - cwd

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// 直接用 pi 命令，不走 Windows 路径解析

interface PiSpawnCommand {
  command: string;
  args: string[];
}

const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const TASK_ARG_LIMIT = 8000;

export interface BuildSpawnInput {
  /** Agent md 配置的 model */
  model?: string;
  /** thinking level */
  thinking?: string;
  /** agent md 配置的 tools 白名单 (不含内置工具，会自动加) */
  tools?: string[];
  /** agent md 配置的 extensions */
  extensions?: string[];
  /** agent md 配置的 skills */
  skills?: string[];
  /** 是否继承 skills (agent md: inheritSkills) */
  inheritSkills: boolean;
  /** system prompt 模式 */
  systemPromptMode: "append" | "replace";
  /** system prompt 内容 */
  systemPrompt?: string;
  /** system prompt 来源文件路径 (有则直接用文件，不写临时文件) */
  systemPromptFile?: string;
  /** 任务内容 */
  task: string;
  /** 工作目录 */
  cwd?: string;
  /** TermX 基础设施：始终注入的 extension 路径 */
  termxExtension?: string;
  /** TermX 基础设施：始终注入的 skill 路径 */
  termxSkills?: string[];
  /** TermX 基础设施：始终包含的工具名 */
  termxTools?: string[];
}

export interface BuildSpawnResult {
  spawn: PiSpawnCommand;
  env: Record<string, string>;
  tempDir?: string;
}

export function buildSpawnCommand(input: BuildSpawnInput): BuildSpawnResult {
  const args: string[] = [];

  // ── model + thinking ──
  if (input.model) args.push("--model", input.model);
  if (input.thinking) args.push("--thinking", input.thinking);

  // ── extensions ──
  // 始终注入 termxExtension (TermX 基础设施，不管 agent md 怎么配)
  const allExtensions = [...new Set([
    ...(input.termxExtension ? [input.termxExtension] : []),
    ...(input.extensions ?? []),
  ])];

  if (input.extensions !== undefined && input.extensions.length >= 0) {
    // agent 配了 extensions → --no-extensions，显式列出全部
    args.push("--no-extensions");
    for (const ext of allExtensions) {
      args.push("--extension", ext);
    }
  } else {
    // agent 没配 → additive 注入 termxExtension
    for (const ext of allExtensions) {
      args.push("--extension", ext);
    }
  }

  // ── tools ──
  // 如果 agent 配了 tools → 白名单，自动加入内置工具 + termx 工具
  if (input.tools && input.tools.length > 0) {
    const toolSet = [...new Set([...BUILTIN_TOOLS, ...input.tools, ...(input.termxTools ?? [])])];
    args.push("--tools", toolSet.join(","));
  }

  // ── skills ──
  // --no-skills 可以加，但 termxSkills 始终用 --skill 注入 (additive even with --no-skills)
  if (input.inheritSkills === false) {
    args.push("--no-skills");
  }
  // agent md 配的 skills
  if (input.skills && input.skills.length > 0) {
    for (const skill of input.skills) {
      args.push("--skill", skill);
    }
  }
  // TermX 基础设施 skills (始终注入)
  for (const skill of input.termxSkills ?? []) {
    args.push("--skill", skill);
  }

  // ── system prompt ──
  let tempDir: string | undefined;
  if (input.systemPrompt) {
    if (input.systemPromptFile) {
      // 有文件路径 → 直接用
      const promptPath = input.systemPromptFile.replace(/\\/g, "/");
      args.push(
        input.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
        promptPath,
      );
    } else {
      // 只有内容 → 写临时文件
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-termx-"));
      const promptPath = path.join(tempDir, "prompt.md");
      fs.writeFileSync(promptPath, input.systemPrompt, { mode: 0o600 });
      args.push(
        input.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
        promptPath.replace(/\\/g, "/"),
      );
    }
  }

  // ── task ──
  if (input.task.length > TASK_ARG_LIMIT) {
    if (!tempDir) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-termx-"));
    }
    const taskPath = path.join(tempDir, "task.md");
    fs.writeFileSync(taskPath, `Task: ${input.task}`, { mode: 0o600 });
    args.push(`@${taskPath.replace(/\\/g, "/")}`);
  } else {
    args.push(`Task: ${input.task}`);
  }

  // ── 环境变量 ──
  const env: Record<string, string> = {};
  // 传递 TERMX_* 环境变量给子进程 (pane 已注入，但显式传递更可靠)
  if (process.env.TERMX_PORT) env.TERMX_PORT = process.env.TERMX_PORT;
  if (process.env.TERMX_TOKEN) env.TERMX_TOKEN = process.env.TERMX_TOKEN;
  // TERMX_PANE_ID 不传 — 新 pane 有自己的 ID

  // Windows 反斜杠在 bash 中是转义符，统一换为 /
  const normalizedArgs = args.map((a) => a.replace(/\\/g, "/"));
  return { spawn: { command: "pi", args: normalizedArgs }, env, tempDir };
}

export function cleanupTempDir(tempDir: string | undefined): void {
  if (!tempDir) return;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch { /* best effort */ }
}
