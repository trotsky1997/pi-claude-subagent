import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseManagedRuntimeRecord,
  sanitizeNamedAgentState,
  type NamedAgentRecord,
  type NamedAgentState,
} from "pi-claude-runtime-core/managed-runtime-schemas";

export function createEmptyNamedAgentState(): NamedAgentState {
  return { agents: {} };
}

export function normalizeNamedAgentRecord(name: string, value: unknown): NamedAgentRecord | null {
  return parseManagedRuntimeRecord(value, name);
}

export function normalizeNamedAgentState(state: NamedAgentState): NamedAgentState {
  return sanitizeNamedAgentState(state);
}

export function getNamedAgentRegistryPath(cwd: string): string {
  return path.resolve(cwd, ".pi", "claude-subagent", "named-agents.json");
}

export async function loadNamedAgentStateFromDisk(cwd: string): Promise<NamedAgentState> {
  try {
    const raw = await fs.promises.readFile(getNamedAgentRegistryPath(cwd), "utf-8");
    return sanitizeNamedAgentState(JSON.parse(raw));
  } catch {
    return createEmptyNamedAgentState();
  }
}

export async function saveNamedAgentStateToDisk(cwd: string, state: NamedAgentState): Promise<void> {
  const filePath = getNamedAgentRegistryPath(cwd);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(normalizeNamedAgentState(state), null, 2), "utf-8");
}

export async function upsertNamedAgentRecordOnDisk(cwd: string, record: NamedAgentRecord): Promise<NamedAgentState> {
  const state = await loadNamedAgentStateFromDisk(cwd);
  const next = normalizeNamedAgentState({
    agents: {
      ...state.agents,
      [record.name]: record,
    },
  });
  await saveNamedAgentStateToDisk(cwd, next);
  return next;
}

export async function removeNamedAgentRecordFromDisk(cwd: string, name: string): Promise<NamedAgentState> {
  const state = await loadNamedAgentStateFromDisk(cwd);
  const agents = { ...state.agents };
  delete agents[name];
  const next = normalizeNamedAgentState({ agents });
  await saveNamedAgentStateToDisk(cwd, next);
  return next;
}

export async function updateNamedAgentRecordStatusOnDisk(options: {
  cwd: string;
  name: string;
  mutate: (record: NamedAgentRecord) => NamedAgentRecord;
}): Promise<NamedAgentRecord | null> {
  const state = await loadNamedAgentStateFromDisk(options.cwd);
  const current = state.agents[options.name];
  if (!current) return null;
  const nextRecord = options.mutate(current);
  await saveNamedAgentStateToDisk(options.cwd, {
    agents: {
      ...state.agents,
      [options.name]: nextRecord,
    },
  });
  return nextRecord;
}

export function markRunningAgentsInterrupted(
  state: NamedAgentState,
  reason: string,
  options?: { keepRunning?: (record: NamedAgentRecord) => boolean },
): NamedAgentState {
  let changed = false;
  const agents: Record<string, NamedAgentRecord> = {};
  for (const [name, record] of Object.entries(state.agents)) {
    if (options?.keepRunning?.(record)) {
      agents[name] = record;
      continue;
    }
    if (record.status === "running") {
      changed = true;
      agents[name] = {
        ...record,
        status: "interrupted",
        background: false,
        lastCompletedAt: record.lastCompletedAt ?? new Date().toISOString(),
        lastError: record.lastError ?? reason,
      };
      continue;
    }
    agents[name] = record;
  }
  return changed ? { agents } : state;
}
