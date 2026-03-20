/**
 * OpenCode Memory System Plugin
 *
 * Integrates agent memory capabilities into OpenCode/Sisyphus
 * Based on "Memory in the Age of AI Agents" (arXiv:2512.13564v2)
 */

import type { Plugin, Hooks, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import initSqlJs, { type Database } from "sql.js";
import { join } from "path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";

// ============================================================
// Types
// ============================================================

interface MemoryEntry {
  id: string;
  type: "fact" | "experience" | "preference" | "skill";
  content: string;
  metadata: Record<string, unknown>;
  importance: number;
  accessCount: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
}

interface SessionContext {
  sessionId: string;
  currentTask?: string;
  recentTools: string[];
  conversationSummary?: string;
}

// ============================================================
// Memory Store (sql.js based - pure JS SQLite)
// ============================================================

class MemoryStore {
  private db: Database | null = null;
  private dbPath: string;
  private sessionId: string = "";
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  setSessionId(sessionId: string) {
    this.sessionId = sessionId;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  async initialize(): Promise<void> {
    // Ensure directory exists
    const dir = this.dbPath.substring(0, this.dbPath.lastIndexOf("/"));
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Initialize sql.js
    const SQL = await initSqlJs();

    // Load existing database or create new
    if (existsSync(this.dbPath)) {
      const fileBuffer = readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
    } else {
      this.db = new SQL.Database();
    }

    this.initializeSchema();
  }

  private initializeSchema(): void {
    if (!this.db) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT DEFAULT '{}',
        importance REAL DEFAULT 0.5,
        access_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS session_context (
        session_id TEXT PRIMARY KEY,
        current_task TEXT,
        recent_tools TEXT DEFAULT '[]',
        conversation_summary TEXT,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_conv_session ON conversation_history(session_id)`);

    this.save();
  }

  private save(): void {
    if (!this.db) return;

    // Debounce saves
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      if (this.db) {
        const data = this.db.export();
        const buffer = Buffer.from(data);
        writeFileSync(this.dbPath, buffer);
      }
    }, 1000);
  }

  private forceSave(): void {
    if (!this.db) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const data = this.db.export();
    const buffer = Buffer.from(data);
    writeFileSync(this.dbPath, buffer);
  }

  // Memory CRUD
  addMemory(entry: Omit<MemoryEntry, "id" | "accessCount" | "createdAt" | "updatedAt" | "lastAccessedAt">): string {
    const sessionId = this.sessionId;
    if (!this.db) return "";

    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    this.db.run(`
      INSERT INTO memories (id, session_id, type, content, metadata, importance, access_count, created_at, updated_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `, [id, sessionId, entry.type, entry.content, JSON.stringify(entry.metadata), entry.importance, now, now, now]);

    this.save();
    return id;
  }

  getMemory(id: string): MemoryEntry | null {
    const sessionId = this.sessionId;
    if (!this.db) return null;

    const result = this.db.exec(`SELECT * FROM memories WHERE id = ? AND session_id = ?`, [id, sessionId]);
    if (result.length === 0 || result[0].values.length === 0) return null;

    // Update access count
    this.db.run(`UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ? AND session_id = ?`, [Date.now(), id, sessionId]);
    this.save();

    return this.rowToEntry(result[0].columns, result[0].values[0]);
  }

  queryMemories(options: {
    type?: string;
    limit?: number;
    minImportance?: number;
    search?: string;
  } = {}): MemoryEntry[] {
    const sessionId = this.sessionId;
    if (!this.db) return [];

    let sql = "SELECT * FROM memories WHERE session_id = ?";
    const params: any[] = [sessionId];

    if (options.type) {
      sql += " AND type = ?";
      params.push(options.type);
    }

    if (options.minImportance !== undefined) {
      sql += " AND importance >= ?";
      params.push(options.minImportance);
    }

    if (options.search) {
      sql += " AND content LIKE ?";
      params.push(`%${options.search}%`);
    }

    sql += " ORDER BY importance DESC, last_accessed_at DESC";

    if (options.limit) {
      sql += ` LIMIT ${options.limit}`;
    }

    const result = this.db.exec(sql, params);
    if (result.length === 0) return [];

    return result[0].values.map(row => this.rowToEntry(result[0].columns, row));
  }

  updateMemory(id: string, updates: Partial<Pick<MemoryEntry, "content" | "metadata" | "importance">>): boolean {
    const sessionId = this.sessionId;
    if (!this.db) return false;

    const sets: string[] = ["updated_at = ?"];
    const params: any[] = [Date.now()];

    if (updates.content !== undefined) {
      sets.push("content = ?");
      params.push(updates.content);
    }
    if (updates.metadata !== undefined) {
      sets.push("metadata = ?");
      params.push(JSON.stringify(updates.metadata));
    }
    if (updates.importance !== undefined) {
      sets.push("importance = ?");
      params.push(updates.importance);
    }

    params.push(id, sessionId);
    this.db.run(`UPDATE memories SET ${sets.join(", ")} WHERE id = ? AND session_id = ?`, params);
    this.save();
    return this.db.getRowsModified() > 0;
  }

  deleteMemory(id: string): boolean {
    const sessionId = this.sessionId;
    if (!this.db) return false;
    this.db.run("DELETE FROM memories WHERE id = ? AND session_id = ?", [id, sessionId]);
    this.save();
    return this.db.getRowsModified() > 0;
  }

  // Session Context
  getSessionContext(): SessionContext | null {
    const sessionId = this.sessionId;
    if (!this.db) return null;

    const result = this.db.exec(`SELECT * FROM session_context WHERE session_id = ?`, [sessionId]);
    if (result.length === 0 || result[0].values.length === 0) return null;

    const cols = result[0].columns;
    const row = result[0].values[0];
    const idx = (name: string) => cols.indexOf(name);

    return {
      sessionId: row[idx("session_id")] as string,
      currentTask: row[idx("current_task")] as string | undefined,
      recentTools: JSON.parse((row[idx("recent_tools")] as string) || "[]"),
      conversationSummary: row[idx("conversation_summary")] as string | undefined,
    };
  }

  updateSessionContext(updates: Partial<Omit<SessionContext, "sessionId">>): void {
    const sessionId = this.sessionId;
    if (!this.db) return;

    const existing = this.getSessionContext();

    if (existing) {
      const sets: string[] = ["updated_at = ?"];
      const params: any[] = [Date.now()];

      if (updates.currentTask !== undefined) {
        sets.push("current_task = ?");
        params.push(updates.currentTask);
      }
      if (updates.recentTools !== undefined) {
        sets.push("recent_tools = ?");
        params.push(JSON.stringify(updates.recentTools));
      }
      if (updates.conversationSummary !== undefined) {
        sets.push("conversation_summary = ?");
        params.push(updates.conversationSummary);
      }

      params.push(sessionId);
      this.db.run(`UPDATE session_context SET ${sets.join(", ")} WHERE session_id = ?`, params);
    } else {
      this.db.run(`
        INSERT INTO session_context (session_id, current_task, recent_tools, conversation_summary, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `, [
        sessionId,
        updates.currentTask || null,
        JSON.stringify(updates.recentTools || []),
        updates.conversationSummary || null,
        Date.now()
      ]);
    }

    this.save();
  }

  // Conversation History
  addConversation(role: string, content: string): void {
    const sessionId = this.sessionId;
    if (!this.db) return;

    this.db.run(`
      INSERT INTO conversation_history (session_id, role, content, timestamp)
      VALUES (?, ?, ?, ?)
    `, [sessionId, role, content, Date.now()]);

    // Keep only last 50 messages per session
    this.db.run(`
      DELETE FROM conversation_history
      WHERE session_id = ? AND id NOT IN (
        SELECT id FROM conversation_history WHERE session_id = ? ORDER BY timestamp DESC LIMIT 50
      )
    `, [sessionId, sessionId]);

    this.save();
  }

  getRecentConversations(limit = 10): Array<{ role: string; content: string; timestamp: number }> {
    const sessionId = this.sessionId;
    if (!this.db) return [];

    const result = this.db.exec(`
      SELECT role, content, timestamp FROM conversation_history
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `, [sessionId, limit]);

    if (result.length === 0) return [];

    const cols = result[0].columns;
    return result[0].values.map(row => ({
      role: row[cols.indexOf("role")] as string,
      content: row[cols.indexOf("content")] as string,
      timestamp: row[cols.indexOf("timestamp")] as number,
    }));
  }

  // Stats
  getStats(): { total: number; byType: Record<string, number>; avgImportance: number } {
    const sessionId = this.sessionId;
    if (!this.db) return { total: 0, byType: {}, avgImportance: 0 };

    const totalResult = this.db.exec(`SELECT COUNT(*) as count FROM memories WHERE session_id = ?`, [sessionId]);
    const total = totalResult.length > 0 && totalResult[0].values.length > 0 ? totalResult[0].values[0][0] as number : 0;

    const byTypeResult = this.db.exec(`SELECT type, COUNT(*) as count FROM memories WHERE session_id = ? GROUP BY type`, [sessionId]);
    const byType: Record<string, number> = {};
    if (byTypeResult.length > 0) {
      for (const row of byTypeResult[0].values) {
        byType[row[0] as string] = row[1] as number;
      }
    }

    const avgResult = this.db.exec(`SELECT AVG(importance) as avg FROM memories WHERE session_id = ?`, [sessionId]);
    const avgImportance = avgResult.length > 0 && avgResult[0].values.length > 0 ? (avgResult[0].values[0][0] as number) || 0 : 0;

    return { total, byType, avgImportance };
  }

  private rowToEntry(columns: string[], row: any[]): MemoryEntry {
    const idx = (name: string) => columns.indexOf(name);
    return {
      id: row[idx("id")] as string,
      type: row[idx("type")] as MemoryEntry["type"],
      content: row[idx("content")] as string,
      metadata: JSON.parse((row[idx("metadata")] as string) || "{}"),
      importance: row[idx("importance")] as number,
      accessCount: row[idx("access_count")] as number,
      createdAt: row[idx("created_at")] as number,
      updatedAt: row[idx("updated_at")] as number,
      lastAccessedAt: row[idx("last_accessed_at")] as number,
    };
  }

  close(): void {
    this.forceSave();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// ============================================================
// Plugin Implementation
// ============================================================

const MemoryPlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const { directory } = input;

  // Initialize memory store (without session ID - will be set from hooks)
  const dataDir = join(homedir(), ".local", "share", "opencode", "memory");
  const dbPath = join(dataDir, "memory.db");
  const store = new MemoryStore(dbPath);
  await store.initialize();

  console.log(`[Memory] Initialized at: ${dbPath}`);

  // Helper to get session ID from hook input, fallback to project-based ID
  const getSessionId = (input: { sessionID?: string }): string => {
    return input?.sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`;
  };

  return {
    // Inject memory context into system prompt
    "experimental.chat.system.transform": async (input, output) => {
      const sessionId = getSessionId(input);
      store.setSessionId(sessionId);

      const memories = store.queryMemories({ limit: 10, minImportance: 0.5 });
      const context = store.getSessionContext();

      if (memories.length === 0 && !context) return;

      const memoryContext: string[] = [];

      // Add relevant memories
      if (memories.length > 0) {
        memoryContext.push("\n<agent_memory>");
        memoryContext.push("## Relevant Memories");
        for (const mem of memories) {
          memoryContext.push(`- [${mem.type}] ${mem.content}`);
        }
        memoryContext.push("</agent_memory>");
      }

      // Add session context
      if (context?.currentTask) {
        memoryContext.push(`\n<current_task>${context.currentTask}</current_task>`);
      }
      if (context?.recentTools && context.recentTools.length > 0) {
        memoryContext.push(`\n<recent_tools>${context.recentTools.slice(-5).join(", ")}</recent_tools>`);
      }

      // Append to system prompt
      if (memoryContext.length > 0) {
        output.system.push(...memoryContext);
      }
    },

    // Record messages
    "chat.message": async (input, output) => {
      const sessionId = getSessionId(input);
      store.setSessionId(sessionId);

      const { parts } = output;
      // Extract text content from parts
      const textParts = parts.filter(p => p.type === "text").map(p => (p as any).text || "");
      const content = textParts.join("\n").slice(0, 1000); // Limit length

      if (content) {
        store.addConversation("user", content);
      }
    },

    // Track tool usage
    "tool.execute.after": async (input, output) => {
      const sessionId = getSessionId(input);
      store.setSessionId(sessionId);

      const { tool: toolName } = input;

      // Update recent tools in session context
      const context = store.getSessionContext();
      const recentTools = context?.recentTools || [];
      recentTools.push(toolName);

      // Keep only last 20 tools
      store.updateSessionContext({
        recentTools: recentTools.slice(-20),
      });

      // Record significant tool executions as experiences
      const significantTools = ["Edit", "Write", "Bash", "mcp_task"];
      if (significantTools.some(t => toolName.includes(t))) {
        store.addMemory({
          type: "experience",
          content: `Used tool: ${toolName}`,
          metadata: { toolName, timestamp: Date.now() },
          importance: 0.6,
        });
      }
    },

    // Custom tools for memory interaction
    tool: {
      memory_query: tool({
        description: "Query agent memory for relevant information. Use this to recall facts, preferences, or past experiences.",
        args: {
          query: tool.schema.string().describe("Search query or topic to look for in memory"),
          type: tool.schema.enum(["fact", "experience", "preference", "skill"]).optional().describe("Filter by memory type"),
          limit: tool.schema.number().optional().describe("Maximum number of results (default: 10)"),
        },
        async execute(args, { sessionID }) {
          const sessionId = sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`;
          store.setSessionId(sessionId);

          const memories = store.queryMemories({
            search: args.query,
            type: args.type,
            limit: args.limit || 10,
          });

          if (memories.length === 0) {
            return "No relevant memories found.";
          }

          const results = memories.map(m => `- [${m.type}] ${m.content} (importance: ${m.importance.toFixed(2)})`);
          return `Found ${memories.length} memories:\n${results.join("\n")}`;
        },
      }),

      memory_add: tool({
        description: "Add new information to agent memory. Use this to remember important facts, user preferences, or learned skills.",
        args: {
          type: tool.schema.enum(["fact", "preference", "skill"]).describe("Type of memory to store"),
          content: tool.schema.string().describe("The information to remember"),
          importance: tool.schema.number().min(0).max(1).optional().describe("Importance score 0-1 (default: 0.5)"),
        },
        async execute(args, { sessionID }) {
          const sessionId = sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`;
          store.setSessionId(sessionId);

          const id = store.addMemory({
            type: args.type,
            content: args.content,
            metadata: { addedBy: "agent" },
            importance: args.importance || 0.5,
          });

          return `Memory stored with ID: ${id}`;
        },
      }),

      memory_stats: tool({
        description: "Get statistics about agent memory usage.",
        args: {},
        async execute(_, { sessionID }) {
          const sessionId = sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`;
          store.setSessionId(sessionId);

          const stats = store.getStats();
          const context = store.getSessionContext();

          return [
            `Memory Statistics:`,
            `- Total memories: ${stats.total}`,
            `- By type: ${JSON.stringify(stats.byType)}`,
            `- Average importance: ${stats.avgImportance.toFixed(2)}`,
            `- Current task: ${context?.currentTask || "None"}`,
            `- Recent tools: ${context?.recentTools?.slice(-5).join(", ") || "None"}`,
          ].join("\n");
        },
      }),

      memory_set_task: tool({
        description: "Set the current task context for the session.",
        args: {
          task: tool.schema.string().describe("Description of the current task"),
        },
        async execute(args, { sessionID }) {
          const sessionId = sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`;
          store.setSessionId(sessionId);

          store.updateSessionContext({ currentTask: args.task });
          return `Current task set to: ${args.task}`;
        },
      }),

      memory_status: tool({
        description: "Get a concise status of the memory system.",
        args: {},
        async execute(_, { sessionID }) {
          const sessionId = sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`;
          store.setSessionId(sessionId);

          const stats = store.getStats();
          const context = store.getSessionContext();
          const task = context?.currentTask || "None";
          const recentTools = context?.recentTools?.slice(-3).join(", ") || "None";
          return `🧠 Memory: ${stats.total} items | 🎯 Task: ${task} | 🔧 Recent: ${recentTools}`;
        },
      }),
    },
  };
};

export default MemoryPlugin;