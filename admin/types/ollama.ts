export type BabylonOllamaModel = {
  id: string
  name: string
  description: string
  estimated_pulls: string
  model_last_updated: string
  first_seen: string
  tags: BabylonOllamaModelTag[]
}

export type BabylonOllamaModelTag = {
  name: string
  size: string
  context: string
  input: string
  cloud: boolean
  thinking: boolean
}

export type BabylonOllamaModelAPIResponse = {
  success: boolean
  message: string
  models: BabylonOllamaModel[]
}

export type ToolFunction = {
  name: string
  description?: string
  parameters?: Record<string, any>
}

export type Tool = {
  type: 'function'
  function: ToolFunction
}

export type ToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string // JSON string
  }
}

export type OllamaChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export type OllamaChatRequest = {
  model: string
  messages: OllamaChatMessage[]
  stream?: boolean
  sessionId?: number
  tools?: Tool[]
}

export type OllamaChatResponse = {
  model: string
  created_at: string
  message: {
    role: string
    content: string
  }
  done: boolean
}

export type BabylonInstalledModel = {
  name: string
  size: number
  digest?: string
  details?: Record<string, any>
}

export type BabylonChatResponse = {
  message: { content: string; thinking?: string }
  done: boolean
  model: string
}
