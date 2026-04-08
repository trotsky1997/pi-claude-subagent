import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type AgentMemoryScope = "user" | "project" | "local";

const MEMORY_FILE_NAME = "MEMORY.md";
const MAX_MEMORY_CHARS = 25_000;
const MAX_MEMORY_LINES = 200;

function sanitizeAgentType(agentType: string): string {
  return agentType.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

export function getAgentMemoryDir(cwd: string, agentType: string, scope: AgentMemoryScope): string {
  const safeAgentType = sanitizeAgentType(agentType);
  switch (scope) {
    case "project":
      return path.join(cwd, ".pi", "claude-subagent", "agent-memory", safeAgentType);
    case "local":
      return path.join(cwd, ".pi", "claude-subagent", "agent-memory-local", safeAgentType);
    case "user":
    default:
      return path.join(os.homedir(), ".pi", "claude-subagent", "agent-memory", safeAgentType);
  }
}

export function getAgentMemoryEntrypoint(cwd: string, agentType: string, scope: AgentMemoryScope): string {
  return path.join(getAgentMemoryDir(cwd, agentType, scope), MEMORY_FILE_NAME);
}

function getScopeNote(scope: AgentMemoryScope): string {
  switch (scope) {
    case "project":
      return "This memory is project-scoped. Keep it specific to the current repository and shared workflow.";
    case "local":
      return "This memory is local-scoped. It can include machine-specific or unshared working habits.";
    case "user":
    default:
      return "This memory is user-scoped. Keep it broadly reusable across repositories when possible.";
  }
}

async function ensureMemoryEntrypoint(memoryFile: string): Promise<void> {
  await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  try {
    await fs.access(memoryFile);
  } catch {
    await fs.writeFile(memoryFile, "# Persistent Agent Memory\n\n", "utf-8");
  }
}

async function readMemoryExcerpt(memoryFile: string): Promise<string> {
  try {
    const raw = await fs.readFile(memoryFile, "utf-8");
    const limitedLines = raw.split(/\r?\n/).slice(0, MAX_MEMORY_LINES).join("\n");
    return limitedLines.length > MAX_MEMORY_CHARS
      ? `${limitedLines.slice(0, MAX_MEMORY_CHARS)}\n...`
      : limitedLines;
  } catch {
    return "";
  }
}

export async function loadAgentMemoryPrompt(cwd: string, agentType: string, scope: AgentMemoryScope): Promise<string> {
  const memoryFile = getAgentMemoryEntrypoint(cwd, agentType, scope);
  await ensureMemoryEntrypoint(memoryFile);
  const existingMemory = (await readMemoryExcerpt(memoryFile)).trim();

  const sections = [
    "# Persistent Agent Memory",
    `Memory file: ${memoryFile}`,
    getScopeNote(scope),
    "Use read, write, and edit to maintain this file when a durable preference, workflow rule, or long-lived project fact should survive across future runs of this agent.",
  ];

  if (existingMemory) {
    sections.push(`Current memory contents:\n\n${existingMemory}`);
  } else {
    sections.push("Current memory contents: (empty)");
  }

  return sections.join("\n\n");
}
