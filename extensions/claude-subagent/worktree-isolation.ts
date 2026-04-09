import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ManagedRuntimeKind } from "pi-claude-runtime-core/managed-runtime-schemas";

const execFileAsync = promisify(execFile);

function sanitizePathComponent(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "runtime";
}

function toAbsoluteCwd(cwd: string): string {
	return path.resolve(cwd.trim() || ".");
}

function getRuntimeKey(options: {
	name: string;
	kind?: ManagedRuntimeKind;
	teamName?: string;
}): string {
	const kind = options.kind ?? "subagent";
	if (kind === "teammate") {
		if (!options.teamName) {
			throw new Error(
				`Teammate runtime "${options.name}" requires a team name.`,
			);
		}
		return `teammate:${options.teamName}:${options.name}`;
	}
	return `subagent:${options.name}`;
}

async function runGit(args: string[], cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
		});
		return stdout.trim();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`git ${args.join(" ")} failed in "${cwd}": ${message}`);
	}
}

async function resolveRepoRoot(cwd: string): Promise<string> {
	try {
		const output = await runGit(["rev-parse", "--show-toplevel"], cwd);
		return path.resolve(cwd, output);
	} catch {
		throw new Error(
			`Worktree isolation requires a git repository, but "${cwd}" is not inside one.`,
		);
	}
}

async function resolveGitCommonDir(cwd: string): Promise<string> {
	const output = await runGit(["rev-parse", "--git-common-dir"], cwd);
	return path.resolve(cwd, output);
}

async function ensureManagedWorktree(options: {
	repoRoot: string;
	worktreeRoot: string;
}): Promise<boolean> {
	const repoCommonDir = await resolveGitCommonDir(options.repoRoot);
	const worktreeExists = fs.existsSync(options.worktreeRoot);

	if (worktreeExists) {
		const worktreeTopLevel = await resolveRepoRoot(options.worktreeRoot);
		const worktreeCommonDir = await resolveGitCommonDir(options.worktreeRoot);
		if (path.resolve(worktreeTopLevel) !== path.resolve(options.worktreeRoot)) {
			throw new Error(
				`Managed worktree path "${options.worktreeRoot}" already exists but is rooted at "${worktreeTopLevel}".`,
			);
		}
		if (path.resolve(worktreeCommonDir) !== path.resolve(repoCommonDir)) {
			throw new Error(
				`Managed worktree path "${options.worktreeRoot}" belongs to a different git repository.`,
			);
		}
		return false;
	}

	// Clean out stale registrations before recreating a managed worktree path.
	await runGit(["worktree", "prune"], options.repoRoot);
	await fs.promises.mkdir(path.dirname(options.worktreeRoot), {
		recursive: true,
	});
	await runGit(
		["worktree", "add", "--detach", options.worktreeRoot, "HEAD"],
		options.repoRoot,
	);
	return true;
}

export type WorktreeIsolationResult = {
	stateCwd: string;
	baseCwd: string;
	repoRoot: string;
	runtimeKey: string;
	worktreeRoot: string;
	runtimeCwd: string;
	repoContainerDir: string;
	relativeRuntimeSubpath: string;
	created: boolean;
};

export async function resolveManagedWorktreeIsolation(options: {
	stateCwd: string;
	baseCwd: string;
	name: string;
	kind?: ManagedRuntimeKind;
	teamName?: string;
}): Promise<WorktreeIsolationResult> {
	const stateCwd = toAbsoluteCwd(options.stateCwd);
	const baseCwd = toAbsoluteCwd(options.baseCwd);
	const repoRoot = await resolveRepoRoot(baseCwd);
	const relativeRuntimeSubpath = path.relative(repoRoot, baseCwd);
	if (
		relativeRuntimeSubpath.startsWith(`..${path.sep}`) ||
		relativeRuntimeSubpath === ".."
	) {
		throw new Error(
			`Resolved cwd "${baseCwd}" is outside repo root "${repoRoot}".`,
		);
	}

	const runtimeKey = getRuntimeKey({
		name: options.name,
		kind: options.kind,
		teamName: options.teamName,
	});
	const repoHash = createHash("sha1")
		.update(repoRoot)
		.digest("hex")
		.slice(0, 8);
	const repoSlug = `${sanitizePathComponent(path.basename(repoRoot))}-${repoHash}`;
	const repoContainerDir = path.resolve(
		repoRoot,
		"..",
		".pi-claude-subagent-worktrees",
		repoSlug,
	);
	const worktreeRoot = path.join(
		repoContainerDir,
		sanitizePathComponent(runtimeKey),
	);
	const created = await ensureManagedWorktree({ repoRoot, worktreeRoot });
	const runtimeCwd =
		relativeRuntimeSubpath && relativeRuntimeSubpath !== "."
			? path.join(worktreeRoot, relativeRuntimeSubpath)
			: worktreeRoot;

	return {
		stateCwd,
		baseCwd,
		repoRoot,
		runtimeKey,
		worktreeRoot,
		runtimeCwd,
		repoContainerDir,
		relativeRuntimeSubpath:
			relativeRuntimeSubpath === "." ? "" : relativeRuntimeSubpath,
		created,
	};
}
