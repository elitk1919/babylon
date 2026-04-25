import type { Tool } from '../../types/ollama.js'
import logger from '@adonisjs/core/services/logger'

export type ToolHandler = (args: Record<string, any>) => Promise<string>

type RegisteredTool = {
  definition: Tool
  handler: ToolHandler
}

/**
 * Central registry for tools available to the AI.
 * MCP service will register tools here on startup and when servers connect/disconnect.
 */
class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map()

  register(definition: Tool, handler: ToolHandler): void {
    logger.info(`[ToolRegistry] Registered tool: "${definition.function.name}"`)
    this.tools.set(definition.function.name, { definition, handler })
  }

  unregister(name: string): void {
    logger.info(`[ToolRegistry] Unregistered tool: "${name}"`)
    this.tools.delete(name)
  }

  unregisterAll(): void {
    logger.info(`[ToolRegistry] Unregistered all tools (${this.tools.size} removed)`)
    this.tools.clear()
  }

  async execute(name: string, args: Record<string, any>): Promise<string> {
    const tool = this.tools.get(name)
    if (!tool) {
      logger.warn(`[ToolRegistry] Attempted to execute unknown tool: "${name}"`)
      throw new Error(`Unknown tool: "${name}"`)
    }
    logger.info(`[ToolRegistry] Executing tool: "${name}"`, { args: Object.keys(args) })
    try {
      const result = await tool.handler(args)
      logger.info(`[ToolRegistry] Tool "${name}" completed (${result.length} chars)`)
      return result
    } catch (err) {
      logger.error(`[ToolRegistry] Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
  }

  getDefinitions(): Tool[] {
    return Array.from(this.tools.values()).map((t) => t.definition)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  get size(): number {
    return this.tools.size
  }
}

export const toolRegistry = new ToolRegistry()
