# Babylon

A fork of [Project N.O.M.A.D.](https://github.com/Crosstalk-Solutions/project-nomad) — an offline-first knowledge and AI server.

**Goal:** Extend NOMAD with tool calling and MCP (Model Context Protocol) support, enabling agentic AI workflows against offline knowledge resources.

## Quick Links
- [Architecture](docs/architecture.md)
- [Roadmap](docs/roadmap.md)
- [Decisions](docs/decisions.md)

## Upstream
- Fork of: `Crosstalk-Solutions/project-nomad` v1.31.0
- License: Apache 2.0

## Key Facts
- Backend: AdonisJS (TypeScript), React/Inertia.js frontend
- AI layer: OpenAI SDK pointed at Ollama's `/v1` compatible endpoint
- Vector DB: Qdrant (RAG)
- Queue: BullMQ
- Deployment: Docker Compose

## AI Configuration
The backend uses `ai.remoteOllamaUrl` in KVStore to point at any OpenAI-compatible endpoint.
Target setup: Ollama running on a remote PC with RTX 4070 (12GB VRAM), running Qwen3:14b.

Ollama is started with:
```
OLLAMA_HOST=0.0.0.0 ollama serve
```

Claude Code connects to Ollama using:
```
cmd /C "set ANTHROPIC_AUTH_TOKEN=ollama && set ANTHROPIC_BASE_URL=http://localhost:11434 && claude --model qwen3.5:9b"
```

## Critical Files
- `admin/app/services/ollama_service.ts` — core AI client (chat, streaming, embeddings, model management, tool execution loop)
- `admin/app/services/tool_registry.ts` — central tool registry (MCP and future built-in tools)
- `admin/app/services/mcp_service.ts` — MCP client lifecycle, tool discovery, KVStore persistence
- `admin/app/services/wikipedia_mcp_server.ts` — built-in Wikipedia MCP server (ZIM files)
- `admin/app/controllers/mcp_controller.ts` — MCP server CRUD API
- `admin/app/services/rag_service.ts` — RAG pipeline and Qdrant integration
- `admin/app/controllers/ollama_controller.ts` — chat API endpoints
- `admin/app/services/chat_service.ts` — session management
- `admin/start/routes.ts` — all API routes

## Development
```bash
cd admin
npm install
node ace serve --hmr   # dev server with hot reload
```
