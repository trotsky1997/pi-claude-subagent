import * as path from "node:path";
import type {
	ExtensionAPI,
	ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "pi-claude-runtime-core/agent-discovery";
import type { AgentPermissionMode } from "pi-claude-runtime-core/managed-runtime-schemas";

const BUILTIN_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"write",
	"find",
	"grep",
	"ls",
] as const;
const PLAN_MODE_BLOCKED_TOOLS = new Set(["edit", "write"]);
const PLAN_MODE_EXTRA_ALLOWED_TOOLS = new Set([
	"enter_plan_mode",
	"update_plan",
	"request_plan_approval",
	"askuserquestion",
	"webfetch",
	"recursive_webfetch",
	"web_search",
]);

export type AgentPermissionConfig = {
	allowedTools?: string[];
	disallowedTools?: string[];
	allowedDirectories?: string[];
	allowedSkills?: string[];
	disallowedSkills?: string[];
	permissionMode?: AgentPermissionMode;
};

function normalizeList(values: string[] | undefined): string[] | undefined {
	if (!values || values.length === 0) return undefined;
	const normalized = [
		...new Set(values.map((value) => value.trim()).filter(Boolean)),
	];
	return normalized.length > 0 ? normalized : undefined;
}

function shouldBlockForPlanMode(
	toolName: string,
	config: AgentPermissionConfig,
): boolean {
	return (
		config.permissionMode === "plan" &&
		PLAN_MODE_BLOCKED_TOOLS.has(toolName.toLowerCase())
	);
}

function isPlanModeExtraAllowed(
	toolName: string,
	config: AgentPermissionConfig,
): boolean {
	return (
		config.permissionMode === "plan" &&
		PLAN_MODE_EXTRA_ALLOWED_TOOLS.has(toolName.toLowerCase())
	);
}

export function parseStringList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		return normalizeList(
			value.filter((entry): entry is string => typeof entry === "string"),
		);
	}
	if (typeof value === "string") {
		return normalizeList(value.split(","));
	}
	return undefined;
}

export function mergePermissionConfig(
	agent: AgentConfig,
	overrides: AgentPermissionConfig = {},
): AgentPermissionConfig {
	return {
		...(normalizeList(overrides.allowedTools ?? agent.tools)
			? { allowedTools: normalizeList(overrides.allowedTools ?? agent.tools) }
			: {}),
		...(normalizeList(overrides.disallowedTools ?? agent.disallowedTools)
			? {
					disallowedTools: normalizeList(
						overrides.disallowedTools ?? agent.disallowedTools,
					),
				}
			: {}),
		...(normalizeList(overrides.allowedDirectories ?? agent.allowedDirectories)
			? {
					allowedDirectories: normalizeList(
						overrides.allowedDirectories ?? agent.allowedDirectories,
					),
				}
			: {}),
		...(normalizeList(overrides.allowedSkills ?? agent.allowedSkills)
			? {
					allowedSkills: normalizeList(
						overrides.allowedSkills ?? agent.allowedSkills,
					),
				}
			: {}),
		...(normalizeList(overrides.disallowedSkills ?? agent.disallowedSkills)
			? {
					disallowedSkills: normalizeList(
						overrides.disallowedSkills ?? agent.disallowedSkills,
					),
				}
			: {}),
		...((overrides.permissionMode ?? agent.permissionMode)
			? { permissionMode: overrides.permissionMode ?? agent.permissionMode }
			: {}),
	};
}

export function resolveAllowedToolNames(
	config: AgentPermissionConfig,
): string[] | undefined {
	const allow = normalizeList(config.allowedTools);
	const deny = new Set(
		(normalizeList(config.disallowedTools) ?? []).map((value) =>
			value.toLowerCase(),
		),
	);
	const base = allow ?? [...BUILTIN_TOOL_NAMES];
	const filtered = [
		...new Set(
			base.filter(
				(name) =>
					!deny.has(name.toLowerCase()) &&
					!shouldBlockForPlanMode(name, config),
			),
		),
	];
	return allow || deny.size > 0 || config.permissionMode === "plan"
		? filtered
		: undefined;
}

export function filterCustomTools(
	customTools: ToolDefinition[] | undefined,
	config: AgentPermissionConfig,
): ToolDefinition[] | undefined {
	if (!customTools) return undefined;
	const allow = normalizeList(config.allowedTools)?.map((value) =>
		value.toLowerCase(),
	);
	const deny = new Set(
		(normalizeList(config.disallowedTools) ?? []).map((value) =>
			value.toLowerCase(),
		),
	);
	const filtered = customTools.filter((tool) => {
		const name = tool.name.toLowerCase();
		if (isPlanModeExtraAllowed(name, config)) return true;
		if (allow && !allow.includes(name)) return false;
		if (deny.has(name)) return false;
		if (shouldBlockForPlanMode(name, config)) return false;
		return true;
	});
	return filtered;
}

export function resolveAllowedDirectories(
	cwd: string,
	config: AgentPermissionConfig,
): string[] | undefined {
	const dirs = normalizeList(config.allowedDirectories);
	if (!dirs) return undefined;
	return [...new Set(dirs.map((dir) => path.resolve(cwd, dir)))];
}

function isWithinAllowedDirectories(
	candidatePath: string,
	allowedDirectories: string[],
): boolean {
	const resolvedCandidate = path.resolve(candidatePath);
	return allowedDirectories.some((allowedDir) => {
		const resolvedDir = path.resolve(allowedDir);
		return (
			resolvedCandidate === resolvedDir ||
			resolvedCandidate.startsWith(`${resolvedDir}${path.sep}`)
		);
	});
}

function extractPathInputs(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): string[] {
	switch (toolName) {
		case "read":
		case "edit":
		case "write": {
			const raw =
				typeof input.path === "string"
					? input.path
					: typeof input.file_path === "string"
						? input.file_path
						: undefined;
			return raw ? [path.resolve(cwd, raw)] : [];
		}
		case "grep":
		case "find":
		case "ls": {
			const raw = typeof input.path === "string" ? input.path : cwd;
			return [path.resolve(cwd, raw)];
		}
		default:
			return [];
	}
}

function isToolAllowed(
	toolName: string,
	config: AgentPermissionConfig,
): boolean {
	const allow = normalizeList(config.allowedTools)?.map((value) =>
		value.toLowerCase(),
	);
	const deny = new Set(
		(normalizeList(config.disallowedTools) ?? []).map((value) =>
			value.toLowerCase(),
		),
	);
	const name = toolName.toLowerCase();
	if (isPlanModeExtraAllowed(name, config)) return true;
	if (allow && !allow.includes(name)) return false;
	if (deny.has(name)) return false;
	if (shouldBlockForPlanMode(name, config)) return false;
	return true;
}

export function createPermissionExtensionFactory(
	cwd: string,
	config: AgentPermissionConfig,
): (pi: ExtensionAPI) => void {
	const allowedDirectories = resolveAllowedDirectories(cwd, config);

	return (pi: ExtensionAPI) => {
		pi.on("tool_call", (event) => {
			if (shouldBlockForPlanMode(event.toolName, config)) {
				return {
					block: true,
					reason: `Tool \"${event.toolName}\" is blocked while this managed agent is running in plan mode. Stay read-only until the plan is approved, but use read-only tools such as bash/read/find/grep/ls as needed.`,
				};
			}

			if (!isToolAllowed(event.toolName, config)) {
				return {
					block: true,
					reason: `Tool \"${event.toolName}\" is not permitted for this agent.`,
				};
			}

			if (!allowedDirectories || allowedDirectories.length === 0) {
				return undefined;
			}

			const paths = extractPathInputs(
				event.toolName,
				event.input as Record<string, unknown>,
				cwd,
			);
			if (paths.length === 0) {
				return undefined;
			}

			const deniedPath = paths.find(
				(candidate) =>
					!isWithinAllowedDirectories(candidate, allowedDirectories),
			);
			if (!deniedPath) {
				return undefined;
			}

			return {
				block: true,
				reason: `Path \"${deniedPath}\" is outside the agent's allowed directories.`,
			};
		});
	};
}

export function filterAllowedSkills(
	skillNames: string[] | undefined,
	allSkillNames: string[],
	disallowedSkillNames: string[] | undefined,
): string[] {
	const allowed = normalizeList(skillNames)?.map((value) =>
		value.toLowerCase(),
	);
	const denied = new Set(
		(normalizeList(disallowedSkillNames) ?? []).map((value) =>
			value.toLowerCase(),
		),
	);
	return allSkillNames.filter((name) => {
		const normalized = name.toLowerCase();
		if (allowed && !allowed.includes(normalized)) return false;
		if (denied.has(normalized)) return false;
		return true;
	});
}
