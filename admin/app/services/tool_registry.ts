import type { Tool } from '../../types/ollama.js'

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
    this.tools.set(definition.function.name, { definition, handler })
  }

  unregister(name: string): void {
    this.tools.delete(name)
  }

  unregisterAll(): void {
    this.tools.clear()
  }

  async execute(name: string, args: Record<string, any>): Promise<string> {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`Unknown tool: "${name}"`)
    return tool.handler(args)
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
