import { z } from "zod";
import { ManagedRuntimeKindSchema } from "pi-claude-runtime-core/managed-runtime-schemas";

const OptionalStringSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim() ? value.trim() : undefined,
  z.string().min(1).optional(),
);

const OptionalStringListSchema = z.preprocess(
  (value) => Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))]
    : undefined,
  z.array(z.string().min(1)).optional(),
);

const AgentPermissionModeSchema = z.enum(["acceptEdits", "bypassPermissions", "default", "dontAsk", "plan", "bubble"]);
const AgentEffortLevelSchema = z.enum(["low", "medium", "high", "max"]);
const AgentEffortSchema = z.union([AgentEffortLevelSchema, z.number().int().positive()]).optional();
const AgentIsolationSchema = z.enum(["worktree", "remote"]).optional();
const AgentHooksSchema = z.record(z.string(), z.unknown()).optional();
const AgentMcpServerSpecSchema = z.union([z.string().min(1), z.record(z.string(), z.unknown())]);
const AgentMcpServersSchema = z.array(AgentMcpServerSpecSchema).optional();

export const DetachedAgentConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  tools: OptionalStringListSchema,
  disallowedTools: OptionalStringListSchema,
  allowedDirectories: OptionalStringListSchema,
  skills: OptionalStringListSchema,
  allowedSkills: OptionalStringListSchema,
  disallowedSkills: OptionalStringListSchema,
  permissionMode: AgentPermissionModeSchema.optional(),
  effort: AgentEffortSchema,
  mcpServers: AgentMcpServersSchema,
  requiredMcpServers: OptionalStringListSchema,
  hooks: AgentHooksSchema,
  isolation: AgentIsolationSchema,
  model: OptionalStringSchema,
  background: z.boolean().optional(),
  color: OptionalStringSchema,
  initialPrompt: OptionalStringSchema,
  maxTurns: z.number().int().positive().optional(),
  memory: z.enum(["user", "project", "local"]).optional(),
  systemPrompt: z.string(),
  source: z.enum(["bundled", "user", "project"]),
  filePath: z.string().min(1),
});

export const DetachedBackgroundPayloadSchema = z.object({
  runtimeKey: z.string().min(1),
  taskId: z.string().min(1),
  inboxFile: z.string().min(1),
  outboxFile: z.string().min(1),
  outboxCursorFile: z.string().min(1),
  stateCwd: z.string().min(1),
  runtimeCwd: z.string().min(1),
  name: z.string().min(1),
  kind: ManagedRuntimeKindSchema,
  teamName: OptionalStringSchema,
  sessionDir: z.string().min(1),
  sessionFile: z.string().min(1),
  agent: DetachedAgentConfigSchema,
  modelOverride: OptionalStringSchema,
  currentModel: OptionalStringSchema,
  task: z.string().min(1),
  description: OptionalStringSchema,
  managedPlanModeInitialReason: OptionalStringSchema,
  allowedTools: OptionalStringListSchema,
  disallowedTools: OptionalStringListSchema,
  allowedDirectories: OptionalStringListSchema,
  allowedSkills: OptionalStringListSchema,
  disallowedSkills: OptionalStringListSchema,
});

export const DetachedControlMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    content: z.string().min(1),
    summary: OptionalStringSchema,
  }),
  z.object({
    type: z.literal("shutdown"),
    reason: OptionalStringSchema,
  }),
]);

export const DetachedOutboxEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("plan_approval_request"),
    requestId: z.string().min(1),
    runtimeKey: z.string().min(1),
    runtimeName: z.string().min(1),
    runtimeKind: ManagedRuntimeKindSchema,
    teamName: OptionalStringSchema,
    planPath: z.string().min(1),
    summary: OptionalStringSchema,
    timestamp: z.string().min(1),
  }),
  z.object({
    type: z.literal("terminal"),
    runtimeKey: z.string().min(1),
    runtimeName: z.string().min(1),
    runtimeKind: ManagedRuntimeKindSchema,
    teamName: OptionalStringSchema,
    status: z.enum(["completed", "failed", "interrupted"]),
    description: OptionalStringSchema,
    resultText: OptionalStringSchema,
    error: OptionalStringSchema,
    completedAt: z.string().min(1),
  }),
  z.object({
    type: z.literal("child_message"),
    runtimeKey: z.string().min(1),
    runtimeName: z.string().min(1),
    runtimeKind: ManagedRuntimeKindSchema,
    teamName: OptionalStringSchema,
    summary: OptionalStringSchema,
    content: z.string().min(1),
    timestamp: z.string().min(1),
  }),
]);

export type DetachedAgentConfig = z.infer<typeof DetachedAgentConfigSchema>;
export type DetachedBackgroundPayload = z.infer<typeof DetachedBackgroundPayloadSchema>;
export type DetachedControlMessage = z.infer<typeof DetachedControlMessageSchema>;
export type DetachedOutboxEvent = z.infer<typeof DetachedOutboxEventSchema>;

export function parseDetachedBackgroundPayload(value: unknown): DetachedBackgroundPayload {
  return DetachedBackgroundPayloadSchema.parse(value);
}

export function parseDetachedControlMessage(value: unknown): DetachedControlMessage {
  return DetachedControlMessageSchema.parse(value);
}

export function parseDetachedOutboxEvent(value: unknown): DetachedOutboxEvent {
  return DetachedOutboxEventSchema.parse(value);
}
