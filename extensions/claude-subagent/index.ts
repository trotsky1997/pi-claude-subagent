/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext, getMarkdownTheme, type ToolDefinition, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentScope } from "pi-claude-runtime-core/agent-discovery";
import type { ActiveTeamState, BackgroundAgentNotification, NamedAgentRecord, NamedAgentState, TeamMemberRecord } from "pi-claude-runtime-core/managed-runtime-schemas";
import {
	AGENT_PERMISSION_MODES,
	parseAgentPermissionMode,
	parseManagedRuntimeRecord,
	sanitizeActiveTeamState,
	sanitizeNamedAgentState,
} from "pi-claude-runtime-core/managed-runtime-schemas";
import { ManagedTaskRegistry } from "pi-claude-runtime-core/managed-task-registry";
import { getSharedClaudeTodoBridge, setSharedAgentRuntimeManager, setSharedChildRuntimeToolBuilder, setSharedManagedRuntimeCoordinator, setSharedManagedTaskRegistry, type ChildRuntimeToolContext, type ManagedRuntimeCoordinatorLike } from "pi-claude-runtime-core/runtime-bridge";
import { loadTeamRecord, saveTeamRecord, createTeamRecord, deleteTeamRecord, loadActiveTeamState, removeTeamMember, saveActiveTeamState, upsertTeamMember, getTeamsDir } from "pi-claude-runtime-core/team-state";
import { AgentRuntimeManager } from "./agent-runtime-manager.js";
import { discoverAgents } from "./agents.js";
import { createPermissionExtensionFactory, filterCustomTools, mergePermissionConfig, resolveAllowedDirectories, resolveAllowedToolNames } from "./agent-permissions.js";
import { getAgentMemoryDir } from "./agent-memory.js";
import { consumeDetachedOutboxEvents, getRuntimeKey, launchDetachedBackgroundRun, queueDetachedBackgroundMessage, requestDetachedBackgroundShutdown, supportsDetachedBackgroundRun } from "./detached-background.js";
import { loadNamedAgentStateFromDisk as loadNamedAgentStateFromDiskFile, markRunningAgentsInterrupted as markNamedAgentStateInterrupted, saveNamedAgentStateToDisk as saveNamedAgentStateToDiskFile } from "./named-agent-state.js";
import { runSdkSingleAgent } from "./sdk-agent.js";
import { ManagedRuntimeProfile } from "./runtime-profile.js";

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const promptsDir = path.join(baseDir, "prompts");

function getBundledPromptPaths(): string[] {
	try {
		return fs
			.readdirSync(promptsDir, { withFileTypes: true })
			.filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
			.map((entry) => path.join(promptsDir, entry.name))
			.sort();
	} catch {
		return [];
	}
}

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "bundled" | "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-claude-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	modelOverride: string | undefined,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const resolvedModel = modelOverride ?? agent.model;
	if (resolvedModel) args.push("--model", resolvedModel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: resolvedModel,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const PermissionModeSchema = StringEnum(AGENT_PERMISSION_MODES, {
	description: 'Permission mode override for the managed agent runtime.',
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

type ClaudeAgentParams = {
	description: string;
	prompt: string;
	subagent_type?: string;
	model?: string;
	allowed_tools?: string[];
	disallowed_tools?: string[];
	allowed_directories?: string[];
	allowed_skills?: string[];
	disallowed_skills?: string[];
	mode?: string;
	run_in_background?: boolean;
	name?: string;
	team_name?: string;
	cwd?: string;
};

type StructuredSendMessage =
	| {
		type: "shutdown_request";
		request_id?: string;
		reason?: string;
	}
	| {
		type: "shutdown_response";
		request_id: string;
		approve: boolean;
		reason?: string;
	}
	| {
		type: "plan_approval_request";
		request_id?: string;
		summary?: string;
	}
	| {
		type: "plan_approval_response";
		request_id: string;
		approve: boolean;
		feedback?: string;
	};

type SendMessageContent = string | StructuredSendMessage;

type SendMessageParams = {
	to: string;
	message: SendMessageContent;
	summary?: string;
};

type SendMessageDetails = {
	to: string;
	agentType: string;
	delivery: "queued" | "resumed" | "stopped";
	kind?: NamedAgentRecord["kind"];
	teamName?: string;
	recipients?: string[];
	pendingCount?: number;
	previousStatus?: NamedAgentRecord["status"];
	requestId?: string;
	messageType?: StructuredSendMessage["type"];
};

type TeamCreateParams = {
	team_name: string;
	description?: string;
	agent_type?: string;
};

type TeamCreateDetails = {
	team_name: string;
	created: boolean;
	member_count: number;
};

type TeamDeleteParams = Record<string, never>;

type TeamDeleteDetails = {
	team_name?: string;
	deleted: boolean;
	member_count: number;
};

const NAMED_AGENT_STATE_ENTRY = "claude-subagent-named-agents";
const ACTIVE_TEAM_STATE_ENTRY = "claude-subagent-active-team";
const BACKGROUND_AGENT_MESSAGE = "claude-subagent-background";
const DETACHED_OUTBOX_MESSAGE = "claude-subagent-detached-outbox";
const INTERRUPTED_BACKGROUND_MESSAGE = "The parent Pi session shut down or reloaded before the background agent finished.";
const DEFAULT_TEAMMATE_AUTOCLAIM_POLL_MS = 500;
const DETACHED_OUTBOX_POLL_MS = 1000;

type ChildLeadMessagePayload = {
	from: string;
	senderKind: NonNullable<NamedAgentRecord["kind"]>;
	teamName?: string;
	summary?: string;
	message: SendMessageContent;
};

let sessionRootCwd = process.cwd();
let runtimeManager: AgentRuntimeManager | null = null;
let managedTaskRegistry: ManagedTaskRegistry | null = null;
let activeTeamState: ActiveTeamState = {};
let notifyLeadFromChildRuntime: ((payload: ChildLeadMessagePayload) => void) | null = null;
const teammateAutoClaimPollers = new Map<string, ReturnType<typeof setTimeout>>();
let detachedOutboxPoller: ReturnType<typeof setInterval> | null = null;

function getTeammatePollKey(teamName: string, teammateName: string): string {
	return `${teamName}:${teammateName}`;
}

function clearTeammateAutoClaimPoller(teammateName: string | undefined, teamName: string | undefined): void {
	if (!teammateName || !teamName) return;
	const key = getTeammatePollKey(teamName, teammateName);
	const existing = teammateAutoClaimPollers.get(key);
	if (existing) {
		clearTimeout(existing);
		teammateAutoClaimPollers.delete(key);
	}
}

function clearAllTeammateAutoClaimPollers(): void {
	for (const timer of teammateAutoClaimPollers.values()) {
		clearTimeout(timer);
	}
	teammateAutoClaimPollers.clear();
}

function normalizeNamedAgentRecord(name: string, value: unknown): NamedAgentRecord | null {
	return parseManagedRuntimeRecord(value, name);
}

function normalizeNamedAgentState(state: NamedAgentState): NamedAgentState {
	return sanitizeNamedAgentState(state);
}

function createEmptyNamedAgentState(): NamedAgentState {
	return { agents: {} };
}

let namedAgentState: NamedAgentState = createEmptyNamedAgentState();
let persistNamedAgentStateImpl: (() => void) | null = null;

function getManagedTaskIdForNamedRuntime(name: string, kind: "subagent" | "teammate", teamName?: string): string {
	if (kind === "teammate") {
		return `teammate:${teamName ?? "unknown"}:${name}`;
	}
	return `subagent:${name}`;
}

function isDetachedManagedRuntimeRunning(name: string, kind: "subagent" | "teammate", teamName?: string): boolean {
	const taskId = getManagedTaskIdForNamedRuntime(name, kind, teamName);
	const task = managedTaskRegistry?.get(taskId);
	return Boolean(task && task.status === "running" && task.runtimeKind === kind && task.detached === true);
}

function getDetachedManagedRuntimeTask(name: string, kind: "subagent" | "teammate", teamName?: string) {
	const taskId = getManagedTaskIdForNamedRuntime(name, kind, teamName);
	const task = managedTaskRegistry?.get(taskId);
	return task && task.runtimeKind === kind && task.detached === true ? task : undefined;
}

async function pollDetachedOutboxEvents(pi: ExtensionAPI): Promise<void> {
	if (!managedTaskRegistry) return;
	for (const task of managedTaskRegistry.list().filter((entry) => entry.detached === true && entry.runtimeKind === "subagent")) {
		const events = await consumeDetachedOutboxEvents({ cwd: sessionRootCwd, runtimeKey: task.runtimeKey });
		for (const event of events) {
			switch (event.type) {
				case "plan_approval_request":
					pi.sendMessage(
						{
							customType: DETACHED_OUTBOX_MESSAGE,
							content: `Detached ${event.runtimeKind} \"${event.runtimeName}\" requested plan approval. Request ID: ${event.requestId}.${event.summary ? ` Summary: ${event.summary}` : ""}`,
							display: true,
							details: event,
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
					break;
				case "terminal": {
					const registryTask = managedTaskRegistry.get(event.runtimeKey);
					const details: BackgroundAgentNotification = {
						name: event.runtimeName,
						agentType: registryTask?.agentType ?? task.agentType,
						cwd: registryTask?.cwd ?? task.cwd,
						kind: event.runtimeKind,
						...(event.teamName ? { teamName: event.teamName } : {}),
						model: registryTask?.model,
						description: event.description,
						status: event.status,
						sessionFile: registryTask?.sessionFile,
						startedAt: registryTask?.startedAt,
						completedAt: event.completedAt,
						resultText: event.resultText,
						error: event.error,
					};
					pi.sendMessage(
						{
							customType: BACKGROUND_AGENT_MESSAGE,
							content: formatBackgroundNotification(details),
							display: true,
							details,
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
					const refreshedNamedState = await loadNamedAgentStateFromDiskFile(sessionRootCwd);
					namedAgentState = refreshedNamedState;
					await persistNamedAgentState();
					break;
				}
				case "child_message":
					pi.sendMessage(
						{
							customType: DETACHED_OUTBOX_MESSAGE,
							content: `${event.runtimeKind} \"${event.runtimeName}\": ${event.content}`,
							display: true,
							details: event,
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
					break;
			}
		}
	}
}

function startDetachedOutboxPoller(pi: ExtensionAPI): void {
	if (detachedOutboxPoller) return;
	detachedOutboxPoller = setInterval(() => {
		void pollDetachedOutboxEvents(pi);
	}, DETACHED_OUTBOX_POLL_MS);
	detachedOutboxPoller.unref?.();
}

function stopDetachedOutboxPoller(): void {
	if (!detachedOutboxPoller) return;
	clearInterval(detachedOutboxPoller);
	detachedOutboxPoller = null;
}

function getNamedAgentSessionDir(cwd: string): string {
	return path.resolve(cwd, ".pi", "claude-subagent", "agent-sessions");
}

function getNamedAgentRegistryPath(cwd: string): string {
	return path.resolve(cwd, ".pi", "claude-subagent", "named-agents.json");
}

function markRunningAgentsInterrupted(state: NamedAgentState, reason: string): NamedAgentState {
	let changed = false;
	const agents: Record<string, NamedAgentRecord> = {};
	for (const [name, record] of Object.entries(state.agents)) {
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

async function loadNamedAgentStateFromDisk(cwd: string): Promise<NamedAgentState> {
	try {
		const raw = await fs.promises.readFile(getNamedAgentRegistryPath(cwd), "utf-8");
		return sanitizeNamedAgentState(JSON.parse(raw));
	} catch {
		return createEmptyNamedAgentState();
	}
}

async function saveNamedAgentStateToDisk(cwd: string, state: NamedAgentState): Promise<void> {
	const filePath = getNamedAgentRegistryPath(cwd);
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await fs.promises.writeFile(filePath, JSON.stringify(normalizeNamedAgentState(state), null, 2), "utf-8");
}

function restoreActiveTeamState(ctx: ExtensionContext): ActiveTeamState {
	let state: ActiveTeamState = {};
	for (const entry of ctx.sessionManager.getBranch()) {
		const customEntry = entry as { type?: string; customType?: string; data?: unknown };
		if (customEntry.type === "custom" && customEntry.customType === ACTIVE_TEAM_STATE_ENTRY) {
			state = sanitizeActiveTeamState(customEntry.data);
		}
	}
	return state;
}

function restoreNamedAgentState(ctx: ExtensionContext): NamedAgentState {
	let state = createEmptyNamedAgentState();
	for (const entry of ctx.sessionManager.getBranch()) {
		const customEntry = entry as { type?: string; customType?: string; data?: unknown };
		if (customEntry.type === "custom" && customEntry.customType === NAMED_AGENT_STATE_ENTRY) {
			state = sanitizeNamedAgentState(customEntry.data);
		}
	}
	return state;
}

async function persistActiveTeamState(): Promise<void> {
	await saveActiveTeamState(sessionRootCwd, activeTeamState);
	if (activeTeamState.teamName) {
		piActiveTeamStateAppend?.(activeTeamState);
	}
}

let piActiveTeamStateAppend: ((state: ActiveTeamState) => void) | null = null;

async function persistNamedAgentState(): Promise<void> {
	namedAgentState = normalizeNamedAgentState(namedAgentState);
	await saveNamedAgentStateToDisk(sessionRootCwd, namedAgentState);
	persistNamedAgentStateImpl?.();
}

function upsertNamedAgentRecord(record: NamedAgentRecord): void {
	namedAgentState = {
		...namedAgentState,
		agents: {
			...namedAgentState.agents,
			[record.name]: record,
		},
	};
}

function toManagedTeammateRecord(teamName: string, member: TeamMemberRecord): NamedAgentRecord | undefined {
	if (!member.sessionFile) return undefined;
	return {
		name: member.name,
		agentType: member.agentType,
		cwd: member.cwd,
		sessionFile: member.sessionFile,
		kind: "teammate",
		teamName,
		...(typeof member.autoClaimTasks === "boolean" ? { autoClaimTasks: member.autoClaimTasks } : {}),
		...(member.allowedTools ? { allowedTools: member.allowedTools } : {}),
		...(member.disallowedTools ? { disallowedTools: member.disallowedTools } : {}),
		...(member.allowedDirectories ? { allowedDirectories: member.allowedDirectories } : {}),
		...(member.allowedSkills ? { allowedSkills: member.allowedSkills } : {}),
		...(member.disallowedSkills ? { disallowedSkills: member.disallowedSkills } : {}),
		...(member.permissionMode ? { permissionMode: member.permissionMode } : {}),
		...(member.effort !== undefined ? { effort: member.effort } : {}),
		...(member.mcpServers ? { mcpServers: member.mcpServers } : {}),
		...(member.requiredMcpServers ? { requiredMcpServers: member.requiredMcpServers } : {}),
		...(member.hooks ? { hooks: member.hooks } : {}),
		...(member.isolation ? { isolation: member.isolation } : {}),
		...(member.model ? { model: member.model } : {}),
		...(member.sessionId ? { sessionId: member.sessionId } : {}),
		...(member.color ? { color: member.color } : {}),
		...(typeof member.initialPromptApplied === "boolean" ? { initialPromptApplied: member.initialPromptApplied } : {}),
		status: member.status ?? "idle",
		background: false,
		...(member.lastResultText ? { lastResultText: member.lastResultText } : {}),
		...(member.lastError ? { lastError: member.lastError } : {}),
	};
}

function toDetachedManagedRecord(task: {
	taskId: string;
	runtimeName: string;
	runtimeKind: "subagent" | "teammate";
	teamName?: string;
	agentType: string;
	cwd: string;
	sessionFile?: string;
	sessionId?: string;
	model?: string;
	status: NamedAgentRecord["status"];
	background: boolean;
	startedAt?: string;
	completedAt?: string;
	resultText?: string;
	error?: string;
}): NamedAgentRecord | undefined {
	if (!task.sessionFile) return undefined;
	return {
		name: task.runtimeName,
		agentType: task.agentType,
		cwd: task.cwd,
		sessionFile: task.sessionFile,
		kind: task.runtimeKind,
		...(task.teamName ? { teamName: task.teamName } : {}),
		...(task.sessionId ? { sessionId: task.sessionId } : {}),
		...(task.model ? { model: task.model } : {}),
		status: task.status,
		background: task.background,
		...(task.startedAt ? { lastStartedAt: task.startedAt } : {}),
		...(task.completedAt ? { lastCompletedAt: task.completedAt } : {}),
		...(task.resultText ? { lastResultText: task.resultText } : {}),
		...(task.error ? { lastError: task.error } : {}),
	};
}

function toTeamMemberRecord(record: NamedAgentRecord): TeamMemberRecord {
	return {
		name: record.name,
		agentType: record.agentType,
		cwd: record.cwd,
		joinedAt: record.lastStartedAt ?? record.lastCompletedAt ?? new Date().toISOString(),
		...(typeof record.autoClaimTasks === "boolean" ? { autoClaimTasks: record.autoClaimTasks } : {}),
		...(record.allowedTools ? { allowedTools: record.allowedTools } : {}),
		...(record.disallowedTools ? { disallowedTools: record.disallowedTools } : {}),
		...(record.allowedDirectories ? { allowedDirectories: record.allowedDirectories } : {}),
		...(record.allowedSkills ? { allowedSkills: record.allowedSkills } : {}),
		...(record.disallowedSkills ? { disallowedSkills: record.disallowedSkills } : {}),
		...(record.permissionMode ? { permissionMode: record.permissionMode } : {}),
		...(record.effort !== undefined ? { effort: record.effort } : {}),
		...(record.mcpServers ? { mcpServers: record.mcpServers } : {}),
		...(record.requiredMcpServers ? { requiredMcpServers: record.requiredMcpServers } : {}),
		...(record.hooks ? { hooks: record.hooks } : {}),
		...(record.isolation ? { isolation: record.isolation } : {}),
		...(record.model ? { model: record.model } : {}),
		...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
		...(record.sessionId ? { sessionId: record.sessionId } : {}),
		...(record.color ? { color: record.color } : {}),
		...(typeof record.initialPromptApplied === "boolean" ? { initialPromptApplied: record.initialPromptApplied } : {}),
		status: record.status ?? "idle",
		...(record.lastResultText ? { lastResultText: record.lastResultText } : {}),
		...(record.lastError ? { lastError: record.lastError } : {}),
	};
}

async function persistTeammateRecord(record: NamedAgentRecord): Promise<void> {
	if (record.kind !== "teammate" || !record.teamName) return;
	const team = await loadTeamRecord(sessionRootCwd, record.teamName);
	if (!team) return;
	await saveTeamRecord(sessionRootCwd, upsertTeamMember(team, toTeamMemberRecord(record)));
}

async function removeTeammateMember(cwd: string, teamName: string, memberName: string): Promise<void> {
	const team = await loadTeamRecord(cwd, teamName);
	if (!team?.members[memberName]) return;

	try {
		await getSharedClaudeTodoBridge()?.unassignOwnerTasks(cwd, teamName, memberName);
	} catch {
		// Keep teammate cleanup best-effort if task reclamation races or the list is missing.
	}

	await saveTeamRecord(cwd, removeTeamMember(team, memberName));
}

async function prunePersistedTeammates(cwd: string): Promise<void> {
	let entries: string[] = [];
	try {
		entries = await fs.promises.readdir(getTeamsDir(cwd));
	} catch {
		return;
	}

	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const teamName = entry.slice(0, -5);
		const team = await loadTeamRecord(cwd, teamName);
		if (!team || Object.keys(team.members).length === 0) continue;

		for (const memberName of Object.keys(team.members)) {
			if (getDetachedManagedRuntimeTask(memberName, "teammate", team.name)) {
				continue;
			}
			await removeTeammateMember(cwd, team.name, memberName);
		}
	}
}

async function maybeAutoClaimTaskForTeammate(record: NamedAgentRecord): Promise<void> {
	if (record.kind !== "teammate" || !record.teamName || record.autoClaimTasks !== true) {
		return;
	}
	if (!runtimeManager) return;
	const claudeTodoBridge = getSharedClaudeTodoBridge();
	if (!claudeTodoBridge) return;

	const current = runtimeManager.get(record.name, { kind: "teammate", teamName: record.teamName });
	if (!current) return;
	if (current.status !== "completed" && current.status !== "idle") {
		return;
	}

	const tasks = claudeTodoBridge.filterExternalTasks(await claudeTodoBridge.listTasks(sessionRootCwd, record.teamName));
	const nextTask = claudeTodoBridge.findAvailableTask(tasks);
	if (!nextTask) {
		scheduleTeammateAutoClaim(record);
		return;
	}

	const claimResult = await claudeTodoBridge.claimTask(sessionRootCwd, record.teamName, nextTask.id, record.name, {
		checkAgentBusy: true,
	});
	if (!claimResult.success) {
		scheduleTeammateAutoClaim(current);
		return;
	}

	await claudeTodoBridge.markTaskInProgress(sessionRootCwd, record.teamName, nextTask.id, record.name);
	await runtimeManager.launchExistingBackground({
		name: record.name,
		kind: "teammate",
		teamName: record.teamName,
		task: `${claudeTodoBridge.getWorkerSystemPrompt(record.name, record.teamName)}\n\n${claudeTodoBridge.formatTaskForPrompt(nextTask)}`,
		description: nextTask.subject,
	});
}

function scheduleTeammateAutoClaim(record: NamedAgentRecord): void {
	if (record.kind !== "teammate" || !record.teamName || record.autoClaimTasks !== true) {
		return;
	}
	const key = getTeammatePollKey(record.teamName, record.name);
	if (teammateAutoClaimPollers.has(key)) return;
	const timer = setTimeout(() => {
		teammateAutoClaimPollers.delete(key);
		void maybeAutoClaimTaskForTeammate(record).catch(() => {
			scheduleTeammateAutoClaim(record);
		});
	}, DEFAULT_TEAMMATE_AUTOCLAIM_POLL_MS);
	teammateAutoClaimPollers.set(key, timer);
}

function formatBackgroundNotification(details: BackgroundAgentNotification): string {
	const statusLabel = details.status === "launched"
		? "launched"
		: details.status === "completed"
			? "completed"
			: details.status === "failed"
				? "failed"
				: "interrupted";
	const subject = (details.kind === "teammate" || Boolean(details.teamName))
		? `Teammate "${details.name}" (${details.agentType})${details.teamName ? ` in team "${details.teamName}"` : ""}`
		: `Background agent "${details.name}" (${details.agentType})`;
	let text = `${subject} ${statusLabel}.`;
	if (details.description) {
		text += `
Task: ${details.description}`;
	}
	if (details.error) {
		text += `
Error: ${details.error}`;
	} else if (details.resultText) {
		text += `
Result: ${details.resultText}`;
	}
	return text;
}

function renderBackgroundNotification(message: any, options: any, theme: any): Text {
	const details = message.details as BackgroundAgentNotification | undefined;
	const status = details?.status ?? "completed";
	const color = status === "completed" ? "success" : status === "launched" ? "warning" : "error";
	const base = typeof message.content === "string" ? message.content : formatBackgroundNotification(details ?? {
		name: "agent",
		agentType: "general-purpose",
		cwd: sessionRootCwd,
		status,
	});
	const prefix = theme.fg(color, `[${status.toUpperCase()}]`);
	let text = `${prefix} ${base}`;
	if (options?.expanded && details?.sessionFile) {
		text += `\n${theme.fg("dim", details.sessionFile)}`;
	}
	return new Text(text, 0, 0);
}

function makeBackgroundLaunchResult(record: NamedAgentRecord, agent: AgentConfig, task: string): SingleResult {
	return {
		agent: agent.name,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: record.model,
		stopReason: "background",
		errorMessage: undefined,
	};
}

const TeamCreateParamsSchema = Type.Object({
	team_name: Type.String({ description: "Name for the team to create or activate" }),
	description: Type.Optional(Type.String({ description: "Optional team description" })),
	agent_type: Type.Optional(Type.String({ description: "Optional lead agent type label" })),
});

const TeamDeleteParamsSchema = Type.Object({});

const StructuredSendMessageSchema = Type.Union([
	Type.Object({
		type: Type.Literal("shutdown_request"),
		request_id: Type.Optional(Type.String({ description: "Optional request ID. Generated automatically when omitted." })),
		reason: Type.Optional(Type.String({ description: "Why the recipient should stop." })),
	}),
	Type.Object({
		type: Type.Literal("shutdown_response"),
		request_id: Type.String({ description: "The shutdown request ID being answered." }),
		approve: Type.Boolean({ description: "Whether shutdown is approved." }),
		reason: Type.Optional(Type.String({ description: "Optional explanation for the response." })),
	}),
	Type.Object({
		type: Type.Literal("plan_approval_request"),
		request_id: Type.Optional(Type.String({ description: "Optional request ID. Generated automatically when omitted." })),
		summary: Type.Optional(Type.String({ description: "Short summary of the plan awaiting approval." })),
	}),
	Type.Object({
		type: Type.Literal("plan_approval_response"),
		request_id: Type.String({ description: "The plan approval request ID being answered." }),
		approve: Type.Boolean({ description: "Whether the proposed plan is approved." }),
		feedback: Type.Optional(Type.String({ description: "Optional revision feedback when the plan is rejected." })),
	}),
]);

const SendMessageParamsSchema = Type.Object({
	to: Type.String({ description: "Target named agent" }),
	message: Type.Union([
		Type.String({ description: "Message to deliver to the named agent" }),
		StructuredSendMessageSchema,
	]),
	summary: Type.Optional(Type.String({ description: "Optional short summary shown in the UI" })),
});

const AgentParams = Type.Object({
	description: Type.String({ description: "A short (3-5 word) description of the task" }),
	prompt: Type.String({ description: "The task for the agent to perform" }),
	subagent_type: Type.Optional(Type.String({ description: "The type of specialized agent to use for this task" })),
	model: Type.Optional(Type.String({ description: "Optional model override for this agent" })),
	allowed_tools: Type.Optional(Type.Array(Type.String(), { description: "Optional tool allowlist for this agent runtime" })),
	disallowed_tools: Type.Optional(Type.Array(Type.String(), { description: "Optional tool denylist for this agent runtime" })),
	allowed_directories: Type.Optional(Type.Array(Type.String(), { description: "Optional directory allowlist for file-based tools" })),
	allowed_skills: Type.Optional(Type.Array(Type.String(), { description: "Optional skill allowlist for this agent runtime" })),
	disallowed_skills: Type.Optional(Type.Array(Type.String(), { description: "Optional skill denylist for this agent runtime" })),
	mode: Type.Optional(PermissionModeSchema),
	run_in_background: Type.Optional(Type.Boolean({ description: "Set to true to run this agent in the background" })),
	name: Type.Optional(Type.String({ description: "Optional name for persistent continuation. Required for run_in_background." })),
	team_name: Type.Optional(Type.String({ description: "Optional local team context for spawning an in-process teammate" })),
	cwd: Type.Optional(Type.String({ description: "Optional working directory override for this agent process" })),
});

function isStructuredSendMessage(message: SendMessageContent): message is StructuredSendMessage {
	return typeof message !== "string";
}

function normalizeSendMessageContent(message: SendMessageContent): SendMessageContent {
	if (!isStructuredSendMessage(message)) return message;
	if (message.type === "shutdown_request" || message.type === "plan_approval_request") {
		return {
			...message,
			request_id: message.request_id?.trim() || randomUUID(),
		};
	}
	return message;
}

function serializeSendMessageContent(message: SendMessageContent): string {
	if (typeof message === "string") return message;
	return JSON.stringify(message);
}

function getSendMessagePreview(message: SendMessageContent): string {
	const serialized = serializeSendMessageContent(message);
	return serialized.length > 80 ? `${serialized.slice(0, 80)}...` : serialized;
}

function getDefaultSendMessageSummary(message: SendMessageContent): string | undefined {
	if (!isStructuredSendMessage(message)) return undefined;
	switch (message.type) {
		case "shutdown_request":
			return "shutdown request";
		case "shutdown_response":
			return message.approve ? "shutdown approved" : "shutdown rejected";
		case "plan_approval_request":
			return "plan approval request";
		case "plan_approval_response":
			return message.approve ? "plan approved" : "plan rejected";
		default:
			return undefined;
	}
}

function formatChildLeadMessage(payload: ChildLeadMessagePayload): string {
	const prefix = payload.senderKind === "teammate"
		? `Teammate "${payload.from}"`
		: `Agent "${payload.from}"`;
	const summaryLine = payload.summary ? `Summary: ${payload.summary}
` : "";
	if (typeof payload.message === "string") {
		return `${prefix} sent a message to team-lead.${payload.teamName ? ` Team: ${payload.teamName}.` : ""}
${summaryLine}Message: ${payload.message}`;
	}

	switch (payload.message.type) {
		case "shutdown_response":
			return `${prefix} responded to shutdown request ${payload.message.request_id}: approve=${payload.message.approve}.${payload.message.reason ? ` Reason: ${payload.message.reason}` : ""}`;
		case "plan_approval_response":
			return `${prefix} responded to plan approval request ${payload.message.request_id}: approve=${payload.message.approve}.${payload.message.feedback ? ` Feedback: ${payload.message.feedback}` : ""}`;
		case "plan_approval_request":
			return `${prefix} asked team-lead to review a plan.${payload.message.request_id ? ` Request ID: ${payload.message.request_id}.` : ""}${payload.message.summary ? ` Summary: ${payload.message.summary}` : ""}`;
		case "shutdown_request":
			return `${prefix} asked team-lead for shutdown.${payload.message.request_id ? ` Request ID: ${payload.message.request_id}.` : ""}${payload.message.reason ? ` Reason: ${payload.message.reason}` : ""}`;
		default:
			return `${prefix} sent a structured message to team-lead: ${JSON.stringify(payload.message)}`;
	}
}

function buildChildSendMessageBridgeTools(context: ChildRuntimeToolContext): ToolDefinition[] {
	return [
		defineTool({
			name: "SendMessage",
			label: "SendMessage",
			description: "Send a follow-up message to another managed runtime or back to team-lead.",
			parameters: SendMessageParamsSchema,
			async execute(_toolCallId, rawParams: SendMessageParams) {
				const params = rawParams as SendMessageParams;
				const target = params.to.trim();
				const normalizedMessage = normalizeSendMessageContent(params.message);
				const summary = params.summary?.trim() || getDefaultSendMessageSummary(normalizedMessage);
				if (!target) {
					return {
						content: [{ type: "text", text: "SendMessage target must not be empty." }],
						details: { to: "", agentType: "unknown", delivery: "queued" },
						isError: true,
					};
				}

				if (target === "team-lead") {
					if (!notifyLeadFromChildRuntime) {
						return {
							content: [{ type: "text", text: "The parent session bridge is not available right now." }],
							details: { to: target, agentType: "team-lead", delivery: "queued", kind: context.senderKind, teamName: context.teamName },
							isError: true,
						};
					}
					notifyLeadFromChildRuntime({
						from: context.senderName,
						senderKind: context.senderKind,
						teamName: context.teamName,
						summary,
						message: normalizedMessage,
					});
					return {
						content: [{ type: "text", text: "Message delivered to team-lead." }],
						details: { to: target, agentType: "team-lead", delivery: "queued", kind: context.senderKind, teamName: context.teamName, ...(isStructuredSendMessage(normalizedMessage) && "request_id" in normalizedMessage && normalizedMessage.request_id ? { requestId: normalizedMessage.request_id } : {}), ...(isStructuredSendMessage(normalizedMessage) ? { messageType: normalizedMessage.type } : {}) },
					};
				}

				if (target === "*" && context.senderKind === "teammate" && context.teamName && runtimeManager) {
					const team = await loadTeamRecord(context.cwd, context.teamName);
					if (!team) {
						return {
							content: [{ type: "text", text: `Team "${context.teamName}" no longer exists.` }],
							details: { to: target, agentType: "team", delivery: "queued", kind: context.senderKind, teamName: context.teamName },
							isError: true,
						};
					}
					const recipients: string[] = [];
					const discovery = discoverAgents(context.cwd, "both");
					for (const member of Object.values(team.members)) {
						if (member.name === context.senderName) continue;
						const liveRecord = runtimeManager.get(member.name, { kind: "teammate", teamName: context.teamName });
						if (!liveRecord) continue;
						const selectedAgent = discovery.agents.find((agent) => agent.name === liveRecord.agentType);
						if (!selectedAgent) continue;
						await runtimeManager.sendMessage({
							kind: "teammate",
							teamName: context.teamName,
							color: liveRecord.color,
							name: liveRecord.name,
							agent: selectedAgent,
							message: serializeSendMessageContent(normalizedMessage),
							summary,
							defaultCwd: context.cwd,
							requestedCwd: liveRecord.cwd,
							modelRegistry: context.runtimeContext.modelRegistry,
							currentModel: context.runtimeContext.currentModel,
							modelOverride: liveRecord.model,
							persisted: liveRecord,
							customTools: buildTeammateRuntimeCustomTools({
								cwd: context.cwd,
								teamName: context.teamName,
								actingAgentName: liveRecord.name,
								runtimeContext: context.runtimeContext,
							}),
						});
						recipients.push(liveRecord.name);
					}
					return {
						content: [{ type: "text", text: recipients.length > 0 ? `Broadcast delivered to ${recipients.length} teammate(s).` : "No other live teammates were available for broadcast." }],
						details: { to: target, agentType: "team", delivery: "queued", kind: context.senderKind, teamName: context.teamName, recipients, ...(isStructuredSendMessage(normalizedMessage) ? { messageType: normalizedMessage.type } : {}) },
					};
				}

				const result = await executeSendMessageTool(
					{ ...params, message: normalizedMessage, ...(summary ? { summary } : {}) },
					undefined,
					{ cwd: context.cwd, modelRegistry: context.runtimeContext.modelRegistry, model: context.runtimeContext.currentModel } as ExtensionContext,
				);
				return result;
			},
		}),
	];
}

function buildTeammateRuntimeCustomTools(options: {
	cwd: string;
	teamName: string;
	actingAgentName: string;
	runtimeContext: ChildRuntimeToolContext["runtimeContext"];
}): ToolDefinition[] {
	const claudeTodoBridge = getSharedClaudeTodoBridge();
	return [
		...(claudeTodoBridge
			? claudeTodoBridge.buildClaudeTodoCustomTools({
				cwd: options.cwd,
				taskListId: options.teamName,
				actingAgentName: options.actingAgentName,
				runtimeContext: options.runtimeContext,
			})
			: []),
		...buildChildSendMessageBridgeTools({
			cwd: options.cwd,
			senderName: options.actingAgentName,
			senderKind: "teammate",
			teamName: options.teamName,
			runtimeContext: options.runtimeContext,
		}),
	];
}

function buildNamedSubagentRuntimeCustomTools(options: {
	cwd: string;
	actingAgentName: string;
	runtimeContext: ChildRuntimeToolContext["runtimeContext"];
}): ToolDefinition[] {
	return buildChildSendMessageBridgeTools({
		cwd: options.cwd,
		senderName: options.actingAgentName,
		senderKind: "subagent",
		runtimeContext: options.runtimeContext,
	});
}

function createManagedPlanModeBridge(options: {
	name: string;
	kind: "subagent" | "teammate";
	teamName?: string;
	reason?: string;
}) {
	return {
		...(options.reason?.trim() ? { initialReason: options.reason.trim() } : {}),
		requestPlanApproval: async (request: {
			planPath: string;
			plan: string;
			summary?: string;
		}) => {
			const requestId = randomUUID();
			const summary = request.summary?.trim()
				? `${request.summary.trim()} (plan: ${request.planPath})`
				: `Review approved-plan request for ${options.name}. Plan file: ${request.planPath}`;
			notifyLeadFromChildRuntime?.({
				from: options.name,
				senderKind: options.kind,
				teamName: options.teamName,
				summary: "plan approval request",
				message: {
					type: "plan_approval_request",
					request_id: requestId,
					summary,
				},
			});
			return { requestId };
		},
	};
}

async function persistDetachedLaunchRecord(record: NamedAgentRecord): Promise<void> {
	if (record.kind === "teammate" && record.teamName) {
		const team = await loadTeamRecord(sessionRootCwd, record.teamName);
		if (team) {
			await saveTeamRecord(sessionRootCwd, upsertTeamMember(team, toTeamMemberRecord(record)));
		}
		return;
	}
	namedAgentState = {
		...namedAgentState,
		agents: {
			...namedAgentState.agents,
			[record.name]: record,
		},
	};
	await persistNamedAgentState();
}

async function stopManagedRuntime(target: string, options: {
	kind: NamedAgentRecord["kind"];
	teamName?: string;
}): Promise<boolean> {
	const stoppedLive = runtimeManager
		? await runtimeManager.abort(target, { kind: options.kind, ...(options.teamName ? { teamName: options.teamName } : {}) })
		: false;
	if (stoppedLive) return true;
	if (isDetachedManagedRuntimeRunning(target, options.kind, options.teamName)) {
		await requestDetachedBackgroundShutdown({
			cwd: sessionRootCwd,
			name: target,
			kind: options.kind,
			...(options.teamName ? { teamName: options.teamName } : {}),
			reason: "shutdown requested",
		});
		return true;
	}
	return false;
}

function renderAgentCall(args: ClaudeAgentParams, theme: any): Text {
	const agentName = args.subagent_type?.trim() || "general-purpose";
	const preview = args.prompt.length > 80 ? `${args.prompt.slice(0, 80)}...` : args.prompt;
	let text =
		theme.fg("toolTitle", theme.bold("Agent ")) +
		theme.fg("accent", agentName) +
		theme.fg("muted", ` ${args.description}`);
	if (args.run_in_background) text += theme.fg("warning", " [background requested]");
	text += `
  ${theme.fg("dim", preview)}`;
	return new Text(text, 0, 0);
}

function renderSendMessageCall(args: SendMessageParams, theme: any): Text {
	const preview = getSendMessagePreview(args.message);
	let text =
		theme.fg("toolTitle", theme.bold("SendMessage ")) +
		theme.fg("accent", args.to);
	if (args.summary?.trim()) {
		text += theme.fg("muted", ` ${args.summary.trim()}`);
	}
	text += `
  ${theme.fg("dim", preview)}`;
	return new Text(text, 0, 0);
}

function renderTeamCreateCall(args: TeamCreateParams, theme: any): Text {
	let text = theme.fg("toolTitle", theme.bold("TeamCreate ")) + theme.fg("accent", args.team_name);
	if (args.description?.trim()) {
		text += `
  ${theme.fg("dim", args.description.trim())}`;
	}
	return new Text(text, 0, 0);
}

function renderTeamCreateResult(result: any, _options: any, _theme: any): Text {
	const first = result.content?.[0];
	return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
}

function renderTeamDeleteCall(_args: TeamDeleteParams, theme: any): Text {
	return new Text(theme.fg("toolTitle", theme.bold("TeamDelete")), 0, 0);
}

function renderTeamDeleteResult(result: any, _options: any, _theme: any): Text {
	const first = result.content?.[0];
	return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
}

function renderSendMessageResult(result: any, _options: any, _theme: any): Text {
	const first = result.content?.[0];
	return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
}

async function executeTeamCreateTool(
	params: TeamCreateParams,
	ctx: ExtensionContext,
): Promise<AgentToolResult<TeamCreateDetails>> {
	const teamName = params.team_name.trim();
	if (!teamName) {
		return {
			content: [{ type: "text", text: "team_name must not be empty." }],
			details: { team_name: "", created: false, member_count: 0 },
			isError: true,
		};
	}

	const existing = await loadTeamRecord(ctx.cwd, teamName);
	if (existing) {
		await getSharedClaudeTodoBridge()?.ensureTaskListDir(ctx.cwd, existing.name);
		activeTeamState = { teamName: existing.name };
		await persistActiveTeamState();
		return {
			content: [{ type: "text", text: `Team "${existing.name}" is now the active local team.` }],
			details: { team_name: existing.name, created: false, member_count: Object.keys(existing.members).length },
		};
	}

	const created = createTeamRecord({
		name: teamName,
		cwd: ctx.cwd,
		leadName: "team-lead",
		description: params.description?.trim() || undefined,
		leadAgentType: params.agent_type?.trim() || undefined,
	});
	await saveTeamRecord(ctx.cwd, created);
	await getSharedClaudeTodoBridge()?.resetTaskList(ctx.cwd, created.name);
	await getSharedClaudeTodoBridge()?.ensureTaskListDir(ctx.cwd, created.name);
	activeTeamState = { teamName: created.name };
	await persistActiveTeamState();
	return {
		content: [{ type: "text", text: `Created local team "${created.name}", initialized its shared task list, and set it active for teammate routing.` }],
		details: { team_name: created.name, created: true, member_count: 0 },
	};
}

async function executeTeamDeleteTool(
	_params: TeamDeleteParams,
	ctx: ExtensionContext,
): Promise<AgentToolResult<TeamDeleteDetails>> {
	const diskTeamState = await loadActiveTeamState(ctx.cwd);
	if (diskTeamState.teamName) {
		activeTeamState = diskTeamState;
	}

	const teamName = activeTeamState.teamName;
	if (!teamName) {
		return {
			content: [{ type: "text", text: "No active local team to delete." }],
			details: { deleted: false, member_count: 0 },
			isError: true,
		};
	}

	const team = await loadTeamRecord(ctx.cwd, teamName);
	if (!team) {
		activeTeamState = {};
		await persistActiveTeamState();
		return {
			content: [{ type: "text", text: `Team "${teamName}" was already missing. Cleared the active team context.` }],
			details: { team_name: teamName, deleted: true, member_count: 0 },
		};
	}

	const liveMembers = runtimeManager?.list().filter((record) =>
		record.kind === "teammate" && record.teamName === team.name && record.status === "running",
	) ?? [];
	if (liveMembers.length > 0) {
		return {
			content: [{
				type: "text",
				text: `Cannot delete team "${team.name}" while ${liveMembers.length} teammate(s) are still running: ${liveMembers.map((member) => member.name).join(", ")}. Stop them first, for example with SendMessage using a structured shutdown_request.`,
			}],
			details: { team_name: team.name, deleted: false, member_count: Object.keys(team.members).length },
			isError: true,
		};
	}

	for (const memberName of Object.keys(team.members)) {
		clearTeammateAutoClaimPoller(memberName, team.name);
		try {
			await getSharedClaudeTodoBridge()?.unassignOwnerTasks(ctx.cwd, team.name, memberName);
		} catch {
			// Keep deletion best-effort if ownership cleanup races the task list watcher.
		}
	}

	await deleteTeamRecord(ctx.cwd, team.name);
	try {
		const taskListDir = getSharedClaudeTodoBridge()?.getTaskListDir(ctx.cwd, team.name);
		if (taskListDir) {
			await fs.promises.rm(taskListDir, { recursive: true, force: true });
		}
	} catch {
		// Ignore task-list cleanup races; the team file is the primary source of truth.
	}

	activeTeamState = activeTeamState.teamName === team.name ? {} : activeTeamState;
	await persistActiveTeamState();

	return {
		content: [{ type: "text", text: `Deleted local team "${team.name}" and cleaned up its shared task list.` }],
		details: { team_name: team.name, deleted: true, member_count: Object.keys(team.members).length },
	};
}

async function executeSendMessageTool(
	params: SendMessageParams,
	_ctxSignal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<SendMessageDetails>> {
	const target = params.to.trim();
	const normalizedMessage = normalizeSendMessageContent(params.message);
	const summary = params.summary?.trim() || getDefaultSendMessageSummary(normalizedMessage);
	const messageText = serializeSendMessageContent(normalizedMessage);
	const shutdownRequest = isStructuredSendMessage(normalizedMessage) && normalizedMessage.type === "shutdown_request"
		? normalizedMessage
		: undefined;
	if (!target) {
		return {
			content: [{ type: "text", text: "SendMessage target must not be empty." }],
			details: { to: "", agentType: "unknown", delivery: "queued" },
			isError: true,
		};
	}
	if (!runtimeManager) {
		return {
			content: [{ type: "text", text: "Agent runtime manager is not initialized." }],
			details: { to: target, agentType: "unknown", delivery: "queued" },
			isError: true,
		};
	}

	const diskState = await loadNamedAgentStateFromDisk(ctx.cwd);
	if (Object.keys(diskState.agents).length > 0) {
		namedAgentState = diskState;
	}
	const diskTeamState = await loadActiveTeamState(ctx.cwd);
	if (diskTeamState.teamName) {
		activeTeamState = diskTeamState;
	}

	const discovery = discoverAgents(ctx.cwd, "both");
	const activeTeamName = activeTeamState.teamName;
	const activeTeam = activeTeamName ? await loadTeamRecord(ctx.cwd, activeTeamName) : null;
	const currentModelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

	if (target === "*") {
		if (!activeTeamName || !activeTeam) {
			return {
				content: [{ type: "text", text: "Broadcast routing requires an active local team. Use TeamCreate first." }],
				details: { to: target, agentType: "team", delivery: "queued" },
				isError: true,
			};
		}
		const members = Object.values(activeTeam.members);
		if (members.length === 0) {
			return {
				content: [{ type: "text", text: `Team "${activeTeamName}" has no teammates to message yet.` }],
				details: { to: target, agentType: "team", delivery: "queued", teamName: activeTeamName, recipients: [] },
				isError: true,
			};
		}

		const recipients: string[] = [];
		if (shutdownRequest) {
			for (const member of members) {
				const liveRecord = runtimeManager.get(member.name, { kind: "teammate", teamName: activeTeamName });
				if (!liveRecord) {
					await removeTeammateMember(ctx.cwd, activeTeamName, member.name);
					continue;
				}
				await stopManagedRuntime(liveRecord.name, { kind: "teammate", teamName: activeTeamName });
				recipients.push(liveRecord.name);
			}

			if (recipients.length === 0) {
				return {
					content: [{ type: "text", text: `Team "${activeTeamName}" has no live teammates in this Pi session. Relaunch them with Agent(team_name + name) first.` }],
					details: { to: target, agentType: "team", delivery: "stopped", teamName: activeTeamName, recipients: [], requestId: shutdownRequest.request_id, messageType: shutdownRequest.type },
					isError: true,
				};
			}

			return {
				content: [{
					type: "text",
					text: `Shutdown requested for ${recipients.length} teammate(s) in team "${activeTeamName}".`,
				}],
				details: { to: target, agentType: "team", delivery: "stopped", teamName: activeTeamName, recipients, requestId: shutdownRequest.request_id, messageType: shutdownRequest.type },
			};
		}

		for (const member of members) {
			const liveRecord = runtimeManager.get(member.name, { kind: "teammate", teamName: activeTeamName });
			if (!liveRecord) {
				await removeTeammateMember(ctx.cwd, activeTeamName, member.name);
				continue;
			}

			const selectedAgent = discovery.agents.find((agent) => agent.name === liveRecord.agentType);
			if (!selectedAgent) {
				return {
					content: [{ type: "text", text: `Team member "${member.name}" refers to unavailable agent type "${liveRecord.agentType}".` }],
					details: { to: target, agentType: liveRecord.agentType, delivery: "queued", teamName: activeTeamName },
					isError: true,
				};
			}
			await runtimeManager.sendMessage({
				kind: "teammate",
				teamName: activeTeamName,
				color: liveRecord.color,
				name: liveRecord.name,
				agent: selectedAgent,
				message: messageText,
				summary,
				defaultCwd: ctx.cwd,
				requestedCwd: liveRecord.cwd,
				modelRegistry: ctx.modelRegistry,
				currentModel: ctx.model,
				modelOverride: liveRecord.model,
				persisted: liveRecord,
				customTools: buildTeammateRuntimeCustomTools({
					cwd: ctx.cwd,
					teamName: activeTeamName,
					actingAgentName: liveRecord.name,
					runtimeContext: { modelRegistry: ctx.modelRegistry, currentModel: ctx.model },
				}),
			});
			recipients.push(liveRecord.name);
		}

		if (recipients.length === 0) {
			return {
				content: [{ type: "text", text: `Team "${activeTeamName}" has no live teammates in this Pi session. Relaunch them with Agent(team_name + name) first.` }],
				details: { to: target, agentType: "team", delivery: "queued", teamName: activeTeamName, recipients: [] },
				isError: true,
			};
		}

		return {
			content: [{
				type: "text",
				text: `Broadcast delivered to ${recipients.length} teammate(s) in team "${activeTeamName}".`,
			}],
			details: { to: target, agentType: "team", delivery: "queued", teamName: activeTeamName, recipients },
		};
	}

	if (activeTeamName && activeTeam && activeTeam.members[target]) {
		const member = activeTeam.members[target];
		const liveRecord = runtimeManager.get(target, { kind: "teammate", teamName: activeTeamName });
		const detachedTeammateTask = getDetachedManagedRuntimeTask(target, "teammate", activeTeamName);
		if (!liveRecord) {
			if (detachedTeammateTask?.status === "running") {
				const pendingCount = await queueDetachedBackgroundMessage({
					cwd: ctx.cwd,
					name: target,
					kind: "teammate",
					teamName: activeTeamName,
					message: messageText,
					summary,
				});
				return {
					content: [{ type: "text", text: `Message queued for detached teammate "${target}". Pending messages: ${pendingCount}.` }],
					details: { to: target, agentType: member.agentType, delivery: "queued", kind: "teammate", teamName: activeTeamName, pendingCount },
				};
			}
			if (detachedTeammateTask) {
				const selectedAgent = discovery.agents.find((agent) => agent.name === member.agentType);
				if (!selectedAgent) {
					return {
						content: [{ type: "text", text: `Teammate "${target}" refers to unavailable agent type "${member.agentType}".` }],
						details: { to: target, agentType: member.agentType, delivery: "queued", kind: "teammate", teamName: activeTeamName },
						isError: true,
					};
				}
				const relaunched = await launchDetachedBackgroundRun({
					cwd: ctx.cwd,
					getSessionDir: getNamedAgentSessionDir,
					name: target,
					kind: "teammate",
					teamName: activeTeamName,
					agent: selectedAgent,
					task: messageText,
					description: summary ?? `Follow-up for ${target}`,
					currentModel: currentModelLabel,
					modelOverride: member.model,
					permissions: {
						...(member.allowedTools ? { allowedTools: member.allowedTools } : {}),
						...(member.disallowedTools ? { disallowedTools: member.disallowedTools } : {}),
						...(member.allowedDirectories ? { allowedDirectories: member.allowedDirectories } : {}),
						...(member.allowedSkills ? { allowedSkills: member.allowedSkills } : {}),
						...(member.disallowedSkills ? { disallowedSkills: member.disallowedSkills } : {}),
						...(member.permissionMode ? { permissionMode: member.permissionMode } : {}),
					},
					persisted: toManagedTeammateRecord(activeTeamName, member),
					managedPlanModeInitialReason: member.permissionMode === "plan" ? member.lastDescription : undefined,
					managedTaskRegistry,
				});
				await saveTeamRecord(ctx.cwd, upsertTeamMember(activeTeam, toTeamMemberRecord(relaunched)));
				return {
					content: [{ type: "text", text: `Detached teammate "${target}" was ${detachedTeammateTask.status}; relaunched with your message.` }],
					details: { to: target, agentType: member.agentType, delivery: "resumed", kind: "teammate", teamName: activeTeamName, previousStatus: detachedTeammateTask.status },
				};
			}
			await removeTeammateMember(ctx.cwd, activeTeamName, target);
			return {
				content: [{ type: "text", text: `Teammate "${target}" is not live in this Pi session anymore. Launch it again with Agent(team_name + name) before using SendMessage.` }],
				details: { to: target, agentType: member.agentType, delivery: "queued", kind: "teammate", teamName: activeTeamName },
				isError: true,
			};
		}

		if (shutdownRequest) {
			await stopManagedRuntime(target, { kind: "teammate", teamName: activeTeamName });
			return {
				content: [{ type: "text", text: `Shutdown requested for teammate "${target}".` }],
				details: { to: target, agentType: liveRecord.agentType, delivery: "stopped", kind: "teammate", teamName: activeTeamName, previousStatus: liveRecord.status, requestId: shutdownRequest.request_id, messageType: shutdownRequest.type },
			};
		}

		const selectedAgent = discovery.agents.find((agent) => agent.name === liveRecord.agentType);
		if (!selectedAgent) {
			return {
				content: [{ type: "text", text: `Teammate "${target}" refers to unavailable agent type "${liveRecord.agentType}".` }],
				details: { to: target, agentType: liveRecord.agentType, delivery: "queued", kind: "teammate", teamName: activeTeamName },
				isError: true,
			};
		}

		try {
			const delivery = await runtimeManager.sendMessage({
				kind: "teammate",
				teamName: activeTeamName,
				color: liveRecord.color,
				name: target,
				agent: selectedAgent,
				message: messageText,
				summary,
				defaultCwd: ctx.cwd,
				requestedCwd: liveRecord.cwd,
				modelRegistry: ctx.modelRegistry,
				currentModel: ctx.model,
				modelOverride: liveRecord.model,
				persisted: liveRecord,
				customTools: buildTeammateRuntimeCustomTools({
					cwd: ctx.cwd,
					teamName: activeTeamName,
					actingAgentName: liveRecord.name,
					runtimeContext: { modelRegistry: ctx.modelRegistry, currentModel: ctx.model },
				}),
			});

			if (delivery.delivery === "queued") {
				const pendingSuffix = delivery.pendingCount ? ` Pending messages: ${delivery.pendingCount}.` : "";
				return {
					content: [{ type: "text", text: `Message queued for teammate "${target}".${pendingSuffix}` }],
					details: { to: target, agentType: selectedAgent.name, delivery: "queued", kind: "teammate", teamName: activeTeamName, ...(delivery.pendingCount ? { pendingCount: delivery.pendingCount } : {}) },
				};
			}

			return {
				content: [{ type: "text", text: `Teammate "${target}" was ${delivery.previousStatus ?? "idle"}; resumed it in the background with your message.` }],
				details: { to: target, agentType: selectedAgent.name, delivery: "resumed", kind: "teammate", teamName: activeTeamName, previousStatus: delivery.previousStatus },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: `SendMessage failed: ${message}` }],
				details: { to: target, agentType: liveRecord.agentType, delivery: "queued", kind: "teammate", teamName: activeTeamName },
				isError: true,
			};
		}
	}

	const namedRecord = runtimeManager.get(target, { kind: "subagent" }) ?? namedAgentState.agents[target];
	if (!namedRecord) {
		return {
			content: [{ type: "text", text: `Unknown named agent "${target}".` }],
			details: { to: target, agentType: "unknown", delivery: "queued" },
			isError: true,
		};
	}

	if (shutdownRequest) {
		await stopManagedRuntime(target, { kind: "subagent" });
		return {
			content: [{ type: "text", text: `Shutdown requested for agent "${target}".` }],
			details: { to: target, agentType: namedRecord.agentType, delivery: "stopped", kind: "subagent", previousStatus: namedRecord.status, requestId: shutdownRequest.request_id, messageType: shutdownRequest.type },
		};
	}

	const selectedAgent = discovery.agents.find((agent) => agent.name === namedRecord.agentType);
	if (!selectedAgent) {
		return {
			content: [{
				type: "text",
				text: `Named agent "${target}" is bound to agent type "${namedRecord.agentType}", but that agent definition is not currently available.`,
			}],
			details: { to: target, agentType: namedRecord.agentType, delivery: "queued", kind: "subagent" },
			isError: true,
		};
	}

	const detachedSubagentTask = getDetachedManagedSubagentTask(target);
	if (!runtimeManager.get(target, { kind: "subagent" }) && detachedSubagentTask?.status === "running") {
		const pendingCount = await queueDetachedBackgroundMessage({
			cwd: ctx.cwd,
			name: target,
			kind: "subagent",
			message: messageText,
			summary,
		});
		return {
			content: [{ type: "text", text: `Message queued for detached background agent "${target}". Pending messages: ${pendingCount}.` }],
			details: { to: target, agentType: namedRecord.agentType, delivery: "queued", kind: "subagent", pendingCount },
		};
	}

	if (!runtimeManager.get(target, { kind: "subagent" }) && detachedSubagentTask && detachedSubagentTask.status !== "running") {
		const resumed = await launchDetachedBackgroundRun({
			cwd: ctx.cwd,
			getSessionDir: getNamedAgentSessionDir,
			name: target,
			kind: "subagent",
			agent: selectedAgent,
			task: messageText,
			description: summary ?? `Follow-up for ${target}`,
			currentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			modelOverride: namedRecord.model,
			permissions: {
				...(namedRecord.allowedTools ? { allowedTools: namedRecord.allowedTools } : {}),
				...(namedRecord.disallowedTools ? { disallowedTools: namedRecord.disallowedTools } : {}),
				...(namedRecord.allowedDirectories ? { allowedDirectories: namedRecord.allowedDirectories } : {}),
				...(namedRecord.allowedSkills ? { allowedSkills: namedRecord.allowedSkills } : {}),
				...(namedRecord.disallowedSkills ? { disallowedSkills: namedRecord.disallowedSkills } : {}),
				...(namedRecord.permissionMode ? { permissionMode: namedRecord.permissionMode } : {}),
			},
			persisted: namedRecord,
			managedPlanModeInitialReason: namedRecord.permissionMode === "plan" ? namedRecord.lastDescription : undefined,
			managedTaskRegistry,
		});
		namedAgentState = {
			...namedAgentState,
			agents: {
				...namedAgentState.agents,
				[target]: resumed,
			},
		};
		await persistNamedAgentState();
		return {
			content: [{ type: "text", text: `Detached background agent "${target}" was ${detachedSubagentTask.status}; relaunched with your follow-up message.` }],
			details: { to: target, agentType: namedRecord.agentType, delivery: "resumed", kind: "subagent", previousStatus: detachedSubagentTask.status },
		};
	}

	try {
		const delivery = await runtimeManager.sendMessage({
			kind: "subagent",
			name: target,
			agent: selectedAgent,
			message: messageText,
			summary,
			defaultCwd: ctx.cwd,
			requestedCwd: namedRecord.cwd,
			modelRegistry: ctx.modelRegistry,
			currentModel: ctx.model,
			modelOverride: namedRecord.model,
			persisted: namedRecord,
			customTools: buildNamedSubagentRuntimeCustomTools({
				cwd: ctx.cwd,
				actingAgentName: target,
				runtimeContext: { modelRegistry: ctx.modelRegistry, currentModel: ctx.model },
			}),
		});

		if (delivery.delivery === "queued") {
			const pendingSuffix = delivery.pendingCount ? ` Pending messages: ${delivery.pendingCount}.` : "";
			return {
				content: [{ type: "text", text: `Message queued for delivery to "${target}" at its next tool round.${pendingSuffix}` }],
				details: { to: target, agentType: selectedAgent.name, delivery: "queued", kind: "subagent", ...(delivery.pendingCount ? { pendingCount: delivery.pendingCount } : {}) },
			};
		}

		return {
			content: [{ type: "text", text: `Agent "${target}" was ${delivery.previousStatus ?? "idle"}; resumed it in the background with your message. You'll be notified when it finishes.` }],
			details: { to: target, agentType: selectedAgent.name, delivery: "resumed", kind: "subagent", previousStatus: delivery.previousStatus },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `SendMessage failed: ${message}` }],
			details: { to: target, agentType: namedRecord.agentType, delivery: "queued", kind: "subagent" },
			isError: true,
		};
	}
}

async function executeClaudeAgentTool(
	params: ClaudeAgentParams,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentDetails>> {
	const agentScope: AgentScope = "both";
	const discovery = discoverAgents(ctx.cwd, agentScope);
	const agents = discovery.agents;
	const makeDetails = (results: SingleResult[]): SubagentDetails => ({
		mode: "single",
		agentScope,
		projectAgentsDir: discovery.projectAgentsDir,
		results,
	});

	const logicalName = params.name?.trim() || undefined;
	const explicitTeamName = params.team_name?.trim() || undefined;
	const diskState = await loadNamedAgentStateFromDisk(ctx.cwd);
	if (Object.keys(diskState.agents).length > 0) {
		namedAgentState = diskState;
	}
	const diskTeamState = await loadActiveTeamState(ctx.cwd);
	if (diskTeamState.teamName) {
		activeTeamState = diskTeamState;
	}

	const subagentRecord = logicalName ? runtimeManager?.get(logicalName, { kind: "subagent" }) ?? namedAgentState.agents[logicalName] : undefined;
	if (subagentRecord && params.subagent_type?.trim() && params.subagent_type.trim() !== subagentRecord.agentType) {
		return {
			content: [{ type: "text", text: `Named agent "${logicalName}" is already bound to agent type "${subagentRecord.agentType}". Use the same subagent_type or choose a different name.` }],
			details: makeDetails([]),
			isError: true,
		};
	}

	const agentName = params.subagent_type?.trim() || subagentRecord?.agentType || "general-purpose";
	const selectedAgent = agents.find((agent) => agent.name === agentName);
	if (!selectedAgent) {
		const available = agents.map((agent) => agent.name).join(", ") || "none";
		return {
			content: [{ type: "text", text: `Unknown agent type "${agentName}". Available agents: ${available}` }],
			details: makeDetails([]),
			isError: true,
		};
	}

	if (selectedAgent.source === "project" && ctx.hasUI) {
		const dir = discovery.projectAgentsDir ?? "(unknown)";
		const ok = await ctx.ui.confirm(
			"Run project-local agent?",
			`Agent: ${selectedAgent.name}
Source: ${dir}

Project agents are repo-controlled. Only continue for trusted repositories.`,
		);
		if (!ok) {
			return {
				content: [{ type: "text", text: "Canceled: project-local agent not approved." }],
				details: makeDetails([]),
			};
		}
	}

	const requestedPermissionModeRaw = params.mode?.trim();
	const requestedPermissionMode = requestedPermissionModeRaw ? parseAgentPermissionMode(requestedPermissionModeRaw) : undefined;
	if (requestedPermissionModeRaw && !requestedPermissionMode) {
		return {
			content: [{ type: "text", text: `Unknown permission mode "${requestedPermissionModeRaw}".` }],
			details: makeDetails([]),
			isError: true,
		};
	}
	const effectiveAgent = requestedPermissionMode ? { ...selectedAgent, permissionMode: requestedPermissionMode } : selectedAgent;
	const modelOverride = params.model?.trim() || undefined;
	const currentModelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const requestedCwd = params.cwd?.trim() || undefined;
	const effectiveCwdForPermissions = requestedCwd ?? ctx.cwd;
	let permissionConfig = mergePermissionConfig(effectiveAgent, {
		allowedTools: params.allowed_tools,
		disallowedTools: params.disallowed_tools,
		allowedDirectories: params.allowed_directories,
		allowedSkills: params.allowed_skills,
		disallowedSkills: params.disallowed_skills,
	});
	if (effectiveAgent.memory && permissionConfig.allowedDirectories) {
		const memoryDir = getAgentMemoryDir(path.resolve(effectiveCwdForPermissions), effectiveAgent.name, effectiveAgent.memory);
		permissionConfig = {
			...permissionConfig,
			allowedDirectories: [...new Set([...permissionConfig.allowedDirectories, memoryDir])],
		};
	}
	const runtimeProfile = ManagedRuntimeProfile.fromAgent(effectiveAgent, permissionConfig);
	const allowedDirectories = resolveAllowedDirectories(effectiveCwdForPermissions, permissionConfig);
	if (requestedCwd && allowedDirectories && !allowedDirectories.some((dir) => {
		const resolvedRequested = path.resolve(requestedCwd);
		const resolvedDir = path.resolve(dir);
		return resolvedRequested === resolvedDir || resolvedRequested.startsWith(`${resolvedDir}${path.sep}`);
	})) {
		return {
			content: [{ type: "text", text: `Requested cwd \"${requestedCwd}\" is outside the agent's allowed_directories profile.` }],
			details: makeDetails([]),
			isError: true,
		};
	}
	const effectiveBackground = params.run_in_background === true || effectiveAgent.background === true;
	if (effectiveAgent.permissionMode === "plan" && !logicalName) {
		return {
			content: [{ type: "text", text: "Agents with permissionMode=plan currently require name so the managed child runtime can request approval and later resume execution." }],
			details: makeDetails([]),
			isError: true,
		};
	}
	if (effectiveAgent.isolation) {
		return {
			content: [{ type: "text", text: `Agent isolation "${effectiveAgent.isolation}" is declared for "${effectiveAgent.name}", but pi-claude-subagent does not support isolated runtimes yet.` }],
			details: makeDetails([]),
			isError: true,
		};
	}
	if ((effectiveAgent.mcpServers && effectiveAgent.mcpServers.length > 0) || (effectiveAgent.requiredMcpServers && effectiveAgent.requiredMcpServers.length > 0)) {
		return {
			content: [{ type: "text", text: `Agent-level MCP server requirements are declared for "${effectiveAgent.name}", but launch-time MCP provisioning is not implemented yet in pi-claude-subagent.` }],
			details: makeDetails([]),
			isError: true,
		};
	}

	if (explicitTeamName) {
		if (!logicalName) {
			return {
				content: [{ type: "text", text: "team_name requires name so the teammate can be addressed later." }],
				details: makeDetails([]),
				isError: true,
			};
		}

		const team = await loadTeamRecord(ctx.cwd, explicitTeamName);
		if (!team) {
			return {
				content: [{ type: "text", text: `Team "${explicitTeamName}" does not exist yet. Use TeamCreate first.` }],
				details: makeDetails([]),
				isError: true,
			};
		}
		activeTeamState = { teamName: team.name };
		await persistActiveTeamState();

		const liveTeammate = runtimeManager?.get(logicalName, { kind: "teammate", teamName: team.name });
		if (!liveTeammate && team.members[logicalName] && !getDetachedManagedRuntimeTask(logicalName, "teammate", team.name)) {
			await removeTeammateMember(ctx.cwd, team.name, logicalName);
		}

		const persistedTeammate = liveTeammate;
		if (persistedTeammate && requestedCwd && requestedCwd !== persistedTeammate.cwd) {
			return {
				content: [{ type: "text", text: `Teammate "${logicalName}" is already bound to cwd "${persistedTeammate.cwd}". Use the same cwd or choose a different name.` }],
				details: makeDetails([]),
				isError: true,
			};
		}
		if (persistedTeammate) {
			if (!runtimeProfile.matchesRecord(persistedTeammate)) {
				return {
					content: [{ type: "text", text: `Teammate "${logicalName}" is already bound to a different runtime profile. Use the same profile or choose a different name.` }],
					details: makeDetails([]),
					isError: true,
				};
			}
		}

		if (!runtimeManager) {
			throw new Error("Agent runtime manager is not initialized.");
		}

		if (supportsDetachedBackgroundRun({ kind: "teammate", teamName: team.name })) {
			const launched = await launchDetachedBackgroundRun({
				cwd: ctx.cwd,
				getSessionDir: getNamedAgentSessionDir,
				name: logicalName,
				kind: "teammate",
				teamName: team.name,
				agent: effectiveAgent,
				task: params.prompt,
				description: params.description,
				currentModel: currentModelLabel,
				modelOverride: modelOverride ?? persistedTeammate?.model,
				permissions: permissionConfig,
				persisted: persistedTeammate,
				managedPlanModeInitialReason: effectiveAgent.permissionMode === "plan" ? params.description : undefined,
				managedTaskRegistry,
			});
			await saveTeamRecord(ctx.cwd, upsertTeamMember(team, toTeamMemberRecord(launched)));
			return {
				content: [{ type: "text", text: `Detached teammate "${logicalName}" launched in team "${team.name}". It can continue after this Pi process exits.` }],
				details: makeDetails([makeBackgroundLaunchResult(launched, effectiveAgent, params.prompt)]),
			};
		}

		const launched = await runtimeManager.launchBackground({
			kind: "teammate",
			teamName: team.name,
			autoClaimTasks: true,
			allowedTools: permissionConfig.allowedTools,
			disallowedTools: permissionConfig.disallowedTools,
			allowedDirectories: permissionConfig.allowedDirectories,
			allowedSkills: permissionConfig.allowedSkills,
			disallowedSkills: permissionConfig.disallowedSkills,
			color: effectiveAgent.color,
			name: logicalName,
			agent: effectiveAgent,
			task: params.prompt,
			description: params.description,
			defaultCwd: ctx.cwd,
			requestedCwd: persistedTeammate?.cwd ?? requestedCwd,
			modelRegistry: ctx.modelRegistry,
			currentModel: ctx.model,
			modelOverride: modelOverride ?? persistedTeammate?.model,
			persisted: persistedTeammate,
			managedPlanMode: effectiveAgent.permissionMode === "plan"
				? createManagedPlanModeBridge({
					name: logicalName,
					kind: "teammate",
					teamName: team.name,
					reason: params.description,
				})
				: undefined,
			customTools: buildTeammateRuntimeCustomTools({
				cwd: ctx.cwd,
				teamName: team.name,
				actingAgentName: logicalName,
				runtimeContext: { modelRegistry: ctx.modelRegistry, currentModel: ctx.model },
			}),
		});

		return {
			content: [{ type: "text", text: `Teammate "${logicalName}" launched in team "${team.name}". You'll be notified when it completes.` }],
			details: makeDetails([makeBackgroundLaunchResult(launched, effectiveAgent, params.prompt)]),
		};
	}

	if (effectiveBackground && !logicalName) {
		return {
			content: [{ type: "text", text: "Background Agent calls currently require name so the child runtime can be tracked and resumed." }],
			details: makeDetails([]),
			isError: true,
		};
	}

	if (subagentRecord && requestedCwd && requestedCwd !== subagentRecord.cwd) {
		return {
			content: [{ type: "text", text: `Named agent "${logicalName}" is already bound to cwd "${subagentRecord.cwd}". Use the same cwd or choose a different name.` }],
			details: makeDetails([]),
			isError: true,
		};
	}
	if (subagentRecord) {
		if (!runtimeProfile.matchesRecord(subagentRecord)) {
			return {
				content: [{ type: "text", text: `Named agent "${logicalName}" is already bound to a different runtime profile. Use the same profile or choose a different name.` }],
				details: makeDetails([]),
				isError: true,
			};
		}
	}

	const executionCwd = subagentRecord?.cwd ?? requestedCwd ?? ctx.cwd;

	try {
		if (logicalName) {
			if (!runtimeManager) {
				throw new Error("Agent runtime manager is not initialized.");
			}

			if (effectiveBackground) {
				if (supportsDetachedBackgroundRun({
					kind: "subagent",
				})) {
					const launched = await launchDetachedBackgroundRun({
						cwd: ctx.cwd,
						getSessionDir: getNamedAgentSessionDir,
						name: logicalName,
						kind: "subagent",
						agent: effectiveAgent,
						task: params.prompt,
						description: params.description,
						currentModel: currentModelLabel,
						modelOverride,
						permissions: permissionConfig,
						persisted: subagentRecord,
						managedPlanModeInitialReason: effectiveAgent.permissionMode === "plan" ? params.description : undefined,
						managedTaskRegistry,
					});
					namedAgentState = {
						...namedAgentState,
						agents: {
							...namedAgentState.agents,
							[logicalName]: launched,
						},
					};
					await persistNamedAgentState();
					return {
						content: [{ type: "text", text: `Detached background agent "${logicalName}" launched. It can continue after this Pi process exits.` }],
						details: makeDetails([makeBackgroundLaunchResult(launched, effectiveAgent, params.prompt)]),
					};
				}
				const launched = await runtimeManager.launchBackground({
					kind: "subagent",
					name: logicalName,
					allowedTools: permissionConfig.allowedTools,
					disallowedTools: permissionConfig.disallowedTools,
					allowedDirectories: permissionConfig.allowedDirectories,
					allowedSkills: permissionConfig.allowedSkills,
					disallowedSkills: permissionConfig.disallowedSkills,
					agent: effectiveAgent,
					task: params.prompt,
					description: params.description,
					defaultCwd: ctx.cwd,
					requestedCwd,
					modelRegistry: ctx.modelRegistry,
					currentModel: ctx.model,
				modelOverride,
				persisted: subagentRecord,
				managedPlanMode: effectiveAgent.permissionMode === "plan"
					? createManagedPlanModeBridge({
						name: logicalName,
						kind: "subagent",
						reason: params.description,
					})
					: undefined,
				customTools: buildNamedSubagentRuntimeCustomTools({
					cwd: ctx.cwd,
						actingAgentName: logicalName,
						runtimeContext: { modelRegistry: ctx.modelRegistry, currentModel: ctx.model },
					}),
				});
				return {
					content: [{ type: "text", text: `Background agent "${logicalName}" launched. You'll be notified when it completes.` }],
					details: makeDetails([makeBackgroundLaunchResult(launched, effectiveAgent, params.prompt)]),
				};
			}

			const result = await runtimeManager.runForeground({
				kind: "subagent",
				name: logicalName,
				allowedTools: permissionConfig.allowedTools,
				disallowedTools: permissionConfig.disallowedTools,
				allowedDirectories: permissionConfig.allowedDirectories,
				allowedSkills: permissionConfig.allowedSkills,
				disallowedSkills: permissionConfig.disallowedSkills,
				agent: effectiveAgent,
				task: params.prompt,
				description: params.description,
				defaultCwd: ctx.cwd,
				requestedCwd,
				modelRegistry: ctx.modelRegistry,
				currentModel: ctx.model,
				modelOverride,
				signal,
				persisted: subagentRecord,
				managedPlanMode: effectiveAgent.permissionMode === "plan"
					? createManagedPlanModeBridge({
						name: logicalName,
						kind: "subagent",
						reason: params.description,
					})
					: undefined,
				customTools: buildNamedSubagentRuntimeCustomTools({
					cwd: ctx.cwd,
					actingAgentName: logicalName,
					runtimeContext: { modelRegistry: ctx.modelRegistry, currentModel: ctx.model },
				}),
				onUpdate: (partial) => {
					onUpdate?.({
						content: [{ type: "text", text: getFinalOutput(partial.messages) || "(running...)" }],
						details: makeDetails([partial]),
					});
				},
			});

			const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
			if (isError) {
				const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
				return {
					content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
					details: makeDetails([result]),
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
				details: makeDetails([result]),
			};
		}

		const result = await runSdkSingleAgent({
			defaultCwd: executionCwd,
			agent: effectiveAgent,
			task: params.prompt,
			permissions: permissionConfig,
			modelRegistry: ctx.modelRegistry,
			currentModel: ctx.model,
			modelOverride,
			signal,
			onUpdate: (partial) => {
				onUpdate?.({
					content: [{ type: "text", text: getFinalOutput(partial.messages) || "(running...)" }],
					details: makeDetails([partial]),
				});
			},
		});

		const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
		if (isError) {
			const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
			return {
				content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
				details: makeDetails([result]),
				isError: true,
			};
		}

		return {
			content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
			details: makeDetails([result]),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Agent failed: ${message}` }],
			details: makeDetails([]),
			isError: true,
		};
	}
}

export default function (pi: ExtensionAPI) {
	persistNamedAgentStateImpl = () => {
		pi.appendEntry(NAMED_AGENT_STATE_ENTRY, namedAgentState);
	};
	piActiveTeamStateAppend = (state) => {
		pi.appendEntry(ACTIVE_TEAM_STATE_ENTRY, state);
	};
	runtimeManager = new AgentRuntimeManager({
		getSessionDir: getNamedAgentSessionDir,
		hooks: {
			onStateChange: async (record) => {
				const taskEntry = managedTaskRegistry ? await managedTaskRegistry.upsertFromRecord(record) : undefined;
				if (taskEntry) {
					pi.events.emit("claude-subagent:managed-task-changed", { ...taskEntry });
				}
			if (record.kind === "teammate") {
				await persistTeammateRecord(record);
				pi.events.emit("claude-subagent:teammates-changed", { ...record });
				if (record.status === "running" || record.autoClaimTasks !== true) {
					clearTeammateAutoClaimPoller(record.name, record.teamName);
					} else if (record.status === "completed" || record.status === "idle") {
						scheduleTeammateAutoClaim(record);
					} else {
						clearTeammateAutoClaimPoller(record.name, record.teamName);
					}
					return;
				}
				upsertNamedAgentRecord(record);
				await persistNamedAgentState();
			},
			onTerminal: async ({ record, result, wasBackground }) => {
				const taskEntry = managedTaskRegistry ? await managedTaskRegistry.noteTerminal({ record, result, wasBackground }) : undefined;
				if (taskEntry) {
					pi.events.emit("claude-subagent:managed-task-changed", { ...taskEntry });
				}
				let inferredTeamName = record.teamName;
				if (!inferredTeamName && activeTeamState.teamName) {
					const activeTeam = await loadTeamRecord(sessionRootCwd, activeTeamState.teamName);
					if (activeTeam?.members[record.name]) {
						inferredTeamName = activeTeamState.teamName;
					}
				}
				if (!inferredTeamName) {
					try {
						const entries = await fs.promises.readdir(getTeamsDir(sessionRootCwd));
						for (const entry of entries) {
							if (!entry.endsWith('.json')) continue;
							const teamName = entry.slice(0, -5);
							const team = await loadTeamRecord(sessionRootCwd, teamName);
							if (team?.members[record.name]) {
								inferredTeamName = team.name;
								break;
							}
						}
					} catch {
						// Ignore missing team directory during notification formatting.
					}
				}
				if (inferredTeamName && record.kind === "teammate" && (record.status === "failed" || record.status === "interrupted")) {
					try {
						await removeTeammateMember(sessionRootCwd, inferredTeamName, record.name);
					} catch {
						// Keep runtime termination notifications best-effort if task reclamation fails.
					}
				}
				const details: BackgroundAgentNotification = {
					name: record.name,
					agentType: record.agentType,
					cwd: record.cwd,
					kind: record.kind ?? (inferredTeamName ? "teammate" : "subagent"),
					...(inferredTeamName ? { teamName: inferredTeamName } : {}),
					model: record.model,
					description: record.lastDescription,
					status: record.status === "completed" ? "completed" : record.status === "failed" ? "failed" : "interrupted",
					sessionFile: record.sessionFile,
					startedAt: record.lastStartedAt,
					completedAt: record.lastCompletedAt,
					resultText: record.lastResultText,
					error: record.lastError,
				};
				pi.sendMessage(
					{
						customType: BACKGROUND_AGENT_MESSAGE,
						content: formatBackgroundNotification(details),
						display: true,
						details,
					},
					{
						deliverAs: "followUp",
						triggerTurn: true,
					},
				);
			},
		},
	});
	const managedRuntimeCoordinator: ManagedRuntimeCoordinatorLike = {
		get(name, options) {
			const live = runtimeManager?.get(name, options);
			if (live) return live;
			const detached = getDetachedManagedRuntimeTask(name, options?.kind ?? "subagent", options?.teamName);
			return detached ? toDetachedManagedRecord(detached) : undefined;
		},
		list() {
			const liveRecords = runtimeManager?.list() ?? [];
			const liveKeys = new Set(liveRecords.map((record) => getManagedTaskIdForNamedRuntime(record.name, record.kind ?? "subagent", record.teamName)));
			const detachedRecords = (managedTaskRegistry?.list() ?? [])
				.filter((task) => task.detached === true)
				.filter((task) => !liveKeys.has(task.taskId))
				.map((task) => toDetachedManagedRecord(task))
				.filter((record): record is NamedAgentRecord => Boolean(record));
			return [...liveRecords, ...detachedRecords];
		},
		async abort(name, options) {
			return stopManagedRuntime(name, { kind: options?.kind, teamName: options?.teamName });
		},
		async launchBackground(input) {
			if (supportsDetachedBackgroundRun({ kind: input.kind, teamName: input.teamName })) {
				const launched = await launchDetachedBackgroundRun({
					cwd: input.defaultCwd,
					getSessionDir: getNamedAgentSessionDir,
					name: input.name,
					kind: input.kind,
					teamName: input.teamName,
					agent: input.agent,
					task: input.task,
					description: input.description,
					currentModel: input.currentModel ? `${input.currentModel.provider}/${input.currentModel.id}` : undefined,
					modelOverride: input.modelOverride,
					permissions: {
						...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
						...(input.disallowedTools ? { disallowedTools: input.disallowedTools } : {}),
						...(input.allowedDirectories ? { allowedDirectories: input.allowedDirectories } : {}),
						...(input.allowedSkills ? { allowedSkills: input.allowedSkills } : {}),
						...(input.disallowedSkills ? { disallowedSkills: input.disallowedSkills } : {}),
						...(input.agent.permissionMode ? { permissionMode: input.agent.permissionMode } : {}),
					},
					persisted: input.persisted,
					managedPlanModeInitialReason: input.agent.permissionMode === "plan" ? input.description : undefined,
					managedTaskRegistry,
				});
				await persistDetachedLaunchRecord(launched);
				return launched;
			}
			if (!runtimeManager) {
				throw new Error("Agent runtime manager is not initialized.");
			}
			return runtimeManager.launchBackground(input);
		},
		async sendMessage(input) {
			const live = runtimeManager?.get(input.name, { kind: input.kind, teamName: input.teamName });
			if (live && runtimeManager) {
				return runtimeManager.sendMessage(input);
			}
			const detached = getDetachedManagedRuntimeTask(input.name, input.kind ?? "subagent", input.teamName);
			if (!detached) {
				throw new Error(`Managed runtime \"${input.name}\" is not active.`);
			}
			if (detached.status === "running") {
				const pendingCount = await queueDetachedBackgroundMessage({
					cwd: input.defaultCwd,
					name: input.name,
					kind: input.kind,
					teamName: input.teamName,
					message: input.message,
					summary: input.summary,
				});
				return {
					delivery: "queued",
					record: toDetachedManagedRecord(detached) ?? input.persisted,
					pendingCount,
				};
			}
			const relaunched = await launchDetachedBackgroundRun({
				cwd: input.defaultCwd,
				getSessionDir: getNamedAgentSessionDir,
				name: input.name,
				kind: input.kind,
				teamName: input.teamName,
				agent: input.agent,
				task: input.message,
				description: input.summary ?? `Follow-up for ${input.name}`,
				currentModel: input.currentModel ? `${input.currentModel.provider}/${input.currentModel.id}` : undefined,
				modelOverride: input.modelOverride,
				permissions: {
					...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
					...(input.disallowedTools ? { disallowedTools: input.disallowedTools } : {}),
					...(input.allowedDirectories ? { allowedDirectories: input.allowedDirectories } : {}),
					...(input.allowedSkills ? { allowedSkills: input.allowedSkills } : {}),
					...(input.disallowedSkills ? { disallowedSkills: input.disallowedSkills } : {}),
					...(input.agent.permissionMode ? { permissionMode: input.agent.permissionMode } : {}),
				},
				persisted: input.persisted,
				managedPlanModeInitialReason: input.agent.permissionMode === "plan" ? input.summary : undefined,
				managedTaskRegistry,
			});
			await persistDetachedLaunchRecord(relaunched);
			return {
				delivery: "resumed",
				record: relaunched,
				previousStatus: detached.status,
			};
		},
	};
	managedTaskRegistry = new ManagedTaskRegistry(sessionRootCwd);
	notifyLeadFromChildRuntime = (payload) => {
		pi.sendMessage(
			{
				content: formatChildLeadMessage(payload),
				display: true,
			},
			{
				deliverAs: "followUp",
				triggerTurn: true,
			},
		);
	};
	setSharedAgentRuntimeManager(runtimeManager);
	setSharedManagedRuntimeCoordinator(managedRuntimeCoordinator);
	setSharedManagedTaskRegistry(managedTaskRegistry);
	setSharedChildRuntimeToolBuilder(buildChildSendMessageBridgeTools);

	pi.on("resources_discover", () => ({
		promptPaths: getBundledPromptPaths(),
	}));

	pi.registerMessageRenderer(BACKGROUND_AGENT_MESSAGE, (message, options, theme) =>
		renderBackgroundNotification(message, options, theme),
	);

	pi.on("session_start", async (_event, ctx) => {
		sessionRootCwd = ctx.cwd;
		managedTaskRegistry = new ManagedTaskRegistry(ctx.cwd);
		await managedTaskRegistry.load();
		await managedTaskRegistry.markRunningTasksInterrupted(INTERRUPTED_BACKGROUND_MESSAGE, {
			keepRunning: (task) => task.detached === true,
		});
		setSharedManagedTaskRegistry(managedTaskRegistry);
		const sessionState = restoreNamedAgentState(ctx);
		const diskState = await loadNamedAgentStateFromDiskFile(ctx.cwd);
		namedAgentState = Object.keys(diskState.agents).length > 0 ? diskState : sessionState;
		namedAgentState = markNamedAgentStateInterrupted(namedAgentState, INTERRUPTED_BACKGROUND_MESSAGE, {
		keepRunning: (record) => isDetachedManagedRuntimeRunning(record.name, record.kind ?? "subagent", record.teamName),
		});
		await prunePersistedTeammates(ctx.cwd);

		const sessionTeamState = restoreActiveTeamState(ctx);
		const diskTeamState = await loadActiveTeamState(ctx.cwd);
		activeTeamState = diskTeamState.teamName ? diskTeamState : sessionTeamState;

		await persistNamedAgentState();
		await persistActiveTeamState();
		await pollDetachedOutboxEvents(pi);
		startDetachedOutboxPoller(pi);
	});

	pi.on("session_shutdown", async () => {
		clearAllTeammateAutoClaimPollers();
		stopDetachedOutboxPoller();
		setSharedChildRuntimeToolBuilder(null);
		setSharedManagedRuntimeCoordinator(null);
		setSharedManagedTaskRegistry(null);
		notifyLeadFromChildRuntime = null;
		if (!runtimeManager) return;
		await runtimeManager.disposeAll(INTERRUPTED_BACKGROUND_MESSAGE);
		await prunePersistedTeammates(sessionRootCwd);
		setSharedAgentRuntimeManager(null);
	});

	pi.registerTool({
		name: "TeamCreate",
		label: "TeamCreate",
		description: "Create or activate a local Claude-style team context for teammate spawning and message routing.",
		promptSnippet: "Create or activate a local Claude-style team context.",
		promptGuidelines: [
			"Use TeamCreate before spawning teammates with Agent(team_name + name).",
			"A local active team context is also used by SendMessage broadcast routing.",
		],
		parameters: TeamCreateParamsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeTeamCreateTool(params as TeamCreateParams, ctx);
		},
		renderCall(args, theme) {
			return renderTeamCreateCall(args as TeamCreateParams, theme);
		},
		renderResult(result, options, theme) {
			return renderTeamCreateResult(result, options, theme);
		},
	});

	pi.registerTool({
		name: "TeamDelete",
		label: "TeamDelete",
		description: "Delete the active local Claude-style team after all running teammates have stopped.",
		promptSnippet: "Delete the active local Claude-style team and its shared task list.",
		promptGuidelines: [
			"Use TeamDelete when a local swarm is finished and you want to clean up its team/task state.",
			"Do not call TeamDelete while teammates are still running; stop them first.",
		],
		parameters: TeamDeleteParamsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeTeamDeleteTool(params as TeamDeleteParams, ctx);
		},
		renderCall(args, theme) {
			return renderTeamDeleteCall(args as TeamDeleteParams, theme);
		},
		renderResult(result, options, theme) {
			return renderTeamDeleteResult(result, options, theme);
		},
	});

	pi.registerTool({
		name: "Agent",
		label: "Agent",
		description: "Launch a Claude-style specialized agent for delegated work.",
		promptSnippet: "Launch a Claude-style specialized agent for delegated work.",
		promptGuidelines: [
			"Use Agent with subagent_type=Explore for read-only codebase recon.",
			"Use Agent with subagent_type=Plan for read-only implementation planning.",
			"If subagent_type is omitted, the package defaults to general-purpose.",
			"Use allowed_tools/disallowed_tools to shape which tools the child runtime may call.",
			"Use allowed_directories to confine file-based tools to specific directories. bash is blocked when directory restrictions are active.",
			"Use allowed_skills/disallowed_skills to control which skills are loaded into the child runtime.",
			"Use name for persistent continuation across Agent calls.",
			"run_in_background is supported for named agents and agents whose frontmatter sets background: true.",
			"Use SendMessage to deliver follow-up instructions to a named agent while it is running or to resume it in the background later.",
			"Use team_name together with name to spawn a local in-process teammate under an active or existing team.",
		],
		parameters: AgentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeClaudeAgentTool(params as ClaudeAgentParams, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			return renderAgentCall(args as ClaudeAgentParams, theme);
		},
		renderResult(result, options, theme) {
			return renderAgentResult(result, options, theme);
		},
	});

	pi.registerTool({
		name: "SendMessage",
		label: "SendMessage",
		description: "Send a follow-up message to a named managed agent or local teammate. Running agents queue the message; idle agents resume in the background. Structured protocol payloads such as shutdown_request are also supported.",
		promptSnippet: "Send a follow-up message or structured protocol payload to a named managed agent.",
		promptGuidelines: [
			"Use SendMessage with named agents previously launched through Agent.",
			"Use SendMessage with teammate names after creating a team and spawning teammates.",
			"If the target is still running, the message is queued into that live child session.",
			"If the target is idle or stopped, it resumes in the background and will notify on completion.",
			"Use to: '*' to broadcast a plain-text message to all teammates in the active local team.",
		],
		parameters: SendMessageParamsSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeSendMessageTool(params as SendMessageParams, signal, ctx);
		},
		renderCall(args, theme) {
			return renderSendMessageCall(args as SendMessageParams, theme);
		},
		renderResult(result, options, theme) {
			return renderSendMessageResult(result, options, theme);
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized Claude-style subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Bundled package agents are available out of the box; user agents from ~/.pi/agent/agents are also loaded by default.',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
					undefined,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError =
						result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg =
							result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
					undefined,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					undefined,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg =
						result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
