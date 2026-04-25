import type { HttpContext } from '@adonisjs/core/http'
import { mcpService } from '#services/mcp_service'
import { mcpServerConfigSchema } from '#validators/mcp'
import { toolRegistry } from '#services/tool_registry'
import { TOOL_NAME_SEPARATOR } from '../../types/mcp.js'

export default class McpController {
  /**
   * GET /api/mcp/servers — list all server configs with live status
   */
  async index({ response }: HttpContext) {
    const configs = await mcpService.loadConfigs()
    const states = mcpService.getServerStates()
    const stateMap = new Map(states.map((s) => [s.config.id, s]))

    const servers = configs.map((config) => {
      const state = stateMap.get(config.id)
      return {
        ...config,
        status: state?.status ?? 'disconnected',
        error: state?.error,
        toolCount: state?.toolCount ?? 0,
      }
    })

    return response.ok({ servers })
  }

  /**
   * POST /api/mcp/servers — add a new MCP server
   */
  async store({ request, response }: HttpContext) {
    const config = await request.validateUsing(mcpServerConfigSchema)
    try {
      await mcpService.addServer(config)
      const state = mcpService.getServerState(config.id)
      return response.created({
        ...config,
        status: state?.status ?? 'disconnected',
        error: state?.error,
        toolCount: state?.toolCount ?? 0,
      })
    } catch (err: any) {
      return response.conflict({ error: err.message })
    }
  }

  /**
   * PUT /api/mcp/servers/:id — update an existing server config
   */
  async update({ params, request, response }: HttpContext) {
    const config = await request.validateUsing(mcpServerConfigSchema)
    if (config.id !== params.id) {
      return response.badRequest({ error: 'Server id in body must match URL param' })
    }
    try {
      await mcpService.updateServer(config)
      const state = mcpService.getServerState(config.id)
      return response.ok({
        ...config,
        status: state?.status ?? 'disconnected',
        error: state?.error,
        toolCount: state?.toolCount ?? 0,
      })
    } catch (err: any) {
      return response.notFound({ error: err.message })
    }
  }

  /**
   * DELETE /api/mcp/servers/:id — remove a server
   */
  async destroy({ params, response }: HttpContext) {
    await mcpService.removeServer(params.id)
    return response.noContent()
  }

  /**
   * POST /api/mcp/servers/:id/connect — manually connect a server
   */
  async connect({ params, response }: HttpContext) {
    const configs = await mcpService.loadConfigs()
    const config = configs.find((c) => c.id === params.id)
    if (!config) {
      return response.notFound({ error: `Server "${params.id}" not found` })
    }
    await mcpService.connectServer(config)
    const state = mcpService.getServerState(params.id)
    return response.ok({
      status: state?.status ?? 'disconnected',
      error: state?.error,
      toolCount: state?.toolCount ?? 0,
    })
  }

  /**
   * POST /api/mcp/servers/:id/disconnect — manually disconnect a server
   */
  async disconnect({ params, response }: HttpContext) {
    await mcpService.disconnectServer(params.id)
    return response.ok({ status: 'disconnected' })
  }

  /**
   * GET /api/mcp/tools — list all MCP-registered tools (debug endpoint)
   */
  async tools({ response }: HttpContext) {
    const allTools = toolRegistry.getDefinitions()
    const mcpTools = allTools.filter((t) => t.function.name.includes(TOOL_NAME_SEPARATOR))
    return response.ok({
      tools: mcpTools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    })
  }
}
