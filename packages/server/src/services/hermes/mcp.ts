import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import YAML from 'js-yaml'
import { AgentBridgeClient } from './agent-bridge/client'
import { getActiveProfileDir, getProfileDir } from './hermes-profile'
import type { McpActionResponse, McpListResponse, McpServerEntry } from './mcp-types'

export type { McpServerEntry, McpActionResponse } from './mcp-types'

const MCP_LIST_BRIDGE_TIMEOUT_MS = 1200

let bridgeClient: AgentBridgeClient | null = null

export function getBridgeClient(): AgentBridgeClient {
  if (!bridgeClient) {
    bridgeClient = new AgentBridgeClient()
  }
  return bridgeClient
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readMcpConfig(profile?: string): Record<string, unknown> {
  const profileDir = profile ? getProfileDir(profile) : getActiveProfileDir()
  const configPath = join(profileDir, 'config.yaml')
  if (!existsSync(configPath)) return {}
  const parsed = YAML.load(readFileSync(configPath, 'utf-8'), { json: true })
  return isRecord(parsed) ? parsed : {}
}

function buildStaticServerEntry(name: string, config: Record<string, unknown>): McpServerEntry {
  const transport = typeof config.url === 'string' && config.url.trim() ? 'http' : 'stdio'
  return {
    name,
    transport,
    connected: false,
    tools: 0,
    tools_registered: 0,
    tool_names: [],
    tool_names_registered: [],
    tool_details: [],
    raw_config: config,
  }
}

export function readMcpConfigSnapshot(profile?: string, error = 'MCP bridge inventory is still loading'): McpListResponse {
  try {
    const config = readMcpConfig(profile)
    const mcpServers = isRecord(config.mcp_servers) ? config.mcp_servers : {}
    const servers = Object.entries(mcpServers)
      .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
      .map(([name, serverConfig]) => buildStaticServerEntry(name, serverConfig))

    return { ok: true, partial: true, servers, total_tools: 0, error }
  } catch (err: any) {
    return {
      ok: true,
      partial: true,
      servers: [],
      total_tools: 0,
      error: err?.message || error,
    }
  }
}

export async function listMcpServers(profile?: string): Promise<McpListResponse> {
  const live = bridgeMcpAction('mcp_list', {}, profile) as Promise<McpListResponse>
  const fallback = new Promise<McpListResponse>(resolve => {
    setTimeout(() => resolve(readMcpConfigSnapshot(profile)), MCP_LIST_BRIDGE_TIMEOUT_MS)
  })
  return Promise.race([live, fallback])
}

/**
 * Send an MCP action to the AgentBridge using typed client methods.
 */
export async function bridgeMcpAction(
  action: string,
  payload: Record<string, unknown> = {},
  profile?: string
): Promise<McpActionResponse> {
  const client = getBridgeClient()
  let raw: McpActionResponse

  switch (action) {
    case 'mcp_list':
      raw = await client.mcpList(profile)
      break
    case 'mcp_server_add': {
      const addName = String(payload.name || '')
      const addConfig = payload.config as Record<string, unknown> | undefined
      if (!addName || !addConfig) throw new Error('name and config are required')
      raw = await client.mcpAdd(addName, addConfig, profile)
      break
    }
    case 'mcp_server_update': {
      const updName = String(payload.name || '')
      const updConfig = payload.config as Record<string, unknown> | undefined
      if (!updName || !updConfig) throw new Error('name and config are required')
      raw = await client.mcpUpdate(updName, updConfig, profile)
      break
    }
    case 'mcp_server_remove': {
      const rmName = String(payload.name || '')
      if (!rmName) throw new Error('name is required')
      raw = await client.mcpRemove(rmName, profile)
      break
    }
    case 'mcp_server_test': {
      const testName = String(payload.name || '')
      if (!testName) throw new Error('name is required')
      raw = await client.mcpTest(testName, profile)
      break
    }
    case 'mcp_tools_list':
      raw = await client.mcpTools(payload.server as string | undefined, profile, payload.raw as boolean | undefined)
      break
    case 'mcp_reload':
      raw = await client.mcpReload(payload.server as string | undefined, profile)
      break
    default:
      throw new Error(`Unknown MCP action: ${action}`)
  }

  return raw
}
