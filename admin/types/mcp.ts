export const TOOL_NAME_SEPARATOR = '__'

export type McpTransportType = 'stdio' | 'sse'

export type McpServerConfig = {
  /** Short unique identifier, used as tool name prefix (e.g., "wiki", "files") */
  id: string
  /** Human-readable name for the UI */
  name: string
  /** Transport type */
  transport: McpTransportType
  /** For SSE: the server URL (e.g., "http://localhost:3001/sse") */
  url?: string
  /** For SSE: optional headers (e.g., Authorization) */
  headers?: Record<string, string>
  /** For stdio: the command to run (e.g., "npx") */
  command?: string
  /** For stdio: command arguments */
  args?: string[]
  /** For stdio: environment variables to pass to the child process */
  env?: Record<string, string>
  /** Whether this server should auto-connect on startup */
  enabled: boolean
}

export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export type McpServerState = {
  config: McpServerConfig
  status: McpServerStatus
  error?: string
  toolCount: number
}
