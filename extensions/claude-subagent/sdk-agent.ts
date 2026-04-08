import * as path from "node:path";
import type { AgentConfig } from "pi-claude-runtime-core/agent-discovery";
import { createPermissionExtensionFactory, filterAllowedSkills, filterCustomTools, resolveAllowedToolNames, type AgentPermissionConfig } from "./agent-permissions.js";
import { loadAgentMemoryPrompt } from "./agent-memory.js";
import { createManagedPlanModeExtensionFactory } from "pi-claude-plan-mode/managed-runtime";
import {
  AgentSession,
  AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ToolDefinition,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createBashTool,
  createCodingTools,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DefaultResourceLoader,
  getAgentDir,
  type ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";

export interface SdkSingleResult {
  agent: string;
  agentSource: AgentConfig["source"] | "unknown";
  task: string;
  exitCode: number;
  messages: any[];
  stderr: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
  };
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  sessionFile?: string;
  sessionId?: string;
}

export interface ManagedPlanModeBridgeOptions {
  initialReason?: string;
  requestPlanApproval: (request: {
    planPath: string;
    plan: string;
    summary?: string;
  }) => Promise<{ requestId: string }> | { requestId: string };
}

function cloneResult(result: SdkSingleResult): SdkSingleResult {
  return {
    ...result,
    messages: [...result.messages],
    usage: { ...result.usage },
  };
}

function getModelLabel(model: Model<any> | undefined): string | undefined {
  if (!model) return undefined;
  return `${model.provider}/${model.id}`;
}

function resolveModelOverride(
  modelRegistry: ModelRegistry,
  currentModel: Model<any> | undefined,
  override: string | undefined,
): Model<any> | undefined {
  if (!override) return currentModel;

  const raw = override.trim();
  if (!raw) return currentModel;

  if (raw.includes("/")) {
    const [provider, ...rest] = raw.split("/");
    const modelId = rest.join("/");
    const found = provider && modelId ? modelRegistry.find(provider, modelId) : undefined;
    if (found) return found;
  }

  if (currentModel) {
    const sameProvider = modelRegistry.find(currentModel.provider, raw);
    if (sameProvider) return sameProvider;
  }

  const all = modelRegistry.getAll();
  return all.find((model) => model.id === raw || model.name === raw);
}

function buildToolsForAgent(cwd: string, toolNames: string[] | undefined) {
  if (toolNames === undefined) {
    return createCodingTools(cwd);
  }

  if (toolNames.length === 0) {
    return [] as ReturnType<typeof createCodingTools>;
  }

  const normalized = toolNames.map((tool) => tool.trim().toLowerCase()).filter(Boolean);
  const tools = [] as ReturnType<typeof createCodingTools>;

  for (const toolName of normalized) {
    switch (toolName) {
      case "read":
        tools.push(createReadTool(cwd));
        break;
      case "bash":
        tools.push(createBashTool(cwd));
        break;
      case "edit":
        tools.push(createEditTool(cwd));
        break;
      case "write":
        tools.push(createWriteTool(cwd));
        break;
      case "find":
        tools.push(createFindTool(cwd));
        break;
      case "grep":
        tools.push(createGrepTool(cwd));
        break;
      case "ls":
        tools.push(createLsTool(cwd));
        break;
      default:
        break;
    }
  }

  return tools.length > 0 ? tools : createCodingTools(cwd);
}

function createSdkSettingsManager(): SettingsManager {
  return SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1 },
  });
}

function getResourceLoaderOptions(
  cwd: string,
  agent: AgentConfig,
  permissions: AgentPermissionConfig | undefined,
  memoryPrompt: string | undefined,
  managedPlanMode: ManagedPlanModeBridgeOptions | undefined,
): any {
  const requestedSkills = agent.skills;
  const allowSkills = permissions?.allowedSkills;
  const disallowSkills = permissions?.disallowedSkills;
  const shouldLoadSkills = Boolean(
    (requestedSkills && requestedSkills.length > 0)
    || (allowSkills && allowSkills.length > 0)
    || (disallowSkills && disallowSkills.length > 0),
  );
  const requestedSkillNames = new Set((requestedSkills ?? []).map((value) => value.toLowerCase()));

  const extensionFactories = [
    ...(permissions ? [createPermissionExtensionFactory(cwd, permissions)] : []),
    ...(managedPlanMode && permissions?.permissionMode === "plan"
      ? [createManagedPlanModeExtensionFactory(managedPlanMode)]
      : []),
  ];

  return {
    noExtensions: true,
    extensionFactories,
    ...(shouldLoadSkills ? { additionalSkillPaths: [path.join(cwd, ".pi", "skills"), path.join(getAgentDir(), "skills")] } : {}),
    noSkills: !shouldLoadSkills,
    noPromptTemplates: true,
    noThemes: true,
    ...(shouldLoadSkills
      ? {
          skillsOverride: (base: { skills: Array<{ name: string }>; diagnostics: any[] }) => ({
            skills: base.skills.filter((skill) => {
              const allowedByPolicy = filterAllowedSkills(allowSkills, [skill.name], disallowSkills).length > 0;
              if (!allowedByPolicy) return false;
              if (requestedSkillNames.size === 0) return true;
              return requestedSkillNames.has(skill.name.toLowerCase());
            }),
            diagnostics: base.diagnostics,
          }),
        }
      : {}),
    appendSystemPromptOverride: () => [
      `# Custom Agent Instructions
${agent.systemPrompt}`,
      ...(memoryPrompt ? [memoryPrompt] : []),
    ],
  };
}

async function createResourceLoader(
  cwd: string,
  agent: AgentConfig,
  permissions?: AgentPermissionConfig,
  managedPlanMode?: ManagedPlanModeBridgeOptions,
): Promise<DefaultResourceLoader> {
  const memoryPrompt = agent.memory ? await loadAgentMemoryPrompt(cwd, agent.name, agent.memory) : undefined;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    ...getResourceLoaderOptions(cwd, agent, permissions, memoryPrompt, managedPlanMode),
  } as any);
  await resourceLoader.reload();
  return resourceLoader;
}

function createUnknownModelResult(options: {
  agent: AgentConfig;
  task: string;
  modelOverride?: string;
  step?: number;
}): SdkSingleResult {
  const message = `Unknown model override: ${options.modelOverride}`;
  return {
    agent: options.agent.name,
    agentSource: options.agent.source,
    task: options.task,
    exitCode: 1,
    messages: [],
    stderr: message,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: options.modelOverride,
    errorMessage: message,
    stopReason: "error",
    step: options.step,
  };
}

export async function promptSdkAgentSession(options: {
  session: AgentSession;
  agent: AgentConfig;
  task: string;
  model?: string;
  signal?: AbortSignal;
  step?: number;
  maxTurns?: number;
  onUpdate?: (result: SdkSingleResult) => void;
}): Promise<SdkSingleResult> {
  const result: SdkSingleResult = {
    agent: options.agent.name,
    agentSource: options.agent.source,
    task: options.task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: options.model,
    step: options.step,
    sessionFile: options.session.sessionFile,
    sessionId: options.session.sessionId,
  };

  let maxTurnsReached = false;
  const unsubscribe = options.session.subscribe((event: any) => {
    if (event.type !== "message_end") return;

    result.messages.push(event.message);
    const message = event.message as any;
    if (message.role === "assistant") {
      result.usage.turns += 1;
      const usage = message.usage ?? {};
      result.usage.input += usage.input ?? usage.input_tokens ?? 0;
      result.usage.output += usage.output ?? usage.output_tokens ?? 0;
      result.usage.cacheRead += usage.cacheRead ?? usage.cache_read_input_tokens ?? 0;
      result.usage.cacheWrite += usage.cacheWrite ?? usage.cache_creation_input_tokens ?? 0;
      result.usage.cost += usage.cost?.total ?? 0;
      result.usage.contextTokens = usage.totalTokens ?? usage.total_tokens ?? result.usage.contextTokens;
      if (!result.model && message.model) {
        result.model = message.model;
      }
      if (message.stopReason) result.stopReason = message.stopReason;
      if (message.errorMessage) result.errorMessage = message.errorMessage;
      if (options.maxTurns && result.usage.turns >= options.maxTurns && !maxTurnsReached) {
        maxTurnsReached = true;
        result.stopReason = "max_turns";
        result.errorMessage = undefined;
        void options.session.abort();
      }
    }
    options.onUpdate?.(cloneResult(result));
  });

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void options.session.abort();
  };

  try {
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    await options.session.prompt(options.task, { source: "extension" });
    if (maxTurnsReached) {
      result.exitCode = 0;
      result.stopReason = "max_turns";
      result.errorMessage = undefined;
      result.stderr = "";
    } else if (aborted) {
      result.exitCode = 1;
      result.stopReason = "aborted";
      result.errorMessage = result.errorMessage ?? "SDK subagent was aborted";
      result.stderr = result.stderr || result.errorMessage;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (maxTurnsReached) {
      result.exitCode = 0;
      result.stopReason = "max_turns";
      result.errorMessage = undefined;
      result.stderr = "";
    } else {
      result.exitCode = 1;
      result.stopReason = aborted ? "aborted" : "error";
      result.errorMessage = message;
      result.stderr = message;
    }
  } finally {
    unsubscribe();
    if (options.signal) {
      options.signal.removeEventListener("abort", onAbort);
    }
  }

  result.sessionFile = options.session.sessionFile;
  result.sessionId = options.session.sessionId;
  return result;
}

export async function createSdkAgentRuntime(options: {
  defaultCwd: string;
  agent: AgentConfig;
  modelRegistry: ModelRegistry;
  currentModel: Model<any> | undefined;
  modelOverride?: string;
  cwdOverride?: string;
  sessionManager: SessionManager;
  sessionName?: string;
  permissions?: AgentPermissionConfig;
  customTools?: ToolDefinition[];
  managedPlanMode?: ManagedPlanModeBridgeOptions;
}): Promise<{
  runtime: AgentSessionRuntime;
  model?: string;
  modelFallbackMessage?: string;
}> {
  const cwd = options.cwdOverride ?? options.defaultCwd;
  const resolvedModel = resolveModelOverride(
    options.modelRegistry,
    options.currentModel,
    options.modelOverride,
  );

  if (options.modelOverride && !resolvedModel) {
    throw new Error(`Unknown model override: ${options.modelOverride}`);
  }

  const authStorage = options.modelRegistry.authStorage;
  const settingsManager = createSdkSettingsManager();
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: runtimeCwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir,
      authStorage,
      settingsManager,
      modelRegistry: options.modelRegistry,
      resourceLoaderOptions: getResourceLoaderOptions(
        runtimeCwd,
        options.agent,
        options.permissions,
        options.agent.memory ? await loadAgentMemoryPrompt(runtimeCwd, options.agent.name, options.agent.memory) : undefined,
        options.managedPlanMode,
      ),
    });

		const allowedToolNames = resolveAllowedToolNames(options.permissions ?? { allowedTools: options.agent.tools });
    const filteredCustomTools = filterCustomTools(options.customTools, options.permissions ?? {});

    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        ...(resolvedModel ? { model: resolvedModel } : {}),
        tools: buildToolsForAgent(runtimeCwd, allowedToolNames),
        customTools: filteredCustomTools,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(
    createRuntime,
    {
      cwd,
      agentDir: getAgentDir(),
      sessionManager: options.sessionManager,
    },
  );

  if (options.sessionName) {
    runtime.session.setSessionName(options.sessionName);
  }

  return {
    runtime,
    model: getModelLabel(resolvedModel),
    modelFallbackMessage: runtime.modelFallbackMessage,
  };
}

export async function runSdkSingleAgent(options: {
  defaultCwd: string;
  agent: AgentConfig;
  task: string;
  modelRegistry: ModelRegistry;
  currentModel: Model<any> | undefined;
  modelOverride?: string;
  cwdOverride?: string;
  signal?: AbortSignal;
  step?: number;
  sessionManager?: SessionManager;
  sessionName?: string;
  permissions?: AgentPermissionConfig;
  customTools?: ToolDefinition[];
  onUpdate?: (result: SdkSingleResult) => void;
  managedPlanMode?: ManagedPlanModeBridgeOptions;
}): Promise<SdkSingleResult> {
  const cwd = options.cwdOverride ?? options.defaultCwd;
  const resolvedModel = resolveModelOverride(
    options.modelRegistry,
    options.currentModel,
    options.modelOverride,
  );

  if (options.modelOverride && !resolvedModel) {
    return createUnknownModelResult(options);
  }

  const authStorage = options.modelRegistry.authStorage;
	const resourceLoader = await createResourceLoader(cwd, options.agent, options.permissions, options.managedPlanMode);
	const allowedToolNames = resolveAllowedToolNames(options.permissions ?? { allowedTools: options.agent.tools });
	const filteredCustomTools = filterCustomTools(options.customTools, options.permissions ?? {});

  let session: AgentSession | undefined;
  try {
    const created = await createAgentSession({
      cwd,
      authStorage,
      modelRegistry: options.modelRegistry,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      resourceLoader,
      tools: buildToolsForAgent(cwd, allowedToolNames),
      sessionManager: options.sessionManager ?? SessionManager.inMemory(),
      settingsManager: createSdkSettingsManager(),
      customTools: filteredCustomTools,
    });
    session = created.session;

    if (options.sessionName) {
      session.setSessionName(options.sessionName);
    }

    return await promptSdkAgentSession({
      session,
      agent: options.agent,
      task: options.agent.initialPrompt?.trim()
        ? `${options.agent.initialPrompt.trim()}\n\n${options.task}`
        : options.task,
      signal: options.signal,
      step: options.step,
      maxTurns: options.agent.maxTurns,
      model: getModelLabel(resolvedModel),
      onUpdate: options.onUpdate,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      agent: options.agent.name,
      agentSource: options.agent.source,
      task: options.task,
      exitCode: 1,
      messages: [],
      stderr: message,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      model: getModelLabel(resolvedModel),
      errorMessage: message,
      stopReason: "error",
      step: options.step,
      sessionFile: session?.sessionFile,
      sessionId: session?.sessionId,
    };
  } finally {
    await session?.dispose();
  }
}
