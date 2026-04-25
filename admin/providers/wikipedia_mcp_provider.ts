import logger from '@adonisjs/core/services/logger'
import type { ApplicationService } from '@adonisjs/core/types'

/**
 * Boots the built-in Wikipedia MCP server and wires it to the MCP client
 * via in-process transport. Must load after McpProvider.
 */
export default class WikipediaMcpProvider {
  constructor(protected app: ApplicationService) {}

  async boot() {
    if (this.app.getEnvironment() !== 'web') return

    setImmediate(async () => {
      try {
        const { wikipediaMcpServer } = await import('#services/wikipedia_mcp_server')
        const clientTransport = await wikipediaMcpServer.initialize()

        const { mcpService } = await import('#services/mcp_service')
        await mcpService.connectInProcess('wikipedia', 'Wikipedia (Local)', clientTransport)

        logger.info('[WikipediaMcpProvider] Wikipedia MCP server initialized')
      } catch (err: any) {
        logger.error(`[WikipediaMcpProvider] Failed to initialize: ${err.message}`)
      }
    })
  }

  async shutdown() {
    try {
      const { mcpService } = await import('#services/mcp_service')
      await mcpService.disconnectServer('wikipedia')

      const { wikipediaMcpServer } = await import('#services/wikipedia_mcp_server')
      await wikipediaMcpServer.shutdown()

      logger.info('[WikipediaMcpProvider] Wikipedia MCP server shut down')
    } catch (err: any) {
      logger.error(`[WikipediaMcpProvider] Error during shutdown: ${err.message}`)
    }
  }
}
