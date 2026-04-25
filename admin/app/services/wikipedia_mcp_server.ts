import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import * as cheerio from 'cheerio'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as http from 'node:http'
import logger from '@adonisjs/core/services/logger'
import { ZIM_STORAGE_PATH } from '../utils/fs.js'
import type { Archive, Searcher } from '@openzim/libzim'

const MAX_ARTICLE_LENGTH = 50_000
const MAX_SEARCH_RESULTS = 25
const DEFAULT_SEARCH_RESULTS = 10
const DEBUG_SSE_PORT = 3100

class WikipediaMcpServer {
  private mcpServer: McpServer | null = null
  private httpServer: http.Server | null = null
  private archives: Map<string, Archive> = new Map()
  private searcher: Searcher | null = null
  private libzim: typeof import('@openzim/libzim') | null = null

  /**
   * Initialize the MCP server and return the client-side transport for connecting.
   * Also starts a debug SSE server on port 3100 for MCP Inspector.
   */
  async initialize(): Promise<InMemoryTransport> {
    // Primary in-process server
    this.mcpServer = new McpServer(
      { name: 'babylon-wikipedia', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    this.registerTools(this.mcpServer)

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    await this.mcpServer.connect(serverTransport)

    // Debug SSE server for MCP Inspector
    await this.startDebugServer()

    logger.info('[WikipediaMcpServer] Server initialized')
    return clientTransport
  }

  async shutdown(): Promise<void> {
    await this.stopDebugServer()
    if (this.mcpServer) {
      await this.mcpServer.close()
      this.mcpServer = null
    }
    this.searcher = null
    this.archives.clear()
    this.libzim = null
    logger.info('[WikipediaMcpServer] Server shut down')
  }

  private async startDebugServer(): Promise<void> {
    // Map of sessionId -> transport for routing POST messages
    const transports = new Map<string, SSEServerTransport>()

    this.httpServer = http.createServer(async (req, res) => {
      // CORS headers for Inspector
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', '*')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method === 'GET' && req.url === '/sse') {
        // Each SSE connection gets its own McpServer + transport
        const server = new McpServer(
          { name: 'babylon-wikipedia', version: '1.0.0' },
          { capabilities: { tools: {} } },
        )
        this.registerTools(server)

        const transport = new SSEServerTransport('/messages', res)
        transports.set(transport.sessionId, transport)

        transport.onclose = () => {
          transports.delete(transport.sessionId)
        }

        await server.connect(transport)
        return
      }

      if (req.method === 'POST') {
        const url = new URL(req.url ?? '', `http://localhost:${DEBUG_SSE_PORT}`)
        if (url.pathname === '/messages') {
          const sessionId = url.searchParams.get('sessionId')
          const transport = sessionId ? transports.get(sessionId) : undefined
          if (!transport) {
            res.writeHead(400)
            res.end('Unknown session')
            return
          }
          await transport.handlePostMessage(req, res)
          return
        }
      }

      res.writeHead(404)
      res.end('Not found')
    })

    this.httpServer.listen(DEBUG_SSE_PORT, '0.0.0.0', () => {
      logger.info(`[WikipediaMcpServer] Debug SSE server listening on port ${DEBUG_SSE_PORT}`)
    })
  }

  private async stopDebugServer(): Promise<void> {
    if (this.httpServer) {
      this.httpServer.close()
      this.httpServer = null
    }
  }

  // ---------------------------------------------------------------------------
  // Tool registration
  // ---------------------------------------------------------------------------

  private registerTools(server: McpServer): void {
    server.registerTool(
      'search',
      {
        title: 'Search Wikipedia',
        description:
          'Full-text search across local Wikipedia archives. Returns titles, snippets, and paths for matching articles.',
        inputSchema: {
          query: z.string().describe('Search query'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_SEARCH_RESULTS)
            .optional()
            .describe(`Max results (default ${DEFAULT_SEARCH_RESULTS}, max ${MAX_SEARCH_RESULTS})`),
        },
      },
      async (args) => {
        return await this.handleSearch(args.query, args.limit ?? DEFAULT_SEARCH_RESULTS)
      },
    )

    server.registerTool(
      'read_article',
      {
        title: 'Read Wikipedia Article',
        description:
          'Read a Wikipedia article by its path. Use search first to find article paths.',
        inputSchema: {
          path: z.string().describe('Article path (from search results)'),
          format: z
            .enum(['text', 'html'])
            .optional()
            .describe('Output format: "text" (default, clean plaintext) or "html" (raw HTML)'),
        },
      },
      async (args) => {
        return await this.handleReadArticle(args.path, args.format ?? 'text')
      },
    )

    server.registerTool(
      'list_archives',
      {
        title: 'List Wikipedia Archives',
        description: 'List all available local Wikipedia ZIM archives with metadata.',
      },
      async () => {
        return await this.handleListArchives()
      },
    )
  }

  // ---------------------------------------------------------------------------
  // Tool handlers
  // ---------------------------------------------------------------------------

  private async handleSearch(
    query: string,
    limit: number,
  ): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
    await this.ensureArchives()

    if (this.archives.size === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No Wikipedia archives available. Download one from Settings > Wikipedia.',
          },
        ],
      }
    }

    await this.ensureSearcher()

    if (!this.searcher) {
      return {
        content: [
          {
            type: 'text',
            text: 'No archives with full-text search index available. The downloaded Wikipedia archive may not include a search index.',
          },
        ],
      }
    }

    try {
      const search = this.searcher.search(query)
      const results = search.getResults(0, limit)
      const items: Array<{
        title: string
        path: string
        snippet: string
        score: number
      }> = []

      for (const iter of results) {
        items.push({
          title: iter.title,
          path: iter.path,
          snippet: iter.snippet,
          score: iter.score,
        })
      }

      if (items.length === 0) {
        return {
          content: [{ type: 'text', text: `No results found for "${query}".` }],
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { query, totalEstimate: search.estimatedMatches, results: items },
              null,
              2,
            ),
          },
        ],
      }
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Search error: ${err.message}` }],
      }
    }
  }

  private async handleReadArticle(
    articlePath: string,
    format: 'text' | 'html',
  ): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
    await this.ensureArchives()

    if (this.archives.size === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No Wikipedia archives available. Download one from Settings > Wikipedia.',
          },
        ],
      }
    }

    // Search all archives for the path
    for (const [filename, archive] of this.archives) {
      try {
        if (!archive.hasEntryByPath(articlePath)) continue

        const entry = archive.getEntryByPath(articlePath)
        const item = entry.getItem(true) // follow redirects
        const rawData = item.data.data

        if (!rawData || rawData.length === 0) {
          return {
            content: [{ type: 'text', text: `Article at "${articlePath}" has no content.` }],
          }
        }

        const html = rawData.toString('utf-8')

        if (format === 'html') {
          const truncated =
            html.length > MAX_ARTICLE_LENGTH
              ? html.slice(0, MAX_ARTICLE_LENGTH) + '\n\n[truncated]'
              : html
          return { content: [{ type: 'text', text: truncated }] }
        }

        // Text format — strip HTML
        const text = this.extractTextFromHTML(html)
        const truncated =
          text.length > MAX_ARTICLE_LENGTH
            ? text.slice(0, MAX_ARTICLE_LENGTH) + '\n\n[truncated]'
            : text

        return {
          content: [{ type: 'text', text: truncated }],
        }
      } catch (err: any) {
        logger.warn(
          `[WikipediaMcpServer] Error reading "${articlePath}" from ${filename}: ${err.message}`,
        )
        continue
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: `Article not found: "${articlePath}". Use the search tool to find valid article paths.`,
        },
      ],
    }
  }

  private async handleListArchives(): Promise<{
    content: Array<{ type: 'text'; text: string }>
  }> {
    await this.ensureArchives()

    if (this.archives.size === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No Wikipedia archives available. Download one from Settings > Wikipedia.',
          },
        ],
      }
    }

    const items: Array<{
      filename: string
      title: string
      language: string
      articleCount: number
      hasFulltextIndex: boolean
    }> = []

    for (const [filename, archive] of this.archives) {
      try {
        items.push({
          filename,
          title: this.safeGetMetadata(archive, 'Title') ?? filename,
          language: this.safeGetMetadata(archive, 'Language') ?? 'unknown',
          articleCount: archive.articleCount,
          hasFulltextIndex: archive.hasFulltextIndex(),
        })
      } catch (err: any) {
        logger.warn(`[WikipediaMcpServer] Error reading metadata for ${filename}: ${err.message}`)
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
    }
  }

  // ---------------------------------------------------------------------------
  // Archive management
  // ---------------------------------------------------------------------------

  private async ensureLibzim(): Promise<typeof import('@openzim/libzim')> {
    if (!this.libzim) {
      this.libzim = await import('@openzim/libzim')
    }
    return this.libzim
  }

  private async ensureArchives(): Promise<void> {
    const lib = await this.ensureLibzim()

    let zimFiles: string[]
    try {
      const zimDir = path.join(process.cwd(), ZIM_STORAGE_PATH)
      const entries = fs.readdirSync(zimDir)
      zimFiles = entries.filter((f) => f.endsWith('.zim'))
    } catch {
      // Storage path doesn't exist yet
      zimFiles = []
    }

    // Close archives that no longer exist on disk
    for (const filename of this.archives.keys()) {
      if (!zimFiles.includes(filename)) {
        this.archives.delete(filename)
        this.searcher = null // invalidate searcher
      }
    }

    // Open new archives
    const zimDir = path.join(process.cwd(), ZIM_STORAGE_PATH)
    for (const filename of zimFiles) {
      if (this.archives.has(filename)) continue
      try {
        const fullPath = path.join(zimDir, filename)
        const archive = new lib.Archive(fullPath)
        this.archives.set(filename, archive)
        this.searcher = null // invalidate searcher so it's rebuilt
        logger.info(`[WikipediaMcpServer] Opened archive: ${filename} (${archive.articleCount} articles)`)
      } catch (err: any) {
        logger.error(`[WikipediaMcpServer] Failed to open ${filename}: ${err.message}`)
      }
    }
  }

  private async ensureSearcher(): Promise<void> {
    if (this.searcher) return

    const lib = await this.ensureLibzim()
    const indexedArchives = Array.from(this.archives.values()).filter((a) => {
      try {
        return a.hasFulltextIndex()
      } catch {
        return false
      }
    })

    if (indexedArchives.length === 0) {
      this.searcher = null
      return
    }

    this.searcher = new lib.Searcher(indexedArchives)
    logger.info(
      `[WikipediaMcpServer] Searcher created with ${indexedArchives.length} indexed archive(s)`,
    )
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private extractTextFromHTML(html: string): string {
    try {
      const $ = cheerio.load(html)
      const text = $('body').length ? $('body').text() : $.root().text()
      return text.replace(/\s+/g, ' ').replace(/\n\s*\n/g, '\n').trim()
    } catch {
      return html
    }
  }

  private safeGetMetadata(archive: Archive, key: string): string | null {
    try {
      return archive.getMetadata(key)
    } catch {
      return null
    }
  }
}

export const wikipediaMcpServer = new WikipediaMcpServer()
