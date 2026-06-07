// TermX agent discovery — reads .pi/agent/agents/*.md frontmatter
// Used by termx_spawn_agent to configure spawned helpers

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  thinkingLevel?: string;
  tools?: string[];
  systemPrompt: string;
  cwd?: string;
  source: "user" | "project";
}

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };

  const frontmatter = match[1];
  const body = match[2].trim();
  const data: Record<string, string> = {};

  for (const line of frontmatter.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (kv) data[kv[1]] = kv[2].trim();
  }

  return { data, body };
}

function discoverDir(dir: string, source: "user" | "project"): AgentConfig[] {
  if (!existsSync(dir)) return [];

  const result: AgentConfig[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const { data, body } = parseFrontmatter(raw);
      if (!data.name || !data.description) continue;

      result.push({
        name: data.name,
        description: data.description,
        model: data.model,
        thinkingLevel: data.thinkingLevel,
        tools: data.tools ? data.tools.split(",").map((t) => t.trim()) : undefined,
        systemPrompt: body,
        cwd: data.cwd,
        source,
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
