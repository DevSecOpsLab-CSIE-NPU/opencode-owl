# Repo Facts

Static facts about the target repo that inform agent behaviour.
Updated manually when the repo structure changes significantly.

## opencode-owl

- Runtime: Bun + TypeScript
- Test command: `bun test`
- Build command: `bun run build`
- Entry point: `src/index.ts`
- Plugin interface: `@opencode-ai/plugin ^1.3.0`
- MCP server: `src/mcp-server.ts`
- Database: SQLite via `better-sqlite3` + `sqlite-vec`
- No network access required for tests

## Key invariants

- `dist/` is generated; never edit it directly
- `src/index.ts` exports the OpenCode plugin object as default
- Tool names must match OpenCode's tool-name contract (snake_case, no colon)
