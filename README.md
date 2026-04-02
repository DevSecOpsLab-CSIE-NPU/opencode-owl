# OpenCode Memory System Plugin

Agent memory system for the OpenCode/Sisyphus framework. Gives AI coding agents persistent, structured memory across sessions — facts, preferences, procedural skills, and episode tracking.

Based on **"Memory in the Age of AI Agents: A Survey"** (arXiv:2512.13564v2) and informed by production systems including GitHub Copilot Agentic Memory (2026), A-MEM (NeurIPS 2025), AWM (ICML 2025), and MemoryBank (AAAI 2024).

## Features

- **sqlite-vec KNN Search** — 768-dim cosine distance vector search via vec0 virtual table
- **RRF Hybrid Search** — Reciprocal Rank Fusion merges FTS5 BM25 + vector KNN results (k=60)
- **EmbeddingService** — Ollama nomic-embed-text integration with graceful FTS5-only fallback
- **Async Vector Generation** — Non-blocking embedding via setImmediate() on add/update
- **FTS5 Full-Text Search** — BM25-ranked search replaces `LIKE` scans; graceful fallback when unavailable
- **Memory Decay Ranking** — `score = importance × exp(-(λ/strength) × t) × log(2 + access_count)` surfaces actively-used memories
- **Memory Reinforce** — FSRS-inspired multiplicative strength boost with diminishing returns; slows decay rate per reinforcement
- **Global / Project Layers** — cross-project preferences in `global.db`; per-repo facts in `memory.db`
- **Privacy Filter** — regex redaction of API keys, tokens, and credentials before writing to global layer
- **Procedural Skill Memory** — structured workflows with trigger patterns, step lists, and citation verification
- **Episode Tracking** — record task attempts with goal/outcome/actions; lessons auto-promote to persistent facts
- **Schema Versioning** — `schema_version` table + automatic migrations (v1 → v2 → v3 → v4 → v5)
- **CRUD Tools** — full create/read/update/delete for agent-managed memories

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/DevSecOpsLab-CSIE-NPU/opencode-owl/main/install.sh | bash
```

## Manual Installation

```bash
git clone https://github.com/DevSecOpsLab-CSIE-NPU/opencode-owl.git
cd opencode-owl
bun install && bun run build
mkdir -p ~/.config/opencode/plugins/memory-system
cp -r dist/* ~/.config/opencode/plugins/memory-system/
cp package.json ~/.config/opencode/plugins/memory-system/
```

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["./plugins/memory-system"]
}
```

Restart OpenCode. The plugin initializes both databases on first run.

## Available Tools

### Core CRUD

| Tool | Description |
|------|-------------|
| `memory_add` | Add a fact, preference, or skill (supports `layer` param) |
| `memory_query` | FTS5-powered search across project + global layers |
| `memory_list` | Browse all memories with decay score and type filter |
| `memory_update` | Edit content or importance of an existing memory |
| `memory_delete` | Remove a memory by ID |
| `memory_promote` | Copy a global memory into the current project layer |

### Procedural Skills

| Tool | Description |
|------|-------------|
| `memory_add_skill` | Store a reusable workflow (trigger patterns + steps + citations) |
| `memory_approve_skill` | Mark a skill as human-reviewed (confidence 0.9) |
| `memory_validate_citations` | Check that all `file:line` citations still exist on disk |

### Episode Tracking

| Tool | Description |
|------|-------------|
| `memory_start_episode` | Begin tracking a task attempt with a stated goal |
| `memory_end_episode` | Close episode with outcome + lessons; lessons auto-promote to facts |
| `memory_list_episodes` | List recent episodes with outcome, action count, and lesson count |

### Reinforcement

| Tool | Description |
|------|-------------|
| `memory_reinforce` | Boost a memory's `memory_strength`, slowing its decay rate (diminishing returns per call) |

### Utility

| Tool | Description |
|------|-------------|
| `memory_stats` | Project + global memory counts, by-type breakdown |
| `memory_set_task` | Set current task context (shown in system prompt) |
| `memory_status` | One-line memory system summary |
| `memory_version` | Show current package version, schema version, and update status |
| `memory_check_update` | Manually check for available updates from GitHub releases |

### Archive Management

| Tool | Description |
|------|-------------|
| `memory_archive` | Trigger archival of low-score/old memories |
| `memory_list_archived` | List archived memories with date, reason, and preview |
| `memory_restore` | Restore an archived memory back to active |

## Usage Examples

```
# Remember a project fact
memory_add(type="fact", content="This project uses bun test, not npm test", importance=0.9)

# Remember a cross-project preference in global layer
memory_add(type="preference", content="Respond in Traditional Chinese", importance=0.95, layer="global")

# Search with FTS5 (searches project + global)
memory_query(query="test runner", limit=5)

# Add a procedural skill
memory_add_skill(
  name="test-before-commit",
  trigger_patterns=["commit", "push", "PR"],
  steps=["run bun test", "if tests pass: git commit", "git push"],
  applicability="when user has uncommitted changes",
  citations=["package.json:5", "Makefile:12"]
)

# Approve a skill after verifying it's correct
memory_approve_skill(id="mem_1234_abcd")

# Track a task attempt
memory_start_episode(goal="Fix the auth middleware bug")
# ... do work ...
memory_end_episode(
  outcome="success",
  lessons_learned=["JWT expiry must be checked before signature"],
  mistakes=["First tried rotating the key instead of checking expiry"],
  importance_score=8
)

# Review what episodes you've worked on
memory_list_episodes(limit=5)

# Reinforce a critical memory so it decays more slowly
memory_reinforce(id="mem_1234_abcd")
# → memory_strength: 1.80 (1st call), new decay_score: 0.8342
# → memory_strength: 2.88 (2nd call), half-life ~20 days
```

## Storage Layout

```
~/.local/share/opencode/memory/
  memory.db          ← Project layer (per-session, per-repo facts)

~/.config/opencode/memory/
  global.db          ← Global layer (cross-project user preferences)
```

Both databases use bun:sqlite (native SQLite with WAL mode, extension support).

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                  OpenCode Memory Plugin v5                   │
├──────────────────────────────────────────────────────────────┤
│  Hooks                                                       │
│  ├── chat.system.transform  → inject relevant memories       │
│  │     skills rendered as step lists; unreviewed flagged ⚠️  │
│  ├── chat.message           → record conversation history    │
│  └── tool.execute.after     → upsert tool usage aggregate    │
│                               + append action to episode     │
├──────────────────────────────────────────────────────────────┤
│  Memory Layers                                               │
│  ├── Global DB   ~/.config/opencode/memory/global.db         │
│  │     cross-project preferences; privacy-filtered writes    │
│  └── Project DB  ~/.local/share/opencode/memory/memory.db    │
│        per-session facts, skills, experiences, episodes      │
├──────────────────────────────────────────────────────────────┤
│  Vector Components (v5)                                      │
│  ├── EmbeddingService  Ollama nomic-embed-text integration   │
│  └── vec0 Engine       sqlite-vec KNN vector search          │
├──────────────────────────────────────────────────────────────┤
│  Schema (v5)                                                 │
│  ├── memories    id, type, content, citations, source,       │
│  │               confidence, importance, decay metadata,     │
│  │               embedding (BLOB)                            │
│  ├── episodes    goal, outcome, actions[], lessons[],        │
│  │               mistakes[], importance_score, confidence    │
│  ├── memory_vec  vec0 virtual table (768-dim, cosine)        │
│  ├── memory_fts  FTS5 virtual table (porter tokenizer)       │
│  ├── rowmaps     memory_fts_rowmap, memory_vec_rowmap        │
│  ├── session_context    current task, recent tools,          │
│  │                      current_episode_id                   │
│  ├── conversation_history  last 50 messages per session      │
│  └── schema_version        migration tracking                │
└──────────────────────────────────────────────────────────────┘
```

## Memory Types

| Type | Description | Auto-recorded |
|------|-------------|:---:|
| `fact` | Objective information (project setup, API behavior) | — |
| `preference` | User habits and style preferences | — |
| `skill` | Procedural workflows with trigger patterns and steps | — |
| `experience` | Tool usage aggregates (`Edit × 47 this session`) | ✓ |

Skills with `source: "observed"` and `confidence < 0.7` are shown with a ⚠️ warning in the system prompt until reviewed with `memory_approve_skill`.

## Retrieval Ranking

Memory retrieval uses **RRF (Reciprocal Rank Fusion)** to merge results from text-based and semantic searches:

1. **Step 1: FTS5 BM25 search** — Lexical match on keywords and phrases.
2. **Step 2: Vector KNN search** — Semantic match using cosine distance (if Ollama is available).
3. **Step 3: RRF merge** — Scores are combined using `score = Σ 1/(60 + rank + 1)`.
4. **Step 4: Decay score** — Final ranking applies the temporal decay model.

### Decay Model

All merged results are final-scored by:

```
decayScore = rrfScore × importance × exp(-(0.1 / memory_strength) × days_since_access) × log(2 + access_count)
```

| Component | Role |
|-----------|------|
| `importance` | Fixed at creation (0–1); reflects intrinsic value |
| `memory_strength` | Grows with `memory_reinforce` calls; modulates decay rate |
| `days_since_access` | Updated on every retrieval (`last_accessed_at`) |
| `access_count` | Incremented on every retrieval; reflects usage frequency |

**Effective half-lives by strength:**

| `memory_strength` | Decay rate (λ/strength) | Half-life |
|-------------------|-------------------------|-----------|
| 1.0 (default) | 0.100 /day | ~7 days |
| 2.0 (1 reinforce) | 0.050 /day | ~14 days |
| 5.0 (several) | 0.020 /day | ~35 days |
| 10.0 (max) | 0.010 /day | ~69 days |

**Reinforce growth (diminishing returns):**

```
newStrength = min(10.0, currentStrength × max(1.2, 1.8 - 0.2 × reinforcement_count))
```

1st call: ×1.8 → 2nd: ×1.6 → 3rd: ×1.4 → … → floor ×1.2

Results from both layers are merged and deduplicated (project wins over global on identical content).

## Embedding Configuration

The system integrates with **Ollama** for local vector generation:

- **Endpoint**: `http://localhost:11434/api/embed`
- **Model**: `nomic-embed-text` (768-dim)
- **Prefixes**:
  - `passage:` used for storing memories
  - `query:` used for searching memories
- **Fallback**: Gracefully falls back to FTS5-only keyword search if Ollama is unavailable or the model is not pulled.

## Privacy Filter

Before writing to the **global layer**, content is scanned against:

| Pattern | Matches |
|---------|---------|
| `sk-[a-zA-Z0-9]{20,}` | OpenAI API keys |
| `ghp_[a-zA-Z0-9]{36}` | GitHub PATs |
| `AKIA[0-9A-Z]{16}` | AWS Access Keys |
| `-----BEGIN ... PRIVATE KEY-----` | Private keys |
| `(api_key\|password\|secret\|token)\s*[:=]\s*\S+` | Generic secrets |
| `bearer\s+...` | Bearer tokens |

Matches are replaced with `[REDACTED]`; the write proceeds with sanitized content.

## Schema Migrations

| Version | Changes |
|---------|---------|
| v1 | Initial schema: memories, session_context, conversation_history |
| v2 | FTS5 virtual table + rowmap; back-fills index for existing memories |
| v3 | memories: +citations, +source, +confidence; session_context: +current_episode_id; episodes table |
| v4 | memories: +memory_strength, +reinforcement_count |
| v5 | memories: +embedding BLOB; memory_vec vec0 virtual table; memory_vec_rowmap |
| v6 | archived_memories table; auto-archival of low-score/old memories |

Migrations run automatically on startup. Pre-migration backup (`.db.bak`) is created before any schema change.

## Troubleshooting

**Plugin not loading**
1. Verify OpenCode supports plugins (`opencode --version` ≥ 1.0)
2. Check `~/.config/opencode/opencode.json` has `"./plugins/memory-system"` in the `plugin` array
3. Confirm build output: `ls ~/.config/opencode/plugins/memory-system/index.js`

**FTS5 search returning no results**
- FTS5 requires exact token matches (porter-stemmed). Try shorter queries.
- Check `memory_stats()` — if `fts5Available` is false, queries fall back to LIKE automatically.

**Memory not persisting**
1. Check write permissions: `ls -la ~/.local/share/opencode/memory/`
2. `memory_status()` reports DB paths on init.

**Vector search not working**
1. Ensure Ollama is running: `curl http://localhost:11434/api/tags`
2. Verify model is available: `ollama pull nomic-embed-text`
3. Check `memory_status()` — if `vectorAvailable` is false, system defaults to FTS5-only search.

## MCP Server Mode

Expose all memory tools as an HTTP JSON-RPC 2.0 server so any tool — not just OpenCode — can access memories.

```bash
bun run mcp
```

Default port: **3100** — override with `MCP_PORT` env var.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/rpc` | JSON-RPC 2.0 dispatch |
| `GET`  | `/health` | `{ status: "ok", version: "v5" }` |
| `GET`  | `/tools` | List all available tool names |

### JSON-RPC 2.0 Request Format

```json
{
  "jsonrpc": "2.0",
  "method": "memory_query",
  "params": { "query": "test runner", "limit": 5 },
  "id": 1
}
```

All methods accept an optional `"session_id"` param. If omitted, the session defaults to the server's CWD (same logic as the plugin).

### Example Calls

```bash
curl -s -X POST http://localhost:3100/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"memory_query","params":{"query":"bun test"},"id":1}'

curl -s -X POST http://localhost:3100/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"memory_add","params":{"type":"fact","content":"This project uses bun test","importance":0.9},"id":2}'

curl -s http://localhost:3100/health
```

Available methods: `memory_query`, `memory_add`, `memory_list`, `memory_update`, `memory_delete`, `memory_reinforce`, `memory_add_skill`, `memory_approve_skill`, `memory_validate_citations`, `memory_start_episode`, `memory_end_episode`, `memory_list_episodes`, `memory_stats`, `memory_status`

The server opens the same SQLite databases as the OpenCode plugin, so memories are shared between both.

## Development

```bash
bun install
bun run build    # outputs to dist/
bun run dev      # watch mode
bun run clean    # rm -rf dist node_modules
```

## References

- Paper: [Memory in the Age of AI Agents](https://arxiv.org/abs/2512.13564v2) — taxonomy this plugin is built on
- Paper: [A-MEM (NeurIPS 2025)](https://arxiv.org/abs/2502.12110) — Zettelkasten memory evolution
- Paper: [AWM (ICML 2025)](https://proceedings.mlr.press/v267/wang25bx.html) — workflow pattern extraction
- Paper: [MemoryBank (AAAI 2024)](https://arxiv.org/abs/2305.10250) — Ebbinghaus strength model, inspiration for `memory_strength`
- Paper: [Du 2026 Survey](https://arxiv.org/abs/2603.07670) — write–manage–read memory model
- Blog: [GitHub Copilot Agentic Memory](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/) — citation-based fact storage
- Repo: [Agent-Memory-Paper-List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List)
- Framework: [opencode-ai/opencode](https://github.com/opencode-ai/opencode)

## License

MIT
