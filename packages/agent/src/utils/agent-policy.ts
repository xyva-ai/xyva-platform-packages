export type AgentMode = 'advisor' | 'builder' | 'operator'

export interface AgentModePolicy {
  id: AgentMode
  label: string
  risk: 'low' | 'medium' | 'high'
  summary: string
  allowFileWrite: boolean
  allowBrowserMcp: boolean
  allowChatMcpExtensions: boolean
  allowOpsMcpExtensions: boolean
  allowAdminExtensions: boolean
}

export interface McpCatalogPolicyEntry {
  id: string
  chatAllowed?: boolean
  adminOnly?: boolean
}

export const AGENT_MODE_ORDER: AgentMode[] = ['advisor', 'builder', 'operator']

export const AGENT_MODE_POLICIES: Record<AgentMode, AgentModePolicy> = {
  advisor: {
    id: 'advisor',
    label: 'Advisor',
    risk: 'low',
    summary: 'Read-only analysis mode. AI can inspect, explain, and recommend but cannot change files or execute MCP tools.',
    allowFileWrite: false,
    allowBrowserMcp: false,
    allowChatMcpExtensions: false,
    allowOpsMcpExtensions: false,
    allowAdminExtensions: false,
  },
  builder: {
    id: 'builder',
    label: 'Builder',
    risk: 'medium',
    summary: 'Controlled execution mode. AI can write inside approved paths and use chat-safe MCP tools.',
    allowFileWrite: true,
    allowBrowserMcp: true,
    allowChatMcpExtensions: true,
    allowOpsMcpExtensions: false,
    allowAdminExtensions: false,
  },
  operator: {
    id: 'operator',
    label: 'Operator',
    risk: 'high',
    summary: 'Operations mode. AI can run broader QA workflows, including ops-grade MCP extensions, inside policy boundaries.',
    allowFileWrite: true,
    allowBrowserMcp: true,
    allowChatMcpExtensions: true,
    allowOpsMcpExtensions: true,
    allowAdminExtensions: true,
  },
}

export function getAgentModePolicy(mode?: string | null): AgentModePolicy {
  if (!mode || !(mode in AGENT_MODE_POLICIES)) {
    return AGENT_MODE_POLICIES.advisor
  }

  return AGENT_MODE_POLICIES[mode as AgentMode]
}
