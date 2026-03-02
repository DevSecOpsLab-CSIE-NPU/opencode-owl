# OpenCode Memory System Plugin

Agent Memory System for OpenCode/Sisyphus framework, based on the paper **"Memory in the Age of AI Agents: A Survey — Forms, Functions and Dynamics"** (arXiv:2512.13564v2).

## Features

- **Persistent Memory**: Stores facts, preferences, skills, and experiences across sessions
- **Automatic Context Injection**: Relevant memories are automatically injected into system prompts
- **Tool Tracking**: Automatically records tool usage patterns
- **Session Context**: Maintains current task and recent activity context
- **SQLite Storage**: Uses sql.js (pure JavaScript SQLite) for cross-platform compatibility

## Quick Install

```bash
# One-liner installation
curl -fsSL https://raw.githubusercontent.com/DevSecOpsLab-CSIE-NPU/opencode-owl/main/install.sh | bash
```

Or manually:

git clone https://github.com/DevSecOpsLab-CSIE-NPU/opencode-owl.git
cd opencode-owl
./install.sh
# Clone and install
git clone https://github.com/AugustChaoTW/aug-money.git
cd aug-money/packages/opencode-memory-system
./install.sh
```

## Manual Installation

### 1. Install Dependencies & Build

```bash
cd opencode-owl
bun install
bun run build
```

### 2. Copy to OpenCode Plugins Directory

```bash
mkdir -p ~/.config/opencode/plugins/memory-system
cp -r dist/* ~/.config/opencode/plugins/memory-system/
cp package.json ~/.config/opencode/plugins/memory-system/
```

### 3. Configure OpenCode

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["./plugins/memory-system"]
}
```

### 4. Restart OpenCode

The plugin will automatically initialize on next session.

## Available Tools

| Tool | Description |
|------|-------------|
| `memory_add` | Add new information to memory (fact/preference/skill) |
| `memory_query` | Query memories by keyword or type |
| `memory_stats` | Get memory statistics |
| `memory_set_task` | Set current task context |

### Usage Examples

```typescript
// Add a user preference
memory_add(type="preference", content="User prefers Traditional Chinese responses", importance=0.9)

// Add a learned fact
memory_add(type="fact", content="This project uses TypeScript with strict mode", importance=0.8)

// Query memories
memory_query(query="user preferences", type="preference", limit=5)

// Check stats
memory_stats()

// Set current task context
memory_set_task(task="Implementing new feature X")
```

## Data Storage

- **Database**: `~/.local/share/opencode/memory/memory.db`
- **Format**: SQLite (via sql.js WASM)
- **Persistence**: Per-project (based on working directory hash)

## Architecture

```
┌─────────────────────────────────────────────────┐
│           OpenCode Memory Plugin                │
├─────────────────────────────────────────────────┤
│  Hooks:                                         │
│  ├── chat.system.transform → Inject memories    │
│  ├── chat.message → Record conversations        │
│  └── tool.execute.after → Track tool usage      │
├─────────────────────────────────────────────────┤
│  Tools:                                         │
│  ├── memory_add                                 │
│  ├── memory_query                               │
│  ├── memory_stats                               │
│  └── memory_set_task                            │
├─────────────────────────────────────────────────┤
│  Storage: SQLite (sql.js WASM)                  │
│  ├── memories (facts, preferences, skills)      │
│  ├── session_context (current task, tools)      │
│  └── conversation_history (last 50 messages)    │
└─────────────────────────────────────────────────┘
```

## Memory Types

| Type | Description | Example |
|------|-------------|---------|
| `fact` | Objective information about the project/user | "This project uses React 18" |
| `preference` | User preferences and habits | "User prefers verbose explanations" |
| `skill` | Learned capabilities and patterns | "Can use grep for code search" |
| `experience` | Past interactions (auto-recorded) | "Used Edit tool on file X" |

## Configuration

The plugin uses sensible defaults but can be customized:

| Setting | Default | Description |
|---------|---------|-------------|
| Memory limit | 10 | Max memories injected per prompt |
| Min importance | 0.5 | Threshold for auto-injection |
| Conversation history | 50 | Max messages stored per session |
| Recent tools | 20 | Tool usage history length |

## Troubleshooting

### Plugin not loading

1. Check OpenCode version supports plugins
2. Verify `opencode.json` has correct plugin path
3. Check build output exists: `ls ~/.config/opencode/plugins/memory-system/`

### Memory not persisting

1. Check database directory exists: `ls ~/.local/share/opencode/memory/`
2. Verify write permissions

### sql.js WASM issues

Ensure `sql-wasm.wasm` is in the same directory as `index.js`:

```bash
cp node_modules/sql.js/dist/sql-wasm.wasm dist/
```

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Watch mode
bun run dev

# Clean
bun run clean
```

## References

- Original Source: [aug-money/packages/opencode-memory-system](https://github.com/AugustChaoTW/aug-money/tree/main/packages/opencode-memory-system)
- Paper: [Memory in the Age of AI Agents](https://arxiv.org/abs/2512.13564v2)
- GitHub: [Agent-Memory-Paper-List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List)
- OpenCode: [opencode-ai/opencode](https://github.com/opencode-ai/opencode)

- Paper: [Memory in the Age of AI Agents](https://arxiv.org/abs/2512.13564v2)
- GitHub: [Agent-Memory-Paper-List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List)
- OpenCode: [opencode-ai/opencode](https://github.com/opencode-ai/opencode)

## License

MIT
