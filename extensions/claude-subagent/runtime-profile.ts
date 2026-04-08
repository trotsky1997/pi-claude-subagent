import type { AgentConfig } from "pi-claude-runtime-core/agent-discovery";
import type { AgentPermissionConfig } from "./agent-permissions.js";
import type { NamedAgentRecord } from "pi-claude-runtime-core/managed-runtime-schemas";

function normalizeStringList(values: string[] | undefined): string[] {
  return [...(values ?? [])].map((value) => value.trim()).filter(Boolean).sort();
}

function sameStringLists(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = normalizeStringList(a);
  const right = normalizeStringList(b);
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sameSerializedValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export class ManagedRuntimeProfile {
  constructor(
    readonly allowedTools: string[] | undefined,
    readonly disallowedTools: string[] | undefined,
    readonly allowedDirectories: string[] | undefined,
    readonly allowedSkills: string[] | undefined,
    readonly disallowedSkills: string[] | undefined,
    readonly permissionMode: AgentConfig["permissionMode"],
    readonly effort: AgentConfig["effort"],
    readonly mcpServers: AgentConfig["mcpServers"],
    readonly requiredMcpServers: AgentConfig["requiredMcpServers"],
    readonly hooks: AgentConfig["hooks"],
    readonly isolation: AgentConfig["isolation"],
  ) {}

  static fromAgent(agent: AgentConfig, permissions: AgentPermissionConfig): ManagedRuntimeProfile {
    return new ManagedRuntimeProfile(
      permissions.allowedTools,
      permissions.disallowedTools,
      permissions.allowedDirectories,
      permissions.allowedSkills,
      permissions.disallowedSkills,
      permissions.permissionMode ?? agent.permissionMode,
      agent.effort,
      agent.mcpServers,
      agent.requiredMcpServers,
      agent.hooks,
      agent.isolation,
    );
  }

  toPermissionConfig(): AgentPermissionConfig {
    return {
      ...(this.allowedTools ? { allowedTools: this.allowedTools } : {}),
      ...(this.disallowedTools ? { disallowedTools: this.disallowedTools } : {}),
      ...(this.allowedDirectories ? { allowedDirectories: this.allowedDirectories } : {}),
      ...(this.allowedSkills ? { allowedSkills: this.allowedSkills } : {}),
      ...(this.disallowedSkills ? { disallowedSkills: this.disallowedSkills } : {}),
      ...(this.permissionMode ? { permissionMode: this.permissionMode } : {}),
    };
  }

  toRecordFields(): Pick<NamedAgentRecord,
    | "allowedTools"
    | "disallowedTools"
    | "allowedDirectories"
    | "allowedSkills"
    | "disallowedSkills"
    | "permissionMode"
    | "effort"
    | "mcpServers"
    | "requiredMcpServers"
    | "hooks"
    | "isolation"
  > {
    return {
      ...(this.allowedTools ? { allowedTools: this.allowedTools } : {}),
      ...(this.disallowedTools ? { disallowedTools: this.disallowedTools } : {}),
      ...(this.allowedDirectories ? { allowedDirectories: this.allowedDirectories } : {}),
      ...(this.allowedSkills ? { allowedSkills: this.allowedSkills } : {}),
      ...(this.disallowedSkills ? { disallowedSkills: this.disallowedSkills } : {}),
      ...(this.permissionMode ? { permissionMode: this.permissionMode } : {}),
      ...(this.effort !== undefined ? { effort: this.effort } : {}),
      ...(this.mcpServers ? { mcpServers: this.mcpServers } : {}),
      ...(this.requiredMcpServers ? { requiredMcpServers: this.requiredMcpServers } : {}),
      ...(this.hooks ? { hooks: this.hooks } : {}),
      ...(this.isolation ? { isolation: this.isolation } : {}),
    };
  }

  matchesRecord(record: Pick<NamedAgentRecord,
    | "allowedTools"
    | "disallowedTools"
    | "allowedDirectories"
    | "allowedSkills"
    | "disallowedSkills"
    | "permissionMode"
    | "effort"
    | "mcpServers"
    | "requiredMcpServers"
    | "hooks"
    | "isolation"
  >): boolean {
    return sameStringLists(this.allowedTools, record.allowedTools)
      && sameStringLists(this.disallowedTools, record.disallowedTools)
      && sameStringLists(this.allowedDirectories, record.allowedDirectories)
      && sameStringLists(this.allowedSkills, record.allowedSkills)
      && sameStringLists(this.disallowedSkills, record.disallowedSkills)
      && this.permissionMode === record.permissionMode
      && this.isolation === record.isolation
      && sameStringLists(this.requiredMcpServers, record.requiredMcpServers)
      && sameSerializedValue(this.effort, record.effort)
      && sameSerializedValue(this.mcpServers, record.mcpServers)
      && sameSerializedValue(this.hooks, record.hooks);
  }
}
