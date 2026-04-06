/**
 * OpenCode Memory System — HTTP MCP Server (Issue #13)
 *
 * Exposes all memory tools via HTTP JSON-RPC 2.0 for cross-tool memory sharing.
 * Any tool (not just OpenCode) can access memories via HTTP.
 *
 * Default port: 3100 (override with MCP_PORT env var)
 * Default session: derived from CWD (override with session_id in request params)
 *
 * Endpoints:
 *   POST /rpc          — JSON-RPC 2.0 (single endpoint, method dispatch)
 *   GET  /health       — { status: "ok", version: "v5" }
 *   GET  /tools        — list all available tool names
 */

import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { ValidationFramework } from "./validation-framework";
import { TUIStatusManager } from "./tui-status";

type MemoryType     = "fact" | "experience" | "preference" | "skill";
type MemoryLayer    = "global" | "project";
type RowParam       = string | number | null;
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
const EMBED_DIM          = 768;

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
  const daysSince       = (Date.now() - lastAccessedAt) / 86_400_000;
  const effectiveLambda = DECAY_LAMBDA / memoryStrength;
  const recency         = Math.exp(-effectiveLambda * daysSince);
  const frequency       = Math.log(2 + accessCount);
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
  private sessionId     = "";
  private fts5Available = false;
  private vecAvailable  = false;
  private readonly embedder = new EmbeddingService();
  private validation: ValidationFramework | null = null;
  private tuiStatus: TUIStatusManager | null = null;

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

      if (this.projectDb) {
        this.validation = new ValidationFramework(this.projectDb, this.globalDb || undefined);
        this.tuiStatus = new TUIStatusManager(this.projectDb);
      }
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

       db.exec(`
         CREATE TABLE IF NOT EXISTS memory_access_log (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           memory_id TEXT,
           session_id TEXT NOT NULL,
           access_type TEXT NOT NULL,
           query_text TEXT,
           result_rank INTEGER,
           relevance_score REAL,
           timestamp INTEGER NOT NULL,
           FOREIGN KEY(memory_id) REFERENCES memories(id)
         )
       `);
       db.exec("CREATE INDEX IF NOT EXISTS idx_access_log_memory ON memory_access_log(memory_id)");
       db.exec("CREATE INDEX IF NOT EXISTS idx_access_log_session ON memory_access_log(session_id)");
       db.exec("CREATE INDEX IF NOT EXISTS idx_access_log_time ON memory_access_log(timestamp)");
       db.exec("CREATE INDEX IF NOT EXISTS idx_access_log_type ON memory_access_log(access_type)");

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
     const now  = Date.now();
     const stmt = db.prepare("UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?");
     for (const id of ids) {
       try { stmt.run(now, id); } catch { /* ignore */ }
     }
   }

   private logAccess(db: Database | null, sessionId: string, log: {
     memory_id: string | null;
     access_type: string;
     query_text?: string | null;
     result_rank?: number | null;
     relevance_score?: number | null;
   }): void {
     if (!db) return;
     try {
       db.prepare(`
         INSERT INTO memory_access_log (memory_id, session_id, access_type, query_text, result_rank, relevance_score, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)
       `).run(
         log.memory_id,
         sessionId,
         log.access_type,
         log.query_text ?? null,
         log.result_rank ?? null,
         log.relevance_score ?? null,
         Date.now()
       );
     } catch (e) {
       console.error("[Memory] logAccess error:", e);
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
      const finalId      = id;
      const finalSessId  = sessId;
       setImmediate(async () => {
         const vec = await this.embedder.embed(finalContent);
         if (vec) this.insertVecRow(db, finalId, finalSessId, vec);
       });

       this.logAccess(db, sessId, { memory_id: id, access_type: "added" });
       return id;
     } catch (e) { console.error("[Memory] addMemory error:", e); return ""; }
  }

  queryMemories(options: {
    type?: string; limit?: number; minImportance?: number;
    search?: string; layers?: MemoryLayer[];
  } = {}): MemoryEntry[] {
    const layers = options.layers ?? ["project", "global"];
    const limit  = options.limit  ?? 10;

    let ftsIds: string[] = [];

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
      if (options.type)                        { sql += " AND type = ?";           params.push(options.type); }
      if (options.minImportance !== undefined)  { sql += " AND importance >= ?";    params.push(options.minImportance); }
      if (options.search)                      { sql += " AND content LIKE ?";     params.push(`%${options.search}%`); }
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
     for (const m of results)
       m.decayScore = computeDecayScore(m.importance, m.lastAccessedAt, m.accessCount, m.memoryStrength);
     results.sort((a, b) => (b.decayScore ?? 0) - (a.decayScore ?? 0));

     const seen = new Set<string>();
     const deduped: MemoryEntry[] = [];
     for (const m of results) {
       const key = m.content.trim().toLowerCase();
       if (!seen.has(key)) { seen.add(key); deduped.push(m); }
     }
     
     const finalResults = deduped.slice(0, limit);
     
     if (finalResults.length === 0 && options.search) {
       this.logAccess(this.projectDb, this.sessionId, {
         memory_id: null,
         access_type: "query_miss",
         query_text: options.search
       });
     } else {
       for (let i = 0; i < finalResults.length; i++) {
         const m = finalResults[i];
         this.logAccess(
           m.layer === "global" ? this.globalDb : this.projectDb,
           m.layer === "global" ? GLOBAL_SESSION_ID : this.sessionId,
           {
             memory_id: m.id,
             access_type: i < 3 ? "query_hit" : "partial_hit",
             query_text: options.search,
             result_rank: i + 1,
             relevance_score: m.decayScore ?? 0
           }
         );
       }
     }
     
     return finalResults;
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
    for (const [db, sessId] of this.allDbs()) {
      try {
        const sets: string[] = ["updated_at = ?"];
        const params: RowParam[] = [Date.now()];
        if (updates.content    !== undefined) { sets.push("content = ?");    params.push(updates.content); }
        if (updates.metadata   !== undefined) { sets.push("metadata = ?");   params.push(JSON.stringify(updates.metadata)); }
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

  reinforceMemory(id: string): { success: boolean; newStrength: number; newDecayScore: number } {
    const notFound = { success: false, newStrength: 0, newDecayScore: 0 };
    for (const [db, sessId] of this.allDbs()) {
      try {
        const row = db.prepare(
          "SELECT importance, access_count, last_accessed_at, memory_strength, reinforcement_count FROM memories WHERE id = ? AND session_id = ?"
        ).get(id, sessId) as Pick<MemoryRow, "importance" | "access_count" | "last_accessed_at" | "memory_strength" | "reinforcement_count"> | null;
        if (!row) continue;
        const strength = row.memory_strength ?? 1.0;
        const rCount   = row.reinforcement_count ?? 0;
        const growth   = Math.max(1.2, 1.8 - 0.2 * rCount);
        const newStr   = Math.min(10.0, strength * growth);
        const now      = Date.now();
         db.prepare(`
           UPDATE memories SET memory_strength = ?, reinforcement_count = ?,
           access_count = access_count + 1, last_accessed_at = ?, updated_at = ?
           WHERE id = ? AND session_id = ?
         `).run(newStr, rCount + 1, now, now, id, sessId);
         const newScore = computeDecayScore(row.importance, now, (row.access_count ?? 0) + 1, newStr);
         this.logAccess(db, sessId, { memory_id: id, access_type: "reinforced" });
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
        for (const c of cits)
          out.push({ memoryId: r.id, citation: c, valid: existsSync(c.includes(":") ? c.split(":")[0] : c) });
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
        keywords:   JSON.parse(r.keywords   ?? "[]"),
        supersedes: JSON.parse(r.supersedes  ?? "[]"),
        confidence: r.confidence,
        createdAt: r.created_at, updatedAt: r.updated_at,
      }));
    } catch { return []; }
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
        if (updates.currentTask !== undefined)        { sets.push("current_task = ?");      params.push(updates.currentTask); }
        if (updates.recentTools !== undefined)         { sets.push("recent_tools = ?");      params.push(JSON.stringify(updates.recentTools)); }
        if (updates.conversationSummary !== undefined) { sets.push("conversation_summary = ?"); params.push(updates.conversationSummary); }
        if (updates.currentEpisodeId !== undefined)   { sets.push("current_episode_id = ?"); params.push(updates.currentEpisodeId ?? null); }
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

  getHitRate(hours: number = 24, layer: "project" | "global" = "project"): { total: number; hits: number; hitRate: string; hours: number } {
    const db = layer === "global" ? this.globalDb : this.projectDb;
    const sessId = layer === "global" ? GLOBAL_SESSION_ID : this.sessionId;
    if (!db) return { total: 0, hits: 0, hitRate: "0.00%", hours };
    try {
      const since = Date.now() - hours * 3600000;
      const total = (db.prepare("SELECT COUNT(*) as c FROM memory_access_log WHERE session_id = ? AND timestamp > ?").get(sessId, since) as any)?.c || 0;
      const hits = (db.prepare("SELECT COUNT(*) as c FROM memory_access_log WHERE session_id = ? AND access_type = 'query_hit' AND timestamp > ?").get(sessId, since) as any)?.c || 0;
      const rate = total > 0 ? ((hits / total) * 100).toFixed(2) : "0.00";
      return { total, hits, hitRate: rate + "%", hours };
    } catch { return { total: 0, hits: 0, hitRate: "0.00%", hours }; }
  }

  getAccessAnalytics(layer: "project" | "global" = "project"): Record<string, any> {
    const db = layer === "global" ? this.globalDb : this.projectDb;
    const sessId = layer === "global" ? GLOBAL_SESSION_ID : this.sessionId;
    if (!db) return { error: "Database not available" };
    try {
      const since = Date.now() - 24 * 3600000;
      const total = (db.prepare("SELECT COUNT(*) as c FROM memory_access_log WHERE session_id = ? AND timestamp > ?").get(sessId, since) as any)?.c || 0;
      const hits = (db.prepare("SELECT COUNT(*) as c FROM memory_access_log WHERE session_id = ? AND access_type = 'query_hit' AND timestamp > ?").get(sessId, since) as any)?.c || 0;
      const topHitMemories = db.prepare("SELECT memory_id, COUNT(*) as hits FROM memory_access_log WHERE access_type IN ('query_hit', 'partial_hit') AND session_id = ? GROUP BY memory_id ORDER BY hits DESC LIMIT 10").all(sessId) as any[];
      const avgRow = db.prepare("SELECT AVG(relevance_score) as avg FROM memory_access_log WHERE access_type IN ('query_hit', 'partial_hit') AND session_id = ?").get(sessId) as any;
      const missPatterns = db.prepare("SELECT query_text, COUNT(*) as misses FROM memory_access_log WHERE access_type = 'query_miss' AND session_id = ? GROUP BY query_text ORDER BY misses DESC LIMIT 10").all(sessId) as any[];
      return {
        hitRate: total > 0 ? ((hits / total) * 100).toFixed(2) + "%" : "0.00%",
        totalQueries: total,
        topHitMemories,
        averageRelevance: avgRow?.avg || 0,
        missPatterns
      };
    } catch (e) {
      console.error("[Memory] getAccessAnalytics error:", e);
      return { error: String(e) };
    }
  }

  async getValidationReport(daysBack: number = 7, format: "markdown" | "json" = "json"): Promise<Record<string, unknown> | string> {
    if (!this.validation || !this.projectDb) {
      return { error: "Validation framework not initialized" };
    }
    try {
      const report = await this.validation.generateValidationReport(daysBack);
      if (format === "markdown") {
        return this.validation.formatReportAsMarkdown(report);
      }
      return JSON.parse(this.validation.formatReportAsJSON(report));
    } catch (e) {
      console.error("[Memory] getValidationReport error:", e);
      return { error: String(e) };
    }
  }

  async getTUIStatus(): Promise<Record<string, unknown>> {
    if (!this.tuiStatus) {
      return {
        error: "TUI status manager not initialized",
        isAvailable: false,
        label: "owl (--%) ",
        color: "gray",
      };
    }
    try {
      const status = await this.tuiStatus.getStatus();
      return {
        isAvailable: status.isAvailable,
        hitRate: status.hitRate,
        color: status.color,
        label: status.label,
        shortLabel: status.shortLabel,
        tooltip: status.tooltip,
        lastUpdate: status.lastUpdate,
        responseTime: status.responseTime,
        cache: this.tuiStatus.getCacheInfo(),
      };
    } catch (e) {
      console.error("[Memory] getTUIStatus error:", e);
      return { error: String(e) };
    }
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

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id?: string | number | null;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  result: unknown;
  id: string | number | null;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  error: { code: number; message: string; data?: unknown };
  id: string | number | null;
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const JSON_HEADERS = {
  ...CORS_HEADERS,
  "Content-Type": "application/json",
};

const TOOL_NAMES = [
  "memory_query", "memory_add", "memory_list", "memory_update", "memory_delete",
  "memory_reinforce", "memory_add_skill", "memory_approve_skill", "memory_validate_citations",
  "memory_start_episode", "memory_end_episode", "memory_list_episodes",
  "memory_stats", "memory_status",
  "memory_validation_report", "memory_hitrate", "memory_access_analytics",
  "memory_tui_status",
];

function defaultSessionId(): string {
  return `project_${Buffer.from(process.cwd()).toString("base64").slice(0, 16)}`;
}

async function dispatch(
  store: MemoryStore,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const sessionId = typeof params.session_id === "string" ? params.session_id : defaultSessionId();
  store.setSessionId(sessionId);

  switch (method) {

    case "memory_query": {
      const query  = String(params.query ?? "");
      const type   = params.type as string | undefined;
      const limit  = typeof params.limit === "number" ? params.limit : undefined;
      const layers = Array.isArray(params.layers)
        ? (params.layers as MemoryLayer[])
        : (["project", "global"] as MemoryLayer[]);
      const results = store.queryMemories({ search: query, type, limit, layers });
      return results;
    }

    case "memory_add": {
      const type       = String(params.type ?? "fact") as MemoryType;
      const content    = String(params.content ?? "");
      const importance = typeof params.importance === "number" ? params.importance : 0.5;
      const layer      = (params.layer as MemoryLayer) ?? "project";
      const id = store.addMemory({ type, content, metadata: { addedBy: "mcp" }, importance }, layer);
      if (!id) throw new Error("Failed to store memory");
      return { id, layer };
    }

    case "memory_list": {
      const type  = params.type as string | undefined;
      const limit = typeof params.limit === "number" ? params.limit : 20;
      const layer = params.layer as MemoryLayer | undefined;
      return store.listMemories({ type, limit, layer });
    }

    case "memory_update": {
      const id         = String(params.id ?? "");
      const content    = typeof params.content === "string" ? params.content : undefined;
      const importance = typeof params.importance === "number" ? params.importance : undefined;
      const metadata   = typeof params.metadata === "object" && params.metadata !== null
        ? (params.metadata as Record<string, unknown>) : undefined;
      const ok = store.updateMemory(id, { content, importance, metadata });
      return { success: ok, id };
    }

    case "memory_delete": {
      const id = String(params.id ?? "");
      const ok = store.deleteMemory(id);
      return { success: ok, id };
    }

    case "memory_reinforce": {
      const id = String(params.id ?? "");
      return store.reinforceMemory(id);
    }

    case "memory_add_skill": {
      const name             = String(params.name ?? "");
      const triggerPatterns  = Array.isArray(params.trigger_patterns) ? (params.trigger_patterns as string[]) : [];
      const steps            = Array.isArray(params.steps) ? (params.steps as string[]) : [];
      const applicability    = String(params.applicability ?? "");
      const termination      = typeof params.termination === "string" ? params.termination : undefined;
      const citations        = Array.isArray(params.citations) ? (params.citations as string[]) : undefined;
      const importance       = typeof params.importance === "number" ? params.importance : undefined;
      const id = store.addSkillMemory({ name, triggerPatterns, steps, applicability, termination, citations, importance });
      if (!id) throw new Error("Failed to store skill");
      return { id, name };
    }

    case "memory_approve_skill": {
      const id = String(params.id ?? "");
      const ok = store.approveSkill(id);
      return { success: ok, id };
    }

    case "memory_validate_citations": {
      return store.validateCitations();
    }

    case "memory_start_episode": {
      const goal = String(params.goal ?? "");
      const id   = store.startEpisode(goal);
      if (!id) throw new Error("Failed to start episode");
      return { episodeId: id, goal };
    }

    case "memory_end_episode": {
      const outcome         = String(params.outcome ?? "unknown") as EpisodeOutcome;
      const lessonsLearned  = Array.isArray(params.lessons_learned) ? (params.lessons_learned as string[]) : undefined;
      const mistakes        = Array.isArray(params.mistakes) ? (params.mistakes as string[]) : undefined;
      const importanceScore = typeof params.importance_score === "number" ? params.importance_score : undefined;
      const keywords        = Array.isArray(params.keywords) ? (params.keywords as string[]) : undefined;
      const ok = store.endEpisode({ outcome, lessonsLearned, mistakes, importanceScore, keywords });
      return { success: ok, outcome, lessonsPromoted: lessonsLearned?.length ?? 0 };
    }

    case "memory_list_episodes": {
      const limit = typeof params.limit === "number" ? params.limit : 10;
      return store.listEpisodes(limit);
    }

    case "memory_stats": {
      const s   = store.getStats();
      const ctx = store.getSessionContext();
      return {
        project:     s.total,
        global:      s.globalTotal,
        byType:      s.byType,
        avgImportance: s.avgImportance,
        currentTask: ctx?.currentTask ?? null,
        recentTools: ctx?.recentTools?.slice(-5) ?? [],
      };
    }

     case "memory_status": {
       const s   = store.getStats();
       const ctx = store.getSessionContext();
       return {
         summary: `🧠 Project: ${s.total} | Global: ${s.globalTotal} | 🎯 ${ctx?.currentTask ?? "No task"} | 🔧 ${ctx?.recentTools?.slice(-3).join(", ") ?? "None"}`,
         project: s.total,
         global:  s.globalTotal,
         currentTask: ctx?.currentTask ?? null,
       };
     }

     case "memory_hitrate": {
       const hours = (params.hours as number) ?? 24;
       const layer = (params.layer as "project" | "global") ?? "project";
       return store.getHitRate(hours, layer);
     }

      case "memory_access_analytics": {
        const layer = (params.layer as "project" | "global") ?? "project";
        return store.getAccessAnalytics(layer);
      }

      case "memory_validation_report": {
        const daysBack = (params.days_back as number) ?? 7;
        const format = (params.format as "markdown" | "json") ?? "json";
        return await store.getValidationReport(daysBack, format);
      }

      case "memory_tui_status": {
        return await store.getTUIStatus();
      }

      default:
       throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
   }
 }

export function createMcpServer(): ReturnType<typeof Bun.serve> {
  const port = Number(process.env.MCP_PORT ?? 3100);

  const projectDbPath = join(homedir(), ".local", "share", "opencode", "memory", "memory.db");
  const globalDbPath  = join(homedir(), ".config", "opencode", "memory", "global.db");

  const store = new MemoryStore(projectDbPath, globalDbPath);
  store.initialize();
  store.setSessionId(defaultSessionId());

  console.log(`[MCP] Memory v5 server starting on port ${port}`);
  console.log(`[MCP] project db: ${projectDbPath}`);
  console.log(`[MCP] global  db: ${globalDbPath}`);

  const server = Bun.serve({
    port,

    async fetch(req) {
      const url    = new URL(req.url);
      const method = req.method.toUpperCase();

      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      if (url.pathname === "/health" && method === "GET") {
        return new Response(JSON.stringify({ status: "ok", version: "v5" }), {
          status: 200, headers: JSON_HEADERS,
        });
      }

      if (url.pathname === "/tools" && method === "GET") {
        return new Response(JSON.stringify({ tools: TOOL_NAMES }), {
          status: 200, headers: JSON_HEADERS,
        });
      }

      if (url.pathname === "/rpc" && method === "POST") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          const err: JsonRpcError = {
            jsonrpc: "2.0",
            error: { code: -32700, message: "Parse error: invalid JSON" },
            id: null,
          };
          return new Response(JSON.stringify(err), { status: 400, headers: JSON_HEADERS });
        }

        const rpc = body as Partial<JsonRpcRequest>;

        if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
          const err: JsonRpcError = {
            jsonrpc: "2.0",
            error: { code: -32600, message: "Invalid Request" },
            id: rpc.id ?? null,
          };
          return new Response(JSON.stringify(err), { status: 400, headers: JSON_HEADERS });
        }

        const reqId  = rpc.id ?? null;
        const params = (rpc.params ?? {}) as Record<string, unknown>;

        try {
          const result  = await dispatch(store, rpc.method, params);
          const success: JsonRpcSuccess = { jsonrpc: "2.0", result, id: reqId };
          return new Response(JSON.stringify(success), { status: 200, headers: JSON_HEADERS });
        } catch (err: unknown) {
          const e       = err as Error & { code?: number };
          const rpcErr: JsonRpcError = {
            jsonrpc: "2.0",
            error: {
              code:    e.code ?? -32603,
              message: e.message ?? "Internal error",
            },
            id: reqId,
          };
          return new Response(JSON.stringify(rpcErr), { status: 200, headers: JSON_HEADERS });
        }
      }

      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404, headers: JSON_HEADERS,
      });
    },
  });

  console.log(`[MCP] Listening on http://localhost:${server.port}/rpc`);
  return server;
}
