// TermX agent discovery — reads .pi/agents/*.md frontmatter
// Compatible with pi-subagents agent md format

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  skills?: string[];
  extensions?: string[];
  systemPromptMode: "append" | "replace";
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  systemPrompt: string;
  cwd?: string;
  source: "user" | "project";
  file: string;
}

function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { fm: {}, body: raw };

  const body = match[2].trim();
  const fm: Record<string, string> = {};

  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }

  return { fm, body };
}

function parseCommaList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function discoverDir(dir: string, source: "user" | "project"): AgentConfig[] {
  if (!existsSync(dir)) return [];

  const result: AgentConfig[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const { fm, body } = parseFrontmatter(raw);
      if (!fm.name || !fm.description) continue;

      // 兼容 thinkingLevel (旧) 和 thinking (subagents 标准)
      const thinking = fm.thinking || fm.thinkingLevel;
      const skillStr = fm.skill || fm.skills;

      result.push({
        name: fm.name,
        description: fm.description,
        model: fm.model,
        thinking,
        tools: parseCommaList(fm.tools),
        skills: parseCommaList(skillStr),
        extensions: parseCommaList(fm.extensions),
        systemPromptMode: fm.systemPromptMode === "replace" ? "replace" : "append",
        inheritProjectContext: fm.inheritProjectContext === "true",
        inheritSkills: fm.inheritSkills === "true",
        systemPrompt: body,
        cwd: fm.cwd,
        source,
        file: join(dir, file),
      });
    } catch { /* skip invalid files */ }
  }
  return result;
}

const userDir = join(homedir(), ".pi", "agent", "agents");
const projectDir = join(process.cwd(), ".pi", "agents");

export function discoverAgents(): AgentConfig[] {
  return [
    ...discoverDir(userDir, "user"),
    ...discoverDir(projectDir, "project"),
  ];
}

export function getAgent(name: string): AgentConfig | undefined {
  return discoverAgents().find((a) => a.name === name);
}
