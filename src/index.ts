/**
 * OpenCode Memory System Plugin v3
 *
 * Phase 3: Citation-based procedural memory (Issue #6),
 *           Episodic reflection + episode tracking (Issue #7)
 * Phase 2: FTS5 search, global/project layer, decay ranking,
 *           privacy filter, schema versioning
 *
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

type MemoryType = "fact" | "experience" | "preference" | "skill";
type MemoryLayer = "global" | "project";
type RowParam = string | number | null;

interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  metadata: Record<string, unknown>;
  importance: number;
  accessCount: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  layer?: MemoryLayer;
  decayScore?: number;
}

interface SessionContext {
  sessionId: string;
  currentTask?: string;
  recentTools: string[];
  conversationSummary?: string;
  currentEpisodeId?: string;
}

type MemorySource = "observed" | "human";
type EpisodeOutcome = "success" | "partial" | "failure" | "abandoned" | "unknown";

interface EpisodeAction {
  tool: string;
  summary: string;
  timestamp: number;
}

interface Episode {
  episodeId: string;
  sessionId: string;
  goal: string;
  outcome: EpisodeOutcome;
  actions: EpisodeAction[];
  lessonsLearned: string[];
  mistakes: string[];
  importanceScore: number;
  keywords: string[];
  supersedes: string[];
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

// ============================================================
// Constants
// ============================================================

const VALID_MEMORY_TYPES: MemoryType[] = ["fact", "experience", "preference", "skill"];
const MAX_CONTENT_BYTES = 10 * 1024; // 10KB
const SCHEMA_VERSION = 3;
const DECAY_LAMBDA = 0.1;          // decay rate per day
const GLOBAL_SESSION_ID = "__global__";

// Privacy: redact before writing to global layer
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g,
  /(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+/gi,
  /bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi,
];

// ============================================================
// Utility Functions
// ============================================================

function redactSensitiveContent(content: string): { redacted: string; hadSensitive: boolean } {
  let redacted = content;
  let hadSensitive = false;
  for (const pat of SENSITIVE_PATTERNS) {
    const next = redacted.replace(new RegExp(pat.source, pat.flags), "[REDACTED]");
    if (next !== redacted) hadSensitive = true;
    redacted = next;
  }
  return { redacted, hadSensitive };
}

function computeDecayScore(importance: number, lastAccessedAt: number, accessCount: number): number {
  const daysSince = (Date.now() - lastAccessedAt) / 86_400_000;
  const recency = Math.exp(-DECAY_LAMBDA * daysSince);
  const frequency = Math.log(2 + accessCount); // log(2)≈0.69 for new memories
  return importance * recency * frequency;
}

// ============================================================
// MemoryStore
// ============================================================

class MemoryStore {
  private projectDb: Database | null = null;
  private globalDb: Database | null = null;
  private readonly projectDbPath: string;
  private readonly globalDbPath: string;
  private sessionId: string = "";
  private projectSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private globalSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private fts5Available = false;

  constructor(projectDbPath: string, globalDbPath: string) {
    this.projectDbPath = projectDbPath;
    this.globalDbPath = globalDbPath;
  }

  setSessionId(id: string) { this.sessionId = id; }
  getSessionId(): string   { return this.sessionId; }

  // ---- Init ----

  async initialize(): Promise<void> {
    try {
      const SQL = await initSqlJs();

      // Project DB
      this.ensureDir(this.projectDbPath);
      this.projectDb = existsSync(this.projectDbPath)
        ? new SQL.Database(readFileSync(this.projectDbPath))
        : new SQL.Database();
      this.initSchemaForDb(this.projectDb, false);

      // Global DB
      this.ensureDir(this.globalDbPath);
      this.globalDb = existsSync(this.globalDbPath)
        ? new SQL.Database(readFileSync(this.globalDbPath))
        : new SQL.Database();
      this.initSchemaForDb(this.globalDb, true);

      this.forceSave("both");
    } catch (err) {
      console.error("[Memory] Failed to initialize:", err);
    }
  }

  private ensureDir(filePath: string): void {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private initSchemaForDb(db: Database, isGlobal: boolean): void {
    try {
      db.run(`
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
      db.run(`CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)`);

      if (!isGlobal) {
        db.run(`
          CREATE TABLE IF NOT EXISTS session_context (
            session_id TEXT PRIMARY KEY,
            current_task TEXT,
            recent_tools TEXT DEFAULT '[]',
            conversation_summary TEXT,
            current_episode_id TEXT,
            updated_at INTEGER NOT NULL
          )
        `);
        db.run(`
          CREATE TABLE IF NOT EXISTS conversation_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp INTEGER NOT NULL
          )
        `);
        db.run(`CREATE INDEX IF NOT EXISTS idx_conv_session ON conversation_history(session_id)`);
      }

      // Schema versioning
      db.run(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL DEFAULT 0)`);
      this.runMigrations(db);
    } catch (err) {
      console.error("[Memory] Schema init error:", err);
    }
  }

  private runMigrations(db: Database): void {
    try {
      const res = db.exec(`SELECT version FROM schema_version LIMIT 1`);
      const current = res.length > 0 && res[0].values.length > 0
        ? (res[0].values[0][0] as number)
        : 0;

      if (current < 2) {
        // Migration v2: add FTS5 support
        try {
          db.run(`
            CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
            USING fts5(content, tokenize='porter ascii')
          `);
          db.run(`
            CREATE TABLE IF NOT EXISTS memory_fts_rowmap (
              memory_id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              fts_rowid INTEGER NOT NULL
            )
          `);
          db.run(`CREATE INDEX IF NOT EXISTS idx_fts_rowmap_session ON memory_fts_rowmap(session_id)`);
          this.fts5Available = true;

          // Back-fill FTS5 for existing memories
          const existing = db.exec(`SELECT id, session_id, content FROM memories`);
          if (existing.length > 0) {
            for (const row of existing[0].values) {
              const [memId, sessId, content] = row as [string, string, string];
              this.insertFtsRow(db, memId, sessId, content);
            }
          }
        } catch {
          console.log("[Memory] FTS5 not available, falling back to LIKE search");
          this.fts5Available = false;
        }
      } else {
        // FTS5 tables exist from a previous migration
        try {
          db.exec(`SELECT count(*) FROM memory_fts LIMIT 1`);
          this.fts5Available = true;
        } catch {
          this.fts5Available = false;
        }
      }

      if (current < 3) {
        // Migration v3: citations/source/confidence on memories, episodes table
        try {
          // Gracefully add columns (SQLite ALTER TABLE ADD COLUMN is safe)
          try { db.run(`ALTER TABLE memories ADD COLUMN citations TEXT DEFAULT '[]'`); } catch { /* already exists */ }
          try { db.run(`ALTER TABLE memories ADD COLUMN source TEXT DEFAULT 'observed'`); } catch { /* already exists */ }
          try { db.run(`ALTER TABLE memories ADD COLUMN confidence REAL DEFAULT 0.8`); } catch { /* already exists */ }
          try { db.run(`ALTER TABLE session_context ADD COLUMN current_episode_id TEXT`); } catch { /* already exists */ }

          db.run(`
            CREATE TABLE IF NOT EXISTS episodes (
              episode_id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              goal TEXT DEFAULT '',
              outcome TEXT DEFAULT 'unknown',
              actions TEXT DEFAULT '[]',
              lessons_learned TEXT DEFAULT '[]',
              mistakes TEXT DEFAULT '[]',
              importance_score REAL DEFAULT 5.0,
              keywords TEXT DEFAULT '[]',
              supersedes TEXT DEFAULT '[]',
              confidence REAL DEFAULT 0.8,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
          `);
          db.run(`CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id)`);
        } catch (e) {
          console.error("[Memory] Migration v3 error:", e);
        }
      }

      if (current === 0) {
        db.run(`INSERT INTO schema_version(version) VALUES (?)`, [SCHEMA_VERSION] as RowParam[]);
      } else if (current < SCHEMA_VERSION) {
        db.run(`UPDATE schema_version SET version = ?`, [SCHEMA_VERSION] as RowParam[]);
      }
    } catch (err) {
      console.error("[Memory] Migration error:", err);
    }
  }

  // ---- FTS5 helpers ----

  private insertFtsRow(db: Database, memoryId: string, sessionId: string, content: string): void {
    if (!this.fts5Available) return;
    try {
      db.run(`INSERT INTO memory_fts(content) VALUES (?)`, [content] as RowParam[]);
      const rowRes = db.exec(`SELECT last_insert_rowid()`);
      const rowId = rowRes[0].values[0][0] as number;
      db.run(
        `INSERT OR REPLACE INTO memory_fts_rowmap(memory_id, session_id, fts_rowid) VALUES (?,?,?)`,
        [memoryId, sessionId, rowId] as RowParam[]
      );
    } catch (err) {
      console.error("[Memory] FTS insert error:", err);
    }
  }

  private deleteFtsRow(db: Database, memoryId: string): void {
    if (!this.fts5Available) return;
    try {
      const res = db.exec(`SELECT fts_rowid FROM memory_fts_rowmap WHERE memory_id = ?`, [memoryId] as RowParam[]);
      if (res.length > 0 && res[0].values.length > 0) {
        const rowId = res[0].values[0][0] as number;
        db.run(`DELETE FROM memory_fts WHERE rowid = ?`, [rowId] as RowParam[]);
        db.run(`DELETE FROM memory_fts_rowmap WHERE memory_id = ?`, [memoryId] as RowParam[]);
      }
    } catch (err) {
      console.error("[Memory] FTS delete error:", err);
    }
  }

  private searchFtsIds(db: Database, sessionId: string, query: string, limit: number): string[] {
    if (!this.fts5Available) return [];
    try {
      const res = db.exec(
        `SELECT rm.memory_id
         FROM memory_fts
         JOIN memory_fts_rowmap rm ON memory_fts.rowid = rm.fts_rowid
         WHERE memory_fts MATCH ? AND rm.session_id = ?
         LIMIT ?`,
        [query, sessionId, limit] as RowParam[]
      );
      if (res.length === 0) return [];
      return res[0].values.map((row: unknown[]) => row[0] as string);
    } catch (err) {
      console.error("[Memory] FTS search error:", err);
      return [];
    }
  }

  // ---- Save helpers ----

  private scheduleSave(db: Database | null, dbPath: string, timerRef: { value: ReturnType<typeof setTimeout> | null }): void {
    if (!db) return;
    if (timerRef.value) clearTimeout(timerRef.value);
    timerRef.value = setTimeout(() => {
      timerRef.value = null;
      this.flushDb(db, dbPath);
    }, 1000);
  }

  private flushDb(db: Database | null, dbPath: string): void {
    if (!db) return;
    try {
      writeFileSync(dbPath, Buffer.from(db.export()));
    } catch (err) {
      console.error("[Memory] Save error:", err);
    }
  }

  forceSave(which: "project" | "global" | "both" = "project"): void {
    if (which === "project" || which === "both") {
      if (this.projectSaveTimer) { clearTimeout(this.projectSaveTimer); this.projectSaveTimer = null; }
      this.flushDb(this.projectDb, this.projectDbPath);
    }
    if (which === "global" || which === "both") {
      if (this.globalSaveTimer) { clearTimeout(this.globalSaveTimer); this.globalSaveTimer = null; }
      this.flushDb(this.globalDb, this.globalDbPath);
    }
  }

  // ---- Validation ----

  private validateInput(type: string, content: string, importance?: number): string | null {
    if (!VALID_MEMORY_TYPES.includes(type as MemoryType))
      return `Invalid type "${type}". Must be one of: ${VALID_MEMORY_TYPES.join(", ")}`;
    if (!content || content.trim().length === 0)
      return "Content must not be empty";
    if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES)
      return `Content exceeds 10KB limit`;
    if (importance !== undefined && (importance < 0 || importance > 1))
      return `Importance must be 0–1, got ${importance}`;
    return null;
  }

  // ---- Memory CRUD ----

  addMemory(
    entry: Omit<MemoryEntry, "id" | "accessCount" | "createdAt" | "updatedAt" | "lastAccessedAt" | "layer" | "decayScore">,
    layer: MemoryLayer = "project"
  ): string {
    const err = this.validateInput(entry.type, entry.content, entry.importance);
    if (err) { console.error(`[Memory] Validation: ${err}`); return ""; }

    let content = entry.content;
    const db = layer === "global" ? this.globalDb : this.projectDb;
    const sessionId = layer === "global" ? GLOBAL_SESSION_ID : this.sessionId;
    if (!db) return "";

    // Privacy filter for global writes
    if (layer === "global") {
      const { redacted, hadSensitive } = redactSensitiveContent(content);
      if (hadSensitive) {
        console.warn("[Memory] Sensitive content redacted before writing to global layer");
        content = redacted;
      }
    }

    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    try {
      db.run(
        `INSERT INTO memories (id, session_id, type, content, metadata, importance, access_count, created_at, updated_at, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [id, sessionId, entry.type, content, JSON.stringify(entry.metadata), entry.importance, now, now, now] as RowParam[]
      );
      this.insertFtsRow(db, id, sessionId, content);
      this.forceSave(layer);
      return id;
    } catch (e) {
      console.error("[Memory] addMemory error:", e);
      return "";
    }
  }

  /** Upsert aggregated tool usage — prevents experience memory explosion */
  upsertToolUsage(toolName: string, file?: string): void {
    const db = this.projectDb;
    if (!db) return;
    const sessionId = this.sessionId;
    const marker = `[tool_usage:${toolName}]`;
    const now = Date.now();

    try {
      const res = db.exec(
        `SELECT id, metadata FROM memories WHERE session_id = ? AND type = 'experience' AND content LIKE ?`,
        [sessionId, `${marker}%`] as RowParam[]
      );

      const lastInfo = file ? ` (last: ${file})` : "";

      if (res.length > 0 && res[0].values.length > 0) {
        const cols = res[0].columns;
        const row = res[0].values[0];
        const id = row[cols.indexOf("id")] as string;
        const meta = JSON.parse((row[cols.indexOf("metadata")] as string) || "{}") as Record<string, number | string>;
        const count = ((meta.count as number) || 0) + 1;
        const newContent = `${marker} Used tool: ${toolName} × ${count} this session${lastInfo}`;
        const newMeta = { ...meta, count, toolName, lastFile: file || "", lastUsed: now };

        db.run(
          `UPDATE memories SET content = ?, metadata = ?, updated_at = ?, last_accessed_at = ? WHERE id = ?`,
          [newContent, JSON.stringify(newMeta), now, now, id] as RowParam[]
        );
        // Update FTS
        this.deleteFtsRow(db, id);
        this.insertFtsRow(db, id, sessionId, newContent);
      } else {
        const id = `mem_${now}_${Math.random().toString(36).slice(2, 8)}`;
        const newContent = `${marker} Used tool: ${toolName} × 1 this session${lastInfo}`;
        const newMeta = { count: 1, toolName, lastFile: file || "", lastUsed: now };

        db.run(
          `INSERT INTO memories (id, session_id, type, content, metadata, importance, access_count, created_at, updated_at, last_accessed_at)
           VALUES (?, ?, 'experience', ?, ?, 0.3, 0, ?, ?, ?)`,
          [id, sessionId, newContent, JSON.stringify(newMeta), now, now, now] as RowParam[]
        );
        this.insertFtsRow(db, id, sessionId, newContent);
      }

      const timerRef = { value: this.projectSaveTimer };
      this.scheduleSave(db, this.projectDbPath, timerRef);
      this.projectSaveTimer = timerRef.value;
    } catch (e) {
      console.error("[Memory] upsertToolUsage error:", e);
    }
  }

  queryMemories(options: {
    type?: string;
    limit?: number;
    minImportance?: number;
    search?: string;
    layers?: MemoryLayer[];
  } = {}): MemoryEntry[] {
    const layers = options.layers ?? ["project", "global"];
    const limit = options.limit ?? 10;
    const results: MemoryEntry[] = [];

    if (layers.includes("project") && this.projectDb) {
      results.push(...this.queryDb(this.projectDb, this.sessionId, options, "project"));
    }
    if (layers.includes("global") && this.globalDb) {
      results.push(...this.queryDb(this.globalDb, GLOBAL_SESSION_ID, options, "global"));
    }

    // Apply decay scoring and sort
    for (const m of results) {
      m.decayScore = computeDecayScore(m.importance, m.lastAccessedAt, m.accessCount);
    }
    results.sort((a, b) => (b.decayScore ?? 0) - (a.decayScore ?? 0));

    // Deduplicate by content (project wins over global)
    const seen = new Set<string>();
    const deduped: MemoryEntry[] = [];
    for (const m of results) {
      const key = m.content.trim().toLowerCase();
      if (!seen.has(key)) { seen.add(key); deduped.push(m); }
    }

    return deduped.slice(0, limit);
  }

  private queryDb(
    db: Database,
    sessionId: string,
    options: { type?: string; minImportance?: number; search?: string; limit?: number },
    layer: MemoryLayer
  ): MemoryEntry[] {
    try {
      const fetchLimit = (options.limit ?? 10) * 3; // fetch extra for decay re-ranking

      // FTS5 search path
      if (options.search && this.fts5Available) {
        const ftsQuery = options.search.replace(/['"]/g, ""); // sanitize FTS5 query
        const matchIds = this.searchFtsIds(db, sessionId, ftsQuery, fetchLimit);
        if (matchIds.length === 0) return [];

        const placeholders = matchIds.map(() => "?").join(",");
        let sql = `SELECT * FROM memories WHERE id IN (${placeholders})`;
        const params: RowParam[] = [...matchIds];

        if (options.type) { sql += " AND type = ?"; params.push(options.type); }
        if (options.minImportance !== undefined) { sql += " AND importance >= ?"; params.push(options.minImportance); }
        sql += ` LIMIT ?`;
        params.push(fetchLimit);

        const res = db.exec(sql, params);
        if (res.length === 0) return [];
        return res[0].values.map((row: unknown[]) => ({ ...this.rowToEntry(res[0].columns, row), layer }));
      }

      // LIKE fallback
      let sql = "SELECT * FROM memories WHERE session_id = ?";
      const params: RowParam[] = [sessionId];

      if (options.type) { sql += " AND type = ?"; params.push(options.type); }
      if (options.minImportance !== undefined) { sql += " AND importance >= ?"; params.push(options.minImportance); }
      if (options.search) { sql += " AND content LIKE ?"; params.push(`%${options.search}%`); }

      sql += " ORDER BY importance DESC, last_accessed_at DESC LIMIT ?";
      params.push(fetchLimit);

      const res = db.exec(sql, params);
      if (res.length === 0) return [];
      return res[0].values.map((row: unknown[]) => ({ ...this.rowToEntry(res[0].columns, row), layer }));
    } catch (e) {
      console.error("[Memory] queryDb error:", e);
      return [];
    }
  }

  listMemories(options: { type?: string; limit?: number; layer?: MemoryLayer } = {}): MemoryEntry[] {
    const results: MemoryEntry[] = [];
    const limit = options.limit ?? 20;

    if ((!options.layer || options.layer === "project") && this.projectDb) {
      results.push(...this.queryDb(this.projectDb, this.sessionId, { type: options.type, limit }, "project"));
    }
    if ((!options.layer || options.layer === "global") && this.globalDb) {
      results.push(...this.queryDb(this.globalDb, GLOBAL_SESSION_ID, { type: options.type, limit }, "global"));
    }

    for (const m of results) {
      m.decayScore = computeDecayScore(m.importance, m.lastAccessedAt, m.accessCount);
    }
    results.sort((a, b) => (b.decayScore ?? 0) - (a.decayScore ?? 0));
    return results.slice(0, limit);
  }

  updateMemory(id: string, updates: Partial<Pick<MemoryEntry, "content" | "metadata" | "importance">>): boolean {
    if (updates.content !== undefined) {
      const e = this.validateInput("fact", updates.content, updates.importance);
      if (e && e.includes("Content")) { console.error(`[Memory] Validation: ${e}`); return false; }
    }

    for (const [db, sessionId, layer] of this.allDbs()) {
      try {
        const sets: string[] = ["updated_at = ?"];
        const params: RowParam[] = [Date.now()];

        if (updates.content !== undefined) { sets.push("content = ?"); params.push(updates.content); }
        if (updates.metadata !== undefined) { sets.push("metadata = ?"); params.push(JSON.stringify(updates.metadata)); }
        if (updates.importance !== undefined) { sets.push("importance = ?"); params.push(updates.importance); }

        params.push(id, sessionId);
        db.run(`UPDATE memories SET ${sets.join(", ")} WHERE id = ? AND session_id = ?`, params);

        if (db.getRowsModified() > 0) {
          if (updates.content !== undefined) {
            this.deleteFtsRow(db, id);
            this.insertFtsRow(db, id, sessionId, updates.content);
          }
          this.forceSave(layer);
          return true;
        }
      } catch (e) {
        console.error("[Memory] updateMemory error:", e);
      }
    }
    return false;
  }

  deleteMemory(id: string): boolean {
    for (const [db, sessionId, layer] of this.allDbs()) {
      try {
        db.run("DELETE FROM memories WHERE id = ? AND session_id = ?", [id, sessionId] as RowParam[]);
        if (db.getRowsModified() > 0) {
          this.deleteFtsRow(db, id);
          this.forceSave(layer);
          return true;
        }
      } catch (e) {
        console.error("[Memory] deleteMemory error:", e);
      }
    }
    return false;
  }

  promoteToProject(id: string): boolean {
    if (!this.globalDb || !this.projectDb) return false;
    try {
      const res = this.globalDb.exec(
        `SELECT * FROM memories WHERE id = ? AND session_id = ?`,
        [id, GLOBAL_SESSION_ID] as RowParam[]
      );
      if (res.length === 0 || res[0].values.length === 0) return false;

      const entry = this.rowToEntry(res[0].columns, res[0].values[0]);
      const newId = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();

      this.projectDb.run(
        `INSERT INTO memories (id, session_id, type, content, metadata, importance, access_count, created_at, updated_at, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId, this.sessionId, entry.type, entry.content, JSON.stringify(entry.metadata),
         entry.importance, entry.accessCount, now, now, now] as RowParam[]
      );
      this.insertFtsRow(this.projectDb, newId, this.sessionId, entry.content);
      this.forceSave("project");
      return true;
    } catch (e) {
      console.error("[Memory] promoteToProject error:", e);
      return false;
    }
  }

  private allDbs(): Array<[Database, string, MemoryLayer]> {
    const list: Array<[Database, string, MemoryLayer]> = [];
    if (this.projectDb) list.push([this.projectDb, this.sessionId, "project"]);
    if (this.globalDb) list.push([this.globalDb, GLOBAL_SESSION_ID, "global"]);
    return list;
  }

  // ---- Session Context (project DB only) ----

  getSessionContext(): SessionContext | null {
    const db = this.projectDb;
    if (!db) return null;
    try {
      const res = db.exec(`SELECT * FROM session_context WHERE session_id = ?`, [this.sessionId] as RowParam[]);
      if (res.length === 0 || res[0].values.length === 0) return null;
      const cols = res[0].columns;
      const row = res[0].values[0];
      const i = (n: string) => cols.indexOf(n);
      return {
        sessionId: row[i("session_id")] as string,
        currentTask: row[i("current_task")] as string | undefined,
        recentTools: JSON.parse((row[i("recent_tools")] as string) || "[]"),
        conversationSummary: row[i("conversation_summary")] as string | undefined,
        currentEpisodeId: (row[i("current_episode_id")] as string | null) ?? undefined,
      };
    } catch (e) {
      console.error("[Memory] getSessionContext error:", e);
      return null;
    }
  }

  updateSessionContext(updates: Partial<Omit<SessionContext, "sessionId">>): void {
    const db = this.projectDb;
    if (!db) return;
    try {
      const existing = this.getSessionContext();
      const now = Date.now();
      if (existing) {
        const sets: string[] = ["updated_at = ?"];
        const params: RowParam[] = [now];
        if (updates.currentTask !== undefined) { sets.push("current_task = ?"); params.push(updates.currentTask); }
        if (updates.recentTools !== undefined) { sets.push("recent_tools = ?"); params.push(JSON.stringify(updates.recentTools)); }
        if (updates.conversationSummary !== undefined) { sets.push("conversation_summary = ?"); params.push(updates.conversationSummary); }
        if (updates.currentEpisodeId !== undefined) { sets.push("current_episode_id = ?"); params.push(updates.currentEpisodeId ?? null); }
        params.push(this.sessionId);
        db.run(`UPDATE session_context SET ${sets.join(", ")} WHERE session_id = ?`, params);
      } else {
        db.run(
          `INSERT INTO session_context (session_id, current_task, recent_tools, conversation_summary, current_episode_id, updated_at) VALUES (?,?,?,?,?,?)`,
          [this.sessionId, updates.currentTask || null, JSON.stringify(updates.recentTools || []),
           updates.conversationSummary || null, updates.currentEpisodeId || null, now] as RowParam[]
        );
      }
      const timerRef = { value: this.projectSaveTimer };
      this.scheduleSave(db, this.projectDbPath, timerRef);
      this.projectSaveTimer = timerRef.value;
    } catch (e) {
      console.error("[Memory] updateSessionContext error:", e);
    }
  }

  // ---- Conversation History (project DB only) ----

  addConversation(role: string, content: string): void {
    const db = this.projectDb;
    if (!db) return;
    try {
      db.run(
        `INSERT INTO conversation_history (session_id, role, content, timestamp) VALUES (?,?,?,?)`,
        [this.sessionId, role, content, Date.now()] as RowParam[]
      );
      db.run(
        `DELETE FROM conversation_history
         WHERE session_id = ? AND id NOT IN (
           SELECT id FROM conversation_history WHERE session_id = ? ORDER BY timestamp DESC LIMIT 50
         )`,
        [this.sessionId, this.sessionId] as RowParam[]
      );
      const timerRef = { value: this.projectSaveTimer };
      this.scheduleSave(db, this.projectDbPath, timerRef);
      this.projectSaveTimer = timerRef.value;
    } catch (e) {
      console.error("[Memory] addConversation error:", e);
    }
  }

  getRecentConversations(limit = 10): Array<{ role: string; content: string; timestamp: number }> {
    const db = this.projectDb;
    if (!db) return [];
    try {
      const res = db.exec(
        `SELECT role, content, timestamp FROM conversation_history WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?`,
        [this.sessionId, limit] as RowParam[]
      );
      if (res.length === 0) return [];
      const cols = res[0].columns;
      return res[0].values.map((row: unknown[]) => ({
        role: row[cols.indexOf("role")] as string,
        content: row[cols.indexOf("content")] as string,
        timestamp: row[cols.indexOf("timestamp")] as number,
      }));
    } catch (e) {
      console.error("[Memory] getRecentConversations error:", e);
      return [];
    }
  }

  // ---- Stats ----

  getStats(): { total: number; byType: Record<string, number>; avgImportance: number; globalTotal: number } {
    const count = (db: Database | null, sessionId: string) => {
      if (!db) return { total: 0, byType: {} as Record<string, number>, avg: 0 };
      try {
        const t = db.exec(`SELECT COUNT(*) FROM memories WHERE session_id = ?`, [sessionId] as RowParam[]);
        const total = t.length > 0 ? (t[0].values[0][0] as number) : 0;
        const bt = db.exec(`SELECT type, COUNT(*) FROM memories WHERE session_id = ? GROUP BY type`, [sessionId] as RowParam[]);
        const byType: Record<string, number> = {};
        if (bt.length > 0) for (const r of bt[0].values) byType[r[0] as string] = r[1] as number;
        const a = db.exec(`SELECT AVG(importance) FROM memories WHERE session_id = ?`, [sessionId] as RowParam[]);
        const avg = a.length > 0 ? (a[0].values[0][0] as number) || 0 : 0;
        return { total, byType, avg };
      } catch { return { total: 0, byType: {}, avg: 0 }; }
    };

    const proj = count(this.projectDb, this.sessionId);
    const glob = count(this.globalDb, GLOBAL_SESSION_ID);

    return {
      total: proj.total,
      byType: proj.byType,
      avgImportance: proj.avg,
      globalTotal: glob.total,
    };
  }

  private rowToEntry(columns: string[], row: unknown[]): MemoryEntry {
    const i = (n: string) => columns.indexOf(n);
    return {
      id: row[i("id")] as string,
      type: row[i("type")] as MemoryType,
      content: row[i("content")] as string,
      metadata: JSON.parse((row[i("metadata")] as string) || "{}"),
      importance: row[i("importance")] as number,
      accessCount: row[i("access_count")] as number,
      createdAt: row[i("created_at")] as number,
      updatedAt: row[i("updated_at")] as number,
      lastAccessedAt: row[i("last_accessed_at")] as number,
    };
  }

  addSkillMemory(params: {
    name: string;
    triggerPatterns: string[];
    steps: string[];
    applicability: string;
    termination?: string;
    citations?: string[];
    importance?: number;
  }): string {
    const content = `SKILL: ${params.name}\nTriggers: ${params.triggerPatterns.join(", ")}\nApplies when: ${params.applicability}\nSteps:\n${params.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}${params.termination ? `\nDone when: ${params.termination}` : ""}`;
    const db = this.projectDb;
    if (!db) return "";
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const meta = {
      skillName: params.name,
      triggerPatterns: params.triggerPatterns,
      steps: params.steps,
      applicability: params.applicability,
      termination: params.termination || "",
      addedBy: "agent",
    };
    try {
      db.run(
        `INSERT INTO memories (id, session_id, type, content, metadata, importance, access_count, created_at, updated_at, last_accessed_at, citations, source, confidence)
         VALUES (?, ?, 'skill', ?, ?, ?, 0, ?, ?, ?, ?, 'observed', 0.65)`,
        [id, this.sessionId, content, JSON.stringify(meta), params.importance ?? 0.7,
         now, now, now, JSON.stringify(params.citations ?? [])] as RowParam[]
      );
      this.insertFtsRow(db, id, this.sessionId, content);
      this.forceSave("project");
      return id;
    } catch (e) {
      console.error("[Memory] addSkillMemory error:", e);
      return "";
    }
  }

  approveSkill(id: string): boolean {
    const db = this.projectDb;
    if (!db) return false;
    try {
      db.run(
        `UPDATE memories SET source = 'human', confidence = 0.9, updated_at = ? WHERE id = ? AND session_id = ? AND type = 'skill'`,
        [Date.now(), id, this.sessionId] as RowParam[]
      );
      this.forceSave("project");
      return db.getRowsModified() > 0;
    } catch (e) {
      console.error("[Memory] approveSkill error:", e);
      return false;
    }
  }

  validateCitations(): Array<{ memoryId: string; citation: string; valid: boolean }> {
    const db = this.projectDb;
    if (!db) return [];
    const results: Array<{ memoryId: string; citation: string; valid: boolean }> = [];
    try {
      const res = db.exec(
        `SELECT id, citations FROM memories WHERE session_id = ? AND citations != '[]'`,
        [this.sessionId] as RowParam[]
      );
      if (res.length === 0) return [];
      for (const row of res[0].values) {
        const memId = row[0] as string;
        const cits = JSON.parse((row[1] as string) || "[]") as string[];
        for (const cit of cits) {
          const filePath = cit.includes(":") ? cit.split(":")[0] : cit;
          results.push({ memoryId: memId, citation: cit, valid: existsSync(filePath) });
        }
      }
    } catch (e) {
      console.error("[Memory] validateCitations error:", e);
    }
    return results;
  }

  startEpisode(goal: string): string {
    const db = this.projectDb;
    if (!db) return "";
    const episodeId = `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    try {
      db.run(
        `INSERT INTO episodes (episode_id, session_id, goal, outcome, actions, lessons_learned, mistakes, importance_score, keywords, supersedes, confidence, created_at, updated_at)
         VALUES (?, ?, ?, 'unknown', '[]', '[]', '[]', 5.0, '[]', '[]', 0.8, ?, ?)`,
        [episodeId, this.sessionId, goal, now, now] as RowParam[]
      );
      this.updateSessionContext({ currentEpisodeId: episodeId });
      this.forceSave("project");
      return episodeId;
    } catch (e) {
      console.error("[Memory] startEpisode error:", e);
      return "";
    }
  }

  endEpisode(params: {
    outcome: EpisodeOutcome;
    lessonsLearned?: string[];
    mistakes?: string[];
    importanceScore?: number;
    keywords?: string[];
  }): boolean {
    const db = this.projectDb;
    if (!db) return false;
    const ctx = this.getSessionContext();
    const episodeId = ctx?.currentEpisodeId;
    if (!episodeId) return false;
    const now = Date.now();
    try {
      db.run(
        `UPDATE episodes SET outcome = ?, lessons_learned = ?, mistakes = ?, importance_score = ?, keywords = ?, updated_at = ? WHERE episode_id = ? AND session_id = ?`,
        [
          params.outcome,
          JSON.stringify(params.lessonsLearned ?? []),
          JSON.stringify(params.mistakes ?? []),
          params.importanceScore ?? 5.0,
          JSON.stringify(params.keywords ?? []),
          now, episodeId, this.sessionId,
        ] as RowParam[]
      );

      if (params.lessonsLearned && params.lessonsLearned.length > 0) {
        for (const lesson of params.lessonsLearned) {
          if (lesson.trim()) {
            this.addMemory(
              { type: "fact", content: `[lesson] ${lesson}`, metadata: { episodeId, source: "reflection" }, importance: 0.75 },
              "project"
            );
          }
        }
      }

      this.updateSessionContext({ currentEpisodeId: undefined });
      this.forceSave("project");
      return db.getRowsModified() > 0;
    } catch (e) {
      console.error("[Memory] endEpisode error:", e);
      return false;
    }
  }

  addActionToEpisode(toolName: string, summary: string): void {
    const db = this.projectDb;
    if (!db) return;
    const ctx = this.getSessionContext();
    const episodeId = ctx?.currentEpisodeId;
    if (!episodeId) return;
    try {
      const res = db.exec(
        `SELECT actions FROM episodes WHERE episode_id = ? AND session_id = ?`,
        [episodeId, this.sessionId] as RowParam[]
      );
      if (res.length === 0 || res[0].values.length === 0) return;
      const actions = JSON.parse((res[0].values[0][0] as string) || "[]") as EpisodeAction[];
      actions.push({ tool: toolName, summary: summary.slice(0, 200), timestamp: Date.now() });
      db.run(
        `UPDATE episodes SET actions = ?, updated_at = ? WHERE episode_id = ? AND session_id = ?`,
        [JSON.stringify(actions), Date.now(), episodeId, this.sessionId] as RowParam[]
      );
    } catch (e) {
      console.error("[Memory] addActionToEpisode error:", e);
    }
  }

  listEpisodes(limit = 10): Episode[] {
    const db = this.projectDb;
    if (!db) return [];
    try {
      const res = db.exec(
        `SELECT * FROM episodes WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
        [this.sessionId, limit] as RowParam[]
      );
      if (res.length === 0) return [];
      const cols = res[0].columns;
      const i = (n: string) => cols.indexOf(n);
      return res[0].values.map((row: unknown[]) => ({
        episodeId: row[i("episode_id")] as string,
        sessionId: row[i("session_id")] as string,
        goal: row[i("goal")] as string,
        outcome: row[i("outcome")] as EpisodeOutcome,
        actions: JSON.parse((row[i("actions")] as string) || "[]"),
        lessonsLearned: JSON.parse((row[i("lessons_learned")] as string) || "[]"),
        mistakes: JSON.parse((row[i("mistakes")] as string) || "[]"),
        importanceScore: row[i("importance_score")] as number,
        keywords: JSON.parse((row[i("keywords")] as string) || "[]"),
        supersedes: JSON.parse((row[i("supersedes")] as string) || "[]"),
        confidence: row[i("confidence")] as number,
        createdAt: row[i("created_at")] as number,
        updatedAt: row[i("updated_at")] as number,
      }));
    } catch (e) {
      console.error("[Memory] listEpisodes error:", e);
      return [];
    }
  }

  getCurrentEpisodeId(): string | undefined {
    return this.getSessionContext()?.currentEpisodeId;
  }

  close(): void {
    this.forceSave("both");
    this.projectDb?.close();
    this.globalDb?.close();
    this.projectDb = null;
    this.globalDb = null;
  }
}

// ============================================================
// Plugin
// ============================================================

const MemoryPlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const { directory } = input;

  const projectDbPath = join(homedir(), ".local", "share", "opencode", "memory", "memory.db");
  const globalDbPath  = join(homedir(), ".config", "opencode", "memory", "global.db");

  const store = new MemoryStore(projectDbPath, globalDbPath);
  await store.initialize();
  console.log(`[Memory] v2 initialized | project: ${projectDbPath} | global: ${globalDbPath}`);

  const getSessionId = (h: { sessionID?: string }): string =>
    h?.sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`;

  return {
    "experimental.chat.system.transform": async (h, output) => {
      store.setSessionId(getSessionId(h));
      const memories = store.queryMemories({ limit: 10, minImportance: 0.4 });
      const ctx = store.getSessionContext();

      if (memories.length === 0 && !ctx) return;
      const lines: string[] = [];

      if (memories.length > 0) {
        const skills = memories.filter(m => m.type === "skill");
        const others = memories.filter(m => m.type !== "skill");
        lines.push("\n<agent_memory>");
        if (others.length > 0) {
          lines.push("## Memories");
          for (const m of others) {
            const tag = m.layer === "global" ? " [global]" : "";
            lines.push(`- [${m.type}${tag}] ${m.content}`);
          }
        }
        if (skills.length > 0) {
          lines.push("## Skills");
          for (const m of skills) {
            const needsReview = (m.metadata as Record<string, unknown>)?.source === "observed" ? " ⚠️ unreviewed" : "";
            lines.push(`### ${(m.metadata as Record<string, unknown>)?.skillName || m.id}${needsReview}`);
            lines.push(m.content);
          }
        }
        lines.push("</agent_memory>");
      }
      if (ctx?.currentTask)
        lines.push(`\n<current_task>${ctx.currentTask}</current_task>`);
      if (ctx?.recentTools?.length)
        lines.push(`\n<recent_tools>${ctx.recentTools.slice(-5).join(", ")}</recent_tools>`);

      if (lines.length > 0) output.system.push(...lines);
    },

    "chat.message": async (h, output) => {
      store.setSessionId(getSessionId(h));
      const text = output.parts
        .filter(p => p.type === "text")
        .map(p => (p as { text?: string }).text || "")
        .join("\n")
        .slice(0, 1000);
      if (text) store.addConversation("user", text);
    },

    "tool.execute.after": async (h, _output) => {
      store.setSessionId(getSessionId(h));
      const { tool: toolName } = h;
      const ctx = store.getSessionContext();
      const recentTools = ctx?.recentTools || [];
      recentTools.push(toolName);
      store.updateSessionContext({ recentTools: recentTools.slice(-20) });

      const significant = ["Edit", "Write", "Bash", "mcp_task"];
      if (significant.some(t => toolName.includes(t))) {
        const args = (h as { args?: { filePath?: string; path?: string } }).args;
        const file = args?.filePath || args?.path;
        store.upsertToolUsage(toolName, file);
        store.addActionToEpisode(toolName, file ? `${toolName} on ${file}` : toolName);
      }
    },

    tool: {
      memory_query: tool({
        description: "Query agent memory. Searches both project and global layers with FTS5 (falls back to LIKE). Results ranked by decay score.",
        args: {
          query: tool.schema.string().describe("Search query"),
          type: tool.schema.enum(["fact", "experience", "preference", "skill"]).optional(),
          limit: tool.schema.number().optional().describe("Max results (default 10)"),
          layer: tool.schema.enum(["project", "global"]).optional().describe("Restrict to one layer"),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`);
          const layers: MemoryLayer[] = args.layer ? [args.layer] : ["project", "global"];
          const mems = store.queryMemories({ search: args.query, type: args.type, limit: args.limit || 10, layers });
          if (mems.length === 0) return "No relevant memories found.";
          return `Found ${mems.length} memories:\n` +
            mems.map(m => `- [${m.type}${m.layer === "global" ? "/global" : ""}] (id: ${m.id}) ${m.content} (score: ${m.decayScore?.toFixed(3)})`).join("\n");
        },
      }),

      memory_add: tool({
        description: "Add a memory. Default layer is 'project'. Use 'global' for cross-project user preferences. Sensitive content is auto-redacted in global layer.",
        args: {
          type: tool.schema.enum(["fact", "preference", "skill"]).describe("Memory type"),
          content: tool.schema.string().describe("Content to remember (max 10KB)"),
          importance: tool.schema.number().min(0).max(1).optional().describe("Importance 0–1 (default 0.5)"),
          layer: tool.schema.enum(["project", "global"]).optional().describe("Storage layer (default: project)"),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`);
          const layer: MemoryLayer = (args.layer as MemoryLayer) || "project";
          const id = store.addMemory({ type: args.type, content: args.content, metadata: { addedBy: "agent" }, importance: args.importance || 0.5 }, layer);
          if (!id) return "Failed to store memory (validation error or DB unavailable).";
          return `Memory stored with ID: ${id} (layer: ${layer})`;
        },
      }),

      memory_update: tool({
        description: "Update an existing memory by ID.",
        args: {
          id: tool.schema.string(),
          content: tool.schema.string().optional().describe("New content (max 10KB)"),
          importance: tool.schema.number().min(0).max(1).optional(),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`);
          if (!args.content && args.importance === undefined) return "Provide at least one of: content, importance";
          const ok = store.updateMemory(args.id, { content: args.content, importance: args.importance });
          return ok ? `Memory ${args.id} updated.` : `Memory ${args.id} not found.`;
        },
      }),

      memory_delete: tool({
        description: "Delete a memory by ID.",
        args: { id: tool.schema.string() },
        async execute(args, { sessionID }) {
          store.setSessionId(sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`);
          return store.deleteMemory(args.id) ? `Memory ${args.id} deleted.` : `Memory ${args.id} not found.`;
        },
      }),

      memory_list: tool({
        description: "List memories. Shows ID, type, layer, decay score, and content preview.",
        args: {
          type: tool.schema.enum(["fact", "experience", "preference", "skill"]).optional(),
          limit: tool.schema.number().optional().describe("Max results (default 20)"),
          layer: tool.schema.enum(["project", "global"]).optional(),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`);
          const mems = store.listMemories({ type: args.type, limit: args.limit || 20, layer: args.layer as MemoryLayer | undefined });
          if (mems.length === 0) return "No memories stored yet.";
          return `${mems.length} memories:\n` +
            mems.map(m => {
              const preview = m.content.slice(0, 100) + (m.content.length > 100 ? "…" : "");
              return `[${m.type}/${m.layer}] ${m.id}  score:${m.decayScore?.toFixed(3)}  "${preview}"`;
            }).join("\n");
        },
      }),

      memory_promote: tool({
        description: "Promote a global memory into the current project layer.",
        args: { id: tool.schema.string().describe("Memory ID from global layer") },
        async execute(args, { sessionID }) {
          store.setSessionId(sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`);
          return store.promoteToProject(args.id)
            ? `Memory ${args.id} copied from global → project layer.`
            : `Memory ${args.id} not found in global layer.`;
        },
      }),

      memory_add_skill: tool({
        description: "Add a procedural skill memory (reusable workflow). Skills with confidence < 0.7 are shown as unreviewed in system prompt. Use memory_approve_skill to promote to reviewed.",
        args: {
          name: tool.schema.string().describe("Skill name, e.g. 'test-before-commit'"),
          trigger_patterns: tool.schema.array(tool.schema.string()).describe("Phrases that should trigger this skill"),
          steps: tool.schema.array(tool.schema.string()).describe("Ordered steps to execute"),
          applicability: tool.schema.string().describe("When this skill applies"),
          termination: tool.schema.string().optional().describe("Done condition"),
          citations: tool.schema.array(tool.schema.string()).optional().describe("File:line references"),
          importance: tool.schema.number().min(0).max(1).optional(),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`);
          const id = store.addSkillMemory({
            name: args.name,
            triggerPatterns: args.trigger_patterns,
            steps: args.steps,
            applicability: args.applicability,
            termination: args.termination,
            citations: args.citations,
            importance: args.importance,
          });
          return id ? `Skill "${args.name}" stored with ID: ${id} (unreviewed — use memory_approve_skill to confirm)` : "Failed to store skill.";
        },
      }),

      memory_approve_skill: tool({
        description: "Mark a skill memory as human-reviewed (confidence 0.9, source: human). Removes the unreviewed warning from system prompt.",
        args: { id: tool.schema.string().describe("Skill memory ID") },
        async execute(args, { sessionID }) {
          store.setSessionId(sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`);
          return store.approveSkill(args.id) ? `Skill ${args.id} approved (confidence: 0.9).` : `Skill ${args.id} not found.`;
        },
      }),

      memory_validate_citations: tool({
        description: "Check all citation file paths in memory are still valid. Returns stale citations.",
        args: {},
        async execute(_, { sessionID }) {
          store.setSessionId(sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`);
          const results = store.validateCitations();
          if (results.length === 0) return "No citations found.";
          const stale = results.filter(r => !r.valid);
          const valid = results.filter(r => r.valid);
          return [
            `Citations: ${results.length} total, ${valid.length} valid, ${stale.length} stale`,
            ...stale.map(r => `  ✗ ${r.citation} (memory: ${r.memoryId})`),
          ].join("\n");
        },
      }),

      memory_start_episode: tool({
        description: "Start tracking a new episode (task attempt). Automatically records subsequent tool calls as episode actions.",
        args: { goal: tool.schema.string().describe("What you're trying to accomplish") },
        async execute(args, { sessionID }) {
          store.setSessionId(sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`);
          const id = store.startEpisode(args.goal);
          return id ? `Episode started: ${id}\nGoal: ${args.goal}\nCall memory_end_episode when done.` : "Failed to start episode.";
        },
      }),

      memory_end_episode: tool({
        description: "Finalize the current episode. Lessons learned are automatically promoted to fact memories.",
        args: {
          outcome: tool.schema.enum(["success", "partial", "failure", "abandoned"]),
          lessons_learned: tool.schema.array(tool.schema.string()).optional().describe("High-level insights to remember"),
          mistakes: tool.schema.array(tool.schema.string()).optional().describe("Errors made (include what went wrong)"),
          importance_score: tool.schema.number().min(1).max(10).optional().describe("How important was this episode (1-10)"),
          keywords: tool.schema.array(tool.schema.string()).optional(),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`);
          const ok = store.endEpisode({
            outcome: args.outcome as EpisodeOutcome,
            lessonsLearned: args.lessons_learned,
            mistakes: args.mistakes,
            importanceScore: args.importance_score,
            keywords: args.keywords,
          });
          if (!ok) return "No active episode found. Use memory_start_episode first.";
          const promoted = (args.lessons_learned?.length ?? 0);
          return `Episode closed (${args.outcome}). ${promoted} lessons promoted to memory.`;
        },
      }),

      memory_list_episodes: tool({
        description: "List recent episodes for this session.",
        args: { limit: tool.schema.number().optional().describe("Max results (default 10)") },
        async execute(args, { sessionID }) {
          store.setSessionId(sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`);
          const eps = store.listEpisodes(args.limit || 10);
          if (eps.length === 0) return "No episodes recorded yet.";
          return eps.map(ep => {
            const actions = ep.actions.length;
            const lessons = ep.lessonsLearned.length;
            return `[${ep.outcome}] ${ep.episodeId}  goal: "${ep.goal.slice(0, 60)}"  actions:${actions}  lessons:${lessons}`;
          }).join("\n");
        },
      }),

      memory_stats: tool({
        description: "Get memory statistics (project + global layers).",
        args: {},
        async execute(_, { sessionID }) {
          store.setSessionId(sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`);
          const s = store.getStats();
          const ctx = store.getSessionContext();
          return [
            `Memory Statistics:`,
            `- Project memories: ${s.total} | by type: ${JSON.stringify(s.byType)}`,
            `- Global memories:  ${s.globalTotal}`,
            `- Avg importance:   ${s.avgImportance.toFixed(2)}`,
            `- Current task:     ${ctx?.currentTask || "None"}`,
            `- Recent tools:     ${ctx?.recentTools?.slice(-5).join(", ") || "None"}`,
          ].join("\n");
        },
      }),

      memory_set_task: tool({
        description: "Set current task context.",
        args: { task: tool.schema.string() },
        async execute(args, { sessionID }) {
          store.setSessionId(sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`);
          store.updateSessionContext({ currentTask: args.task });
          return `Current task set to: ${args.task}`;
        },
      }),

      memory_status: tool({
        description: "Concise memory system status.",
        args: {},
        async execute(_, { sessionID }) {
          store.setSessionId(sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`);
          const s = store.getStats();
          const ctx = store.getSessionContext();
          return `🧠 Project: ${s.total} | Global: ${s.globalTotal} | 🎯 ${ctx?.currentTask || "No task"} | 🔧 ${ctx?.recentTools?.slice(-3).join(", ") || "None"}`;
        },
      }),
    },
  };
};

export default MemoryPlugin;
