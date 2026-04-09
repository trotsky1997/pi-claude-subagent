import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	AuthStorage,
	ModelRegistry,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import {
	loadTeamRecord,
	saveTeamRecord,
	upsertTeamMember,
} from "pi-claude-runtime-core/team-state";
import { ManagedTaskRegistry } from "./managed-task-registry.js";
import type { AgentPermissionConfig } from "./agent-permissions.js";
import { appendDetachedOutboxEvent } from "./detached-background.js";
import {
	parseDetachedBackgroundPayload,
	parseDetachedControlMessage,
} from "./detached-background-schemas.js";
import { promptSdkAgentSession, createSdkAgentRuntime } from "./sdk-agent.js";
import { updateNamedAgentRecordStatusOnDisk } from "./named-agent-state.js";
import { buildClaudeTodoCustomTools } from "pi-claude-todo-v2/task-tools-bridge";

function getResultText(result: { messages: any[] }): string | undefined {
	for (let i = result.messages.length - 1; i >= 0; i -= 1) {
		const message = result.messages[i] as any;
		if (message?.role !== "assistant") continue;
		for (const part of message.content ?? []) {
			if (
				part?.type === "text" &&
				typeof part.text === "string" &&
				part.text.trim()
			) {
				return part.text;
			}
		}
	}
	return undefined;
}

function toTeamMemberRecord(record: {
	name: string;
	agentType: string;
	cwd: string;
	sessionFile?: string;
	sessionId?: string;
	model?: string;
	color?: string;
	status?: "idle" | "running" | "completed" | "failed" | "interrupted";
	lastDescription?: string;
	lastResultText?: string;
	lastError?: string;
	lastStartedAt?: string;
	lastCompletedAt?: string;
	permissionMode?: string;
	effort?: unknown;
	mcpServers?: unknown;
	requiredMcpServers?: string[];
	hooks?: Record<string, unknown>;
	isolation?: string;
	allowedTools?: string[];
	disallowedTools?: string[];
	allowedDirectories?: string[];
	allowedSkills?: string[];
	disallowedSkills?: string[];
}): any {
	return {
		name: record.name,
		agentType: record.agentType,
		cwd: record.cwd,
		joinedAt: record.lastStartedAt ?? new Date().toISOString(),
		...(record.allowedTools ? { allowedTools: record.allowedTools } : {}),
		...(record.disallowedTools
			? { disallowedTools: record.disallowedTools }
			: {}),
		...(record.allowedDirectories
			? { allowedDirectories: record.allowedDirectories }
			: {}),
		...(record.allowedSkills ? { allowedSkills: record.allowedSkills } : {}),
		...(record.disallowedSkills
			? { disallowedSkills: record.disallowedSkills }
			: {}),
		...(record.permissionMode ? { permissionMode: record.permissionMode } : {}),
		...(record.effort !== undefined ? { effort: record.effort } : {}),
		...(record.mcpServers ? { mcpServers: record.mcpServers } : {}),
		...(record.requiredMcpServers
			? { requiredMcpServers: record.requiredMcpServers }
			: {}),
		...(record.hooks ? { hooks: record.hooks } : {}),
		...(record.isolation ? { isolation: record.isolation } : {}),
		...(record.model ? { model: record.model } : {}),
		...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
		...(record.sessionId ? { sessionId: record.sessionId } : {}),
		...(record.color ? { color: record.color } : {}),
		...(record.status ? { status: record.status } : {}),
		...(record.lastResultText ? { lastResultText: record.lastResultText } : {}),
		...(record.lastError ? { lastError: record.lastError } : {}),
	};
}

function resolveModelLabel(model: Model<any> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

function resolveModel(
	modelRegistry: ModelRegistry,
	label: string | undefined,
): Model<any> | undefined {
	if (!label) return undefined;
	const raw = label.trim();
	if (!raw) return undefined;
	if (raw.includes("/")) {
		const [provider, ...rest] = raw.split("/");
		const modelId = rest.join("/");
		if (provider && modelId) {
			const found = modelRegistry.find(provider, modelId);
			if (found) return found;
		}
	}
	return modelRegistry
		.getAll()
		.find(
			(model) =>
				`${model.provider}/${model.id}` === raw ||
				model.id === raw ||
				model.name === raw,
		);
}

async function loadMailboxMessages(
	mailboxFile: string,
	consumedLines: number,
): Promise<{
	lines: number;
	messages: ReturnType<typeof parseDetachedControlMessage>[];
}> {
	try {
		const raw = await fs.promises.readFile(mailboxFile, "utf-8");
		const lines = raw.split(/\n+/).filter(Boolean);
		const unread = lines.slice(consumedLines);
		return {
			lines: lines.length,
			messages: unread.map((line) =>
				parseDetachedControlMessage(JSON.parse(line)),
			),
		};
	} catch {
		return { lines: consumedLines, messages: [] };
	}
}

async function main(): Promise<void> {
	const payloadPath = process.argv[2];
	if (!payloadPath) {
		throw new Error("Detached runner payload path is required.");
	}

	const payload = parseDetachedBackgroundPayload(
		JSON.parse(await fs.promises.readFile(payloadPath, "utf-8")),
	);
	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);
	const currentModel = resolveModel(modelRegistry, payload.currentModel);
	const sessionManager = SessionManager.open(
		payload.sessionFile,
		payload.sessionDir,
		payload.runtimeCwd,
	);
	const sessionId = sessionManager.getSessionId();
	const managedTaskRegistry = new ManagedTaskRegistry(payload.stateCwd);
	await managedTaskRegistry.load();

	const permissions: AgentPermissionConfig = {
		...(payload.allowedTools ? { allowedTools: payload.allowedTools } : {}),
		...(payload.disallowedTools
			? { disallowedTools: payload.disallowedTools }
			: {}),
		...(payload.allowedDirectories
			? { allowedDirectories: payload.allowedDirectories }
			: {}),
		...(payload.allowedSkills ? { allowedSkills: payload.allowedSkills } : {}),
		...(payload.disallowedSkills
			? { disallowedSkills: payload.disallowedSkills }
			: {}),
		...(payload.agent.permissionMode
			? { permissionMode: payload.agent.permissionMode }
			: {}),
	};

	const { runtime, model } = await createSdkAgentRuntime({
		defaultCwd: payload.runtimeCwd,
		agent: payload.agent,
		modelRegistry,
		currentModel,
		modelOverride: payload.modelOverride,
		sessionManager,
		sessionName: `${payload.name} (${payload.agent.name})`,
		permissions,
		customTools:
			payload.kind === "teammate" && payload.teamName
				? buildClaudeTodoCustomTools(payload.stateCwd, payload.teamName, {
						actingAgentName: payload.name,
						runtimeContext: {
							modelRegistry,
							currentModel,
						},
					})
				: undefined,
		managedPlanMode:
			payload.agent.permissionMode === "plan"
				? {
						...(payload.managedPlanModeInitialReason
							? { initialReason: payload.managedPlanModeInitialReason }
							: {}),
						requestPlanApproval: async (request) => {
							const requestId = randomUUID();
							await appendDetachedOutboxEvent({
								cwd: payload.stateCwd,
								runtimeKey: payload.runtimeKey,
								event: {
									type: "plan_approval_request",
									requestId,
									runtimeKey: payload.runtimeKey,
									runtimeName: payload.name,
									runtimeKind: payload.kind,
									...(payload.teamName ? { teamName: payload.teamName } : {}),
									planPath: request.planPath,
									...(request.summary?.trim()
										? { summary: request.summary.trim() }
										: {}),
									timestamp: new Date().toISOString(),
								},
							});
							return { requestId };
						},
					}
				: undefined,
	});

	const runningRecord = {
		name: payload.name,
		agentType: payload.agent.name,
		cwd: payload.runtimeCwd,
		sessionFile: payload.sessionFile,
		kind: payload.kind,
		...(payload.teamName ? { teamName: payload.teamName } : {}),
		...(payload.allowedTools ? { allowedTools: payload.allowedTools } : {}),
		...(payload.disallowedTools
			? { disallowedTools: payload.disallowedTools }
			: {}),
		...(payload.allowedDirectories
			? { allowedDirectories: payload.allowedDirectories }
			: {}),
		...(payload.allowedSkills ? { allowedSkills: payload.allowedSkills } : {}),
		...(payload.disallowedSkills
			? { disallowedSkills: payload.disallowedSkills }
			: {}),
		...(payload.agent.permissionMode
			? { permissionMode: payload.agent.permissionMode }
			: {}),
		...(payload.agent.effort !== undefined
			? { effort: payload.agent.effort }
			: {}),
		...(payload.agent.mcpServers
			? { mcpServers: payload.agent.mcpServers }
			: {}),
		...(payload.agent.requiredMcpServers
			? { requiredMcpServers: payload.agent.requiredMcpServers }
			: {}),
		...(payload.agent.hooks ? { hooks: payload.agent.hooks } : {}),
		...(payload.agent.isolation ? { isolation: payload.agent.isolation } : {}),
		...(resolveModelLabel(currentModel) || model
			? {
					model:
						payload.modelOverride ?? resolveModelLabel(currentModel) ?? model,
				}
			: {}),
		detached: true,
		processId: process.pid,
		sessionId,
		...(payload.agent.color ? { color: payload.agent.color } : {}),
		status: "running" as const,
		background: true,
		lastDescription: payload.description,
		lastStartedAt: new Date().toISOString(),
	};

	await managedTaskRegistry.upsertFromRecord(runningRecord);
	if (payload.kind === "teammate" && payload.teamName) {
		const team = await loadTeamRecord(payload.stateCwd, payload.teamName);
		if (team) {
			await saveTeamRecord(
				payload.stateCwd,
				upsertTeamMember(team, toTeamMemberRecord(runningRecord)),
			);
		}
	}

	let consumedLines = 0;
	const mailboxTimer = setInterval(async () => {
		const update = await loadMailboxMessages(payload.inboxFile, consumedLines);
		consumedLines = update.lines;
		for (const message of update.messages) {
			if (message.type === "shutdown") {
				await runtime.session.abort();
				continue;
			}
			await runtime.session.sendUserMessage(message.content, {
				deliverAs: "steer",
			});
		}
	}, 500);
	mailboxTimer.unref?.();

	const abortController = new AbortController();
	const onSignal = () => abortController.abort();
	process.on("SIGTERM", onSignal);
	process.on("SIGINT", onSignal);

	try {
		const result = await promptSdkAgentSession({
			session: runtime.session,
			agent: payload.agent,
			task: payload.task,
			model: payload.modelOverride ?? resolveModelLabel(currentModel) ?? model,
			signal: abortController.signal,
			maxTurns: payload.agent.maxTurns,
		});

		const finalStatus =
			result.exitCode !== 0 ||
			result.stopReason === "error" ||
			result.stopReason === "aborted"
				? abortController.signal.aborted
					? "interrupted"
					: "failed"
				: "completed";
		const completedAt = new Date().toISOString();
		await updateNamedAgentRecordStatusOnDisk({
			cwd: payload.stateCwd,
			name: payload.name,
			mutate: (record) => ({
				...record,
				status: finalStatus,
				background: false,
				lastCompletedAt: completedAt,
				lastError:
					finalStatus === "completed"
						? undefined
						: (result.errorMessage ?? result.stderr ?? record.lastError),
				lastResultText: record.lastResultText,
			}),
		});
		await managedTaskRegistry.noteTerminal({
			record: {
				...runningRecord,
				status: finalStatus,
				detached: true,
				processId: process.pid,
				background: false,
				lastCompletedAt: completedAt,
				lastError:
					finalStatus === "completed"
						? undefined
						: (result.errorMessage ?? result.stderr ?? undefined),
			},
			result,
			wasBackground: true,
		});
		if (payload.kind === "teammate" && payload.teamName) {
			const team = await loadTeamRecord(payload.stateCwd, payload.teamName);
			if (team) {
				await saveTeamRecord(
					payload.stateCwd,
					upsertTeamMember(
						team,
						toTeamMemberRecord({
							...runningRecord,
							status: finalStatus,
							lastCompletedAt: completedAt,
							lastError:
								finalStatus === "completed"
									? undefined
									: (result.errorMessage ?? result.stderr ?? undefined),
							lastResultText: getResultText(result),
						}),
					),
				);
			}
		}
		await appendDetachedOutboxEvent({
			cwd: payload.stateCwd,
			runtimeKey: payload.runtimeKey,
			event: {
				type: "terminal",
				runtimeKey: payload.runtimeKey,
				runtimeName: payload.name,
				runtimeKind: payload.kind,
				...(payload.teamName ? { teamName: payload.teamName } : {}),
				status: finalStatus,
				...(payload.description ? { description: payload.description } : {}),
				...((result.errorMessage ?? result.stderr)
					? { error: result.errorMessage ?? result.stderr }
					: {}),
				...(getResultText(result) ? { resultText: getResultText(result) } : {}),
				completedAt,
			},
		});
	} finally {
		clearInterval(mailboxTimer);
		process.off("SIGTERM", onSignal);
		process.off("SIGINT", onSignal);
		await runtime.dispose();
	}
}

if (import.meta.main) {
	main().catch(async (error) => {
		const payloadPath = process.argv[2];
		if (payloadPath && fs.existsSync(payloadPath)) {
			try {
				const payload = parseDetachedBackgroundPayload(
					JSON.parse(await fs.promises.readFile(payloadPath, "utf-8")),
				);
				const managedTaskRegistry = new ManagedTaskRegistry(payload.stateCwd);
				await managedTaskRegistry.load();
				await updateNamedAgentRecordStatusOnDisk({
					cwd: payload.stateCwd,
					name: payload.name,
					mutate: (record) => ({
						...record,
						status: "failed",
						background: false,
						lastCompletedAt: new Date().toISOString(),
						lastError: error instanceof Error ? error.message : String(error),
					}),
				});
				await managedTaskRegistry.upsertFromRecord({
					name: payload.name,
					agentType: payload.agent.name,
					cwd: payload.runtimeCwd,
					sessionFile: payload.sessionFile,
					kind: payload.kind,
					...(payload.teamName ? { teamName: payload.teamName } : {}),
					status: "failed",
					detached: true,
					processId: process.pid,
					background: false,
					lastDescription: payload.description,
					lastCompletedAt: new Date().toISOString(),
					lastError: error instanceof Error ? error.message : String(error),
				});
				if (payload.kind === "teammate" && payload.teamName) {
					const team = await loadTeamRecord(payload.stateCwd, payload.teamName);
					if (team) {
						await saveTeamRecord(
							payload.stateCwd,
							upsertTeamMember(
								team,
								toTeamMemberRecord({
									...payload,
									cwd: payload.runtimeCwd,
									agentType: payload.agent.name,
									status: "failed",
									lastError:
										error instanceof Error ? error.message : String(error),
									lastStartedAt: new Date().toISOString(),
								}),
							),
						);
					}
				}
			} catch {
				// Ignore secondary failures while reporting detached runner errors.
			}
		}
		console.error(
			error instanceof Error ? (error.stack ?? error.message) : String(error),
		);
		process.exitCode = 1;
	});
}
