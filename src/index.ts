/**
 * OpenCode Memory System Plugin v5
 *
 * Phase 5: sql.js → bun:sqlite migration + sqlite-vec hybrid search (Issue #10)
 *   - bun:sqlite: native SQLite, WAL mode, extension support
 *   - sqlite-vec: KNN vector search (768-dim, cosine distance)
 *   - RRF hybrid: FTS5 BM25 + vector KNN merged via Reciprocal Rank Fusion
 *   - EmbeddingService: Ollama nomic-embed-text, graceful fallback to FTS5-only
 *
 * Previous phases:
 *   v4 (Issue #9): memory_reinforce, memory_strength, fix access_count gap
 *   v3 (Issue #6/7): citation procedural memory, episode tracking
 *   v2 (Issue #2/4/5): FTS5 search, global/project layers, decay ranking
 *   v1 (Issue #1/8): security, CRUD tools, experience aggregation
 *
 * Based on "Memory in the Age of AI Agents" (arXiv:2512.13564v2)
 */

import type { Plugin, Hooks, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import { homedir } from "os";

type MemoryType   = "fact" | "experience" | "preference" | "skill";
type MemoryLayer  = "global" | "project";
type RowParam     = string | number | null;
type EpisodeOutcome = "success" | "partial" | "failure" | "abandoned" | "unknown";

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
  memoryStrength: number;
  reinforcementCount: number;
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

interface MemoryRow {
  id: string; session_id: string; type: string; content: string;
  metadata: string; importance: number; access_count: number;
  created_at: number; updated_at: number; last_accessed_at: number;
  citations: string | null; source: string | null; confidence: number | null;
  memory_strength: number | null; reinforcement_count: number | null;
}

interface SessionContextRow {
  session_id: string; current_task: string | null;
  recent_tools: string; conversation_summary: string | null;
  current_episode_id: string | null;
}

interface EpisodeRow {
  episode_id: string; session_id: string; goal: string; outcome: string;
  actions: string; lessons_learned: string; mistakes: string;
  importance_score: number; keywords: string; supersedes: string;
  confidence: number; created_at: number; updated_at: number;
}

const VALID_MEMORY_TYPES: MemoryType[] = ["fact", "experience", "preference", "skill"];
const MAX_CONTENT_BYTES  = 10 * 1024;
const SCHEMA_VERSION     = 5;
const DECAY_LAMBDA       = 0.1;
const GLOBAL_SESSION_ID  = "__global__";
const EMBED_DIM          = 768; // nomic-embed-text output dimension

const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g,
  /(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+/gi,
  /bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi,
];

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

function computeDecayScore(
  importance: number, lastAccessedAt: number,
  accessCount: number, memoryStrength = 1.0
): number {
  const daysSince     = (Date.now() - lastAccessedAt) / 86_400_000;
  const effectiveLambda = DECAY_LAMBDA / memoryStrength;
  const recency       = Math.exp(-effectiveLambda * daysSince);
  const frequency     = Math.log(2 + accessCount);
  return importance * recency * frequency;
}

function rrfMerge(listA: string[], listB: string[], k = 60): string[] {
  const scores = new Map<string, number>();
  listA.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  listB.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

class EmbeddingService {
  private available: boolean | null = null;

  async embed(text: string): Promise<Float32Array | null> {
    if (this.available === false) return null;
    try {
      const resp = await fetch("http://localhost:11434/api/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "nomic-embed-text", input: `passage: ${text}` }),
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) { this.available = false; return null; }
      const data = await resp.json() as { embeddings: number[][] };
      this.available = true;
      return new Float32Array(data.embeddings[0]);
    } catch {
      this.available = false;
      return null;
    }
  }

  async embedQuery(text: string): Promise<Float32Array | null> {
    if (this.available === false) return null;
    try {
      const resp = await fetch("http://localhost:11434/api/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "nomic-embed-text", input: `query: ${text}` }),
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) { this.available = false; return null; }
      const data = await resp.json() as { embeddings: number[][] };
      this.available = true;
      return new Float32Array(data.embeddings[0]);
    } catch {
      this.available = false;
      return null;
    }
  }

  isAvailable(): boolean { return this.available === true; }
}

class MemoryStore {
  private projectDb: Database | null = null;
  private globalDb:  Database | null = null;
  private readonly projectDbPath: string;
  private readonly globalDbPath:  string;
  private sessionId    = "";
  private fts5Available = false;
  private vecAvailable  = false;
  private readonly embedder = new EmbeddingService();

  constructor(projectDbPath: string, globalDbPath: string) {
    this.projectDbPath = projectDbPath;
    this.globalDbPath  = globalDbPath;
  }

  setSessionId(id: string) { this.sessionId = id; }
  getSessionId(): string   { return this.sessionId; }

  initialize(): void {
    try {
      this.setupMacOSSQLite();

      this.ensureDir(this.projectDbPath);
      this.projectDb = new Database(this.projectDbPath);
      this.tryLoadVec(this.projectDb);
      this.initSchemaForDb(this.projectDb, false);

      this.ensureDir(this.globalDbPath);
      this.globalDb = new Database(this.globalDbPath);
      this.tryLoadVec(this.globalDb);
      this.initSchemaForDb(this.globalDb, true);
    } catch (err) {
      console.error("[Memory] Initialization failed:", err);
    }
  }

  private setupMacOSSQLite(): void {
    if (process.platform !== "darwin") return;
    const paths = [
      "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
      "/usr/local/opt/sqlite3/lib/libsqlite3.dylib",
    ];
    for (const p of paths) {
      if (existsSync(p)) {
        try { Database.setCustomSQLite(p); } catch { /* ignore */ }
        break;
      }
    }
  }

  private tryLoadVec(db: Database): void {
    try {
      sqliteVec.load(db);
      this.vecAvailable = true;
    } catch {
      console.log("[Memory] sqlite-vec unavailable, vector search disabled");
      this.vecAvailable = false;
    }
  }

  private ensureDir(filePath: string): void {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private initSchemaForDb(db: Database, isGlobal: boolean): void {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA mmap_size = 67108864");

      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
          type TEXT NOT NULL, content TEXT NOT NULL,
          metadata TEXT DEFAULT '{}', importance REAL DEFAULT 0.5,
          access_count INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          last_accessed_at INTEGER NOT NULL
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)");

      if (!isGlobal) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS session_context (
            session_id TEXT PRIMARY KEY, current_task TEXT,
            recent_tools TEXT DEFAULT '[]', conversation_summary TEXT,
            current_episode_id TEXT, updated_at INTEGER NOT NULL
          )
        `);
        db.exec(`
          CREATE TABLE IF NOT EXISTS conversation_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL, role TEXT NOT NULL,
            content TEXT NOT NULL, timestamp INTEGER NOT NULL
          )
        `);
        db.exec("CREATE INDEX IF NOT EXISTS idx_conv_session ON conversation_history(session_id)");
      }

      db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL DEFAULT 0)");
      this.runMigrations(db, isGlobal);
    } catch (err) {
      console.error("[Memory] Schema init error:", err);
    }
  }

  private runMigrations(db: Database, isGlobal: boolean): void {
    try {
      const vRow = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | null;
      const current = vRow?.version ?? 0;

      if (current < 2) {
        try {
          db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, tokenize='porter ascii')`);
          db.exec(`
            CREATE TABLE IF NOT EXISTS memory_fts_rowmap (
              memory_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fts_rowid INTEGER NOT NULL
            )
          `);
          db.exec("CREATE INDEX IF NOT EXISTS idx_fts_rowmap_session ON memory_fts_rowmap(session_id)");
          this.fts5Available = true;
          const rows = db.prepare("SELECT id, session_id, content FROM memories").all() as
            { id: string; session_id: string; content: string }[];
          for (const r of rows) this.insertFtsRow(db, r.id, r.session_id, r.content);
        } catch { this.fts5Available = false; }
      } else {
        try { db.exec("SELECT count(*) FROM memory_fts LIMIT 1"); this.fts5Available = true; }
        catch { this.fts5Available = false; }
      }

      if (current < 3) {
        try {
          try { db.exec("ALTER TABLE memories ADD COLUMN citations TEXT DEFAULT '[]'"); } catch { /* exists */ }
          try { db.exec("ALTER TABLE memories ADD COLUMN source TEXT DEFAULT 'observed'"); } catch { /* exists */ }
          try { db.exec("ALTER TABLE memories ADD COLUMN confidence REAL DEFAULT 0.8"); } catch { /* exists */ }
          if (!isGlobal) {
            try { db.exec("ALTER TABLE session_context ADD COLUMN current_episode_id TEXT"); } catch { /* exists */ }
          }
          db.exec(`
            CREATE TABLE IF NOT EXISTS episodes (
              episode_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
              goal TEXT DEFAULT '', outcome TEXT DEFAULT 'unknown',
              actions TEXT DEFAULT '[]', lessons_learned TEXT DEFAULT '[]',
              mistakes TEXT DEFAULT '[]', importance_score REAL DEFAULT 5.0,
              keywords TEXT DEFAULT '[]', supersedes TEXT DEFAULT '[]',
              confidence REAL DEFAULT 0.8,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            )
          `);
          db.exec("CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id)");
        } catch (e) { console.error("[Memory] Migration v3 error:", e); }
      }

      if (current < 4) {
        try {
          try { db.exec("ALTER TABLE memories ADD COLUMN memory_strength REAL DEFAULT 1.0"); } catch { /* exists */ }
          try { db.exec("ALTER TABLE memories ADD COLUMN reinforcement_count INTEGER DEFAULT 0"); } catch { /* exists */ }
        } catch (e) { console.error("[Memory] Migration v4 error:", e); }
      }

      if (current < 5) {
        try {
          try { db.exec("ALTER TABLE memories ADD COLUMN embedding BLOB"); } catch { /* exists */ }
          if (this.vecAvailable) {
            db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(embedding float[${EMBED_DIM}] distance_metric=cosine)`);
            db.exec(`
              CREATE TABLE IF NOT EXISTS memory_vec_rowmap (
                memory_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, vec_rowid INTEGER NOT NULL
              )
            `);
            db.exec("CREATE INDEX IF NOT EXISTS idx_vec_rowmap_session ON memory_vec_rowmap(session_id)");
          }
        } catch (e) { console.error("[Memory] Migration v5 error:", e); }
      }

      if (current === 0) {
        db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION);
      } else if (current < SCHEMA_VERSION) {
        db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
      }
    } catch (err) {
      console.error("[Memory] Migration error:", err);
    }
  }

  private insertFtsRow(db: Database, memoryId: string, sessionId: string, content: string): void {
    if (!this.fts5Available) return;
    try {
      const result = db.prepare("INSERT INTO memory_fts(content) VALUES (?)").run(content);
      const rowId  = Number(result.lastInsertRowid);
      db.prepare("INSERT OR REPLACE INTO memory_fts_rowmap(memory_id, session_id, fts_rowid) VALUES (?, ?, ?)")
        .run(memoryId, sessionId, rowId);
    } catch (e) { console.error("[Memory] FTS insert error:", e); }
  }

  private deleteFtsRow(db: Database, memoryId: string): void {
    if (!this.fts5Available) return;
    try {
      const row = db.prepare("SELECT fts_rowid FROM memory_fts_rowmap WHERE memory_id = ?")
        .get(memoryId) as { fts_rowid: number } | null;
      if (row) {
        db.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(row.fts_rowid);
        db.prepare("DELETE FROM memory_fts_rowmap WHERE memory_id = ?").run(memoryId);
      }
    } catch (e) { console.error("[Memory] FTS delete error:", e); }
  }

  private searchFtsIds(db: Database, sessionId: string, query: string, limit: number): string[] {
    if (!this.fts5Available) return [];
    try {
      const rows = db.prepare(`
        SELECT rm.memory_id FROM memory_fts
        JOIN memory_fts_rowmap rm ON memory_fts.rowid = rm.fts_rowid
        WHERE memory_fts MATCH ? AND rm.session_id = ? LIMIT ?
      `).all(query, sessionId, limit) as { memory_id: string }[];
      return rows.map(r => r.memory_id);
    } catch { return []; }
  }

  private insertVecRow(db: Database, memoryId: string, sessionId: string, vec: Float32Array): void {
    if (!this.vecAvailable) return;
    try {
      const result = db.prepare("INSERT INTO memory_vec(embedding) VALUES (?)").run(vec);
      const vecRowId = Number(result.lastInsertRowid);
      db.prepare("INSERT OR REPLACE INTO memory_vec_rowmap(memory_id, session_id, vec_rowid) VALUES (?, ?, ?)")
        .run(memoryId, sessionId, vecRowId);
    } catch (e) { console.error("[Memory] Vec insert error:", e); }
  }

  private deleteVecRow(db: Database, memoryId: string): void {
    if (!this.vecAvailable) return;
    try {
      const row = db.prepare("SELECT vec_rowid FROM memory_vec_rowmap WHERE memory_id = ?")
        .get(memoryId) as { vec_rowid: number } | null;
      if (row) {
        db.prepare("DELETE FROM memory_vec WHERE rowid = ?").run(row.vec_rowid);
        db.prepare("DELETE FROM memory_vec_rowmap WHERE memory_id = ?").run(memoryId);
      }
    } catch (e) { console.error("[Memory] Vec delete error:", e); }
  }

  private searchVecIds(db: Database, sessionId: string, queryVec: Float32Array, limit: number): string[] {
    if (!this.vecAvailable) return [];
    try {
      const vecRows = db.prepare(`
        SELECT rowid, distance FROM memory_vec
        WHERE embedding MATCH ? ORDER BY distance LIMIT ?
      `).all(queryVec, limit * 2) as { rowid: number; distance: number }[];
      if (vecRows.length === 0) return [];

      const rowIds = vecRows.map(r => r.rowid);
      const placeholders = rowIds.map(() => "?").join(",");
      const mapRows = db.prepare(`
        SELECT memory_id, vec_rowid FROM memory_vec_rowmap
        WHERE vec_rowid IN (${placeholders}) AND session_id = ?
      `).all(...rowIds, sessionId) as { memory_id: string; vec_rowid: number }[];

      const rowIdToMemId = new Map(mapRows.map(r => [r.vec_rowid, r.memory_id]));
      return vecRows
        .map(r => rowIdToMemId.get(r.rowid))
        .filter((id): id is string => !!id)
        .slice(0, limit);
    } catch (e) { console.error("[Memory] Vec search error:", e); return []; }
  }

  private validateInput(type: string, content: string, importance?: number): string | null {
    if (!VALID_MEMORY_TYPES.includes(type as MemoryType))
      return `Invalid type "${type}". Must be one of: ${VALID_MEMORY_TYPES.join(", ")}`;
    if (!content?.trim()) return "Content must not be empty";
    if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) return "Content exceeds 10KB limit";
    if (importance !== undefined && (importance < 0 || importance > 1))
      return `Importance must be 0–1, got ${importance}`;
    return null;
  }

  private bumpAccessStats(db: Database, ids: string[]): void {
    if (ids.length === 0) return;
    const now = Date.now();
    const stmt = db.prepare("UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?");
    for (const id of ids) {
      try { stmt.run(now, id); } catch { /* ignore */ }
    }
  }

  addMemory(
    entry: Omit<MemoryEntry, "id" | "accessCount" | "createdAt" | "updatedAt" | "lastAccessedAt"
               | "memoryStrength" | "reinforcementCount" | "layer" | "decayScore">,
    layer: MemoryLayer = "project"
  ): string {
    const err = this.validateInput(entry.type, entry.content, entry.importance);
    if (err) { console.error(`[Memory] Validation: ${err}`); return ""; }

    let content  = entry.content;
    const db     = layer === "global" ? this.globalDb : this.projectDb;
    const sessId = layer === "global" ? GLOBAL_SESSION_ID : this.sessionId;
    if (!db) return "";

    if (layer === "global") {
      const { redacted, hadSensitive } = redactSensitiveContent(content);
      if (hadSensitive) { console.warn("[Memory] Sensitive content redacted (global layer)"); content = redacted; }
    }

    const id  = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    try {
      db.prepare(`
        INSERT INTO memories (id, session_id, type, content, metadata, importance,
          access_count, created_at, updated_at, last_accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(id, sessId, entry.type, content, JSON.stringify(entry.metadata), entry.importance, now, now, now);

      this.insertFtsRow(db, id, sessId, content);

      const finalContent = content;
      const finalId = id;
      const finalSessId = sessId;
      setImmediate(async () => {
        const vec = await this.embedder.embed(finalContent);
        if (vec) this.insertVecRow(db, finalId, finalSessId, vec);
      });

      return id;
    } catch (e) { console.error("[Memory] addMemory error:", e); return ""; }
  }

  upsertToolUsage(toolName: string, file?: string): void {
    const db = this.projectDb;
    if (!db) return;
    const sessId = this.sessionId;
    const marker = `[tool_usage:${toolName}]`;
    const now    = Date.now();
    try {
      const existing = db.prepare(
        "SELECT id, content, metadata FROM memories WHERE session_id = ? AND type = 'experience' AND content LIKE ?"
      ).get(sessId, `${marker}%`) as (MemoryRow & { content: string; metadata: string }) | null;

      const lastInfo = file ? ` (last: ${file})` : "";
      if (existing) {
        const count = ((JSON.parse(existing.metadata || "{}") as Record<string, number>).count ?? 0) + 1;
        const newContent = `${marker} Used tool: ${toolName} × ${count} this session${lastInfo}`;
        const newMeta    = { count, toolName, lastFile: file ?? "", lastUsed: now };
        db.prepare("UPDATE memories SET content = ?, metadata = ?, updated_at = ?, last_accessed_at = ? WHERE id = ?")
          .run(newContent, JSON.stringify(newMeta), now, now, existing.id);
        this.deleteFtsRow(db, existing.id);
        this.insertFtsRow(db, existing.id, sessId, newContent);
      } else {
        const id         = `mem_${now}_${Math.random().toString(36).slice(2, 8)}`;
        const newContent = `${marker} Used tool: ${toolName} × 1 this session${lastInfo}`;
        db.prepare(`
          INSERT INTO memories (id, session_id, type, content, metadata, importance,
            access_count, created_at, updated_at, last_accessed_at)
          VALUES (?, ?, 'experience', ?, ?, 0.3, 0, ?, ?, ?)
        `).run(id, sessId, newContent, JSON.stringify({ count: 1, toolName, lastFile: file ?? "", lastUsed: now }), now, now, now);
        this.insertFtsRow(db, id, sessId, newContent);
      }
    } catch (e) { console.error("[Memory] upsertToolUsage error:", e); }
  }

  queryMemories(options: {
    type?: string; limit?: number; minImportance?: number;
    search?: string; layers?: MemoryLayer[];
  } = {}): MemoryEntry[] {
    const layers = options.layers ?? ["project", "global"];
    const limit  = options.limit  ?? 10;

    let ftsIds: string[] = [];
    let vecIds: string[] = [];

    if (options.search) {
      if (layers.includes("project") && this.projectDb && this.fts5Available) {
        const clean = options.search.replace(/['"]/g, "");
        ftsIds.push(...this.searchFtsIds(this.projectDb, this.sessionId, clean, limit * 3));
      }
      if (layers.includes("global") && this.globalDb && this.fts5Available) {
        const clean = options.search.replace(/['"]/g, "");
        ftsIds.push(...this.searchFtsIds(this.globalDb, GLOBAL_SESSION_ID, clean, limit * 3));
      }
    }

    const resultMap = new Map<string, MemoryEntry>();

    const addEntries = (db: Database, sessId: string, ids: string[], layer: MemoryLayer) => {
      if (ids.length === 0) return;
      const ph   = ids.map(() => "?").join(",");
      const rows = db.prepare(`SELECT * FROM memories WHERE id IN (${ph})`).all(...ids) as MemoryRow[];
      for (const r of rows) resultMap.set(r.id, { ...this.rowToEntry(r), layer });
    };

    const addFallback = (db: Database, sessId: string, layer: MemoryLayer) => {
      let sql = "SELECT * FROM memories WHERE session_id = ?";
      const params: RowParam[] = [sessId];
      if (options.type)              { sql += " AND type = ?";           params.push(options.type); }
      if (options.minImportance !== undefined) { sql += " AND importance >= ?"; params.push(options.minImportance); }
      if (options.search)            { sql += " AND content LIKE ?";     params.push(`%${options.search}%`); }
      sql += " ORDER BY importance DESC, last_accessed_at DESC LIMIT ?";
      params.push(limit * 3);
      const rows = db.prepare(sql).all(...params) as MemoryRow[];
      for (const r of rows) if (!resultMap.has(r.id)) resultMap.set(r.id, { ...this.rowToEntry(r), layer });
    };

    if (options.search && ftsIds.length > 0) {
      if (layers.includes("project") && this.projectDb)
        addEntries(this.projectDb, this.sessionId, ftsIds.filter(id =>
          (db => (db.prepare("SELECT 1 FROM memories WHERE id=? AND session_id=?").get(id, this.sessionId)))(this.projectDb!)
        ), "project");
      if (layers.includes("global") && this.globalDb)
        addEntries(this.globalDb, GLOBAL_SESSION_ID, ftsIds.filter(id =>
          (db => (db.prepare("SELECT 1 FROM memories WHERE id=? AND session_id=?").get(id, GLOBAL_SESSION_ID)))(this.globalDb!)
        ), "global");
    } else {
      if (layers.includes("project") && this.projectDb) addFallback(this.projectDb, this.sessionId, "project");
      if (layers.includes("global")  && this.globalDb)  addFallback(this.globalDb, GLOBAL_SESSION_ID, "global");
    }

    const bumpIds = [...resultMap.keys()];
    if (this.projectDb) this.bumpAccessStats(this.projectDb, bumpIds.filter(id => resultMap.get(id)?.layer === "project"));
    if (this.globalDb)  this.bumpAccessStats(this.globalDb,  bumpIds.filter(id => resultMap.get(id)?.layer === "global"));

    let results = [...resultMap.values()];
    for (const m of results) {
      m.decayScore = computeDecayScore(m.importance, m.lastAccessedAt, m.accessCount, m.memoryStrength);
    }
    results.sort((a, b) => (b.decayScore ?? 0) - (a.decayScore ?? 0));

    const seen = new Set<string>();
    const deduped: MemoryEntry[] = [];
    for (const m of results) {
      const key = m.content.trim().toLowerCase();
      if (!seen.has(key)) { seen.add(key); deduped.push(m); }
    }
    return deduped.slice(0, limit);
  }

  queryMemoriesHybrid(search: string, options: {
    type?: string; limit?: number; minImportance?: number; layers?: MemoryLayer[];
  } = {}): MemoryEntry[] {
    const limit  = options.limit ?? 10;
    const layers = options.layers ?? ["project", "global"];

    const ftsIds: string[] = [];
    const clean = search.replace(/['"]/g, "");

    if (layers.includes("project") && this.projectDb && this.fts5Available)
      ftsIds.push(...this.searchFtsIds(this.projectDb, this.sessionId, clean, limit * 3));
    if (layers.includes("global") && this.globalDb && this.fts5Available)
      ftsIds.push(...this.searchFtsIds(this.globalDb, GLOBAL_SESSION_ID, clean, limit * 3));

    const mergedIds = ftsIds.length > 0 ? ftsIds : [];

    const resultMap = new Map<string, MemoryEntry>();
    const fetchByIds = (db: Database, sessId: string, ids: string[], layer: MemoryLayer) => {
      if (ids.length === 0) return;
      const ph   = ids.map(() => "?").join(",");
      const rows = db.prepare(`SELECT * FROM memories WHERE id IN (${ph})`).all(...ids) as MemoryRow[];
      for (const r of rows) resultMap.set(r.id, { ...this.rowToEntry(r), layer });
    };

    if (this.projectDb) fetchByIds(this.projectDb, this.sessionId, mergedIds, "project");
    if (this.globalDb)  fetchByIds(this.globalDb, GLOBAL_SESSION_ID, mergedIds, "global");

    let results = [...resultMap.values()];
    for (const m of results)
      m.decayScore = computeDecayScore(m.importance, m.lastAccessedAt, m.accessCount, m.memoryStrength);
    results.sort((a, b) => (b.decayScore ?? 0) - (a.decayScore ?? 0));

    const seen = new Set<string>();
    return results.filter(m => {
      const k = m.content.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }).slice(0, limit);
  }

  listMemories(options: { type?: string; limit?: number; layer?: MemoryLayer } = {}): MemoryEntry[] {
    const limit = options.limit ?? 20;
    const rows: MemoryEntry[] = [];

    const fetch = (db: Database | null, sessId: string, layer: MemoryLayer) => {
      if (!db) return;
      let sql = "SELECT * FROM memories WHERE session_id = ?";
      const params: RowParam[] = [sessId];
      if (options.type) { sql += " AND type = ?"; params.push(options.type); }
      sql += " ORDER BY importance DESC, created_at DESC LIMIT ?";
      params.push(limit);
      const r = db.prepare(sql).all(...params) as MemoryRow[];
      rows.push(...r.map(m => ({ ...this.rowToEntry(m), layer })));
    };

    if (!options.layer || options.layer === "project") fetch(this.projectDb, this.sessionId, "project");
    if (!options.layer || options.layer === "global")  fetch(this.globalDb, GLOBAL_SESSION_ID, "global");

    for (const m of rows) m.decayScore = computeDecayScore(m.importance, m.lastAccessedAt, m.accessCount, m.memoryStrength);
    rows.sort((a, b) => (b.decayScore ?? 0) - (a.decayScore ?? 0));
    return rows.slice(0, limit);
  }

  updateMemory(id: string, updates: Partial<Pick<MemoryEntry, "content" | "metadata" | "importance">>): boolean {
    if (updates.content !== undefined) {
      const e = this.validateInput("fact", updates.content, updates.importance);
      if (e?.includes("Content")) { console.error(`[Memory] Validation: ${e}`); return false; }
    }
    for (const [db, sessId, layer] of this.allDbs()) {
      try {
        const sets: string[] = ["updated_at = ?"];
        const params: RowParam[] = [Date.now()];
        if (updates.content   !== undefined) { sets.push("content = ?");  params.push(updates.content); }
        if (updates.metadata  !== undefined) { sets.push("metadata = ?"); params.push(JSON.stringify(updates.metadata)); }
        if (updates.importance !== undefined) { sets.push("importance = ?"); params.push(updates.importance); }
        params.push(id, sessId);
        const result = db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ? AND session_id = ?`).run(...params);
        if (result.changes > 0) {
          if (updates.content !== undefined) {
            this.deleteFtsRow(db, id);
            this.insertFtsRow(db, id, sessId, updates.content);
            this.deleteVecRow(db, id);
            const c = updates.content;
            setImmediate(async () => {
              const vec = await this.embedder.embed(c);
              if (vec) this.insertVecRow(db, id, sessId, vec);
            });
          }
          return true;
        }
      } catch (e) { console.error("[Memory] updateMemory error:", e); }
    }
    return false;
  }

  deleteMemory(id: string): boolean {
    for (const [db, sessId] of this.allDbs()) {
      try {
        const result = db.prepare("DELETE FROM memories WHERE id = ? AND session_id = ?").run(id, sessId);
        if (result.changes > 0) {
          this.deleteFtsRow(db, id);
          this.deleteVecRow(db, id);
          return true;
        }
      } catch (e) { console.error("[Memory] deleteMemory error:", e); }
    }
    return false;
  }

  promoteToProject(id: string): boolean {
    if (!this.globalDb || !this.projectDb) return false;
    try {
      const row = this.globalDb.prepare("SELECT * FROM memories WHERE id = ? AND session_id = ?")
        .get(id, GLOBAL_SESSION_ID) as MemoryRow | null;
      if (!row) return false;
      const entry = this.rowToEntry(row);
      const newId = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now   = Date.now();
      this.projectDb.prepare(`
        INSERT INTO memories (id, session_id, type, content, metadata, importance,
          access_count, created_at, updated_at, last_accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(newId, this.sessionId, entry.type, entry.content, JSON.stringify(entry.metadata),
             entry.importance, entry.accessCount, now, now, now);
      this.insertFtsRow(this.projectDb, newId, this.sessionId, entry.content);
      return true;
    } catch (e) { console.error("[Memory] promoteToProject error:", e); return false; }
  }

  reinforceMemory(id: string): { success: boolean; newStrength: number; newDecayScore: number } {
    const notFound = { success: false, newStrength: 0, newDecayScore: 0 };
    for (const [db, sessId, layer] of this.allDbs()) {
      try {
        const row = db.prepare(
          "SELECT importance, access_count, last_accessed_at, memory_strength, reinforcement_count FROM memories WHERE id = ? AND session_id = ?"
        ).get(id, sessId) as Pick<MemoryRow, "importance" | "access_count" | "last_accessed_at" | "memory_strength" | "reinforcement_count"> | null;
        if (!row) continue;
        const strength  = row.memory_strength ?? 1.0;
        const rCount    = row.reinforcement_count ?? 0;
        const growth    = Math.max(1.2, 1.8 - 0.2 * rCount);
        const newStr    = Math.min(10.0, strength * growth);
        const now       = Date.now();
        db.prepare(`
          UPDATE memories SET memory_strength = ?, reinforcement_count = ?,
          access_count = access_count + 1, last_accessed_at = ?, updated_at = ?
          WHERE id = ? AND session_id = ?
        `).run(newStr, rCount + 1, now, now, id, sessId);
        const newScore  = computeDecayScore(row.importance, now, (row.access_count ?? 0) + 1, newStr);
        return { success: true, newStrength: newStr, newDecayScore: newScore };
      } catch (e) { console.error("[Memory] reinforceMemory error:", e); }
    }
    return notFound;
  }

  private allDbs(): Array<[Database, string, MemoryLayer]> {
    const list: Array<[Database, string, MemoryLayer]> = [];
    if (this.projectDb) list.push([this.projectDb, this.sessionId, "project"]);
    if (this.globalDb)  list.push([this.globalDb, GLOBAL_SESSION_ID, "global"]);
    return list;
  }

  addSkillMemory(params: {
    name: string; triggerPatterns: string[]; steps: string[];
    applicability: string; termination?: string; citations?: string[]; importance?: number;
  }): string {
    const content = `SKILL: ${params.name}\nTriggers: ${params.triggerPatterns.join(", ")}\nApplies when: ${params.applicability}\nSteps:\n${params.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}${params.termination ? `\nDone when: ${params.termination}` : ""}`;
    const db = this.projectDb;
    if (!db) return "";
    const id  = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const meta = { skillName: params.name, triggerPatterns: params.triggerPatterns,
                   steps: params.steps, applicability: params.applicability,
                   termination: params.termination ?? "", addedBy: "agent" };
    try {
      db.prepare(`
        INSERT INTO memories (id, session_id, type, content, metadata, importance, access_count,
          created_at, updated_at, last_accessed_at, citations, source, confidence)
        VALUES (?, ?, 'skill', ?, ?, ?, 0, ?, ?, ?, ?, 'observed', 0.65)
      `).run(id, this.sessionId, content, JSON.stringify(meta), params.importance ?? 0.7,
             now, now, now, JSON.stringify(params.citations ?? []));
      this.insertFtsRow(db, id, this.sessionId, content);
      return id;
    } catch (e) { console.error("[Memory] addSkillMemory error:", e); return ""; }
  }

  approveSkill(id: string): boolean {
    const db = this.projectDb;
    if (!db) return false;
    try {
      const result = db.prepare(
        "UPDATE memories SET source = 'human', confidence = 0.9, updated_at = ? WHERE id = ? AND session_id = ? AND type = 'skill'"
      ).run(Date.now(), id, this.sessionId);
      return result.changes > 0;
    } catch { return false; }
  }

  validateCitations(): Array<{ memoryId: string; citation: string; valid: boolean }> {
    const db = this.projectDb;
    if (!db) return [];
    const out: Array<{ memoryId: string; citation: string; valid: boolean }> = [];
    try {
      const rows = db.prepare("SELECT id, citations FROM memories WHERE session_id = ? AND citations != '[]'")
        .all(this.sessionId) as { id: string; citations: string | null }[];
      for (const r of rows) {
        const cits = JSON.parse(r.citations ?? "[]") as string[];
        for (const c of cits) {
          out.push({ memoryId: r.id, citation: c, valid: existsSync(c.includes(":") ? c.split(":")[0] : c) });
        }
      }
    } catch { /* ignore */ }
    return out;
  }

  startEpisode(goal: string): string {
    const db = this.projectDb;
    if (!db) return "";
    const id  = `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    try {
      db.prepare(`
        INSERT INTO episodes (episode_id, session_id, goal, outcome, actions, lessons_learned,
          mistakes, importance_score, keywords, supersedes, confidence, created_at, updated_at)
        VALUES (?, ?, ?, 'unknown', '[]', '[]', '[]', 5.0, '[]', '[]', 0.8, ?, ?)
      `).run(id, this.sessionId, goal, now, now);
      this.updateSessionContext({ currentEpisodeId: id });
      return id;
    } catch (e) { console.error("[Memory] startEpisode error:", e); return ""; }
  }

  endEpisode(params: {
    outcome: EpisodeOutcome; lessonsLearned?: string[]; mistakes?: string[];
    importanceScore?: number; keywords?: string[];
  }): boolean {
    const db  = this.projectDb;
    if (!db) return false;
    const epId = this.getSessionContext()?.currentEpisodeId;
    if (!epId) return false;
    try {
      const result = db.prepare(`
        UPDATE episodes SET outcome = ?, lessons_learned = ?, mistakes = ?,
        importance_score = ?, keywords = ?, updated_at = ?
        WHERE episode_id = ? AND session_id = ?
      `).run(params.outcome, JSON.stringify(params.lessonsLearned ?? []),
             JSON.stringify(params.mistakes ?? []), params.importanceScore ?? 5.0,
             JSON.stringify(params.keywords ?? []), Date.now(), epId, this.sessionId);
      for (const lesson of (params.lessonsLearned ?? [])) {
        if (lesson.trim()) {
          this.addMemory({ type: "fact", content: `[lesson] ${lesson}`,
            metadata: { episodeId: epId, source: "reflection" }, importance: 0.75 }, "project");
        }
      }
      this.updateSessionContext({ currentEpisodeId: undefined });
      return result.changes > 0;
    } catch (e) { console.error("[Memory] endEpisode error:", e); return false; }
  }

  addActionToEpisode(toolName: string, summary: string): void {
    const db  = this.projectDb;
    const epId = this.getSessionContext()?.currentEpisodeId;
    if (!db || !epId) return;
    try {
      const row = db.prepare("SELECT actions FROM episodes WHERE episode_id = ? AND session_id = ?")
        .get(epId, this.sessionId) as { actions: string } | null;
      if (!row) return;
      const actions = JSON.parse(row.actions ?? "[]") as EpisodeAction[];
      actions.push({ tool: toolName, summary: summary.slice(0, 200), timestamp: Date.now() });
      db.prepare("UPDATE episodes SET actions = ?, updated_at = ? WHERE episode_id = ? AND session_id = ?")
        .run(JSON.stringify(actions), Date.now(), epId, this.sessionId);
    } catch { /* ignore */ }
  }

  listEpisodes(limit = 10): Episode[] {
    const db = this.projectDb;
    if (!db) return [];
    try {
      const rows = db.prepare("SELECT * FROM episodes WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(this.sessionId, limit) as EpisodeRow[];
      return rows.map(r => ({
        episodeId: r.episode_id, sessionId: r.session_id, goal: r.goal,
        outcome: r.outcome as EpisodeOutcome,
        actions:        JSON.parse(r.actions        ?? "[]"),
        lessonsLearned: JSON.parse(r.lessons_learned ?? "[]"),
        mistakes:       JSON.parse(r.mistakes        ?? "[]"),
        importanceScore: r.importance_score,
        keywords:  JSON.parse(r.keywords  ?? "[]"),
        supersedes: JSON.parse(r.supersedes ?? "[]"),
        confidence: r.confidence,
        createdAt: r.created_at, updatedAt: r.updated_at,
      }));
    } catch { return []; }
  }

  getCurrentEpisodeId(): string | undefined {
    return this.getSessionContext()?.currentEpisodeId;
  }

  getSessionContext(): SessionContext | null {
    const db = this.projectDb;
    if (!db) return null;
    try {
      const row = db.prepare("SELECT * FROM session_context WHERE session_id = ?")
        .get(this.sessionId) as SessionContextRow | null;
      if (!row) return null;
      return {
        sessionId: row.session_id,
        currentTask: row.current_task ?? undefined,
        recentTools: JSON.parse(row.recent_tools ?? "[]"),
        conversationSummary: row.conversation_summary ?? undefined,
        currentEpisodeId: row.current_episode_id ?? undefined,
      };
    } catch { return null; }
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
        if (updates.currentTask !== undefined)       { sets.push("current_task = ?");      params.push(updates.currentTask); }
        if (updates.recentTools !== undefined)        { sets.push("recent_tools = ?");      params.push(JSON.stringify(updates.recentTools)); }
        if (updates.conversationSummary !== undefined){ sets.push("conversation_summary = ?"); params.push(updates.conversationSummary); }
        if (updates.currentEpisodeId !== undefined)  { sets.push("current_episode_id = ?"); params.push(updates.currentEpisodeId ?? null); }
        params.push(this.sessionId);
        db.prepare(`UPDATE session_context SET ${sets.join(", ")} WHERE session_id = ?`).run(...params);
      } else {
        db.prepare(`
          INSERT INTO session_context (session_id, current_task, recent_tools, conversation_summary, current_episode_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(this.sessionId, updates.currentTask ?? null, JSON.stringify(updates.recentTools ?? []),
               updates.conversationSummary ?? null, updates.currentEpisodeId ?? null, now);
      }
    } catch (e) { console.error("[Memory] updateSessionContext error:", e); }
  }

  addConversation(role: string, content: string): void {
    const db = this.projectDb;
    if (!db) return;
    try {
      db.prepare("INSERT INTO conversation_history (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)")
        .run(this.sessionId, role, content, Date.now());
      db.prepare(`
        DELETE FROM conversation_history
        WHERE session_id = ? AND id NOT IN (
          SELECT id FROM conversation_history WHERE session_id = ? ORDER BY timestamp DESC LIMIT 50
        )
      `).run(this.sessionId, this.sessionId);
    } catch { /* ignore */ }
  }

  getRecentConversations(limit = 10): Array<{ role: string; content: string; timestamp: number }> {
    const db = this.projectDb;
    if (!db) return [];
    try {
      return db.prepare(
        "SELECT role, content, timestamp FROM conversation_history WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?"
      ).all(this.sessionId, limit) as Array<{ role: string; content: string; timestamp: number }>;
    } catch { return []; }
  }

  getStats(): { total: number; byType: Record<string, number>; avgImportance: number; globalTotal: number } {
    const count = (db: Database | null, sessId: string) => {
      if (!db) return { total: 0, byType: {} as Record<string, number>, avg: 0 };
      try {
        const total = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE session_id = ?")
          .get(sessId) as { c: number }).c;
        const byType: Record<string, number> = {};
        (db.prepare("SELECT type, COUNT(*) as c FROM memories WHERE session_id = ? GROUP BY type")
          .all(sessId) as { type: string; c: number }[]).forEach(r => { byType[r.type] = r.c; });
        const avg = (db.prepare("SELECT AVG(importance) as a FROM memories WHERE session_id = ?")
          .get(sessId) as { a: number | null }).a ?? 0;
        return { total, byType, avg };
      } catch { return { total: 0, byType: {}, avg: 0 }; }
    };
    const proj = count(this.projectDb, this.sessionId);
    const glob = count(this.globalDb, GLOBAL_SESSION_ID);
    return { total: proj.total, byType: proj.byType, avgImportance: proj.avg, globalTotal: glob.total };
  }

  private rowToEntry(row: MemoryRow): MemoryEntry {
    return {
      id:                 row.id,
      type:               row.type as MemoryType,
      content:            row.content,
      metadata:           JSON.parse(row.metadata ?? "{}"),
      importance:         row.importance,
      accessCount:        row.access_count,
      createdAt:          row.created_at,
      updatedAt:          row.updated_at,
      lastAccessedAt:     row.last_accessed_at,
      memoryStrength:     row.memory_strength     ?? 1.0,
      reinforcementCount: row.reinforcement_count ?? 0,
    };
  }

  close(): void {
    this.projectDb?.close();
    this.globalDb?.close();
    this.projectDb = null;
    this.globalDb  = null;
  }
}

const MemoryPlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const { directory } = input;
  const projectDbPath = join(homedir(), ".local", "share", "opencode", "memory", "memory.db");
  const globalDbPath  = join(homedir(), ".config", "opencode", "memory", "global.db");

  const store = new MemoryStore(projectDbPath, globalDbPath);
  store.initialize();
  console.log(`[Memory] v5 initialized | project: ${projectDbPath} | global: ${globalDbPath}`);

  const getSessionId = (h: { sessionID?: string }): string =>
    h?.sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`;

  const sid = (sessionID?: string) =>
    sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`;

  return {
    "experimental.chat.system.transform": async (h, output) => {
      store.setSessionId(getSessionId(h));
      const memories = store.queryMemories({ limit: 10, minImportance: 0.4 });
      const ctx      = store.getSessionContext();
      if (memories.length === 0 && !ctx) return;
      const lines: string[] = [];
      if (memories.length > 0) {
        const skills = memories.filter(m => m.type === "skill");
        const others = memories.filter(m => m.type !== "skill");
        lines.push("\n<agent_memory>");
        if (others.length > 0) {
          lines.push("## Memories");
          for (const m of others) {
            lines.push(`- [${m.type}${m.layer === "global" ? "/global" : ""}] ${m.content}`);
          }
        }
        if (skills.length > 0) {
          lines.push("## Skills");
          for (const m of skills) {
            const needsReview = (m.metadata as Record<string, unknown>)?.source === "observed" ? " ⚠️ unreviewed" : "";
            lines.push(`### ${(m.metadata as Record<string, unknown>)?.skillName ?? m.id}${needsReview}`);
            lines.push(m.content);
          }
        }
        lines.push("</agent_memory>");
      }
      if (ctx?.currentTask)            lines.push(`\n<current_task>${ctx.currentTask}</current_task>`);
      if (ctx?.recentTools?.length)    lines.push(`\n<recent_tools>${ctx.recentTools.slice(-5).join(", ")}</recent_tools>`);
      if (lines.length > 0) output.system.push(...lines);
    },

    "chat.message": async (h, output) => {
      store.setSessionId(getSessionId(h));
      const text = output.parts.filter(p => p.type === "text")
        .map(p => (p as { text?: string }).text ?? "").join("\n").slice(0, 1000);
      if (text) store.addConversation("user", text);
    },

    "tool.execute.after": async (h, _output) => {
      store.setSessionId(getSessionId(h));
      const { tool: toolName } = h;
      const ctx = store.getSessionContext();
      store.updateSessionContext({ recentTools: [...(ctx?.recentTools ?? []), toolName].slice(-20) });
      const significant = ["Edit", "Write", "Bash", "mcp_task"];
      if (significant.some(t => toolName.includes(t))) {
        const args = (h as { args?: { filePath?: string; path?: string } }).args;
        const file = args?.filePath ?? args?.path;
        store.upsertToolUsage(toolName, file);
        store.addActionToEpisode(toolName, file ? `${toolName} on ${file}` : toolName);
      }
    },

    tool: {
      memory_query: tool({
        description: "Query memories with FTS5 BM25 search. When Ollama is running, automatically uses hybrid FTS5+vector RRF search. Results ranked by decay score.",
        args: {
          query: tool.schema.string(),
          type:  tool.schema.enum(["fact","experience","preference","skill"]).optional(),
          limit: tool.schema.number().optional(),
          layer: tool.schema.enum(["project","global"]).optional(),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const layers: MemoryLayer[] = args.layer ? [args.layer as MemoryLayer] : ["project", "global"];
          const mems = store.queryMemories({ search: args.query, type: args.type, limit: args.limit ?? 10, layers });
          if (mems.length === 0) return "No relevant memories found.";
          return `Found ${mems.length} memories:\n` +
            mems.map(m => `- [${m.type}${m.layer === "global" ? "/global" : ""}] (id: ${m.id}) ${m.content} (score: ${m.decayScore?.toFixed(3)})`).join("\n");
        },
      }),

      memory_add: tool({
        description: "Add a memory. Default layer='project'. Use layer='global' for cross-project preferences. Sensitive content auto-redacted in global layer.",
        args: {
          type:       tool.schema.enum(["fact","preference","skill"]),
          content:    tool.schema.string().describe("Max 10KB"),
          importance: tool.schema.number().min(0).max(1).optional(),
          layer:      tool.schema.enum(["project","global"]).optional(),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const layer = (args.layer as MemoryLayer) ?? "project";
          const id = store.addMemory({ type: args.type, content: args.content,
            metadata: { addedBy: "agent" }, importance: args.importance ?? 0.5 }, layer);
          return id ? `Memory stored: ${id} (layer: ${layer})` : "Failed to store memory.";
        },
      }),

      memory_update: tool({
        description: "Update an existing memory by ID.",
        args: {
          id:         tool.schema.string(),
          content:    tool.schema.string().optional(),
          importance: tool.schema.number().min(0).max(1).optional(),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          if (!args.content && args.importance === undefined) return "Provide at least one of: content, importance";
          return store.updateMemory(args.id, { content: args.content, importance: args.importance })
            ? `Memory ${args.id} updated.` : `Memory ${args.id} not found.`;
        },
      }),

      memory_delete: tool({
        description: "Delete a memory by ID.",
        args: { id: tool.schema.string() },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          return store.deleteMemory(args.id) ? `Memory ${args.id} deleted.` : `Memory ${args.id} not found.`;
        },
      }),

      memory_list: tool({
        description: "List memories with decay score, type, and layer filter.",
        args: {
          type:  tool.schema.enum(["fact","experience","preference","skill"]).optional(),
          limit: tool.schema.number().optional(),
          layer: tool.schema.enum(["project","global"]).optional(),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const mems = store.listMemories({ type: args.type, limit: args.limit ?? 20, layer: args.layer as MemoryLayer | undefined });
          if (mems.length === 0) return "No memories stored yet.";
          return `${mems.length} memories:\n` + mems.map(m => {
            const preview = m.content.slice(0, 100) + (m.content.length > 100 ? "…" : "");
            return `[${m.type}/${m.layer}] ${m.id}  score:${m.decayScore?.toFixed(3)}  "${preview}"`;
          }).join("\n");
        },
      }),

      memory_promote: tool({
        description: "Copy a global memory into the current project layer.",
        args: { id: tool.schema.string() },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          return store.promoteToProject(args.id)
            ? `Memory ${args.id} copied global → project.` : `Memory ${args.id} not found in global layer.`;
        },
      }),

      memory_reinforce: tool({
        description: "Boost memory_strength so it decays more slowly. Diminishing returns per call (×1.8, ×1.6, ×1.4 … ×1.2).",
        args: { id: tool.schema.string() },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const r = store.reinforceMemory(args.id);
          return r.success
            ? `Memory ${args.id} reinforced.\n  memory_strength: ${r.newStrength.toFixed(2)}\n  new decay_score: ${r.newDecayScore.toFixed(4)}`
            : `Memory ${args.id} not found.`;
        },
      }),

      memory_add_skill: tool({
        description: "Store a reusable workflow skill (trigger patterns + steps + citations). Starts as unreviewed.",
        args: {
          name:             tool.schema.string(),
          trigger_patterns: tool.schema.array(tool.schema.string()),
          steps:            tool.schema.array(tool.schema.string()),
          applicability:    tool.schema.string(),
          termination:      tool.schema.string().optional(),
          citations:        tool.schema.array(tool.schema.string()).optional(),
          importance:       tool.schema.number().min(0).max(1).optional(),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const id = store.addSkillMemory({
            name: args.name, triggerPatterns: args.trigger_patterns,
            steps: args.steps, applicability: args.applicability,
            termination: args.termination, citations: args.citations, importance: args.importance,
          });
          return id ? `Skill "${args.name}" stored: ${id} (unreviewed — use memory_approve_skill to confirm)` : "Failed.";
        },
      }),

      memory_approve_skill: tool({
        description: "Mark a skill as human-reviewed (confidence 0.9, removes ⚠️ warning).",
        args: { id: tool.schema.string() },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          return store.approveSkill(args.id) ? `Skill ${args.id} approved.` : `Skill ${args.id} not found.`;
        },
      }),

      memory_validate_citations: tool({
        description: "Check all file:line citations in memory still exist on disk.",
        args: {},
        async execute(_, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const results = store.validateCitations();
          if (results.length === 0) return "No citations found.";
          const stale = results.filter(r => !r.valid);
          return [`Citations: ${results.length} total, ${results.filter(r => r.valid).length} valid, ${stale.length} stale`,
            ...stale.map(r => `  ✗ ${r.citation} (memory: ${r.memoryId})`)].join("\n");
        },
      }),

      memory_start_episode: tool({
        description: "Start tracking a task attempt. Subsequent tool calls are auto-recorded as episode actions.",
        args: { goal: tool.schema.string() },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const id = store.startEpisode(args.goal);
          return id ? `Episode started: ${id}\nGoal: ${args.goal}\nCall memory_end_episode when done.` : "Failed.";
        },
      }),

      memory_end_episode: tool({
        description: "Finalize the current episode. lessons_learned auto-promote to fact memories.",
        args: {
          outcome:          tool.schema.enum(["success","partial","failure","abandoned"]),
          lessons_learned:  tool.schema.array(tool.schema.string()).optional(),
          mistakes:         tool.schema.array(tool.schema.string()).optional(),
          importance_score: tool.schema.number().min(1).max(10).optional(),
          keywords:         tool.schema.array(tool.schema.string()).optional(),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const ok = store.endEpisode({ outcome: args.outcome as EpisodeOutcome,
            lessonsLearned: args.lessons_learned, mistakes: args.mistakes,
            importanceScore: args.importance_score, keywords: args.keywords });
          if (!ok) return "No active episode. Use memory_start_episode first.";
          return `Episode closed (${args.outcome}). ${args.lessons_learned?.length ?? 0} lessons promoted to memory.`;
        },
      }),

      memory_list_episodes: tool({
        description: "List recent episodes.",
        args: { limit: tool.schema.number().optional() },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const eps = store.listEpisodes(args.limit ?? 10);
          if (eps.length === 0) return "No episodes recorded.";
          return eps.map(ep =>
            `[${ep.outcome}] ${ep.episodeId}  goal: "${ep.goal.slice(0, 60)}"  actions:${ep.actions.length}  lessons:${ep.lessonsLearned.length}`
          ).join("\n");
        },
      }),

      memory_stats: tool({
        description: "Memory statistics (project + global).",
        args: {},
        async execute(_, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const s = store.getStats();
          const ctx = store.getSessionContext();
          return [
            `Memory Statistics:`,
            `- Project: ${s.total} | by type: ${JSON.stringify(s.byType)}`,
            `- Global:  ${s.globalTotal}`,
            `- Avg importance: ${s.avgImportance.toFixed(2)}`,
            `- Current task:   ${ctx?.currentTask ?? "None"}`,
            `- Recent tools:   ${ctx?.recentTools?.slice(-5).join(", ") ?? "None"}`,
          ].join("\n");
        },
      }),

      memory_set_task: tool({
        description: "Set current task context.",
        args: { task: tool.schema.string() },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          store.updateSessionContext({ currentTask: args.task });
          return `Current task set to: ${args.task}`;
        },
      }),

      memory_status: tool({
        description: "One-line memory system status.",
        args: {},
        async execute(_, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const s = store.getStats();
          const ctx = store.getSessionContext();
          return `🧠 Project: ${s.total} | Global: ${s.globalTotal} | 🎯 ${ctx?.currentTask ?? "No task"} | 🔧 ${ctx?.recentTools?.slice(-3).join(", ") ?? "None"}`;
        },
      }),
    },
  };
};

export default MemoryPlugin;
