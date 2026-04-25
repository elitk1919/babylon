import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { toolRegistry, type ToolHandler } from './tool_registry.js'
import KVStore from '#models/kv_store'
import logger from '@adonisjs/core/services/logger'
import type { Tool } from '../../types/ollama.js'
import {
  TOOL_NAME_SEPARATOR,
  type McpServerConfig,
  type McpServerState,
  type McpServerStatus,
} from '../../types/mcp.js'

const MAX_RECONNECT_DELAY_MS = 30_000
const INITIAL_RECONNECT_DELAY_MS = 1_000

class McpService {
  private clients: Map<string, Client> = new Map()
  private states: Map<string, McpServerState> = new Map()
  /** Tool names registered per server, for clean unregistration */
  private serverTools: Map<string, string[]> = new Map()
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private reconnectAttempts: Map<string, number> = new Map()
  /** In-process servers don't need reconnection or persistence */
  private inProcessServers: Set<string> = new Set()

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  async loadConfigs(): Promise<McpServerConfig[]> {
    const raw = await KVStore.getValue('mcp.servers')
    if (!raw) return []
    try {
      return JSON.parse(raw) as McpServerConfig[]
    } catch {
      logger.warn('[McpService] Failed to parse mcp.servers from KVStore')
      return []
    }
  }

  async saveConfigs(configs: McpServerConfig[]): Promise<void> {
    await KVStore.setValue('mcp.servers', JSON.stringify(configs))
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  async connectServer(config: McpServerConfig): Promise<void> {
    // Disconnect existing connection if any
    if (this.clients.has(config.id)) {
      await this.disconnectServer(config.id)
    }

    this.setState(config, 'connecting')

    try {
      const transport = this.createTransport(config)
      const client = new Client({ name: 'babylon', version: '1.0.0' })

      // Set up close/error handlers before connecting
      client.onclose = () => {
        logger.info(`[McpService] Server "${config.id}" connection closed`)
        this.unregisterToolsForServer(config.id)
        this.clients.delete(config.id)
        this.setState(config, 'disconnected')
        this.scheduleReconnect(config)
      }

      client.onerror = (error: Error) => {
        logger.error(`[McpService] Server "${config.id}" error: ${error.message}`)
        this.updateState(config.id, { status: 'error', error: error.message })
      }

      await client.connect(transport)
      this.clients.set(config.id, client)

      await this.discoverAndRegisterTools(config.id, client)

      const toolCount = this.serverTools.get(config.id)?.length ?? 0
      this.updateState(config.id, { status: 'connected', error: undefined, toolCount })
      this.reconnectAttempts.delete(config.id)

      logger.info(`[McpService] Connected to "${config.id}" (${toolCount} tools)`)
    } catch (err: any) {
      logger.error(`[McpService] Failed to connect to "${config.id}": ${err.message}`)
      this.setState(config, 'error', err.message)
      this.scheduleReconnect(config)
    }
  }

  async disconnectServer(id: string): Promise<void> {
    this.cancelReconnect(id)
    this.unregisterToolsForServer(id)
    this.inProcessServers.delete(id)

    const client = this.clients.get(id)
    if (client) {
      try {
        await client.close()
      } catch (err: any) {
        logger.warn(`[McpService] Error closing "${id}": ${err.message}`)
      }
      this.clients.delete(id)
    }

    const state = this.states.get(id)
    if (state) {
      this.updateState(id, { status: 'disconnected', error: undefined, toolCount: 0 })
    }
  }

  async connectAll(): Promise<void> {
    const configs = await this.loadConfigs()
    const enabled = configs.filter((c) => c.enabled)
    if (enabled.length === 0) {
      logger.info('[McpService] No enabled MCP servers to connect')
      return
    }

    logger.info(`[McpService] Connecting to ${enabled.length} MCP server(s)...`)
    await Promise.allSettled(enabled.map((c) => this.connectServer(c)))
  }

  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.clients.keys())
    await Promise.allSettled(ids.map((id) => this.disconnectServer(id)))
  }

  // ---------------------------------------------------------------------------
  // In-process connection (for built-in MCP servers like Wikipedia)
  // ---------------------------------------------------------------------------

  async connectInProcess(id: string, name: string, clientTransport: Transport): Promise<void> {
    if (this.clients.has(id)) {
      await this.disconnectServer(id)
    }

    this.inProcessServers.add(id)

    const config: McpServerConfig = {
      id,
      name,
      transport: 'sse', // placeholder — not actually used
      enabled: true,
    }

    this.setState(config, 'connecting')

    try {
      const client = new Client({ name: 'babylon', version: '1.0.0' })

      client.onclose = () => {
        logger.info(`[McpService] In-process server "${id}" closed`)
        this.unregisterToolsForServer(id)
        this.clients.delete(id)
        this.setState(config, 'disconnected')
        // No reconnection for in-process servers
      }

      client.onerror = (error: Error) => {
        logger.error(`[McpService] In-process server "${id}" error: ${error.message}`)
        this.updateState(id, { status: 'error', error: error.message })
      }

      await client.connect(clientTransport)
      this.clients.set(id, client)

      await this.discoverAndRegisterTools(id, client)

      const toolCount = this.serverTools.get(id)?.length ?? 0
      this.updateState(id, { status: 'connected', error: undefined, toolCount })

      logger.info(`[McpService] In-process server "${id}" connected (${toolCount} tools)`)
    } catch (err: any) {
      logger.error(`[McpService] Failed to connect in-process server "${id}": ${err.message}`)
      this.setState(config, 'error', err.message)
    }
  }

  // ---------------------------------------------------------------------------
  // Tool discovery & registration
  // ---------------------------------------------------------------------------

  private async discoverAndRegisterTools(serverId: string, client: Client): Promise<void> {
    const result = await client.listTools()
    const toolNames: string[] = []

    for (const mcpTool of result.tools) {
      const namespacedName = this.namespacedToolName(serverId, mcpTool.name)

      const definition: Tool = {
        type: 'function',
        function: {
          name: namespacedName,
          description: mcpTool.description,
          parameters: mcpTool.inputSchema as Record<string, any>,
        },
      }

      const handler = this.createToolHandler(serverId, mcpTool.name)
      toolRegistry.register(definition, handler)
      toolNames.push(namespacedName)
    }

    this.serverTools.set(serverId, toolNames)
  }

  private unregisterToolsForServer(id: string): void {
    const tools = this.serverTools.get(id)
    if (!tools) return

    for (const name of tools) {
      toolRegistry.unregister(name)
    }
    this.serverTools.delete(id)
  }

  private createToolHandler(serverId: string, originalToolName: string): ToolHandler {
    return async (args: Record<string, any>): Promise<string> => {
      const client = this.clients.get(serverId)
      if (!client) {
        throw new Error(`MCP server "${serverId}" is not connected`)
      }

      const result = await client.callTool({ name: originalToolName, arguments: args })

      // MCP callTool returns { content: [...] } or { toolResult: unknown }
      if ('content' in result && Array.isArray(result.content)) {
        return result.content
          .map((item: any) => {
            if (item.type === 'text') return item.text
            if (item.type === 'image') return `[image: ${item.mimeType}]`
            if (item.type === 'resource') return JSON.stringify(item.resource)
            return JSON.stringify(item)
          })
          .join('\n')
      }

      if ('toolResult' in result) {
        return typeof result.toolResult === 'string'
          ? result.toolResult
          : JSON.stringify(result.toolResult)
      }

      return JSON.stringify(result)
    }
  }

  // ---------------------------------------------------------------------------
  // Server CRUD (for API)
  // ---------------------------------------------------------------------------

  async addServer(config: McpServerConfig): Promise<void> {
    const configs = await this.loadConfigs()
    if (configs.some((c) => c.id === config.id)) {
      throw new Error(`Server with id "${config.id}" already exists`)
    }
    configs.push(config)
    await this.saveConfigs(configs)

    if (config.enabled) {
      await this.connectServer(config)
    } else {
      this.setState(config, 'disconnected')
    }
  }

  async removeServer(id: string): Promise<void> {
    await this.disconnectServer(id)
    const configs = await this.loadConfigs()
    await this.saveConfigs(configs.filter((c) => c.id !== id))
    this.states.delete(id)
  }

  async updateServer(config: McpServerConfig): Promise<void> {
    const configs = await this.loadConfigs()
    const idx = configs.findIndex((c) => c.id === config.id)
    if (idx === -1) {
      throw new Error(`Server with id "${config.id}" not found`)
    }

    // Disconnect old, update config, reconnect if enabled
    await this.disconnectServer(config.id)
    configs[idx] = config
    await this.saveConfigs(configs)

    if (config.enabled) {
      await this.connectServer(config)
    } else {
      this.setState(config, 'disconnected')
    }
  }

  getServerStates(): McpServerState[] {
    return Array.from(this.states.values())
  }

  getServerState(id: string): McpServerState | undefined {
    return this.states.get(id)
  }

  // ---------------------------------------------------------------------------
  // Transport factory
  // ---------------------------------------------------------------------------

  private createTransport(config: McpServerConfig) {
    switch (config.transport) {
      case 'sse': {
        if (!config.url) throw new Error(`SSE server "${config.id}" requires a url`)
        const url = new URL(config.url)

        // Try StreamableHTTP first — if the server doesn't support it,
        // SSEClientTransport is the fallback for older servers
        if (config.url.endsWith('/mcp') || config.url.endsWith('/mcp/')) {
          return new StreamableHTTPClientTransport(url, {
            requestInit: config.headers
              ? { headers: config.headers }
              : undefined,
          })
        }

        return new SSEClientTransport(url, {
          eventSourceInit: config.headers
            ? { fetch: (input: string | URL | Request, init?: RequestInit) =>
                fetch(input, { ...init, headers: { ...init?.headers, ...config.headers } })
              }
            : undefined,
        })
      }

      case 'stdio': {
        if (!config.command) throw new Error(`Stdio server "${config.id}" requires a command`)
        return new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env,
        })
      }

      default:
        throw new Error(`Unknown transport type: ${config.transport}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Reconnection
  // ---------------------------------------------------------------------------

  private scheduleReconnect(config: McpServerConfig): void {
    if (!config.enabled || this.inProcessServers.has(config.id)) return
    this.cancelReconnect(config.id)

    const attempts = this.reconnectAttempts.get(config.id) ?? 0
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * Math.pow(2, attempts),
      MAX_RECONNECT_DELAY_MS,
    )

    logger.info(`[McpService] Reconnecting to "${config.id}" in ${delay}ms (attempt ${attempts + 1})`)

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(config.id)
      this.reconnectAttempts.set(config.id, attempts + 1)
      await this.connectServer(config)
    }, delay)

    this.reconnectTimers.set(config.id, timer)
  }

  private cancelReconnect(id: string): void {
    const timer = this.reconnectTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.reconnectTimers.delete(id)
    }
    this.reconnectAttempts.delete(id)
  }

  // ---------------------------------------------------------------------------
  // State helpers
  // ---------------------------------------------------------------------------

  private setState(config: McpServerConfig, status: McpServerStatus, error?: string): void {
    this.states.set(config.id, {
      config,
      status,
      error,
      toolCount: this.serverTools.get(config.id)?.length ?? 0,
    })
  }

  private updateState(id: string, updates: Partial<McpServerState>): void {
    const state = this.states.get(id)
    if (state) {
      Object.assign(state, updates)
    }
  }

  // ---------------------------------------------------------------------------
  // Naming helpers
  // ---------------------------------------------------------------------------

  private namespacedToolName(serverId: string, toolName: string): string {
    return `${serverId}${TOOL_NAME_SEPARATOR}${toolName}`
  }
}

export const mcpService = new McpService()
