import { inject } from '@adonisjs/core'
import OpenAI from 'openai'
import type { ChatCompletionChunk, ChatCompletionMessageParam } from 'openai/resources/chat/completions.js'
import type { Stream } from 'openai/streaming.js'
import { BabylonOllamaModel, Tool, ToolCall } from '../../types/ollama.js'
import { FALLBACK_RECOMMENDED_OLLAMA_MODELS } from '../../constants/ollama.js'
import { toolRegistry } from './tool_registry.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '@adonisjs/core/services/logger'
import axios from 'axios'
import { DownloadModelJob } from '#jobs/download_model_job'
import { SERVICE_NAMES } from '../../constants/service_names.js'
import transmit from '@adonisjs/transmit/services/main'
import Fuse, { IFuseOptions } from 'fuse.js'
import { BROADCAST_CHANNELS } from '../../constants/broadcast.js'
import env from '#start/env'
import { BABYLON_API_DEFAULT_BASE_URL } from '../../constants/misc.js'
import KVStore from '#models/kv_store'

const BABYLON_MODELS_API_PATH = '/api/v1/ollama/models'
const MAX_TOOL_ITERATIONS = 10
const MODELS_CACHE_FILE = path.join(process.cwd(), 'storage', 'ollama-models-cache.json')
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

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

export type BabylonChatStreamChunk = {
  message: { content: string; thinking?: string }
  done: boolean
  tool_calls?: ToolCall[]
  tool_result?: { tool_call_id: string; name: string; result: string }
}

type ChatInput = {
  model: string
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
    tool_calls?: ToolCall[]
    tool_call_id?: string
  }>
  think?: boolean | 'medium'
  stream?: boolean
  numCtx?: number
  tools?: Tool[]
}

@inject()
export class OllamaService {
  private openai: OpenAI | null = null
  private baseUrl: string | null = null
  private initPromise: Promise<void> | null = null
  private isOllamaNative: boolean | null = null

  constructor() {}

  private async _initialize() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        // Check KVStore for a custom base URL (remote Ollama, LM Studio, llama.cpp, etc.)
        const customUrl = (await KVStore.getValue('ai.remoteOllamaUrl')) as string | null
        if (customUrl && customUrl.trim()) {
          this.baseUrl = customUrl.trim().replace(/\/$/, '')
        } else {
          // Fall back to the local Ollama container managed by Docker
          const dockerService = new (await import('./docker_service.js')).DockerService()
          const ollamaUrl = await dockerService.getServiceURL(SERVICE_NAMES.OLLAMA)
          if (!ollamaUrl) {
            throw new Error('Ollama service is not installed or running.')
          }
          this.baseUrl = ollamaUrl.trim().replace(/\/$/, '')
        }

        this.openai = new OpenAI({
          apiKey: 'babylon', // Required by SDK; not validated by Ollama/LM Studio/llama.cpp
          baseURL: `${this.baseUrl}/v1`,
        })
      })()
    }
    return this.initPromise
  }

  private async _ensureDependencies() {
    if (!this.openai) {
      await this._initialize()
    }
  }

  /**
   * Downloads a model from Ollama with progress tracking. Only works with Ollama backends.
   * Use dispatchModelDownload() for background job processing where possible.
   */
  async downloadModel(
    model: string,
    progressCallback?: (percent: number) => void
  ): Promise<{ success: boolean; message: string; retryable?: boolean }> {
    await this._ensureDependencies()
    if (!this.baseUrl) {
      return { success: false, message: 'AI service is not initialized.' }
    }

    try {
      // See if model is already installed
      const installedModels = await this.getModels()
      if (installedModels && installedModels.some((m) => m.name === model)) {
        logger.info(`[OllamaService] Model "${model}" is already installed.`)
        return { success: true, message: 'Model is already installed.' }
      }

      // Model pulling is an Ollama-only operation. Non-Ollama backends (LM Studio, llama.cpp, etc.)
      // return HTTP 200 for unknown endpoints, so the pull would appear to succeed but do nothing.
      if (this.isOllamaNative === false) {
        logger.warn(
          `[OllamaService] Non-Ollama backend detected — skipping model pull for "${model}". Load the model manually in your AI host.`
        )
        return {
          success: false,
          message: `Model "${model}" is not available in your AI host. Please load it manually (model pulling is only supported for Ollama backends).`,
        }
      }

      // Stream pull via Ollama native API
      const pullResponse = await axios.post(
        `${this.baseUrl}/api/pull`,
        { model, stream: true },
        { responseType: 'stream', timeout: 0 }
      )

      await new Promise<void>((resolve, reject) => {
        let buffer = ''
        pullResponse.data.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const parsed = JSON.parse(line)
              if (parsed.completed && parsed.total) {
                const percent = parseFloat(((parsed.completed / parsed.total) * 100).toFixed(2))
                this.broadcastDownloadProgress(model, percent)
                if (progressCallback) progressCallback(percent)
              }
            } catch {
              // ignore parse errors on partial lines
            }
          }
        })
        pullResponse.data.on('end', resolve)
        pullResponse.data.on('error', reject)
      })

      logger.info(`[OllamaService] Model "${model}" downloaded successfully.`)
      return { success: true, message: 'Model downloaded successfully.' }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error(
        `[OllamaService] Failed to download model "${model}": ${errorMessage}`
      )

      // Check for version mismatch (Ollama 412 response)
      const isVersionMismatch = errorMessage.includes('newer version of Ollama')
      const userMessage = isVersionMismatch
        ? 'This model requires a newer version of Ollama. Please update AI Assistant from the Apps page.'
        : `Failed to download model: ${errorMessage}`

      // Broadcast failure to connected clients so UI can show the error
      this.broadcastDownloadError(model, userMessage)

      return { success: false, message: userMessage, retryable: !isVersionMismatch }
    }
  }

  async dispatchModelDownload(modelName: string): Promise<{ success: boolean; message: string }> {
    try {
      logger.info(`[OllamaService] Dispatching model download for ${modelName} via job queue`)

      await DownloadModelJob.dispatch({
        modelName,
      })

      return {
        success: true,
        message:
          'Model download has been queued successfully. It will start shortly after Ollama and Open WebUI are ready (if not already).',
      }
    } catch (error) {
      logger.error(
        `[OllamaService] Failed to dispatch model download for ${modelName}: ${error instanceof Error ? error.message : error}`
      )
      return {
        success: false,
        message: 'Failed to queue model download. Please try again.',
      }
    }
  }

  public async chat(chatRequest: ChatInput): Promise<BabylonChatResponse> {
    await this._ensureDependencies()
    if (!this.openai) {
      throw new Error('AI client is not initialized.')
    }

    const messages = [...chatRequest.messages] as ChatCompletionMessageParam[]
    let toolIterations = 0

    // Tool execution loop — runs until the model stops calling tools or limit reached
    while (true) {
      const params: any = {
        model: chatRequest.model,
        messages,
        stream: false,
      }
      if (chatRequest.think) params.think = chatRequest.think
      if (chatRequest.numCtx) params.num_ctx = chatRequest.numCtx
      if (chatRequest.tools?.length) params.tools = chatRequest.tools

      const response = await this.openai.chat.completions.create(params)
      const choice = response.choices[0]

      if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls?.length) {
        toolIterations++
        if (toolIterations > MAX_TOOL_ITERATIONS) {
          logger.warn(`[OllamaService] Max tool iterations (${MAX_TOOL_ITERATIONS}) reached, stopping loop`)
          return {
            message: { content: 'Tool execution limit reached. Please try a simpler request.' },
            done: true,
            model: response.model,
          }
        }

        messages.push(choice.message as ChatCompletionMessageParam)

        for (const tc of choice.message.tool_calls) {
          if (tc.type !== 'function') continue
          const fn = (tc as any).function as { name: string; arguments: string }
          let result: string
          try {
            const args = JSON.parse(fn.arguments || '{}')
            result = await toolRegistry.execute(fn.name, args)
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`
            logger.warn(`[OllamaService] Tool "${fn.name}" failed: ${result}`)
          }
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result! } as any)
        }

        continue
      }

      return {
        message: {
          content: choice.message.content ?? '',
          thinking: (choice.message as any).thinking ?? undefined,
        },
        done: true,
        model: response.model,
      }
    }
  }

  public async chatStream(chatRequest: ChatInput): Promise<AsyncIterable<BabylonChatStreamChunk>> {
    await this._ensureDependencies()
    if (!this.openai) {
      throw new Error('AI client is not initialized.')
    }

    const openai = this.openai
    const loggerRef = logger

    // Returns how many trailing chars of `text` could be the start of `tag`
    function partialTagSuffix(tag: string, text: string): number {
      for (let len = Math.min(tag.length - 1, text.length); len >= 1; len--) {
        if (text.endsWith(tag.slice(0, len))) return len
      }
      return 0
    }

    async function* streamWithThinkParsing(
      rawStream: Stream<ChatCompletionChunk>,
      toolCallsAcc: Map<number, { id: string; name: string; arguments: string }>
    ): AsyncGenerator<BabylonChatStreamChunk> {
      // Stateful parser for <think>...</think> tags that may be split across chunks.
      // Ollama provides thinking natively via delta.thinking; OpenAI-compatible backends
      // (LM Studio, llama.cpp, etc.) embed them inline in delta.content.
      let tagBuffer = ''
      let inThink = false

      for await (const chunk of rawStream) {
        const delta = chunk.choices[0]?.delta

        // Accumulate tool call deltas for later execution
        if ((delta as any)?.tool_calls) {
          for (const tc of (delta as any).tool_calls) {
            if (!toolCallsAcc.has(tc.index)) {
              toolCallsAcc.set(tc.index, { id: '', name: '', arguments: '' })
            }
            const acc = toolCallsAcc.get(tc.index)!
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name += tc.function.name
            if (tc.function?.arguments) acc.arguments += tc.function.arguments
          }
        }

        const nativeThinking: string = (delta as any)?.thinking ?? ''
        const rawContent: string = delta?.content ?? ''

        tagBuffer += rawContent
        let parsedContent = ''
        let parsedThinking = ''

        while (tagBuffer.length > 0) {
          if (inThink) {
            const closeIdx = tagBuffer.indexOf('</think>')
            if (closeIdx !== -1) {
              parsedThinking += tagBuffer.slice(0, closeIdx)
              tagBuffer = tagBuffer.slice(closeIdx + 8)
              inThink = false
            } else {
              const hold = partialTagSuffix('</think>', tagBuffer)
              parsedThinking += tagBuffer.slice(0, tagBuffer.length - hold)
              tagBuffer = tagBuffer.slice(tagBuffer.length - hold)
              break
            }
          } else {
            const openIdx = tagBuffer.indexOf('<think>')
            if (openIdx !== -1) {
              parsedContent += tagBuffer.slice(0, openIdx)
              tagBuffer = tagBuffer.slice(openIdx + 7)
              inThink = true
            } else {
              const hold = partialTagSuffix('<think>', tagBuffer)
              parsedContent += tagBuffer.slice(0, tagBuffer.length - hold)
              tagBuffer = tagBuffer.slice(tagBuffer.length - hold)
              break
            }
          }
        }

        const finishReason = chunk.choices[0]?.finish_reason
        yield {
          message: { content: parsedContent, thinking: nativeThinking + parsedThinking || undefined },
          done: finishReason !== null && finishReason !== undefined && finishReason !== 'tool_calls',
        }
      }
    }

    async function* toolLoop(): AsyncGenerator<BabylonChatStreamChunk> {
      const messages = [...chatRequest.messages] as ChatCompletionMessageParam[]
      let toolIterations = 0

      while (true) {
        const params: any = {
          model: chatRequest.model,
          messages,
          stream: true,
        }
        if (chatRequest.think) params.think = chatRequest.think
        if (chatRequest.numCtx) params.num_ctx = chatRequest.numCtx
        if (chatRequest.tools?.length) params.tools = chatRequest.tools

        const rawStream = (await openai.chat.completions.create(params)) as unknown as Stream<ChatCompletionChunk>
        const toolCallsAcc = new Map<number, { id: string; name: string; arguments: string }>()
        let lastFinishReason: string | null = null

        // Stream content chunks to client, accumulating any tool calls in parallel
        for await (const chunk of streamWithThinkParsing(rawStream, toolCallsAcc)) {
          yield chunk
          if (chunk.done) lastFinishReason = 'stop'
        }

        // If tool calls were requested, execute them and continue the loop
        if (toolCallsAcc.size > 0 && lastFinishReason !== 'stop') {
          toolIterations++
          if (toolIterations > MAX_TOOL_ITERATIONS) {
            loggerRef.warn(`[OllamaService] Max tool iterations (${MAX_TOOL_ITERATIONS}) reached, stopping loop`)
            yield { message: { content: 'Tool execution limit reached. Please try a simpler request.' }, done: true }
            return
          }
          const toolCalls: ToolCall[] = Array.from(toolCallsAcc.values()).map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          }))

          // Yield tool_calls chunk so the UI knows what's being invoked
          yield { message: { content: '' }, done: false, tool_calls: toolCalls }

          // Add assistant message with tool calls to history
          messages.push({ role: 'assistant', content: '', tool_calls: toolCalls } as any)

          // Execute each tool and stream results back to the UI
          for (const tc of toolCalls) {
            let result: string
            try {
              const args = JSON.parse(tc.function.arguments || '{}')
              result = await toolRegistry.execute(tc.function.name, args)
            } catch (err) {
              result = `Error: ${err instanceof Error ? err.message : String(err)}`
              loggerRef.warn(`[OllamaService] Tool "${tc.function.name}" failed: ${result}`)
            }

            yield { message: { content: '' }, done: false, tool_result: { tool_call_id: tc.id, name: tc.function.name, result } }
            messages.push({ role: 'tool', tool_call_id: tc.id, content: result } as any)
          }

          // Continue loop — model will respond using the tool results
          continue
        }

        // No tool calls, stream is complete
        return
      }
    }

    return toolLoop()
  }

  public async checkModelHasThinking(modelName: string): Promise<boolean> {
    await this._ensureDependencies()
    if (!this.baseUrl) return false

    try {
      const response = await axios.post(
        `${this.baseUrl}/api/show`,
        { model: modelName },
        { timeout: 5000 }
      )
      return Array.isArray(response.data?.capabilities) && response.data.capabilities.includes('thinking')
    } catch {
      // Non-Ollama backends don't expose /api/show — assume no thinking support
      return false
    }
  }

  public async deleteModel(modelName: string): Promise<{ success: boolean; message: string }> {
    await this._ensureDependencies()
    if (!this.baseUrl) {
      return { success: false, message: 'AI service is not initialized.' }
    }

    try {
      await axios.delete(`${this.baseUrl}/api/delete`, {
        data: { model: modelName },
        timeout: 10000,
      })
      return { success: true, message: `Model "${modelName}" deleted.` }
    } catch (error) {
      logger.error(
        `[OllamaService] Failed to delete model "${modelName}": ${error instanceof Error ? error.message : error}`
      )
      return { success: false, message: 'Failed to delete model. This may not be an Ollama backend.' }
    }
  }

  /**
   * Generate embeddings for the given input strings.
   * Tries the Ollama native /api/embed endpoint first, falls back to /v1/embeddings.
   */
  public async embed(model: string, input: string[]): Promise<{ embeddings: number[][] }> {
    await this._ensureDependencies()
    if (!this.baseUrl || !this.openai) {
      throw new Error('AI service is not initialized.')
    }

    try {
      // Prefer Ollama native endpoint (supports batch input natively)
      const response = await axios.post(
        `${this.baseUrl}/api/embed`,
        { model, input },
        { timeout: 60000 }
      )
      // Some backends (e.g. LM Studio) return HTTP 200 for unknown endpoints with an incompatible
      // body — validate explicitly before accepting the result.
      if (!Array.isArray(response.data?.embeddings)) {
        throw new Error('Invalid /api/embed response — missing embeddings array')
      }
      return { embeddings: response.data.embeddings }
    } catch {
      // Fall back to OpenAI-compatible /v1/embeddings
      // Explicitly request float format — some backends (e.g. LM Studio) don't reliably
      // implement the base64 encoding the OpenAI SDK requests by default.
      logger.info('[OllamaService] /api/embed unavailable, falling back to /v1/embeddings')
      const results = await this.openai.embeddings.create({ model, input, encoding_format: 'float' })
      return { embeddings: results.data.map((e) => e.embedding as number[]) }
    }
  }

  public async getModels(includeEmbeddings = false): Promise<BabylonInstalledModel[]> {
    await this._ensureDependencies()
    if (!this.baseUrl) {
      throw new Error('AI service is not initialized.')
    }

    try {
      // Prefer the Ollama native endpoint which includes size and metadata
      const response = await axios.get(`${this.baseUrl}/api/tags`, { timeout: 5000 })
      // LM Studio returns HTTP 200 for unknown endpoints with an incompatible body — validate explicitly
      if (!Array.isArray(response.data?.models)) {
        throw new Error('Not an Ollama-compatible /api/tags response')
      }
      this.isOllamaNative = true
      const models: BabylonInstalledModel[] = response.data.models
      if (includeEmbeddings) return models
      return models.filter((m) => !m.name.includes('embed'))
    } catch {
      // Fall back to the OpenAI-compatible /v1/models endpoint (LM Studio, llama.cpp, etc.)
      this.isOllamaNative = false
      logger.info('[OllamaService] /api/tags unavailable, falling back to /v1/models')
      try {
        const modelList = await this.openai!.models.list()
        const models: BabylonInstalledModel[] = modelList.data.map((m) => ({ name: m.id, size: 0 }))
        if (includeEmbeddings) return models
        return models.filter((m) => !m.name.includes('embed'))
      } catch (err) {
        logger.error(
          `[OllamaService] Failed to list models: ${err instanceof Error ? err.message : err}`
        )
        return []
      }
    }
  }

  async getAvailableModels(
    {
      sort,
      recommendedOnly,
      query,
      limit,
      force,
    }: {
      sort?: 'pulls' | 'name'
      recommendedOnly?: boolean
      query: string | null
      limit?: number
      force?: boolean
    } = {
      sort: 'pulls',
      recommendedOnly: false,
      query: null,
      limit: 15,
    }
  ): Promise<{ models: BabylonOllamaModel[]; hasMore: boolean } | null> {
    try {
      const models = await this.retrieveAndRefreshModels(sort, force)
      if (!models) {
        logger.warn(
          '[OllamaService] Returning fallback recommended models due to failure in fetching available models'
        )
        return {
          models: FALLBACK_RECOMMENDED_OLLAMA_MODELS,
          hasMore: false,
        }
      }

      if (!recommendedOnly) {
        const filteredModels = query ? this.fuseSearchModels(models, query) : models
        return {
          models: filteredModels.slice(0, limit || 15),
          hasMore: filteredModels.length > (limit || 15),
        }
      }

      const sortedByPulls = sort === 'pulls' ? models : this.sortModels(models, 'pulls')
      const firstThree = sortedByPulls.slice(0, 3)

      const recommendedModels = firstThree.map((model) => {
        return {
          ...model,
          tags: model.tags && model.tags.length > 0 ? [model.tags[0]] : [],
        }
      })

      if (query) {
        const filteredRecommendedModels = this.fuseSearchModels(recommendedModels, query)
        return {
          models: filteredRecommendedModels,
          hasMore: filteredRecommendedModels.length > (limit || 15),
        }
      }

      return {
        models: recommendedModels,
        hasMore: recommendedModels.length > (limit || 15),
      }
    } catch (error) {
      logger.error(
        `[OllamaService] Failed to get available models: ${error instanceof Error ? error.message : error}`
      )
      return null
    }
  }

  private async retrieveAndRefreshModels(
    sort?: 'pulls' | 'name',
    force?: boolean
  ): Promise<BabylonOllamaModel[] | null> {
    try {
      if (!force) {
        const cachedModels = await this.readModelsFromCache()
        if (cachedModels) {
          logger.info('[OllamaService] Using cached available models data')
          return this.sortModels(cachedModels, sort)
        }
      } else {
        logger.info('[OllamaService] Force refresh requested, bypassing cache')
      }

      logger.info('[OllamaService] Fetching fresh available models from API')

      const baseUrl = env.get('BABYLON_API_URL') || BABYLON_API_DEFAULT_BASE_URL
      const fullUrl = new URL(BABYLON_MODELS_API_PATH, baseUrl).toString()

      const response = await axios.get(fullUrl)
      if (!response.data || !Array.isArray(response.data.models)) {
        logger.warn(
          `[OllamaService] Invalid response format when fetching available models: ${JSON.stringify(response.data)}`
        )
        return null
      }

      const rawModels = response.data.models as BabylonOllamaModel[]

      const noCloud = rawModels
        .map((model) => ({
          ...model,
          tags: model.tags.filter((tag) => !tag.cloud),
        }))
        .filter((model) => model.tags.length > 0)

      await this.writeModelsToCache(noCloud)
      return this.sortModels(noCloud, sort)
    } catch (error) {
      logger.error(
        `[OllamaService] Failed to retrieve models from Babylon API: ${error instanceof Error ? error.message : error}`
      )
      return null
    }
  }

  private async readModelsFromCache(): Promise<BabylonOllamaModel[] | null> {
    try {
      const stats = await fs.stat(MODELS_CACHE_FILE)
      const cacheAge = Date.now() - stats.mtimeMs

      if (cacheAge > CACHE_MAX_AGE_MS) {
        logger.info('[OllamaService] Cache is stale, will fetch fresh data')
        return null
      }

      const cacheData = await fs.readFile(MODELS_CACHE_FILE, 'utf-8')
      const models = JSON.parse(cacheData) as BabylonOllamaModel[]

      if (!Array.isArray(models)) {
        logger.warn('[OllamaService] Invalid cache format, will fetch fresh data')
        return null
      }

      return models
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(
          `[OllamaService] Error reading cache: ${error instanceof Error ? error.message : error}`
        )
      }
      return null
    }
  }

  private async writeModelsToCache(models: BabylonOllamaModel[]): Promise<void> {
    try {
      await fs.mkdir(path.dirname(MODELS_CACHE_FILE), { recursive: true })
      await fs.writeFile(MODELS_CACHE_FILE, JSON.stringify(models, null, 2), 'utf-8')
      logger.info('[OllamaService] Successfully cached available models')
    } catch (error) {
      logger.warn(
        `[OllamaService] Failed to write models cache: ${error instanceof Error ? error.message : error}`
      )
    }
  }

  private sortModels(models: BabylonOllamaModel[], sort?: 'pulls' | 'name'): BabylonOllamaModel[] {
    if (sort === 'pulls') {
      models.sort((a, b) => {
        const parsePulls = (pulls: string) => {
          const multiplier = pulls.endsWith('K')
            ? 1_000
            : pulls.endsWith('M')
              ? 1_000_000
              : pulls.endsWith('B')
                ? 1_000_000_000
                : 1
          return parseFloat(pulls) * multiplier
        }
        return parsePulls(b.estimated_pulls) - parsePulls(a.estimated_pulls)
      })
    } else if (sort === 'name') {
      models.sort((a, b) => a.name.localeCompare(b.name))
    }

    models.forEach((model) => {
      if (model.tags && Array.isArray(model.tags)) {
        model.tags.sort((a, b) => {
          const parseSize = (size: string) => {
            const multiplier = size.endsWith('KB')
              ? 1 / 1_000
              : size.endsWith('MB')
                ? 1 / 1_000_000
                : size.endsWith('GB')
                  ? 1
                  : size.endsWith('TB')
                    ? 1_000
                    : 0
            return parseFloat(size) * multiplier
          }
          return parseSize(a.size) - parseSize(b.size)
        })
      }
    })

    return models
  }

  private broadcastDownloadError(model: string, error: string) {
    transmit.broadcast(BROADCAST_CHANNELS.OLLAMA_MODEL_DOWNLOAD, {
      model,
      percent: -1,
      error,
      timestamp: new Date().toISOString(),
    })
  }

  private broadcastDownloadProgress(model: string, percent: number) {
    transmit.broadcast(BROADCAST_CHANNELS.OLLAMA_MODEL_DOWNLOAD, {
      model,
      percent,
      timestamp: new Date().toISOString(),
    })
    logger.info(`[OllamaService] Download progress for model "${model}": ${percent}%`)
  }

  private fuseSearchModels(models: BabylonOllamaModel[], query: string): BabylonOllamaModel[] {
    const options: IFuseOptions<BabylonOllamaModel> = {
      ignoreDiacritics: true,
      keys: ['name', 'description', 'tags.name'],
      threshold: 0.3,
    }

    const fuse = new Fuse(models, options)

    return fuse.search(query).map((result) => result.item)
  }
}
