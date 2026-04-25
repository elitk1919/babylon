import logger from '@adonisjs/core/services/logger'
import type { ApplicationService } from '@adonisjs/core/types'

/**
 * Loads saved MCP server configs from KVStore on startup and connects to
 * all enabled servers. Disconnects cleanly on shutdown.
 */
export default class McpProvider {
  constructor(protected app: ApplicationService) {}

  async boot() {
    if (this.app.getEnvironment() !== 'web') return

    setImmediate(async () => {
      try {
        const { mcpService } = await import('#services/mcp_service')
        await mcpService.connectAll()
        logger.info('[McpProvider] MCP servers initialized')
      } catch (err: any) {
        logger.error(`[McpProvider] Failed to initialize MCP servers: ${err.message}`)
      }
    })
  }

  async shutdown() {
    try {
      const { mcpService } = await import('#services/mcp_service')
      await mcpService.disconnectAll()
      logger.info('[McpProvider] MCP servers disconnected')
    } catch (err: any) {
      logger.error(`[McpProvider] Error during MCP shutdown: ${err.message}`)
    }
  }
}
