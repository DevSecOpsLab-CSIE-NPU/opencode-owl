#!/usr/bin/env bun
/**
 * mcp-stdio.ts — stdio MCP transport for Claude Code compatibility.
 *
 * Claude Code communicates with MCP servers via stdin/stdout using the
 * Model Context Protocol (JSON-RPC 2.0, newline-delimited).
 *
 * Usage (add to .claude/mcp.json or ~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "opencode-owl": {
 *         "command": "bun",
 *         "args": ["/path/to/opencode-owl/dist/mcp-stdio.js"]
 *       }
 *     }
 *   }
 */

import { join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { MemoryStore, dispatch, defaultSessionId } from "./mcp-server";

const __filename = fileURLToPath(import.meta.url);

// ── DB paths (same as HTTP server so they share the same data) ───────────────
const projectDbPath = join(homedir(), ".local", "share", "opencode", "memory", "memory.db");
const globalDbPath  = join(homedir(), ".config", "opencode", "memory", "global.db");

const store = new MemoryStore(projectDbPath, globalDbPath);
store.initialize();
store.setSessionId(defaultSessionId());

// ── Tool definitions (MCP JSON Schema) ───────────────────────────────────────
const TOOLS = [
  {
    name: "memory_query",
    description: "Search owl memory for relevant facts, experiences, preferences, or skills.",
    inputSchema: {
      type: "object",
      properties: {
        query:  { type: "string",  description: "Search query" },
        type:   { type: "string",  description: "Filter: fact|experience|preference|skill" },
        limit:  { type: "number",  description: "Max results (default 10)" },
        layers: { type: "array",   items: { type: "string" }, description: "project|global" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_add",
    description: "Store a new memory (fact, experience, preference, or skill).",
    inputSchema: {
      type: "object",
      properties: {
        content:    { type: "string", description: "Memory content" },
        type:       { type: "string", description: "fact|experience|preference|skill" },
        importance: { type: "number", description: "0.0–1.0 (default 0.5)" },
        layer:      { type: "string", description: "project|global (default project)" },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_stats",
    description: "Show memory statistics: total memories, types breakdown.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_start_episode",
    description: "Begin a learning episode. Call at task start to track outcomes.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Task goal for this episode" },
      },
      required: ["goal"],
    },
  },
  {
    name: "memory_end_episode",
    description: "End an episode and record lessons learned.",
    inputSchema: {
      type: "object",
      properties: {
        outcome:          { type: "string", description: "success|partial|failure|abandoned|unknown" },
        lessons_learned:  { type: "array",  items: { type: "string" }, description: "Key lessons" },
        keywords:         { type: "array",  items: { type: "string" }, description: "Searchable keywords" },
        importance_score: { type: "number", description: "0.0–1.0" },
      },
      required: ["outcome"],
    },
  },
  {
    name: "memory_status",
    description: "One-line status summary of the memory system.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ahe_status",
    description: "Get current AHE eval status: running state, last pass@1, last suite.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ahe_run_eval",
    description: "Run an AHE task evaluation suite against the configured agent backend.",
    inputSchema: {
      type: "object",
      properties: {
        suite:   { type: "string", description: "Suite name, e.g. terminal" },
        task:    { type: "string", description: "Optional specific task_id" },
        backend: { type: "string", description: "opencode|claude-code" },
      },
      required: ["suite"],
    },
  },
  {
    name: "ahe_analyze_failures",
    description: "Analyze failures from the latest (or specified) eval run.",
    inputSchema: {
      type: "object",
      properties: {
        run: { type: "string", description: "Run label or 'traces/runs/latest'" },
      },
    },
  },
  {
    name: "owl_status",
    description: "Get opencode-owl system status: memory counts, episode state, hit rate.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ── MCP stdio protocol ────────────────────────────────────────────────────────
function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handleRequest(req: Record<string, unknown>): Promise<void> {
  const id     = req.id ?? null;
  const method = String(req.method ?? "");
  const params  = (req.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) — no response
  if (req.id === undefined) return;

  try {
    let result: unknown;

    if (method === "initialize") {
      result = {
        protocolVersion: "2024-11-05",
        capabilities:    { tools: {} },
        serverInfo:      { name: "opencode-owl", version: "1.3.0" },
      };
    } else if (method === "tools/list") {
      result = { tools: TOOLS };
    } else if (method === "tools/call") {
      let toolName     = String(params.name ?? "");
      const toolParams = (params.arguments ?? {}) as Record<string, unknown>;
      // owl_status is an opencode plugin alias; map it to memory_status here
      if (toolName === "owl_status") toolName = "memory_status";
      const data       = await dispatch(store, toolName, toolParams);
      result = {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } else if (method === "ping") {
      result = {};
    } else {
      send({ jsonrpc: "2.0", error: { code: -32601, message: `Method not found: ${method}` }, id });
      return;
    }

    send({ jsonrpc: "2.0", result, id });
  } catch (err: unknown) {
    const e = err as Error & { code?: number };
    send({ jsonrpc: "2.0", error: { code: e.code ?? -32603, message: e.message ?? "Internal error" }, id });
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rpcReq = JSON.parse(trimmed) as Record<string, unknown>;
      await handleRequest(rpcReq);
    } catch {
      send({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }
  }
});

process.stdin.on("end", () => process.exit(0));
process.stderr.write("[owl-mcp-stdio] started\n");
