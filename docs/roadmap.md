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

## Phase 3 — MCP Client
- [ ] Add `@modelcontextprotocol/sdk` dependency
- [ ] Create `mcp_service.ts` — connects to configured MCP servers, discovers tools
- [ ] Wire MCP tools into chat pipeline (inject as tools on each request)
- [ ] Handle MCP tool execution in the tool loop
- [ ] Persist MCP server configs in KVStore

## Phase 4 — MCP Config UI
- [ ] Add MCP server management screen (add/remove/test servers)
- [ ] Show active MCP tools in chat UI
- [ ] Display tool calls and results inline in chat

## Phase 5 — Offline Knowledge MCP Servers
- [ ] Build MCP server for Kiwix ZIM files (offline Wikipedia, medical refs)
  - Tools: `search_wikipedia`, `get_article`, `get_section`
  - Library: `@openzim/libzim` (already a dependency)
- [ ] Consider whether ZIM RAG ingestion (already supported) is sufficient vs MCP tool approach

## Upstream Sync
- Track upstream NOMAD releases for bug fixes and new features
- Cherry-pick relevant upstream commits where possible
