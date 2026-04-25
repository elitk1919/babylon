# Roadmap

## Phase 1 — Rebrand ✅
- [x] Rename NOMAD → Babylon throughout codebase (UI strings, package names, internal references)
- [ ] Update README and docs

## Phase 2 — Tool Calling ✅
- [x] Add `tools` parameter support to `OllamaService.chat()` and `chatStream()`
- [x] Handle tool call responses in the streaming pipeline
- [x] Implement tool execution loop (call → result → continue)
- [x] Update `ChatInput` type to include optional tools array
- [x] Update validators
- [x] Create `tool_registry.ts` — central registry MCP will populate in Phase 3

## Phase 3 — MCP Client ✅
- [x] Add `@modelcontextprotocol/sdk` dependency
- [x] Create `mcp_service.ts` — connects to configured MCP servers, discovers tools
- [x] Wire MCP tools into chat pipeline (inject as tools on each request)
- [x] Handle MCP tool execution in the tool loop
- [x] Persist MCP server configs in KVStore
- [x] MCP API endpoints (`mcp_controller.ts`) — CRUD, connect/disconnect, tool listing
- [x] Boot-time provider (`mcp_provider.ts`) — auto-connects enabled servers on startup
- [x] Support SSE, Streamable HTTP, and stdio transports
- [x] Reconnection with exponential backoff for remote servers
- [x] In-process transport for built-in MCP servers

## Phase 4 — MCP Config UI
- [ ] Add MCP server management screen (add/remove/test servers)
- [ ] Show active MCP tools in chat UI
- [ ] Display tool calls and results inline in chat

## Phase 5 — Offline Knowledge MCP Servers (partially complete)
- [x] Build Wikipedia MCP server for Kiwix ZIM files (`wikipedia_mcp_server.ts`)
  - Tools: `search`, `read_article`, `list_archives`
  - Uses `@openzim/libzim` with lazy archive loading
  - Runs in-process via `InMemoryTransport`, auto-connected by `wikipedia_mcp_provider.ts`
  - Debug SSE server on port 3100 for MCP Inspector
- [x] Decision: MCP tool approach for Wikipedia (D005) — RAG remains for smaller curated content
- [ ] Consider additional offline MCP servers (medical refs, etc.)

## Upstream Sync
- Track upstream NOMAD releases for bug fixes and new features
- Cherry-pick relevant upstream commits where possible
