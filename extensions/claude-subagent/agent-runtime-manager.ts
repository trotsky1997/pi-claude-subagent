import * as fs from "node:fs";
import type { Model } from "@mariozechner/pi-ai";
import { AgentSessionRuntime, type ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "pi-claude-runtime-core/agent-discovery";
import type { ManagedRuntimeKind, NamedAgentRecord, NamedAgentStatus } from "pi-claude-runtime-core/managed-runtime-schemas";
import type { AgentPermissionConfig } from "./agent-permissions.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createSdkAgentRuntime, promptSdkAgentSession, type ManagedPlanModeBridgeOptions, type SdkSingleResult } from "./sdk-agent.js";
import { ManagedRuntimeProfile } from "./runtime-profile.js";

type RuntimeHooks = {
  onStateChange?: (record: NamedAgentRecord) => Promise<void> | void;
  onTerminal?: (event: {
    record: NamedAgentRecord;
    result: SdkSingleResult;
    wasBackground: boolean;
  }) => Promise<void> | void;
};

type ManagedHandle = {
  runtime: AgentSessionRuntime;
  agent: AgentConfig;
  record: NamedAgentRecord;
  activeRun?: Promise<SdkSingleResult>;
  disposing: boolean;
};

export type SendMessageDelivery = {
  delivery: "queued" | "resumed";
  record: NamedAgentRecord;
  pendingCount?: number;
  previousStatus?: NamedAgentStatus;
};

function makeRuntimeKey(options: {
  name: string;
  kind?: ManagedRuntimeKind;
  teamName?: string;
}): string {
  const kind = options.kind ?? "subagent";
  if (kind === "teammate") {
    if (!options.teamName) {
      throw new Error(`Teammate runtime "${options.name}" requires a team name.`);
    }
    return `teammate:${options.teamName}:${options.name}`;
  }
  return `subagent:${options.name}`;
}

function getResultText(result: SdkSingleResult): string | undefined {
  for (let i = result.messages.length - 1; i >= 0; i -= 1) {
    const message = result.messages[i] as any;
    if (message?.role !== "assistant") continue;
    for (const part of message.content ?? []) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        return part.text;
      }
    }
  }
  return undefined;
}

function getTerminalStatus(handle: ManagedHandle, result: SdkSingleResult): NamedAgentStatus {
  if (handle.disposing) return "interrupted";
  if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
    return "failed";
  }
  return "completed";
}

function getErrorText(handle: ManagedHandle, result: SdkSingleResult): string | undefined {
  if (handle.disposing) {
    return handle.record.lastError ?? "The parent Pi session shut down before the background agent finished.";
  }
  return result.errorMessage || result.stderr || undefined;
}

function ensureSessionFile(sessionFile: string | undefined, name: string): string {
  if (!sessionFile) {
    throw new Error(`Named agent \"${name}\" did not get a persistent session file.`);
  }
  return sessionFile;
}

export class AgentRuntimeManager {
  private readonly handles = new Map<string, ManagedHandle>();

  constructor(
    private readonly options: {
      getSessionDir: (cwd: string) => string;
      hooks?: RuntimeHooks;
    },
  ) {}

  get(name: string, options?: { kind?: ManagedRuntimeKind; teamName?: string }): NamedAgentRecord | undefined {
    const directKey = makeRuntimeKey({ name, kind: options?.kind, teamName: options?.teamName });
    const direct = this.handles.get(directKey);
    if (direct) return { ...direct.record };

    if (!options?.kind && !options?.teamName) {
      const subagent = this.handles.get(makeRuntimeKey({ name }));
      if (subagent) return { ...subagent.record };
    }

    return undefined;
  }

  list(): NamedAgentRecord[] {
    return [...this.handles.values()].map((handle) => ({ ...handle.record }));
  }

  async ensureHandle(input: {
    kind?: ManagedRuntimeKind;
    teamName?: string;
    autoClaimTasks?: boolean;
    allowedTools?: string[];
    disallowedTools?: string[];
    allowedDirectories?: string[];
    allowedSkills?: string[];
    disallowedSkills?: string[];
    color?: string;
    customTools?: ToolDefinition[];
    managedPlanMode?: ManagedPlanModeBridgeOptions;
    name: string;
    agent: AgentConfig;
    defaultCwd: string;
    sessionCwd?: string;
    requestedCwd?: string;
    modelRegistry: ModelRegistry;
    currentModel: Model<any> | undefined;
    modelOverride?: string;
    persisted?: NamedAgentRecord;
  }): Promise<NamedAgentRecord> {
    return this.getOrCreateHandle(input).then((handle) => ({ ...handle.record }));
  }

  async runForeground(input: {
    kind?: ManagedRuntimeKind;
    teamName?: string;
    autoClaimTasks?: boolean;
    allowedTools?: string[];
    disallowedTools?: string[];
    allowedDirectories?: string[];
    allowedSkills?: string[];
    disallowedSkills?: string[];
    color?: string;
    customTools?: ToolDefinition[];
    managedPlanMode?: ManagedPlanModeBridgeOptions;
    name: string;
    agent: AgentConfig;
    task: string;
    description?: string;
    defaultCwd: string;
    sessionCwd?: string;
    requestedCwd?: string;
    modelRegistry: ModelRegistry;
    currentModel: Model<any> | undefined;
    modelOverride?: string;
    signal?: AbortSignal;
    step?: number;
    onUpdate?: (result: SdkSingleResult) => void;
    persisted?: NamedAgentRecord;
  }): Promise<SdkSingleResult> {
    const handle = await this.getOrCreateHandle(input);
    if (this.isHandleRunning(handle)) {
      throw new Error(`Named agent \"${input.name}\" is already running in the background. Wait for it to finish before sending another prompt.`);
    }
    return this.startForegroundRun(handle, input);
  }

  async launchBackground(input: {
    kind?: ManagedRuntimeKind;
    teamName?: string;
    autoClaimTasks?: boolean;
    allowedTools?: string[];
    disallowedTools?: string[];
    allowedDirectories?: string[];
    allowedSkills?: string[];
    disallowedSkills?: string[];
    color?: string;
    customTools?: ToolDefinition[];
    managedPlanMode?: ManagedPlanModeBridgeOptions;
    name: string;
    agent: AgentConfig;
    task: string;
    description?: string;
    defaultCwd: string;
    sessionCwd?: string;
    requestedCwd?: string;
    modelRegistry: ModelRegistry;
    currentModel: Model<any> | undefined;
    modelOverride?: string;
    step?: number;
    onUpdate?: (result: SdkSingleResult) => void;
    persisted?: NamedAgentRecord;
  }): Promise<NamedAgentRecord> {
    const handle = await this.getOrCreateHandle(input);
    if (this.isHandleRunning(handle)) {
      throw new Error(`Named agent \"${input.name}\" is already running in the background. Wait for it to finish before launching it again.`);
    }

    this.startBackgroundRun(handle, input);
    return { ...handle.record };
  }

  async sendMessage(input: {
    kind?: ManagedRuntimeKind;
    teamName?: string;
    autoClaimTasks?: boolean;
    allowedTools?: string[];
    disallowedTools?: string[];
    allowedDirectories?: string[];
    allowedSkills?: string[];
    disallowedSkills?: string[];
    color?: string;
    customTools?: ToolDefinition[];
    managedPlanMode?: ManagedPlanModeBridgeOptions;
    name: string;
    agent: AgentConfig;
    message: string;
    summary?: string;
    defaultCwd: string;
    sessionCwd?: string;
    requestedCwd?: string;
    modelRegistry: ModelRegistry;
    currentModel: Model<any> | undefined;
    modelOverride?: string;
    persisted?: NamedAgentRecord;
  }): Promise<SendMessageDelivery> {
    const handle = await this.getOrCreateHandle(input);

    if (this.isHandleRunning(handle)) {
      await handle.runtime.session.sendUserMessage(input.message, { deliverAs: "steer" });
      return {
        delivery: "queued",
        record: { ...handle.record },
        pendingCount: handle.runtime.session.pendingMessageCount,
      };
    }

    const previousStatus = handle.record.status ?? "idle";
    this.startBackgroundRun(handle, {
      task: input.message,
      description: input.summary ?? `Follow-up for ${input.name}`,
    });
    return {
      delivery: "resumed",
      record: { ...handle.record },
      previousStatus,
    };
  }

  async abort(name: string, options?: { kind?: ManagedRuntimeKind; teamName?: string }): Promise<boolean> {
    const handle = this.handles.get(makeRuntimeKey({ name, kind: options?.kind, teamName: options?.teamName }));
    if (!handle) return false;
    try {
      await handle.runtime.session.abort();
      return true;
    } catch {
      return false;
    }
  }

  async launchExistingBackground(input: {
    name: string;
    kind?: ManagedRuntimeKind;
    teamName?: string;
    task: string;
    description?: string;
    signal?: AbortSignal;
    step?: number;
    onUpdate?: (result: SdkSingleResult) => void;
  }): Promise<NamedAgentRecord> {
    const handle = this.handles.get(makeRuntimeKey({ name: input.name, kind: input.kind, teamName: input.teamName }));
    if (!handle) {
      throw new Error(`Managed runtime "${input.name}" is not active in this session.`);
    }
    if (this.isHandleRunning(handle)) {
      throw new Error(`Managed runtime "${input.name}" is already running.`);
    }
    this.startBackgroundRun(handle, input);
    return { ...handle.record };
  }

  async disposeAll(reason: string): Promise<NamedAgentRecord[]> {
    const handles = [...this.handles.values()];
    const now = new Date().toISOString();

    for (const handle of handles) {
      handle.disposing = true;
      if (handle.record.status === "running" || handle.runtime.session.pendingMessageCount > 0) {
        handle.record = {
          ...handle.record,
          status: "interrupted",
          background: false,
          lastCompletedAt: now,
          lastError: reason,
        };
        await this.emitState(handle);
      }
    }

    for (const handle of handles) {
      try {
        await handle.runtime.session.abort();
      } catch {
        // Ignore abort errors during shutdown.
      }
      try {
        await handle.runtime.dispose();
      } catch {
        // Ignore dispose errors during shutdown.
      }
      this.handles.delete(makeRuntimeKey({ name: handle.record.name, kind: handle.record.kind, teamName: handle.record.teamName }));
    }

    return handles.map((handle) => ({ ...handle.record }));
  }

  private isHandleRunning(handle: ManagedHandle): boolean {
    return Boolean(handle.activeRun) || handle.runtime.session.isStreaming;
  }

  private startBackgroundRun(
    handle: ManagedHandle,
    input: {
      task: string;
      description?: string;
      signal?: AbortSignal;
      step?: number;
      onUpdate?: (result: SdkSingleResult) => void;
    },
  ): void {
    const runPromise = this.startRun(handle, input, true);
    handle.activeRun = runPromise.finally(() => {
      handle.activeRun = undefined;
    });
  }

  private async startForegroundRun(
    handle: ManagedHandle,
    input: {
      task: string;
      description?: string;
      signal?: AbortSignal;
      step?: number;
      onUpdate?: (result: SdkSingleResult) => void;
    },
  ): Promise<SdkSingleResult> {
    handle.activeRun = this.startRun(handle, input, false);
    try {
      return await handle.activeRun;
    } finally {
      handle.activeRun = undefined;
    }
  }

  private async getOrCreateHandle(input: {
    kind?: ManagedRuntimeKind;
    teamName?: string;
    autoClaimTasks?: boolean;
    allowedTools?: string[];
    disallowedTools?: string[];
    allowedDirectories?: string[];
    allowedSkills?: string[];
    disallowedSkills?: string[];
    color?: string;
    customTools?: ToolDefinition[];
    managedPlanMode?: ManagedPlanModeBridgeOptions;
    name: string;
    agent: AgentConfig;
    defaultCwd: string;
    sessionCwd?: string;
    requestedCwd?: string;
    modelRegistry: ModelRegistry;
    currentModel: Model<any> | undefined;
    modelOverride?: string;
    persisted?: NamedAgentRecord;
  }): Promise<ManagedHandle> {
    const sessionCwd = input.sessionCwd ?? input.defaultCwd;
    const executionCwd = input.persisted?.cwd ?? input.requestedCwd ?? input.defaultCwd;
    const runtimeKey = makeRuntimeKey({ name: input.name, kind: input.kind, teamName: input.teamName });
    const existing = this.handles.get(runtimeKey);
    if (existing) {
      if (existing.record.agentType !== input.agent.name) {
        throw new Error(
          `Named agent \"${input.name}\" is already bound to agent type \"${existing.record.agentType}\".`,
        );
      }
      if (existing.record.cwd !== executionCwd) {
        throw new Error(`Named agent \"${input.name}\" is already bound to cwd \"${existing.record.cwd}\".`);
      }
      return existing;
    }

    const sessionManager =
      input.persisted?.sessionFile && fs.existsSync(input.persisted.sessionFile)
        ? SessionManager.open(
            input.persisted.sessionFile,
            this.options.getSessionDir(sessionCwd),
            executionCwd,
          )
        : SessionManager.create(executionCwd, this.options.getSessionDir(sessionCwd));

    const runtimeProfile = ManagedRuntimeProfile.fromAgent(input.agent, {
      ...(input.allowedTools ?? input.persisted?.allowedTools ? { allowedTools: input.allowedTools ?? input.persisted?.allowedTools } : {}),
      ...(input.disallowedTools ?? input.persisted?.disallowedTools ? { disallowedTools: input.disallowedTools ?? input.persisted?.disallowedTools } : {}),
      ...(input.allowedDirectories ?? input.persisted?.allowedDirectories ? { allowedDirectories: input.allowedDirectories ?? input.persisted?.allowedDirectories } : {}),
      ...(input.allowedSkills ?? input.persisted?.allowedSkills ? { allowedSkills: input.allowedSkills ?? input.persisted?.allowedSkills } : {}),
      ...(input.disallowedSkills ?? input.persisted?.disallowedSkills ? { disallowedSkills: input.disallowedSkills ?? input.persisted?.disallowedSkills } : {}),
      ...(input.agent.permissionMode ?? input.persisted?.permissionMode ? { permissionMode: input.agent.permissionMode ?? input.persisted?.permissionMode } : {}),
    });

    const { runtime, model } = await createSdkAgentRuntime({
      defaultCwd: executionCwd,
      agent: input.agent,
      modelRegistry: input.modelRegistry,
      currentModel: input.currentModel,
      modelOverride: input.modelOverride,
      sessionManager,
      sessionName: `${input.name} (${input.agent.name})`,
      permissions: {
        ...runtimeProfile.toPermissionConfig(),
      } satisfies AgentPermissionConfig,
      customTools: input.customTools,
      managedPlanMode: input.managedPlanMode,
    });

    const sessionFile = ensureSessionFile(runtime.session.sessionFile, input.name);
    const handle: ManagedHandle = {
      runtime,
      agent: input.agent,
      record: {
        name: input.name,
        agentType: input.agent.name,
        sessionFile,
        kind: input.kind ?? input.persisted?.kind ?? "subagent",
        ...(input.teamName ?? input.persisted?.teamName ? { teamName: input.teamName ?? input.persisted?.teamName } : {}),
        ...(typeof input.autoClaimTasks === "boolean"
          ? { autoClaimTasks: input.autoClaimTasks }
          : typeof input.persisted?.autoClaimTasks === "boolean"
            ? { autoClaimTasks: input.persisted.autoClaimTasks }
            : {}),
        ...runtimeProfile.toRecordFields(),
        sessionId: runtime.session.sessionId,
        cwd: executionCwd,
        model: model ?? input.persisted?.model,
        ...(input.color ?? input.persisted?.color ? { color: input.color ?? input.persisted?.color } : {}),
        status: input.persisted?.status ?? "idle",
        background: input.persisted?.background ?? false,
        initialPromptApplied:
          input.persisted?.initialPromptApplied
          ?? Boolean(input.persisted?.sessionFile && fs.existsSync(input.persisted.sessionFile)),
        lastDescription: input.persisted?.lastDescription,
        lastStartedAt: input.persisted?.lastStartedAt,
        lastCompletedAt: input.persisted?.lastCompletedAt,
        lastError: input.persisted?.lastError,
        lastResultText: input.persisted?.lastResultText,
      },
      disposing: false,
    };

    this.handles.set(runtimeKey, handle);
    await this.emitState(handle);
    return handle;
  }

  private async startRun(
    handle: ManagedHandle,
    input: {
      task: string;
      description?: string;
      signal?: AbortSignal;
      step?: number;
      onUpdate?: (result: SdkSingleResult) => void;
    },
    isBackground: boolean,
  ): Promise<SdkSingleResult> {
    const startedAt = new Date().toISOString();
    const initialPrompt = !handle.record.initialPromptApplied && handle.agent.initialPrompt?.trim()
      ? `${handle.agent.initialPrompt.trim()}\n\n${input.task}`
      : input.task;

    handle.record = {
      ...handle.record,
      status: "running",
      background: isBackground,
      initialPromptApplied: handle.record.initialPromptApplied || Boolean(handle.agent.initialPrompt?.trim()),
      lastDescription: input.description ?? handle.record.lastDescription,
      lastStartedAt: startedAt,
      lastCompletedAt: undefined,
      lastError: undefined,
    };
    await this.emitState(handle);

    const result = await promptSdkAgentSession({
      session: handle.runtime.session,
      agent: handle.agent,
      task: initialPrompt,
      model: handle.record.model,
      signal: input.signal,
      step: input.step,
      maxTurns: handle.agent.maxTurns,
      onUpdate: input.onUpdate,
    });

    const completedAt = new Date().toISOString();
    const lastResultText = getResultText(result);
    handle.record = {
      ...handle.record,
      sessionFile: ensureSessionFile(result.sessionFile ?? handle.record.sessionFile, handle.record.name),
      sessionId: result.sessionId ?? handle.record.sessionId,
      model: result.model ?? handle.record.model,
      status: getTerminalStatus(handle, result),
      background: false,
      lastCompletedAt: completedAt,
      lastError: getErrorText(handle, result),
      lastResultText: lastResultText ?? handle.record.lastResultText,
    };
    await this.emitState(handle);

    if (isBackground && !handle.disposing) {
      await this.options.hooks?.onTerminal?.({
        record: { ...handle.record },
        result,
        wasBackground: true,
      });
    }

    return result;
  }

  private async emitState(handle: ManagedHandle): Promise<void> {
    await this.options.hooks?.onStateChange?.({ ...handle.record });
  }
}
