# pi-claude-subagent

Claude-style delegated subagents and local in-process teammates for Pi, based on Pi's official `subagent` extension example and extended toward Claude Code's `Agent` system.

This package currently has a hybrid architecture:

- `subagent` keeps the original subprocess-based Pi delegation model for stable single / parallel / chain execution
- `Agent` is the Claude-style interface and is SDK-backed for managed single-agent execution
- named `Agent` calls persist child session identity so later calls can continue the same child context
- named `Agent` calls can also run in the background and notify the parent session when they finish
- `TeamCreate`, `team_name + name`, and `SendMessage` provide a local in-process teammate layer modeled after Claude Code's local coordination flow
- new local `TeamCreate` calls also initialize/reset the matching Claude Todo V2 task list (`Team = TaskList`)
- when `pi-claude-todo-v2` is loaded in the same Pi process, teammate runtimes can also receive the shared `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` / `TaskStop` tools, plus a bridged `SendMessage` tool for child-to-lead and child-to-child coordination
- task owner changes now emit dedicated assignment notifications instead of remaining silent

## Install

Install into the current project from GitHub:

```bash
pi install -l git:github.com/trotsky1997/pi-claude-subagent
```

Install globally into Pi:

```bash
pi install git:github.com/trotsky1997/pi-claude-subagent
```

Local install from this workspace:

```bash
pi install -l /home/aka/pi-playground/pi-claude-subagent
```

Quick-load without installing:

```bash
pi -e /home/aka/pi-playground/pi-claude-subagent/extensions/claude-subagent/index.ts
```

## Tools

The package currently registers five tools:

- `Agent` - Claude-style delegated agent call using fields like `prompt`, `description`, `subagent_type`, optional `model`, optional `mode`, optional `name`, optional `cwd`, optional `allowed_tools`, optional `disallowed_tools`, optional `allowed_directories`, optional `allowed_skills`, optional `disallowed_skills`, optional `run_in_background`, optional `team_name`
- `SendMessage` - Claude-style follow-up message tool for named agents and local teammates managed by this package, including structured protocol payloads such as `shutdown_request` and plan-approval responses
- `TeamCreate` - create or activate a local team context for teammate spawning and team broadcasts
- `TeamDelete` - delete the active local team after all running teammates have stopped, and clean up its shared task list
- `subagent` - Pi-native delegation tool with `single`, `parallel`, and `chain` modes

### Current `Agent` lifecycle support

Supported now:

- `subagent_type`
- `prompt`
- `description`
- `model`
- `cwd`
- `allowed_tools` / `disallowed_tools` for tool-level gating
- `allowed_directories` for file-tool directory confinement
- `skills` frontmatter for preloading a specific skill subset
- `allowed_skills` / `disallowed_skills` for skill loading control
- `name` for persistent named-agent continuation
- `mode` / agent frontmatter `permissionMode` metadata, with `plan` now bootstrapping the shared `pi-claude-plan-mode` runtime for named managed agents and teammates
- `run_in_background` for named agents
- agent frontmatter `background: true`
- agent frontmatter `permissionMode`
- agent frontmatter `effort`
- agent frontmatter `mcpServers` / `requiredMcpServers`
- agent frontmatter `hooks`
- agent frontmatter `initialPrompt`
- agent frontmatter `maxTurns`
- agent frontmatter `memory` (`user`, `project`, or `local`)
- agent frontmatter `isolation`, with `worktree` now supported for named agents and teammates and `remote` still reserved for future backend support
- `SendMessage` follow-ups for named agents
- `team_name + name` for local in-process teammate spawns
- `TeamCreate` + `SendMessage to "*"` for local team broadcast routing
- local task-tool injection for teammate runtimes when used together with `pi-claude-todo-v2`, including `TaskStop`
- bridged child-runtime `SendMessage` so teammates and managed named agents can message `team-lead` or other managed runtimes from inside their own child session
- manual teammates auto-claim shared team tasks while idle when used together with `pi-claude-todo-v2`

Not fully supported yet:

- Claude tmux / split-pane teammate backends
- Claude CCR / remote isolation backends
- bridge / UDS cross-session `SendMessage`
- launch-time MCP server provisioning for agent `mcpServers` / `requiredMcpServers`
- executable agent hook wiring for frontmatter `hooks`

If `name` is provided without `team_name`, the package persists a child session for that logical subagent and reopens it on later calls with the same name.

Current managed-plan-mode detail: `permissionMode=plan` currently requires `name` so the child runtime can request approval, receive a later `plan_approval_response`, and then restore normal tools in the same session.

If `run_in_background: true` is provided, or the selected agent frontmatter sets `background: true`:

- `name` is required for subagent background launches
- standard managed teammates still run on runtime-backed sessions, but named background subagents without team mode or plan mode now use a detached Bun runner so they can continue after the parent Pi process exits
- the parent session receives a completion/failure notification automatically
- while it is running, use `SendMessage` to queue follow-up instructions into that live child session

If `team_name + name` is provided:

- the call spawns or resumes a local in-process teammate runtime
- the team must already exist, typically via `TeamCreate`
- teammates run as managed background workers and can be resumed through `SendMessage`
- when `pi-claude-todo-v2` is loaded in the same process, assigning a task owner to a local teammate also wakes/resumes that teammate immediately and emits an assignment notification
- when `pi-claude-todo-v2` is loaded in the same process, manual teammates also poll the shared team task list and auto-claim pending, unowned, unblocked tasks while idle
- interrupted or failed local teammates release unfinished owned tasks back to `pending` so work does not stay orphaned
- teammate membership is treated as process-local: when Pi exits or reloads, dead teammate records are pruned from the team file instead of being resumed in a later session

If `SendMessage` is used:

- running named agents and live teammates receive the message via the live child-session queue
- idle/completed named agents are resumed in the background from their persistent child session; local teammates are only messageable while still live in the current Pi process
- `to: "*"` broadcasts messages to all live teammates in the active local team
- structured `shutdown_request` messages stop the targeted local managed runtime directly and carry a generated `request_id` when one is not supplied
- unknown targets fail clearly

Detached background support currently covers named subagents and named teammates, including managed plan-mode subagents. Detached runs keep a persistent inbox/outbox under `.pi/claude-subagent/detached-runs/` so follow-up messages, plan approval requests, and terminal notifications can survive the parent Pi process.

Background runs always keep persistent child session history. Detached named subagents and named teammates can continue after the parent Pi process exits, consume follow-up messages from an inbox mailbox, and emit approval/completion events through an outbox mailbox. Only in-process managed runtimes that are not launched through the detached path become `interrupted` if Pi reloads or exits mid-run.

## Agent sources

The package resolves agents in this order:

1. bundled package agents
2. user agents from `~/.pi/agent/agents`
3. project agents from the nearest `.pi/agents`

That means user/project agents can override bundled defaults by name.

## Bundled Claude-style agents

- `general-purpose`
- `Explore`
- `Plan`
- `verification`

Compatibility aliases remain available for now:

- `scout`
- `planner`
- `reviewer`
- `worker`

## Bundled workflow prompts

- `/subagent-implement`
- `/scout-and-plan`
- `/implement-and-review`

These prompts still use the `subagent` tool internally because it already supports chain mode directly.

## Persistence layout

Managed runtime state is stored under the project:

- `.pi/claude-subagent/agent-sessions/` - persistent child session files for named agents and teammates
- `.pi/claude-subagent/named-agents.json` - named subagent registry plus lifecycle state
- `.pi/claude-subagent/managed-tasks.json` - shared managed-task registry for named subagents and teammates
- `.pi/claude-subagent/teams/` - local team files and teammate membership/state
- `.pi/claude-subagent/active-team.json` - current active local team context
- `.pi/claude-subagent/agent-memory/` and `.pi/claude-subagent/agent-memory-local/` - project/local persistent agent memory roots when agents opt into memory
- sibling `../.pi-claude-subagent-worktrees/<repo-hash>/<runtime>/` directories - retained git worktrees for named runtimes using `isolation: worktree`

This gives local Claude-style continuation and teammate coordination without depending on a single long-lived parent process. Live background execution still depends on the current Pi process because it is runtime-backed rather than subprocess-detached.

## Security model

In addition to the selected agent prompt itself, the Claude-style `Agent` tool now supports runtime permission shaping:

- tool gating through `allowed_tools` / `disallowed_tools`
- directory gating for file-oriented tools through `allowed_directories`
- skill loading control through `allowed_skills` / `disallowed_skills`
- automatic memory-path allowance for agents that declare `memory`

Bundled/user/project agent frontmatter can also declare:

- `tools`
- `disallowed_tools`
- `allowed_directories`
- `skills`
- `allowed_skills`
- `disallowed_skills`
- `permissionMode`
- `effort`
- `mcpServers`
- `requiredMcpServers`
- `hooks`
- `isolation`
- `initialPrompt`
- `maxTurns`
- `memory`

Current limitations: `allowed_directories` still only constrains file-oriented tools. `bash` is now allowed even when directory restrictions are set, so shell commands are not path-confined yet and can still escape those directory boundaries. `isolation: worktree` currently requires `name`, creates a retained sibling git worktree outside the main checkout, and keeps successful worktrees on disk for manual review/merge. `isolation: remote` is still not implemented.

Project-local agents are repo-controlled prompts. When the selected agent comes from the nearest `.pi/agents` directory and Pi has an interactive UI, the package asks for confirmation before running it.
