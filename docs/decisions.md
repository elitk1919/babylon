# Decisions

## D001 — Fork NOMAD instead of building from scratch
**Decision:** Fork Project N.O.M.A.D. (Apache 2.0) as the base.
**Why:** NOMAD already has a solid offline content stack (Kiwix/ZIM, maps, medical refs), RAG pipeline with Qdrant, Docker deployment, and a clean React UI. Building equivalent infrastructure from scratch would be significant effort.
**Tradeoff:** Must maintain divergence from upstream. Will cherry-pick relevant upstream updates manually.

## D002 — Use OpenAI SDK pointed at Ollama (not Anthropic SDK)
**Decision:** Keep the existing OpenAI SDK approach, configure `ANTHROPIC_BASE_URL`-style via `ai.remoteOllamaUrl` KVStore entry.
**Why:** NOMAD already uses OpenAI SDK against Ollama's `/v1` endpoint. This works. Swapping to Anthropic SDK would require embedding provider changes and add complexity with no real benefit since Ollama is the inference backend.
**How:** Set `ai.remoteOllamaUrl` to `http://[4070-pc]:11434` in KVStore. No code change needed.

## D003 — Default all-in-one, remote AI host as optional
**Decision:** Default deployment runs Ollama on the same machine as Babylon. Remote Ollama (or any OpenAI-compatible endpoint) is supported via `ai.remoteOllamaUrl` config with no code changes.
**Why:** All-in-one is simpler, more portable, and better fits the offline-resilience goal. Remote offloading is useful when a stronger GPU is available on another machine, but is an environmental choice, not an architectural requirement.
**Tradeoff:** All-in-one performance is constrained by host hardware. Remote mode introduces a network dependency.

## D004 — Qwen3:14b as primary model
**Decision:** Use Qwen3:14b (Q4 quantization) as the primary model.
**Why:** Best tool-calling model that fits comfortably in 12GB VRAM. User has confirmed tool calling works with Qwen3 series. Qwen3 has significantly improved tool use over Qwen2.5.

## D005 — MCP over pure RAG for offline Wikipedia
**Decision:** Build MCP server tools for Kiwix ZIM content rather than (or in addition to) RAG ingestion.
**Why:** Wikipedia is too large to embed fully. Tool-based retrieval lets the model request exactly what it needs. ZIM files are already a supported RAG format in NOMAD, so RAG remains available for smaller curated content.
**Note:** `@openzim/libzim` is already a dependency — no new packages needed for ZIM reading.
