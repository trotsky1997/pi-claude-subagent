import {
  discoverAgents as discoverAgentsFromCore,
  formatAgentList,
  type AgentConfig,
  type AgentDiscoveryResult,
  type AgentMemoryScope,
  type AgentScope,
} from "pi-claude-runtime-core/agent-discovery";

export type {
  AgentConfig,
  AgentDiscoveryResult,
  AgentMemoryScope,
  AgentScope,
};

export { formatAgentList };

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  return discoverAgentsFromCore(cwd, scope);
}
