# OpenCode Memory System Plugin

Agent memory system for the OpenCode/Sisyphus framework. Gives AI coding agents persistent, structured memory across sessions — facts, preferences, procedural skills, and episode tracking.

Based on **"Memory in the Age of AI Agents: A Survey"** (arXiv:2512.13564v2) and informed by production systems including GitHub Copilot Agentic Memory (2026), A-MEM (NeurIPS 2025), and AWM (ICML 2025).

## Features

- **FTS5 Full-Text Search** — BM25-ranked search replaces `LIKE` scans; graceful fallback when unavailable
- **Memory Decay Ranking** — `score = importance × exp(-λt) × log(2 + access_count)` surfaces recently-used memories first
- **Global / Project Layers** — cross-project preferences in `global.db`; per-repo facts in `memory.db`
- **Privacy Filter** — regex redaction of API keys, tokens, and credentials before writing to global layer
- **Procedural Skill Memory** — structured workflows with trigger patterns, step lists, and citation verification
- **Episode Tracking** — record task attempts with goal/outcome/actions; lessons auto-promote to persistent facts
- **Schema Versioning** — `schema_version` table + automatic migrations (v1 → v2 → v3)
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

### Utility

| Tool | Description |
|------|-------------|
| `memory_stats` | Project + global memory counts, by-type breakdown |
| `memory_set_task` | Set current task context (shown in system prompt) |
| `memory_status` | One-line memory system summary |

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
```

## Storage Layout

```
~/.local/share/opencode/memory/
  memory.db          ← Project layer (per-session, per-repo facts)

~/.config/opencode/memory/
  global.db          ← Global layer (cross-project user preferences)
```

Both databases use SQLite via sql.js (pure-JS WASM, no native extensions required).

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                  OpenCode Memory Plugin v3                   │
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
│  Schema (v3)                                                 │
│  ├── memories    id, type, content, citations, source,       │
│  │               confidence, importance, decay metadata      │
│  ├── episodes    goal, outcome, actions[], lessons[],        │
│  │               mistakes[], importance_score, confidence    │
│  ├── memory_fts  FTS5 virtual table (porter tokenizer)       │
│  ├── memory_fts_rowmap  FTS5 ↔ memory ID mapping            │
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

All query results are scored and sorted by:

```
decayScore = importance × exp(-0.1 × days_since_access) × log(2 + access_count)
```

- New, important memories score high immediately
- Frequently-accessed memories stay near the top
- Stale, unvisited memories naturally sink

Results from both layers are merged and deduplicated (project wins over global on identical content).

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

Migrations run automatically on startup. Existing data is preserved.

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

**sql.js WASM missing**
```bash
cp node_modules/sql.js/dist/sql-wasm.wasm dist/
cp dist/sql-wasm.wasm ~/.config/opencode/plugins/memory-system/
```

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
- Paper: [Du 2026 Survey](https://arxiv.org/abs/2603.07670) — write–manage–read memory model
- Blog: [GitHub Copilot Agentic Memory](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/) — citation-based fact storage
- Repo: [Agent-Memory-Paper-List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List)
- Framework: [opencode-ai/opencode](https://github.com/opencode-ai/opencode)

## License

MIT
