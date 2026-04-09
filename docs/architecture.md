# Architecture

## System Overview

### Default: All-in-one
```
┌──────────────────────────────────────┐
│           Babylon (Docker)           │
│                                      │
│  AdonisJS backend  ←→  React UI      │
│       ↕                  ↕           │
│    Qdrant (RAG)       MySQL          │
│    Redis (queue)      BullMQ         │
│       ↕                              │
│    Ollama (local)                    │
│    (any OpenAI-compatible backend)   │
└──────────────────────────────────────┘
```

### Optional: Remote AI host
Ollama (or any OpenAI-compatible endpoint) can run on a separate machine — useful when offloading inference to a PC with a stronger GPU. Configured via `ai.remoteOllamaUrl` in KVStore with no code changes required.

```
┌──────────────────────┐        ┌─────────────────────┐
│   Babylon (Docker)   │  HTTP  │   Remote AI Host    │
│                      │ ──────▶│                     │
│  AdonisJS + React    │        │  Ollama / LM Studio │
│  Qdrant, MySQL, etc  │        │  llama.cpp, etc.    │
└──────────────────────┘        └─────────────────────┘
```

## AI Pipeline

### Chat Flow
1. Client sends POST `/api/ollama/chat` (streaming or non-streaming)
2. Controller injects system message if missing
3. Query rewriting via `rewriteQueryWithContext()` (uses LLM to improve RAG queries)
4. RAG retrieval from Qdrant (semantic + keyword hybrid ranking)
5. Augmented messages sent to Ollama via OpenAI SDK
6. Response streamed back via SSE

### OllamaService
- Uses **OpenAI SDK** (`openai` npm package) pointed at Ollama's `/v1` endpoint
- Remote URL configurable via `ai.remoteOllamaUrl` in KVStore (set via UI or API)
- Falls back to local Docker-managed Ollama if no remote URL set
- `isOllamaNative` flag distinguishes true Ollama from OpenAI-compat backends (LM Studio, llama.cpp)
- Streaming parser handles `<think>` tags split across chunks

### RAG Pipeline (rag_service.ts)
- Embedding model: Nomic Embed Text v1.5 (768-dimensional)
- Chunk size: ~1,500 tokens, batch size: 8
- Retrieval: semantic similarity (threshold 0.3), retrieves 3x then reranks
- Reranking: semantic score + keyword boost (+10%) + term match (+7.5%) + source diversity penalty
- Supported file types: PDF, EPUB, images (OCR via Tesseract), plain text, **ZIM archives**

### Embeddings
- Tries Ollama native `/api/embed` first
- Falls back to `/v1/embeddings` (OpenAI-compatible)

## Tool Calling (Planned)
See [roadmap.md](roadmap.md) — `params: any` in `ollama_service.ts` makes this a small addition.

## MCP Integration (Planned)
See [roadmap.md](roadmap.md).

## Key Dependencies
| Package | Purpose |
|---|---|
| `openai` | LLM client (pointed at Ollama /v1) |
| `@qdrant/js-client-rest` | Vector DB for RAG |
| `bullmq` | Background job queue |
| `@openzim/libzim` | ZIM file reading (offline Wikipedia) |
| `tesseract.js` | OCR for scanned PDFs/images |
| `@modelcontextprotocol/sdk` | MCP client (to be added) |
