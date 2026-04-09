import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "pi-claude-runtime-core/agent-discovery";
import type { ManagedRuntimeKind, NamedAgentRecord } from "pi-claude-runtime-core/managed-runtime-schemas";
import type { AgentPermissionConfig } from "./agent-permissions.js";
import { upsertNamedAgentRecordOnDisk } from "./named-agent-state.js";
import type { ManagedTaskRegistry } from "./managed-task-registry.js";
import {
  DetachedBackgroundPayloadSchema,
  parseDetachedOutboxEvent,
  type DetachedBackgroundPayload,
  type DetachedControlMessage,
  type DetachedOutboxEvent,
} from "./detached-background-schemas.js";

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const detachedRunnerPath = path.join(baseDir, "detached-runner.ts");
const localRequire = createRequire(import.meta.url);

function buildDetachedNodePath(): string | undefined {
  const roots = new Set<string>();
  const currentNodePath = process.env.NODE_PATH?.trim();
  if (currentNodePath) {
    for (const entry of currentNodePath.split(path.delimiter).map((value) => value.trim()).filter(Boolean)) {
      roots.add(entry);
    }
  }

  for (const specifier of [
    "@mariozechner/pi-coding-agent/package.json",
    "@mariozechner/pi-ai/package.json",
    "pi-claude-plan-mode/package.json",
    "pi-claude-todo-v2/package.json",
  ]) {
    try {
      const resolved = localRequire.resolve(specifier);
      roots.add(path.dirname(path.dirname(resolved)));
    } catch {
      // Best-effort resolution; detached runner can still rely on existing NODE_PATH entries.
    }
  }

  return roots.size > 0 ? [...roots].join(path.delimiter) : undefined;
}

function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

export function getRuntimeKey(options: { name: string; kind?: ManagedRuntimeKind; teamName?: string }): string {
  const kind = options.kind ?? "subagent";
  if (kind === "teammate") {
    return `teammate:${options.teamName ?? "unknown"}:${options.name}`;
  }
  return `subagent:${options.name}`;
}

export function getDetachedRuntimeDir(cwd: string, runtimeKey: string): string {
  return path.resolve(cwd, ".pi", "claude-subagent", "detached-runs", sanitizeKey(runtimeKey));
}

export function getDetachedInboxFile(cwd: string, runtimeKey: string): string {
  return path.join(getDetachedRuntimeDir(cwd, runtimeKey), "inbox.jsonl");
}

export function getDetachedOutboxFile(cwd: string, runtimeKey: string): string {
  return path.join(getDetachedRuntimeDir(cwd, runtimeKey), "outbox.jsonl");
}

export function getDetachedOutboxCursorFile(cwd: string, runtimeKey: string): string {
  return path.join(getDetachedRuntimeDir(cwd, runtimeKey), "outbox.cursor");
}

function getDetachedPayloadFile(cwd: string, runtimeKey: string): string {
  return path.join(getDetachedRuntimeDir(cwd, runtimeKey), "payload.json");
}

function resolveCurrentModelLabel(currentModel: string | undefined, modelOverride: string | undefined): string | undefined {
  return modelOverride?.trim() || currentModel?.trim() || undefined;
}

async function ensurePersistentSession(options: {
  runtimeCwd: string;
  sessionDir: string;
  existingSessionFile?: string;
}): Promise<{ sessionFile: string; sessionId: string }> {
  if (options.existingSessionFile && fs.existsSync(options.existingSessionFile)) {
    const sessionManager = SessionManager.open(options.existingSessionFile, options.sessionDir, options.runtimeCwd);
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) {
      throw new Error(`Persisted session is missing a session file: ${options.existingSessionFile}`);
    }
    return { sessionFile, sessionId: sessionManager.getSessionId() };
  }

  const sessionManager = SessionManager.create(options.runtimeCwd, options.sessionDir);
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) {
    throw new Error("Failed to create a persistent session file for detached background execution.");
  }
  return { sessionFile, sessionId: sessionManager.getSessionId() };
}

export function supportsDetachedBackgroundRun(options: {
  kind?: ManagedRuntimeKind;
  teamName?: string;
}): boolean {
  const kind = options.kind ?? "subagent";
  if (kind === "teammate") {
    return Boolean(options.teamName);
  }
  return true;
}

export async function launchDetachedBackgroundRun(options: {
  stateCwd: string;
  runtimeCwd?: string;
  getSessionDir: (cwd: string) => string;
  name: string;
  kind?: ManagedRuntimeKind;
  teamName?: string;
  agent: AgentConfig;
  task: string;
  description?: string;
  currentModel: string | undefined;
  modelOverride?: string;
  permissions: AgentPermissionConfig;
  persisted?: NamedAgentRecord;
  managedPlanModeInitialReason?: string;
  managedTaskRegistry?: ManagedTaskRegistry | null;
}): Promise<NamedAgentRecord> {
  const kind = options.kind ?? "subagent";
  const stateCwd = options.stateCwd;
  const runtimeCwd = options.persisted?.cwd ?? options.runtimeCwd ?? stateCwd;
  const runtimeKey = getRuntimeKey({ name: options.name, kind, teamName: options.teamName });
  const runtimeDir = getDetachedRuntimeDir(stateCwd, runtimeKey);
  await fs.promises.mkdir(runtimeDir, { recursive: true });
  const sessionDir = options.getSessionDir(stateCwd);
  const { sessionFile, sessionId } = await ensurePersistentSession({
    runtimeCwd,
    sessionDir,
    existingSessionFile: options.persisted?.sessionFile,
  });

  const taskId = runtimeKey;
  const inboxFile = getDetachedInboxFile(stateCwd, runtimeKey);
  const outboxFile = getDetachedOutboxFile(stateCwd, runtimeKey);
  const outboxCursorFile = getDetachedOutboxCursorFile(stateCwd, runtimeKey);
  const payloadFile = getDetachedPayloadFile(stateCwd, runtimeKey);
  const payload: DetachedBackgroundPayload = DetachedBackgroundPayloadSchema.parse({
    runtimeKey,
    taskId,
    inboxFile,
    outboxFile,
    outboxCursorFile,
    stateCwd,
    runtimeCwd,
    name: options.name,
    kind,
    teamName: options.teamName,
    sessionDir,
    sessionFile,
    agent: options.agent,
    modelOverride: options.modelOverride,
    currentModel: resolveCurrentModelLabel(options.currentModel, options.modelOverride),
    task: options.task,
    description: options.description,
    managedPlanModeInitialReason: options.managedPlanModeInitialReason,
    allowedTools: options.permissions.allowedTools,
    disallowedTools: options.permissions.disallowedTools,
    allowedDirectories: options.permissions.allowedDirectories,
    allowedSkills: options.permissions.allowedSkills,
    disallowedSkills: options.permissions.disallowedSkills,
  });

  await fs.promises.writeFile(payloadFile, JSON.stringify(payload, null, 2), "utf-8");
  await fs.promises.writeFile(inboxFile, "", "utf-8");
  await fs.promises.writeFile(outboxFile, "", "utf-8");
  await fs.promises.writeFile(outboxCursorFile, "0\n", "utf-8");

  const nodePath = buildDetachedNodePath();

  const detachedProcess = spawn("bun", [detachedRunnerPath, payloadFile], {
    cwd: stateCwd,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ...(nodePath ? { NODE_PATH: nodePath } : {}),
    },
  });
  detachedProcess.unref();

  const record: NamedAgentRecord = {
    name: options.name,
    agentType: options.agent.name,
    cwd: runtimeCwd,
    sessionFile,
    kind,
    ...(options.teamName ? { teamName: options.teamName } : {}),
    ...(options.permissions.allowedTools ? { allowedTools: options.permissions.allowedTools } : {}),
    ...(options.permissions.disallowedTools ? { disallowedTools: options.permissions.disallowedTools } : {}),
    ...(options.permissions.allowedDirectories ? { allowedDirectories: options.permissions.allowedDirectories } : {}),
    ...(options.permissions.allowedSkills ? { allowedSkills: options.permissions.allowedSkills } : {}),
    ...(options.permissions.disallowedSkills ? { disallowedSkills: options.permissions.disallowedSkills } : {}),
    ...(options.agent.permissionMode ? { permissionMode: options.agent.permissionMode } : {}),
    ...(options.agent.effort !== undefined ? { effort: options.agent.effort } : {}),
    ...(options.agent.mcpServers ? { mcpServers: options.agent.mcpServers } : {}),
    ...(options.agent.requiredMcpServers ? { requiredMcpServers: options.agent.requiredMcpServers } : {}),
    ...(options.agent.hooks ? { hooks: options.agent.hooks } : {}),
    ...(options.agent.isolation ? { isolation: options.agent.isolation } : {}),
    ...(options.modelOverride || options.currentModel ? { model: resolveCurrentModelLabel(options.currentModel, options.modelOverride) } : {}),
    sessionId,
    ...(options.agent.color ? { color: options.agent.color } : {}),
    status: "running",
    background: true,
    lastDescription: options.description,
    lastStartedAt: new Date().toISOString(),
  };

  await upsertNamedAgentRecordOnDisk(stateCwd, record);
  if (options.managedTaskRegistry) {
    await options.managedTaskRegistry.upsertFromRecord({
      ...record,
      detached: true,
      processId: detachedProcess.pid,
    });
  }
  return record;
}

export async function queueDetachedBackgroundMessage(options: {
  cwd: string;
  name: string;
  kind?: ManagedRuntimeKind;
  teamName?: string;
  message: string;
  summary?: string;
}): Promise<number> {
  const runtimeKey = getRuntimeKey({ name: options.name, kind: options.kind, teamName: options.teamName });
  const inboxFile = getDetachedInboxFile(options.cwd, runtimeKey);
  const payload: DetachedControlMessage = {
    type: "message",
    content: options.message,
    ...(options.summary?.trim() ? { summary: options.summary.trim() } : {}),
  };
  await fs.promises.mkdir(path.dirname(inboxFile), { recursive: true });
  await fs.promises.appendFile(inboxFile, `${JSON.stringify(payload)}\n`, "utf-8");
  const lines = (await fs.promises.readFile(inboxFile, "utf-8")).trim().split(/\n+/).filter(Boolean);
  return lines.length;
}

export async function requestDetachedBackgroundShutdown(options: {
  cwd: string;
  name: string;
  kind?: ManagedRuntimeKind;
  teamName?: string;
  reason?: string;
}): Promise<void> {
  const runtimeKey = getRuntimeKey({ name: options.name, kind: options.kind, teamName: options.teamName });
  const inboxFile = getDetachedInboxFile(options.cwd, runtimeKey);
  const payload: DetachedControlMessage = {
    type: "shutdown",
    ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
  };
  await fs.promises.mkdir(path.dirname(inboxFile), { recursive: true });
  await fs.promises.appendFile(inboxFile, `${JSON.stringify(payload)}\n`, "utf-8");
}

export async function appendDetachedOutboxEvent(options: {
  cwd: string;
  runtimeKey: string;
  event: DetachedOutboxEvent;
}): Promise<void> {
  const outboxFile = getDetachedOutboxFile(options.cwd, options.runtimeKey);
  await fs.promises.mkdir(path.dirname(outboxFile), { recursive: true });
  await fs.promises.appendFile(outboxFile, `${JSON.stringify(options.event)}\n`, "utf-8");
}

async function readCursor(cursorFile: string): Promise<number> {
  try {
    const raw = await fs.promises.readFile(cursorFile, "utf-8");
    const value = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

async function writeCursor(cursorFile: string, count: number): Promise<void> {
  await fs.promises.mkdir(path.dirname(cursorFile), { recursive: true });
  await fs.promises.writeFile(cursorFile, `${count}\n`, "utf-8");
}

export async function consumeDetachedOutboxEvents(options: {
  cwd: string;
  runtimeKey: string;
}): Promise<DetachedOutboxEvent[]> {
  const outboxFile = getDetachedOutboxFile(options.cwd, options.runtimeKey);
  const cursorFile = getDetachedOutboxCursorFile(options.cwd, options.runtimeKey);
  const consumedLines = await readCursor(cursorFile);
  let raw = "";
  try {
    raw = await fs.promises.readFile(outboxFile, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.split(/\n+/).filter(Boolean);
  const unread = lines.slice(consumedLines).map((line) => parseDetachedOutboxEvent(JSON.parse(line)));
  await writeCursor(cursorFile, lines.length);
  return unread;
}
