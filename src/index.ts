/**
 * OpenCode Memory System Plugin v7
 *
 * Phase 8 (Issue #11 — Research Gaps):
 *   - Memory Conflict Detection: auto-detect contradictory memories on add
 *   - Confidence-Aware Ranking: confidence factor integrated into decay score
 *   - Memory Consolidation: memory_consolidate tool merges similar memories
 *   - Configurable Constants: env-based overrides for decay, archival, RRF
 *
 * Phase 7: Version Update Flow
 *   - VersionChecker: GitHub release comparison + semver parsing
 *   - Startup notification: console + system prompt (once per version)
 *   - Pre-migration backup: .db → .db.bak before schema changes
 *   - memory_check_update: manual version check tool
 *   - memory_version: display current package + schema version
 *
 * Phase 6: Forgetting Mechanism (Issue #12)
 *   - archived_memories table: soft-delete low-score/old memories
 *   - archiveOldMemories(): decay < 0.05 AND access < 2 AND age > 30d
 *   - cleanupExperiences(): experience-type memories older than 7 days
 *   - memory_archive, memory_list_archived, memory_restore tools
 *   - Auto-triggered archival on startup (non-blocking)
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
import { mkdirSync, existsSync, copyFileSync } from "fs";
import { homedir } from "os";
import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);

interface TUIStatusResponse {
  isAvailable: boolean;
  hitRate: number;
  color: "green" | "yellow" | "red" | "gray";
  label: string;
  shortLabel: string;
  tooltip: {
    title: string;
    lines: string[];
  };
  lastUpdate: number;
  responseTime: number;
}

class OwlStatusManager {
  private cachedStatus: { data: TUIStatusResponse; timestamp: number } | null = null;
  private readonly CACHE_TTL_MS = 60000;
  private readonly MCP_ENDPOINT = "http://localhost:3100/rpc";
  private readonly TIMEOUT_MS = 1500;

  async getStatus(): Promise<TUIStatusResponse | null> {
    const now = Date.now();
    if (this.cachedStatus && now - this.cachedStatus.timestamp < this.CACHE_TTL_MS) {
      return this.cachedStatus.data;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

      const response = await fetch(this.MCP_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "memory_tui_status",
          params: {},
          id: 1,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return this.getUnavailableStatus();
      }

      const data = (await response.json()) as {
        result?: TUIStatusResponse;
        error?: unknown;
      };
      const status = data.result;

      if (!status) {
        return this.getUnavailableStatus();
      }

      this.cachedStatus = {
        data: status,
        timestamp: now,
      };

      return status;
    } catch (err) {
      console.debug("[Owl TUI] Fetch failed:", err instanceof Error ? err.message : String(err));
      return this.getUnavailableStatus();
    }
  }

  private getUnavailableStatus(): TUIStatusResponse {
    return {
      isAvailable: false,
      hitRate: 0,
      color: "gray",
      label: "owl (—)",
      shortLabel: "owl",
      tooltip: {
        title: "OpenCode-Owl Memory System",
        lines: [
          "Status: ⚠ Service Unavailable",
          "Check if MCP server is running",
          "Port: 3100",
        ],
      },
      lastUpdate: Date.now(),
      responseTime: 0,
    };
  }

  formatStatus(status: TUIStatusResponse): string {
    const lines = [
      `Status: ${status.label}`,
      `Hit Rate: ${(status.hitRate * 100).toFixed(1)}%`,
      `Available: ${status.isAvailable ? "✅" : "⚠️"}`,
      "",
      status.tooltip.title,
      ...status.tooltip.lines,
    ];
    return lines.join("\n");
  }
}

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
  confidence?: number;
  layer?: MemoryLayer;
  decayScore?: number;
  supersedes?: string[];
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

interface ArchivedMemoryRow extends MemoryRow {
  archived_at: number;
  archive_reason: string | null;
}

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseType: "major" | "minor" | "patch" | "none";
  releaseNotes: string;
  releaseUrl: string;
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
const SCHEMA_VERSION     = 11;
const DECAY_LAMBDA       = parseFloat(process.env.MEMORY_DECAY_LAMBDA ?? "0.1");
const GLOBAL_SESSION_ID  = "__global__";
const EMBED_DIM          = 768;
const PACKAGE_VERSION    = "1.2.5";
const GITHUB_RELEASES_URL = "https://api.github.com/repos/DevSecOpsLab-CSIE-NPU/opencode-owl/releases/latest";

// Configurable thresholds (env overrides)
const ARCHIVAL_DECAY_THRESHOLD   = parseFloat(process.env.MEMORY_ARCHIVAL_DECAY ?? "0.05");
const ARCHIVAL_ACCESS_THRESHOLD  = parseInt(process.env.MEMORY_ARCHIVAL_ACCESS ?? "2", 10);
const ARCHIVAL_AGE_DAYS           = parseInt(process.env.MEMORY_ARCHIVAL_AGE ?? "30", 10);
const EXPERIENCE_CLEANUP_DAYS     = parseInt(process.env.MEMORY_EXPERIENCE_CLEANUP ?? "7", 10);
const RRF_K                       = parseFloat(process.env.MEMORY_RRF_K ?? "60");
const CONFIDENCE_WEIGHT           = parseFloat(process.env.MEMORY_CONFIDENCE_WEIGHT ?? "0.15");
const CONSOLIDATION_SIMILARITY    = parseFloat(process.env.MEMORY_CONSOLIDATION_SIMILARITY ?? "0.85");
const CONTEXT_TERM_LIMIT          = parseInt(process.env.MEMORY_CONTEXT_TERM_LIMIT ?? "5", 10);
const CONVERSATION_HISTORY_LIMIT  = parseInt(process.env.MEMORY_CONVERSATION_LIMIT ?? "50", 10);
const REFLECTION_THROTTLE_MS      = parseInt(process.env.MEMORY_REFLECTION_THROTTLE ?? "3600000", 10);
const TOOL_PATTERN_MIN_REPEAT     = parseInt(process.env.MEMORY_TOOL_PATTERN_MIN ?? "3", 10);
const SEMANTIC_CONFLICT_THRESHOLD = parseFloat(process.env.MEMORY_SEMANTIC_CONFLICT_THRESHOLD ?? "0.75");
const CONFLICT_RESOLUTION_STRATEGY = process.env.MEMORY_CONFLICT_RESOLUTION ?? "confidence";
const DECAY_MODEL                 = process.env.MEMORY_DECAY_MODEL ?? "exponential";
const ADAPTIVE_DECAY_ENABLED      = process.env.MEMORY_ADAPTIVE_DECAY === "true";

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
  accessCount: number, memoryStrength = 1.0, confidence = 0.8,
  model: string = DECAY_MODEL
): number {
  const daysSince     = (Date.now() - lastAccessedAt) / 86_400_000;
  const frequency     = Math.log(2 + accessCount);
  const confidenceFactor = 1.0 + CONFIDENCE_WEIGHT * (confidence - 0.5);

  let recency: number;
  switch (model) {
    case "power_law":
      recency = Math.pow(1 + daysSince, -DECAY_LAMBDA * memoryStrength);
      break;
    case "step_function":
      const steps = Math.floor(daysSince / 7);
      recency = Math.pow(0.8, steps) / memoryStrength;
      break;
    case "forgetting_curve":
      const R = Math.exp(-daysSince / (33 * memoryStrength));
      recency = R * (1 + 0.1 * Math.log(1 + accessCount));
      break;
    case "exponential":
    default:
      const effectiveLambda = DECAY_LAMBDA / memoryStrength;
      recency = Math.exp(-effectiveLambda * daysSince);
      break;
  }

  return importance * recency * frequency * confidenceFactor;
}

function getDefaultDecayModelForType(type: MemoryType): string {
  const modelMap: Record<MemoryType, string> = {
    fact: "power_law",
    experience: "exponential",
    preference: "step_function",
    skill: "forgetting_curve",
  };
  return modelMap[type] ?? "exponential";
}

function rrfMerge(listA: string[], listB: string[], k = RRF_K): string[] {
  const scores = new Map<string, number>();
  listA.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  listB.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

class VersionChecker {
  private readonly currentVersion: string;
  private latestCache: UpdateInfo | null = null;
  private lastChecked = 0;

  constructor(currentVersion: string) {
    this.currentVersion = currentVersion;
  }

  parseSemver(version: string): { major: number; minor: number; patch: number } {
    const clean = version.replace(/^v/, "");
    const parts = clean.split(".").map(Number);
    return { major: parts[0] ?? 0, minor: parts[1] ?? 0, patch: parts[2] ?? 0 };
  }

  compareVersions(current: string, latest: string): "major" | "minor" | "patch" | "none" {
    const c = this.parseSemver(current);
    const l = this.parseSemver(latest);
    if (l.major > c.major) return "major";
    if (l.minor > c.minor) return "minor";
    if (l.patch > c.patch) return "patch";
    return "none";
  }

  async check(): Promise<UpdateInfo> {
    if (this.latestCache && Date.now() - this.lastChecked < REFLECTION_THROTTLE_MS) return this.latestCache;

    try {
      const resp = await fetch(GITHUB_RELEASES_URL, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        this.latestCache = { currentVersion: this.currentVersion, latestVersion: this.currentVersion, updateAvailable: false, releaseType: "none", releaseNotes: "", releaseUrl: "" };
        this.lastChecked = Date.now();
        return this.latestCache;
      }
      const data = await resp.json() as { tag_name: string; body: string; html_url: string };
      const latestVersion = data.tag_name.replace(/^v/, "");
      const releaseType = this.compareVersions(this.currentVersion, latestVersion);
      const updateAvailable = releaseType !== "none";

      this.latestCache = {
        currentVersion: this.currentVersion,
        latestVersion,
        updateAvailable,
        releaseType,
        releaseNotes: data.body ?? "",
        releaseUrl: data.html_url ?? "",
      };
    } catch {
      this.latestCache = { currentVersion: this.currentVersion, latestVersion: this.currentVersion, updateAvailable: false, releaseType: "none", releaseNotes: "", releaseUrl: "" };
    }
    this.lastChecked = Date.now();
    return this.latestCache;
  }

  getNotification(info: UpdateInfo): string | null {
    if (!info.updateAvailable) return null;
    const typeLabel = info.releaseType === "major" ? "MAJOR" : info.releaseType === "minor" ? "MINOR" : "PATCH";
    const changelog = info.releaseNotes.split("\n").filter(l => l.trim().startsWith("-")).slice(0, 5).join("\n");
    return [
      `Update available: ${info.currentVersion} → ${info.latestVersion} (${typeLabel})`,
      changelog ? `Changelog:\n${changelog}` : "",
      `Release: ${info.releaseUrl}`,
    ].filter(Boolean).join("\n");
  }
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
      this.createBackup(this.projectDbPath);
      this.projectDb = new Database(this.projectDbPath);
      this.tryLoadVec(this.projectDb);
      this.initSchemaForDb(this.projectDb, false);

      this.ensureDir(this.globalDbPath);
      this.createBackup(this.globalDbPath);
      this.globalDb = new Database(this.globalDbPath);
      this.tryLoadVec(this.globalDb);
      this.initSchemaForDb(this.globalDb, true);
    } catch (err) {
      console.error("[Memory] Initialization failed:", err);
    }
  }

  private createBackup(dbPath: string): void {
    if (!existsSync(dbPath)) return;
    const backupPath = `${dbPath}.bak`;
    try {
      copyFileSync(dbPath, backupPath);
    } catch { /* ignore — backup is best-effort */ }
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

      if (current < 6) {
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS archived_memories (
              id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
              type TEXT NOT NULL, content TEXT NOT NULL,
              metadata TEXT DEFAULT '{}', importance REAL DEFAULT 0.5,
              access_count INTEGER DEFAULT 0,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
              last_accessed_at INTEGER NOT NULL,
              citations TEXT, source TEXT, confidence REAL,
              memory_strength REAL, reinforcement_count INTEGER,
              embedding BLOB,
              archived_at INTEGER NOT NULL,
              archive_reason TEXT
            )
          `);
          db.exec("CREATE INDEX IF NOT EXISTS idx_archived_session ON archived_memories(session_id)");
          db.exec("CREATE INDEX IF NOT EXISTS idx_archived_type ON archived_memories(type)");
          db.exec("CREATE INDEX IF NOT EXISTS idx_archived_at ON archived_memories(archived_at)");
        } catch (e) { console.error("[Memory] Migration v6 error:", e); }
      }

      if (current < 7) {
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS conflict_log (
              id TEXT PRIMARY KEY,
              source_id TEXT NOT NULL,
              target_id TEXT NOT NULL,
              conflict_type TEXT NOT NULL,
              similarity_score REAL,
              resolution TEXT,
              resolved_at INTEGER,
              created_at INTEGER NOT NULL
            )
          `);
          db.exec("CREATE INDEX IF NOT EXISTS idx_conflict_source ON conflict_log(source_id)");
          db.exec("CREATE INDEX IF NOT EXISTS idx_conflict_target ON conflict_log(target_id)");
          db.exec("CREATE INDEX IF NOT EXISTS idx_conflict_type ON conflict_log(conflict_type)");
        } catch (e) { console.error("[Memory] Migration v7 error:", e); }
      }

      if (current < 8) {
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS consolidation_history (
              id TEXT PRIMARY KEY,
              keeper_id TEXT NOT NULL,
              merged_ids TEXT NOT NULL,
              original_content TEXT,
              consolidated_content TEXT NOT NULL,
              abstraction_level TEXT DEFAULT 'raw',
              source_ids TEXT,
              created_at INTEGER NOT NULL
            )
          `);
          db.exec("CREATE INDEX IF NOT EXISTS idx_consolidation_keeper ON consolidation_history(keeper_id)");
          try { db.exec("ALTER TABLE memories ADD COLUMN abstraction_level TEXT DEFAULT 'raw'"); } catch { /* exists */ }
          try { db.exec("ALTER TABLE memories ADD COLUMN source_ids TEXT DEFAULT '[]'"); } catch { /* exists */ }
        } catch (e) { console.error("[Memory] Migration v8 error:", e); }
      }

      if (current < 9) {
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS ablation_experiments (
              id TEXT PRIMARY KEY,
              memory_ids TEXT NOT NULL,
              baseline_metrics TEXT,
              ablation_metrics TEXT,
              impact_scores TEXT,
              created_at INTEGER NOT NULL
            )
          `);
          db.exec("CREATE INDEX IF NOT EXISTS idx_ablation_created ON ablation_experiments(created_at)");
          db.exec(`
            CREATE TABLE IF NOT EXISTS execution_traces (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              tool_name TEXT NOT NULL,
              success INTEGER DEFAULT 0,
              duration_ms INTEGER,
              error TEXT,
              created_at INTEGER NOT NULL
            )
          `);
          db.exec("CREATE INDEX IF NOT EXISTS idx_trace_session ON execution_traces(session_id)");
          db.exec("CREATE INDEX IF NOT EXISTS idx_trace_tool ON execution_traces(tool_name)");
        } catch (e) { console.error("[Memory] Migration v9 error:", e); }
      }

      if (current < 10) {
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS memory_relationships (
              id TEXT PRIMARY KEY,
              source_id TEXT NOT NULL,
              target_id TEXT NOT NULL,
              relation_type TEXT NOT NULL,
              confidence REAL DEFAULT 0.8,
              derived_from TEXT,
              created_at INTEGER NOT NULL
            )
          `);
          db.exec("CREATE INDEX IF NOT EXISTS idx_rel_source ON memory_relationships(source_id)");
          db.exec("CREATE INDEX IF NOT EXISTS idx_rel_target ON memory_relationships(target_id)");
          db.exec("CREATE INDEX IF NOT EXISTS idx_rel_type ON memory_relationships(relation_type)");
          db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_unique ON memory_relationships(source_id, target_id, relation_type)");
        } catch (e) { console.error("[Memory] Migration v10 error:", e); }
      }

      if (current < 11) {
        try {
          try { db.exec("ALTER TABLE memories ADD COLUMN decay_model TEXT DEFAULT 'exponential'"); } catch { /* exists */ }
          try { db.exec("ALTER TABLE memories ADD COLUMN decay_params TEXT DEFAULT '{}'"); } catch { /* exists */ }
          db.exec(`
            CREATE TABLE IF NOT EXISTS forgetting_analytics (
              id TEXT PRIMARY KEY,
              memory_id TEXT NOT NULL,
              decay_model TEXT NOT NULL,
              decay_rate REAL,
              retrieval_count INTEGER DEFAULT 0,
              retrieval_success_rate REAL,
              adjusted_decay_rate REAL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
          `);
          db.exec("CREATE INDEX IF NOT EXISTS idx_forgetting_memory ON forgetting_analytics(memory_id)");
          db.exec("CREATE INDEX IF NOT EXISTS idx_forgetting_model ON forgetting_analytics(decay_model)");
        } catch (e) { console.error("[Memory] Migration v11 error:", e); }
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
      m.decayScore = computeDecayScore(m.importance, m.lastAccessedAt, m.accessCount, m.memoryStrength, m.confidence ?? 0.8);
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
      m.decayScore = computeDecayScore(m.importance, m.lastAccessedAt, m.accessCount, m.memoryStrength, m.confidence ?? 0.8);
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

    for (const m of rows) m.decayScore = computeDecayScore(m.importance, m.lastAccessedAt, m.accessCount, m.memoryStrength, m.confidence ?? 0.8);
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
          "SELECT importance, access_count, last_accessed_at, memory_strength, reinforcement_count, confidence FROM memories WHERE id = ? AND session_id = ?"
        ).get(id, sessId) as Pick<MemoryRow, "importance" | "access_count" | "last_accessed_at" | "memory_strength" | "reinforcement_count" | "confidence"> | null;
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
        const newScore  = computeDecayScore(row.importance, now, (row.access_count ?? 0) + 1, newStr, row.confidence ?? 0.8);
        return { success: true, newStrength: newStr, newDecayScore: newScore };
      } catch (e) { console.error("[Memory] reinforceMemory error:", e); }
    }
    return notFound;
  }

  archiveOldMemories(): { projectArchived: number; globalArchived: number } {
    const archiveFromDb = (db: Database): number => {
      let count = 0;
      try {
        const archivalAgeCutoff = Date.now() - ARCHIVAL_AGE_DAYS * 86_400_000;
        const rows = db.prepare(`
          SELECT * FROM memories WHERE access_count < ? AND created_at < ?
        `).all(ARCHIVAL_ACCESS_THRESHOLD, archivalAgeCutoff) as MemoryRow[];
        const now = Date.now();
        for (const row of rows) {
          const entry = this.rowToEntry(row);
          const decayScore = computeDecayScore(entry.importance, entry.lastAccessedAt, entry.accessCount, entry.memoryStrength, entry.confidence ?? 0.8);
          if (decayScore < ARCHIVAL_DECAY_THRESHOLD) {
            try {
              db.prepare(`
                INSERT OR REPLACE INTO archived_memories (
                  id, session_id, type, content, metadata, importance,
                  access_count, created_at, updated_at, last_accessed_at,
                  citations, source, confidence, memory_strength, reinforcement_count,
                  embedding, archived_at, archive_reason
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                row.id, row.session_id, row.type, row.content, row.metadata,
                row.importance, row.access_count, row.created_at, row.updated_at,
                row.last_accessed_at, row.citations ?? null, row.source ?? null,
                row.confidence ?? null, row.memory_strength ?? null,
                row.reinforcement_count ?? null,
                (row as unknown as { embedding?: Buffer | null }).embedding ?? null,
                now, `auto:decay_score=${decayScore.toFixed(4)}`
              );
              db.prepare("DELETE FROM memories WHERE id = ?").run(row.id);
              this.deleteFtsRow(db, row.id);
              this.deleteVecRow(db, row.id);
              count++;
            } catch (e) { console.error("[Memory] archiveOldMemories row error:", e); }
          }
        }
      } catch (e) { console.error("[Memory] archiveOldMemories error:", e); }
      return count;
    };
    const projectArchived = this.projectDb ? archiveFromDb(this.projectDb) : 0;
    const globalArchived  = this.globalDb  ? archiveFromDb(this.globalDb)  : 0;
    return { projectArchived, globalArchived };
  }

  cleanupExperiences(): { projectArchived: number } {
    const db = this.projectDb;
    if (!db) return { projectArchived: 0 };
    let projectArchived = 0;
    try {
      const experienceCleanupCutoff = Date.now() - EXPERIENCE_CLEANUP_DAYS * 86_400_000;
      const rows = db.prepare(`
        SELECT * FROM memories WHERE type = 'experience' AND created_at < ?
      `).all(experienceCleanupCutoff) as MemoryRow[];
      const now = Date.now();
      for (const row of rows) {
        try {
          db.prepare(`
            INSERT OR REPLACE INTO archived_memories (
              id, session_id, type, content, metadata, importance,
              access_count, created_at, updated_at, last_accessed_at,
              citations, source, confidence, memory_strength, reinforcement_count,
              embedding, archived_at, archive_reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            row.id, row.session_id, row.type, row.content, row.metadata,
            row.importance, row.access_count, row.created_at, row.updated_at,
            row.last_accessed_at, row.citations ?? null, row.source ?? null,
            row.confidence ?? null, row.memory_strength ?? null,
            row.reinforcement_count ?? null,
            (row as unknown as { embedding?: Buffer | null }).embedding ?? null,
            now, "auto:experience_cleanup"
          );
          db.prepare("DELETE FROM memories WHERE id = ?").run(row.id);
          this.deleteFtsRow(db, row.id);
          this.deleteVecRow(db, row.id);
          projectArchived++;
        } catch (e) { console.error("[Memory] cleanupExperiences row error:", e); }
      }
    } catch (e) { console.error("[Memory] cleanupExperiences error:", e); }
    return { projectArchived };
  }

  listArchivedMemories(options: { limit?: number; layer?: MemoryLayer; type?: string } = {}):
    Array<MemoryEntry & { archivedAt: number; archiveReason: string | null }> {
    const limit = options.limit ?? 20;
    const results: Array<MemoryEntry & { archivedAt: number; archiveReason: string | null }> = [];

    const fetch = (db: Database | null, sessId: string, layer: MemoryLayer) => {
      if (!db) return;
      let sql = "SELECT * FROM archived_memories WHERE session_id = ?";
      const params: RowParam[] = [sessId];
      if (options.type) { sql += " AND type = ?"; params.push(options.type); }
      sql += " ORDER BY archived_at DESC LIMIT ?";
      params.push(limit);
      try {
        const rows = db.prepare(sql).all(...params) as ArchivedMemoryRow[];
        for (const r of rows) {
          results.push({ ...this.rowToEntry(r), layer, archivedAt: r.archived_at, archiveReason: r.archive_reason });
        }
      } catch (e) { console.error("[Memory] listArchivedMemories error:", e); }
    };

    if (!options.layer || options.layer === "project") fetch(this.projectDb, this.sessionId, "project");
    if (!options.layer || options.layer === "global")  fetch(this.globalDb, GLOBAL_SESSION_ID, "global");

    results.sort((a, b) => b.archivedAt - a.archivedAt);
    return results.slice(0, limit);
  }

  restoreMemory(id: string): boolean {
    for (const [db, sessId, _layer] of this.allDbs()) {
      try {
        const row = db.prepare("SELECT * FROM archived_memories WHERE id = ? AND session_id = ?")
          .get(id, sessId) as ArchivedMemoryRow | null;
        if (!row) continue;
        const now = Date.now();
        db.prepare(`
          INSERT OR REPLACE INTO memories (
            id, session_id, type, content, metadata, importance,
            access_count, created_at, updated_at, last_accessed_at,
            citations, source, confidence, memory_strength, reinforcement_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          row.id, row.session_id, row.type, row.content, row.metadata,
          row.importance, row.access_count, row.created_at, now,
          now, row.citations ?? null, row.source ?? null,
          row.confidence ?? null, row.memory_strength ?? null,
          row.reinforcement_count ?? null
        );
        this.insertFtsRow(db, row.id, sessId, row.content);
        db.prepare("DELETE FROM archived_memories WHERE id = ? AND session_id = ?").run(id, sessId);
        return true;
      } catch (e) { console.error("[Memory] restoreMemory error:", e); }
    }
    return false;
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
          SELECT id FROM conversation_history WHERE session_id = ? ORDER BY timestamp DESC LIMIT ${CONVERSATION_HISTORY_LIMIT}
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
      confidence:         row.confidence          ?? 0.8,
    };
  }

  buildContextQuery(
    recentConversations: Array<{ role: string; content: string; timestamp: number }>,
    currentTask?: string,
    recentTools?: string[]
  ): string {
    const STOP_WORDS = new Set([
      "a","an","the","and","or","but","in","on","at","to","for","of","with","by","from",
      "is","are","was","were","be","been","being","have","has","had","do","does","did",
      "will","would","could","should","may","might","can","this","that","these","those",
      "i","me","my","we","our","you","your","he","she","it","they","them","their",
      "what","which","who","how","when","where","why","not","no","yes","so","if","then",
      "than","as","up","out","about","into","through","over","after","before","just",
      "also","use","used","using","make","made","get","got","set","run","let","new",
      "all","more","some","any","each","both","here","there","now","only","very","much",
      "like","need","want","know","see","try","look","go","come","back","while","please",
      "thanks","okay","sure","ok","its","one","two","three","four","five",
      "had","his","her","him","did","say","said","s","t","re","ve","ll","d",
    ]);

    const termFreq = new Map<string, number>();

    const extractTerms = (text: string, weight: number) => {
      const words = text.toLowerCase()
        .replace(/[^a-z0-9\s_\-]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
      for (const w of words) termFreq.set(w, (termFreq.get(w) ?? 0) + weight);
    };

    if (currentTask) extractTerms(currentTask, 3);

    for (const msg of recentConversations.slice(0, CONTEXT_TERM_LIMIT + 1)) {
      const snippet = msg.role === "user" ? msg.content.slice(0, 500) : msg.content.slice(0, 200);
      extractTerms(snippet, msg.role === "user" ? 1.5 : 0.5);
    }

    if (recentTools) {
      for (const t of recentTools.slice(-(CONTEXT_TERM_LIMIT + 3))) {
        const parts = t.toLowerCase().split(/[_\-\.]+/).filter(p => p.length > 3 && !STOP_WORDS.has(p));
        for (const p of parts) termFreq.set(p, (termFreq.get(p) ?? 0) + 2);
      }
    }

    return [...termFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, CONTEXT_TERM_LIMIT)
      .map(([term]) => term)
      .join(" ");
  }

  // ── Auto-Reflection (Issue #14) ──────────────────────────────────────────────

  private detectToolPatterns(tools: string[]): string[] {
    if (tools.length < 6) return [];
    const patternCounts = new Map<string, number>();
    for (let len = 2; len <= 3; len++) {
      for (let i = 0; i <= tools.length - len; i++) {
        const seq = tools.slice(i, i + len).join(" → ");
        patternCounts.set(seq, (patternCounts.get(seq) ?? 0) + 1);
      }
    }
    return [...patternCounts.entries()]
      .filter(([, count]) => count >= TOOL_PATTERN_MIN_REPEAT)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([seq, count]) => `"${seq}" repeated ${count}×`);
  }

  generateReflection(): string {
    const db = this.projectDb;
    if (!db) return "";
    try {
      const conversations = this.getRecentConversations(50);
      const episodes      = this.listEpisodes(20);
      const ctx           = this.getSessionContext();

      const expRows = db.prepare(
        "SELECT content, metadata FROM memories WHERE session_id = ? AND type = 'experience' ORDER BY updated_at DESC LIMIT 50"
      ).all(this.sessionId) as { content: string; metadata: string }[];

      const toolUsages: Array<{ tool: string; count: number; lastFile: string }> = [];
      for (const row of expRows) {
        try {
          const meta = JSON.parse(row.metadata ?? "{}") as Record<string, unknown>;
          if (meta.toolName && typeof meta.count === "number") {
            toolUsages.push({
              tool:     meta.toolName as string,
              count:    meta.count,
              lastFile: (meta.lastFile as string) ?? "",
            });
          }
        } catch { /* skip malformed */ }
      }
      toolUsages.sort((a, b) => b.count - a.count);

      const lines: string[] = [];
      lines.push(`[AUTO-REFLECTION] Session: ${this.sessionId} | Generated: ${new Date().toISOString()}`);

      if (episodes.length > 0) {
        lines.push(`\nTASKS ATTEMPTED (${episodes.length} episode${episodes.length !== 1 ? "s" : ""}):`);
        for (const ep of episodes) {
          lines.push(`  [${ep.outcome.toUpperCase()}] ${ep.goal.slice(0, 120)}`);
        }
      }

      const byOutcome: Record<string, number> = {};
      for (const ep of episodes) byOutcome[ep.outcome] = (byOutcome[ep.outcome] ?? 0) + 1;
      if (episodes.length > 0) {
        const outcomeStr = Object.entries(byOutcome).map(([k, v]) => `${v} ${k}`).join(", ");
        lines.push(`\nOUTCOMES: ${outcomeStr}`);
      }

      const allLessons: string[] = [];
      for (const ep of episodes) allLessons.push(...ep.lessonsLearned);
      if (allLessons.length > 0) {
        lines.push(`\nLESSONS LEARNED (${allLessons.length}):`);
        for (const lesson of allLessons.slice(0, 15)) {
          lines.push(`  - ${lesson.slice(0, 150)}`);
        }
      }

      if (toolUsages.length > 0) {
        lines.push(`\nTOOL USAGE (top ${Math.min(10, toolUsages.length)}):`);
        for (const t of toolUsages.slice(0, 10)) {
          const fileInfo = t.lastFile ? ` (last: ${t.lastFile})` : "";
          lines.push(`  - ${t.tool}: ${t.count}×${fileInfo}`);
        }
      }

      const recentTools = ctx?.recentTools ?? [];
      if (recentTools.length >= 6) {
        const pats = this.detectToolPatterns(recentTools);
        if (pats.length > 0) {
          lines.push(`\nOBSERVED PATTERNS:`);
          for (const p of pats) lines.push(`  - ${p}`);
        }
      }

      const totalInvocations = toolUsages.reduce((s, t) => s + t.count, 0);
      lines.push(`\nACTIVITY SUMMARY:`);
      lines.push(`  - Conversation messages:   ${conversations.length}`);
      lines.push(`  - Total tool invocations:  ${totalInvocations}`);
      lines.push(`  - Unique tools used:       ${toolUsages.length}`);
      lines.push(`  - Episodes tracked:        ${episodes.length}`);

      const reflection = lines.join("\n");

      const importance = Math.min(1.0, Math.max(0.4,
        0.3 +
        Math.min(0.3, episodes.length    * 0.05) +
        Math.min(0.2, allLessons.length  * 0.04) +
        Math.min(0.2, toolUsages.length  * 0.02)
      ));

      this.addMemory({
        type: "fact",
        content: reflection,
        metadata: {
          source:               "auto-reflection",
          sessionId:            this.sessionId,
          episodeCount:         episodes.length,
          lessonCount:          allLessons.length,
          toolCount:            toolUsages.length,
          totalToolInvocations: totalInvocations,
          generatedAt:          Date.now(),
        },
        importance,
      }, "project");

      return reflection;
    } catch (e) {
      console.error("[Memory] generateReflection error:", e);
      return "";
    }
  }

  getLatestReflection(): MemoryEntry | null {
    const db = this.projectDb;
    if (!db) return null;
    try {
      const rows = db.prepare(`
        SELECT * FROM memories
        WHERE session_id = ? AND type = 'fact' AND metadata LIKE '%"source":"auto-reflection"%'
        ORDER BY created_at DESC LIMIT 1
      `).all(this.sessionId) as MemoryRow[];
      if (rows.length === 0) return null;
      return { ...this.rowToEntry(rows[0]), layer: "project" };
    } catch { return null; }
  }

  // ── Conflict Detection (Issue #12 — v1.2.1) ──────────────────────────────────

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  detectConflicts(newContent: string, newType: MemoryType, layer: MemoryLayer): Array<{ id: string; content: string; reason: string; score: number }> {
    const db = layer === "global" ? this.globalDb : this.projectDb;
    if (!db) return [];
    const sessId = layer === "global" ? GLOBAL_SESSION_ID : this.sessionId;
    const conflicts: Array<{ id: string; content: string; reason: string; score: number }> = [];

    try {
      const rows = db.prepare(
        "SELECT id, content, metadata, type, embedding FROM memories WHERE session_id = ? AND type = ?"
      ).all(sessId, newType) as { id: string; content: string; metadata: string; type: string; embedding: Buffer | null }[];

      const newLower = newContent.toLowerCase();
      const newWords = new Set(newLower.split(/\s+/).filter(w => w.length > 3));

      for (const row of rows) {
        const existingLower = row.content.toLowerCase();
        const existingWords = new Set(existingLower.split(/\s+/).filter(w => w.length > 3));

        if (existingWords.size === 0 || newWords.size === 0) continue;

        const overlap = [...newWords].filter(w => existingWords.has(w)).length;
        const jaccard = overlap / (newWords.size + existingWords.size - overlap);

        if (jaccard > CONSOLIDATION_SIMILARITY) {
          conflicts.push({
            id: row.id,
            content: row.content.slice(0, 120),
            reason: `high_similarity(jaccard=${jaccard.toFixed(2)})`,
            score: jaccard,
          });
        }

        if (row.embedding && this.vecAvailable) {
          try {
            const existingVec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
            const negationPatterns = [
              /\b(not|never|don't|doesn't|isn't|aren't|wasn't|weren't|no |without|disabled)\b/gi,
              /\b(use|uses|using|prefer|avoid|disable|enable|skip)\b/gi,
            ];
            const newHasNegation = negationPatterns.some(p => p.test(newContent));
            const existingHasNegation = negationPatterns.some(p => p.test(row.content));

            if (newHasNegation !== existingHasNegation) {
              const similarity = 1.0 - this.cosineSimilarity(existingVec, existingVec);
              if (similarity > SEMANTIC_CONFLICT_THRESHOLD) {
                conflicts.push({
                  id: row.id,
                  content: row.content.slice(0, 120),
                  reason: `semantic_contradiction(cosine=${similarity.toFixed(2)})`,
                  score: similarity,
                });
              }
            }
          } catch { /* skip malformed embedding */ }
        }
      }

      const negationPatterns2 = [
        /\b(not|never|don't|doesn't|isn't|aren't|wasn't|weren't|no |without|disabled|disabled)\b/gi,
        /\b(use|uses|using|prefer|avoid|disable|enable|skip|skip)\b/gi,
      ];
      const newHasNegation2 = negationPatterns2.some(p => p.test(newContent));

      for (const row of rows) {
        const existingWords2 = new Set(row.content.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        const existingHasNegation = negationPatterns2.some(p => p.test(row.content));
        if (newHasNegation2 !== existingHasNegation) {
          const sharedTerms = [...newWords].filter(w => existingWords2.has(w));
          if (sharedTerms.length >= 3) {
            conflicts.push({
              id: row.id,
              content: row.content.slice(0, 120),
              reason: `possible_contradiction(shared_terms=${sharedTerms.join(",")})`,
              score: sharedTerms.length / Math.max(newWords.size, existingWords2.size),
            });
          }
        }
      }
    } catch { /* ignore */ }

    return conflicts.sort((a, b) => b.score - a.score);
  }

  resolveConflict(sourceId: string, targetId: string, strategy: "time" | "confidence" | "access" | "manual" = "confidence"): { success: boolean; winner: string; loser: string; details: string } {
    const db = this.projectDb;
    if (!db) return { success: false, winner: "", loser: "", details: "No database available." };

    try {
      const sourceRow = db.prepare("SELECT * FROM memories WHERE id = ? AND session_id = ?")
        .get(sourceId, this.sessionId) as MemoryRow | null;
      const targetRow = db.prepare("SELECT * FROM memories WHERE id = ? AND session_id = ?")
        .get(targetId, this.sessionId) as MemoryRow | null;

      if (!sourceRow || !targetRow) return { success: false, winner: "", loser: "", details: "One or both memories not found." };

      let winner: MemoryRow, loser: MemoryRow;

      switch (strategy) {
        case "time":
          winner = sourceRow.updated_at >= targetRow.updated_at ? sourceRow : targetRow;
          loser = winner === sourceRow ? targetRow : sourceRow;
          break;
        case "confidence":
          winner = (sourceRow.confidence ?? 0.8) >= (targetRow.confidence ?? 0.8) ? sourceRow : targetRow;
          loser = winner === sourceRow ? targetRow : sourceRow;
          break;
        case "access":
          winner = sourceRow.access_count >= targetRow.access_count ? sourceRow : targetRow;
          loser = winner === sourceRow ? targetRow : sourceRow;
          break;
        case "manual":
          return { success: false, winner: "", loser: "", details: "Manual resolution: choose which memory to keep." };
      }

      db.prepare("UPDATE memories SET supersedes = json_insert(COALESCE(supersedes, '[]'), '$[#], ?) WHERE id = ?")
        .run(loser.id, winner.id);

      const conflictId = `conflict_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(`
        INSERT INTO conflict_log (id, source_id, target_id, conflict_type, similarity_score, resolution, resolved_at, created_at)
        VALUES (?, ?, ?, 'resolved', 0.0, ?, ?, ?)
      `).run(conflictId, sourceId, targetId, strategy, Date.now(), Date.now());

      db.prepare("DELETE FROM memories WHERE id = ?").run(loser.id);
      this.deleteFtsRow(db, loser.id);
      this.deleteVecRow(db, loser.id);

      return {
        success: true,
        winner: winner.id,
        loser: loser.id,
        details: `Kept ${winner.id} (${strategy} priority), removed ${loser.id}. supersedes updated.`,
      };
    } catch (e) { console.error("[Memory] resolveConflict error:", e); return { success: false, winner: "", loser: "", details: String(e) }; }
  }

  getConflictHistory(limit = 20): Array<{ sourceId: string; targetId: string; type: string; resolution: string | null; resolvedAt: number | null }> {
    const db = this.projectDb;
    if (!db) return [];
    try {
      const rows = db.prepare(
        "SELECT source_id, target_id, conflict_type, resolution, resolved_at FROM conflict_log WHERE source_id IN (SELECT id FROM memories WHERE session_id = ?) OR target_id IN (SELECT id FROM memories WHERE session_id = ?) ORDER BY created_at DESC LIMIT ?"
      ).all(this.sessionId, this.sessionId, limit) as { source_id: string; target_id: string; conflict_type: string; resolution: string | null; resolved_at: number | null }[];
      return rows.map(r => ({ sourceId: r.source_id, targetId: r.target_id, type: r.conflict_type, resolution: r.resolution, resolvedAt: r.resolved_at }));
    } catch { return []; }
  }

  // ── Memory Consolidation (Issue #11 — Gap 4 / Issue #13 — v1.2.2) ────────────

  consolidateMemories(dryRun = false, policy: "aggressive" | "moderate" | "conservative" = "moderate"): { groups: number; merged: number; details: string[] } {
    const db = this.projectDb;
    if (!db) return { groups: 0, merged: 0, details: [] };

    const thresholds: Record<string, number> = { aggressive: 0.7, moderate: CONSOLIDATION_SIMILARITY, conservative: 0.95 };
    const threshold = thresholds[policy] ?? CONSOLIDATION_SIMILARITY;

    const details: string[] = [];
    let merged = 0;
    let groupCount = 0;

    try {
      const rows = db.prepare(
        "SELECT id, content, type, session_id FROM memories WHERE session_id = ? AND type IN ('fact', 'preference') ORDER BY importance DESC"
      ).all(this.sessionId) as { id: string; content: string; type: string; session_id: string }[];

      const visited = new Set<string>();
      const groups: string[][] = [];

      for (let i = 0; i < rows.length; i++) {
        if (visited.has(rows[i].id)) continue;
        const group = [rows[i].id];
        visited.add(rows[i].id);

        const wordsA = new Set(rows[i].content.toLowerCase().split(/\s+/).filter(w => w.length > 3));

        for (let j = i + 1; j < rows.length; j++) {
          if (visited.has(rows[j].id)) continue;
          if (rows[j].type !== rows[i].type) continue;

          const wordsB = new Set(rows[j].content.toLowerCase().split(/\s+/).filter(w => w.length > 3));
          if (wordsA.size === 0 || wordsB.size === 0) continue;

          const overlap = [...wordsA].filter(w => wordsB.has(w)).length;
          const jaccard = overlap / (wordsA.size + wordsB.size - overlap);

          if (jaccard >= threshold) {
            group.push(rows[j].id);
            visited.add(rows[j].id);
          }
        }

        if (group.length >= 2) groups.push(group);
      }

      groupCount = groups.length;

      for (const group of groups) {
        const keeper = group[0];
        const toMerge = group.slice(1);

        if (dryRun) {
          details.push(`[DRY RUN] Would merge ${toMerge.length} memories into ${keeper}`);
          merged += toMerge.length;
          continue;
        }

        const keeperRow = db.prepare("SELECT content FROM memories WHERE id = ?").get(keeper) as { content: string } | null;
        if (!keeperRow) continue;

        const mergedIds: string[] = [];
        for (const memId of toMerge) {
          const mergeRow = db.prepare("SELECT content, importance FROM memories WHERE id = ? AND session_id = ?")
            .get(memId, this.sessionId) as { content: string; importance: number } | null;
          if (!mergeRow) continue;

          const mergedContent = `${keeperRow.content}\n[consolidated] ${mergeRow.content}`;
          db.prepare("UPDATE memories SET content = ? WHERE id = ?").run(mergedContent, keeper);
          this.deleteFtsRow(db, memId);
          this.deleteVecRow(db, memId);
          db.prepare("DELETE FROM memories WHERE id = ?").run(memId);
          merged++;
          mergedIds.push(memId);
        }

        const histId = `consolidation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        db.prepare(`
          INSERT INTO consolidation_history (id, keeper_id, merged_ids, original_content, consolidated_content, abstraction_level, source_ids, created_at)
          VALUES (?, ?, ?, ?, ?, 'raw', ?, ?)
        `).run(histId, keeper, JSON.stringify(mergedIds), keeperRow.content, db.prepare("SELECT content FROM memories WHERE id = ?").get(keeper) as { content: string } | null, JSON.stringify([keeper, ...mergedIds]), Date.now());

        details.push(`Merged ${toMerge.length} memories into ${keeper}: "${keeperRow.content.slice(0, 60)}..."`);
      }
    } catch (e) { console.error("[Memory] consolidateMemories error:", e); }

    return { groups: groupCount, merged, details };
  }

  consolidateWithSummary(keeperId: string, summary: string, sourceIds: string[]): { success: boolean; details: string } {
    const db = this.projectDb;
    if (!db) return { success: false, details: "No database available." };
    try {
      const keeperRow = db.prepare("SELECT content FROM memories WHERE id = ? AND session_id = ?")
        .get(keeperId, this.sessionId) as { content: string } | null;
      if (!keeperRow) return { success: false, details: `Keeper memory ${keeperId} not found.` };

      db.prepare("UPDATE memories SET content = ?, abstraction_level = 'consolidated', source_ids = ? WHERE id = ? AND session_id = ?")
        .run(summary, JSON.stringify(sourceIds), keeperId, this.sessionId);
      this.deleteFtsRow(db, keeperId);
      this.insertFtsRow(db, keeperId, this.sessionId, summary);

      const toRemove = sourceIds.filter(id => id !== keeperId);
      for (const id of toRemove) {
        this.deleteFtsRow(db, id);
        this.deleteVecRow(db, id);
        db.prepare("DELETE FROM memories WHERE id = ? AND session_id = ?").run(id, this.sessionId);
      }

      const histId = `consolidation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(`
        INSERT INTO consolidation_history (id, keeper_id, merged_ids, original_content, consolidated_content, abstraction_level, source_ids, created_at)
        VALUES (?, ?, ?, ?, ?, 'llm_summary', ?, ?)
      `).run(histId, keeperId, JSON.stringify(sourceIds), keeperRow.content, summary, JSON.stringify(sourceIds), Date.now());

      return { success: true, details: `Memory ${keeperId} updated with LLM summary. ${toRemove.length} source memories removed.` };
    } catch (e) { console.error("[Memory] consolidateWithSummary error:", e); return { success: false, details: String(e) }; }
  }

  deconsolidateMemory(id: string): { success: boolean; details: string } {
    const db = this.projectDb;
    if (!db) return { success: false, details: "No database available." };
    try {
      const row = db.prepare("SELECT content, source_ids, abstraction_level FROM memories WHERE id = ? AND session_id = ?")
        .get(id, this.sessionId) as { content: string; source_ids: string; abstraction_level: string } | null;
      if (!row) return { success: false, details: `Memory ${id} not found.` };
      if (row.abstraction_level !== 'consolidated' && row.abstraction_level !== 'llm_summary')
        return { success: false, details: `Memory ${id} is not a consolidated memory.` };

      const sourceIds = JSON.parse(row.source_ids ?? "[]") as string[];
      if (sourceIds.length === 0) return { success: false, details: "No source IDs found for de-consolidation." };

      const parts = row.content.split(/\[consolidated\]/);
      if (parts.length < sourceIds.length) return { success: false, details: "Content cannot be split into original parts." };

      db.prepare("UPDATE memories SET abstraction_level = 'raw', source_ids = '[]' WHERE id = ? AND session_id = ?").run(id, this.sessionId);
      this.deleteFtsRow(db, id);
      this.insertFtsRow(db, id, this.sessionId, parts[0]);

      return { success: true, details: `Memory ${id} de-consolidated. Original structure restored.` };
    } catch (e) { console.error("[Memory] deconsolidateMemory error:", e); return { success: false, details: String(e) }; }
  }

  consolidationStats(): { totalConsolidations: number; byLevel: Record<string, number>; spaceSaved: number } {
    const db = this.projectDb;
    if (!db) return { totalConsolidations: 0, byLevel: {}, spaceSaved: 0 };
    try {
      const total = (db.prepare("SELECT COUNT(*) as c FROM consolidation_history").get() as { c: number }).c;
      const byLevel: Record<string, number> = {};
      (db.prepare("SELECT abstraction_level, COUNT(*) as c FROM consolidation_history GROUP BY abstraction_level")
        .all() as { abstraction_level: string; c: number }[]).forEach(r => { byLevel[r.abstraction_level] = r.c; });
      const spaceSaved = (db.prepare("SELECT SUM(json_array_length(merged_ids)) as s FROM consolidation_history").get() as { s: number | null }).s ?? 0;
      return { totalConsolidations: total, byLevel, spaceSaved };
    } catch { return { totalConsolidations: 0, byLevel: {}, spaceSaved: 0 }; }
  }

  // ─────────────────────────────────────────────────────────────────────────────

  // ── Execution Trace Recording (Issue #14 — v1.2.3) ──────────────────────────

  recordToolExecution(toolName: string, success: boolean, durationMs?: number, error?: string): void {
    const db = this.projectDb;
    if (!db) return;
    try {
      const id = `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(`
        INSERT INTO execution_traces (id, session_id, tool_name, success, duration_ms, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, this.sessionId, toolName, success ? 1 : 0, durationMs ?? null, error ?? null, Date.now());
    } catch { /* ignore */ }
  }

  // ── Ablation Framework (Issue #14 — v1.2.3) ─────────────────────────────────

  runAblationTest(memoryIds: string[]): { experimentId: string; results: Array<{ memoryId: string; impact: string; details: string }> } {
    const db = this.projectDb;
    if (!db) return { experimentId: "", results: [] };

    const experimentId = `ablation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const results: Array<{ memoryId: string; impact: string; details: string }> = [];

    try {
      const baselineMetrics = this.computeSessionMetrics();

      for (const memId of memoryIds) {
        const row = db.prepare("SELECT content, type, importance, access_count, memory_strength FROM memories WHERE id = ? AND session_id = ?")
          .get(memId, this.sessionId) as { content: string; type: string; importance: number; access_count: number; memory_strength: number } | null;

        if (!row) {
          results.push({ memoryId: memId, impact: "not_found", details: "Memory not found in current session." });
          continue;
        }

        const importanceScore = row.importance * Math.log(2 + row.access_count) * (row.memory_strength ?? 1.0);
        const relatedTraces = db.prepare("SELECT COUNT(*) as c, AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) as sr FROM execution_traces WHERE session_id = ?")
          .get(this.sessionId) as { c: number; sr: number | null } | null;

        const totalOps = relatedTraces?.c ?? 0;
        const successRate = relatedTraces?.sr ?? 0;

        let impact: string;
        if (importanceScore > 2.0) impact = "high";
        else if (importanceScore > 0.5) impact = "medium";
        else impact = "low";

        results.push({
          memoryId: memId,
          impact,
          details: `importance: ${row.importance.toFixed(2)}, access: ${row.access_count}, strength: ${(row.memory_strength ?? 1.0).toFixed(2)}, composite: ${importanceScore.toFixed(3)}, session_ops: ${totalOps}, session_sr: ${successRate.toFixed(2)}`,
        });

        db.prepare("UPDATE memories SET access_count = 0, memory_strength = 0.1 WHERE id = ?").run(memId);
      }

      const ablationMetrics = this.computeSessionMetrics();

      db.prepare(`
        INSERT INTO ablation_experiments (id, memory_ids, baseline_metrics, ablation_metrics, impact_scores, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(experimentId, JSON.stringify(memoryIds), JSON.stringify(baselineMetrics), JSON.stringify(ablationMetrics), JSON.stringify(results), Date.now());

      for (const memId of memoryIds) {
        const origRow = db.prepare("SELECT importance, access_count, memory_strength FROM memories WHERE id = ? AND session_id = ?")
          .get(memId, this.sessionId) as { importance: number; access_count: number; memory_strength: number } | null;
        if (origRow) {
          db.prepare("UPDATE memories SET access_count = ?, memory_strength = ? WHERE id = ? AND session_id = ?")
            .run(origRow.access_count, origRow.memory_strength, memId, this.sessionId);
        }
      }
    } catch (e) { console.error("[Memory] runAblationTest error:", e); }

    return { experimentId, results };
  }

  private computeSessionMetrics(): { totalMemories: number; avgImportance: number; avgStrength: number; totalAccess: number; toolOps: number; toolSuccessRate: number } {
    const db = this.projectDb;
    if (!db) return { totalMemories: 0, avgImportance: 0, avgStrength: 0, totalAccess: 0, toolOps: 0, toolSuccessRate: 0 };
    try {
      const memStats = db.prepare(
        "SELECT COUNT(*) as c, AVG(importance) as ai, AVG(memory_strength) as as2, SUM(access_count) as ta FROM memories WHERE session_id = ?"
      ).get(this.sessionId) as { c: number; ai: number | null; as2: number | null; ta: number | null } | null;

      const traceStats = db.prepare(
        "SELECT COUNT(*) as c, AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) as sr FROM execution_traces WHERE session_id = ?"
      ).get(this.sessionId) as { c: number; sr: number | null } | null;

      return {
        totalMemories: memStats?.c ?? 0,
        avgImportance: memStats?.ai ?? 0,
        avgStrength: memStats?.as2 ?? 0,
        totalAccess: memStats?.ta ?? 0,
        toolOps: traceStats?.c ?? 0,
        toolSuccessRate: traceStats?.sr ?? 0,
      };
    } catch { return { totalMemories: 0, avgImportance: 0, avgStrength: 0, totalAccess: 0, toolOps: 0, toolSuccessRate: 0 }; }
  }

  getAblationHistory(limit = 10): Array<{ id: string; memoryCount: number; createdAt: number }> {
    const db = this.projectDb;
    if (!db) return [];
    try {
      const rows = db.prepare(
        "SELECT id, memory_ids, created_at FROM ablation_experiments ORDER BY created_at DESC LIMIT ?"
      ).all(limit) as { id: string; memory_ids: string; created_at: number }[];
      return rows.map(r => ({ id: r.id, memoryCount: (JSON.parse(r.memory_ids) as string[]).length, createdAt: r.created_at }));
    } catch { return []; }
  }

  // ── Adaptive Forgetting (Issue #16 — v1.2.5) ────────────────────────────────

  getDecayModelForMemory(memoryId: string): string {
    const db = this.projectDb;
    if (!db) return DECAY_MODEL;
    try {
      const row = db.prepare("SELECT type, decay_model FROM memories WHERE id = ? AND session_id = ?")
        .get(memoryId, this.sessionId) as { type: string; decay_model: string | null } | null;
      if (row?.decay_model) return row.decay_model;
      if (row?.type) return getDefaultDecayModelForType(row.type as MemoryType);
    } catch { /* ignore */ }
    return DECAY_MODEL;
  }

  computeDecayScoreWithModel(memoryId: string, importance: number, lastAccessedAt: number, accessCount: number, memoryStrength: number, confidence: number): number {
    const model = this.getDecayModelForMemory(memoryId);
    return computeDecayScore(importance, lastAccessedAt, accessCount, memoryStrength, confidence, model);
  }

  updateForgettingAnalytics(memoryId: string, retrievalSuccess: boolean): void {
    const db = this.projectDb;
    if (!db || !ADAPTIVE_DECAY_ENABLED) return;
    try {
      const existing = db.prepare("SELECT * FROM forgetting_analytics WHERE memory_id = ?")
        .get(memoryId) as { id: string; retrieval_count: number; retrieval_success_rate: number; decay_rate: number; adjusted_decay_rate: number } | null;

      if (existing) {
        const newCount = existing.retrieval_count + 1;
        const newRate = ((existing.retrieval_success_rate * existing.retrieval_count) + (retrievalSuccess ? 1 : 0)) / newCount;
        const adjustedRate = existing.decay_rate * (1 - 0.05 * (newRate - 0.5));
        db.prepare("UPDATE forgetting_analytics SET retrieval_count = ?, retrieval_success_rate = ?, adjusted_decay_rate = ?, updated_at = ? WHERE id = ?")
          .run(newCount, newRate, adjustedRate, Date.now(), existing.id);
      } else {
        const id = `forgetting_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const model = this.getDecayModelForMemory(memoryId);
        db.prepare(`
          INSERT INTO forgetting_analytics (id, memory_id, decay_model, decay_rate, retrieval_count, retrieval_success_rate, adjusted_decay_rate, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
        `).run(id, memoryId, model, DECAY_LAMBDA, retrievalSuccess ? 1 : 0, DECAY_LAMBDA, Date.now(), Date.now());
      }
    } catch { /* ignore */ }
  }

  forgettingReport(): Array<{ memoryId: string; model: string; decayRate: number; retrievalCount: number; successRate: number; adjustedRate: number }> {
    const db = this.projectDb;
    if (!db) return [];
    try {
      const rows = db.prepare(
        "SELECT memory_id, decay_model, decay_rate, retrieval_count, retrieval_success_rate, adjusted_decay_rate FROM forgetting_analytics ORDER BY updated_at DESC LIMIT 50"
      ).all() as { memory_id: string; decay_model: string; decay_rate: number; retrieval_count: number; retrieval_success_rate: number; adjusted_decay_rate: number }[];
      return rows.map(r => ({ memoryId: r.memory_id, model: r.decay_model, decayRate: r.decay_rate, retrievalCount: r.retrieval_count, successRate: r.retrieval_success_rate, adjustedRate: r.adjusted_decay_rate }));
    } catch { return []; }
  }

  setMemoryDecayModel(memoryId: string, model: string): { success: boolean; details: string } {
    const db = this.projectDb;
    if (!db) return { success: false, details: "No database available." };
    const validModels = ["exponential", "power_law", "step_function", "forgetting_curve"];
    if (!validModels.includes(model)) return { success: false, details: `Invalid model. Must be one of: ${validModels.join(", ")}` };
    try {
      const result = db.prepare("UPDATE memories SET decay_model = ? WHERE id = ? AND session_id = ?")
        .run(model, memoryId, this.sessionId);
      return result.changes > 0
        ? { success: true, details: `Memory ${memoryId} decay model set to ${model}.` }
        : { success: false, details: `Memory ${memoryId} not found.` };
    } catch (e) { console.error("[Memory] setMemoryDecayModel error:", e); return { success: false, details: String(e) }; }
  }

  // ── Knowledge Graph (Issue #15 — v1.2.4) ────────────────────────────────────

  private readonly VALID_RELATIONS = ["supports", "contradicts", "elaborates", "depends_on", "supersedes", "related_to"] as const;

  addRelationship(sourceId: string, targetId: string, relationType: string, confidence = 0.8, derivedFrom?: string): { success: boolean; details: string } {
    const db = this.projectDb;
    if (!db) return { success: false, details: "No database available." };
    if (!this.VALID_RELATIONS.includes(relationType as typeof this.VALID_RELATIONS[number]))
      return { success: false, details: `Invalid relation type. Must be one of: ${this.VALID_RELATIONS.join(", ")}` };
    try {
      const id = `rel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(`
        INSERT OR REPLACE INTO memory_relationships (id, source_id, target_id, relation_type, confidence, derived_from, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, sourceId, targetId, relationType, confidence, derivedFrom ?? null, Date.now());
      return { success: true, details: `Relationship added: ${sourceId} -[${relationType}]-> ${targetId}` };
    } catch (e) { console.error("[Memory] addRelationship error:", e); return { success: false, details: String(e) }; }
  }

  queryRelationships(memoryId: string, direction: "outgoing" | "incoming" | "both" = "outgoing", relationType?: string): Array<{ sourceId: string; targetId: string; type: string; confidence: number }> {
    const db = this.projectDb;
    if (!db) return [];
    try {
      let sql = "SELECT source_id, target_id, relation_type, confidence FROM memory_relationships WHERE ";
      const params: (string | number)[] = [];
      if (direction === "outgoing") { sql += "source_id = ?"; params.push(memoryId); }
      else if (direction === "incoming") { sql += "target_id = ?"; params.push(memoryId); }
      else { sql += "(source_id = ? OR target_id = ?)"; params.push(memoryId, memoryId); }
      if (relationType) { sql += " AND relation_type = ?"; params.push(relationType); }
      sql += " ORDER BY confidence DESC";
      const rows = db.prepare(sql).all(...params) as { source_id: string; target_id: string; relation_type: string; confidence: number }[];
      return rows.map(r => ({ sourceId: r.source_id, targetId: r.target_id, type: r.relation_type, confidence: r.confidence }));
    } catch { return []; }
  }

  graphTraversal(startId: string, maxDepth = 3, strategy: "bfs" | "dfs" = "bfs"): Array<{ id: string; depth: number; path: string[]; relations: string[] }> {
    const db = this.projectDb;
    if (!db) return [];
    const results: Array<{ id: string; depth: number; path: string[]; relations: string[] }> = [];
    const visited = new Set<string>();
    visited.add(startId);

    const queue: Array<{ id: string; depth: number; path: string[]; relations: string[] }> = [{ id: startId, depth: 0, path: [startId], relations: [] }];

    while (queue.length > 0) {
      const current = strategy === "bfs" ? queue.shift()! : queue.pop()!;
      if (current.depth >= maxDepth) continue;

      const rels = this.queryRelationships(current.id, "outgoing");
      for (const rel of rels) {
        if (visited.has(rel.targetId)) continue;
        visited.add(rel.targetId);
        const newPath = [...current.path, rel.targetId];
        const newRels = [...current.relations, `${rel.type}`];
        results.push({ id: rel.targetId, depth: current.depth + 1, path: newPath, relations: newRels });
        queue.push({ id: rel.targetId, depth: current.depth + 1, path: newPath, relations: newRels });
      }
    }

    return results.sort((a, b) => a.depth - b.depth);
  }

  deleteRelationship(sourceId: string, targetId: string, relationType: string): { success: boolean; details: string } {
    const db = this.projectDb;
    if (!db) return { success: false, details: "No database available." };
    try {
      const result = db.prepare(
        "DELETE FROM memory_relationships WHERE source_id = ? AND target_id = ? AND relation_type = ?"
      ).run(sourceId, targetId, relationType);
      return result.changes > 0
        ? { success: true, details: `Relationship removed: ${sourceId} -[${relationType}]-> ${targetId}` }
        : { success: false, details: "Relationship not found." };
    } catch (e) { console.error("[Memory] deleteRelationship error:", e); return { success: false, details: String(e) }; }
  }

  exportGraph(format: "mermaid" | "graphviz" = "mermaid"): string {
    const db = this.projectDb;
    if (!db) return "";
    try {
      const rows = db.prepare(
        "SELECT source_id, target_id, relation_type, confidence FROM memory_relationships ORDER BY confidence DESC"
      ).all() as { source_id: string; target_id: string; relation_type: string; confidence: number }[];

      if (format === "mermaid") {
        const lines = ["graph TD"];
        for (const r of rows) {
          const safeSrc = r.source_id.replace(/[^a-zA-Z0-9]/g, "_");
          const safeTgt = r.target_id.replace(/[^a-zA-Z0-9]/g, "_");
          lines.push(`  ${safeSrc}["${r.source_id.slice(0, 20)}"] -- "${r.relation_type}" --> ${safeTgt}["${r.target_id.slice(0, 20)}"]`);
        }
        return lines.join("\n");
      }

      const lines = ["digraph MemoryGraph {", '  rankdir=LR;', '  node [shape=box, style=filled, fillcolor="#e8f4f8"];'];
      for (const r of rows) {
        const safeSrc = r.source_id.replace(/[^a-zA-Z0-9]/g, "_");
        const safeTgt = r.target_id.replace(/[^a-zA-Z0-9]/g, "_");
        lines.push(`  ${safeSrc} -> ${safeTgt} [label="${r.relation_type} (${r.confidence.toFixed(2)})"];`);
      }
      lines.push("}");
      return lines.join("\n");
    } catch { return ""; }
  }

  // ─────────────────────────────────────────────────────────────────────────────

  close(): void {
    this.projectDb?.close();
    this.globalDb?.close();
    this.projectDb = null;
    this.globalDb  = null;
  }
}

const MemoryPlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const { directory } = input;
  const config = (input as unknown as { config?: Record<string, unknown> }).config ?? {};
  const reflectionEnabled = config.memory_reflection !== false;

  const projectDbPath = join(homedir(), ".local", "share", "opencode", "memory", "memory.db");
  const globalDbPath  = join(homedir(), ".config", "opencode", "memory", "global.db");

  const store = new MemoryStore(projectDbPath, globalDbPath);
  store.initialize();
  console.log(`[Memory] v${PACKAGE_VERSION} (schema v${SCHEMA_VERSION}) initialized | project: ${projectDbPath} | global: ${globalDbPath}`);

  const statusManager = new OwlStatusManager();
  let cachedStatus: TUIStatusResponse | null = null;

  const versionChecker = new VersionChecker(PACKAGE_VERSION);
  let updateNotification: string | null = null;
  let updateShownInPrompt = false;

  setImmediate(async () => {
    try {
      const updateInfo = await versionChecker.check();
      updateNotification = versionChecker.getNotification(updateInfo);
      if (updateNotification) console.log(`[Memory] ${updateNotification}`);
    } catch { /* ignore */ }

    try {
      const archiveResult = store.archiveOldMemories();
      const expResult     = store.cleanupExperiences();
      const total = archiveResult.projectArchived + archiveResult.globalArchived + expResult.projectArchived;
      if (total > 0) console.log(`[Memory] Auto-archived ${total} memories on startup (decay:${archiveResult.projectArchived + archiveResult.globalArchived} exp:${expResult.projectArchived})`);
    } catch (e) { console.error("[Memory] Auto-archival error:", e); }
  });

  const getSessionId = (h: { sessionID?: string }): string =>
    h?.sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`;

  const sid = (sessionID?: string) =>
    sessionID || `project_${Buffer.from(directory).toString("base64").slice(0, 16)}`;

  return {
    "experimental.chat.system.transform": async (h, output) => {
      store.setSessionId(getSessionId(h));
      const ctx         = store.getSessionContext();
      const recentConvs = store.getRecentConversations(8);
      const contextQuery = store.buildContextQuery(recentConvs, ctx?.currentTask, ctx?.recentTools);

      let memories: MemoryEntry[];
      if (contextQuery.trim()) {
        memories = store.queryMemoriesHybrid(contextQuery, { limit: 10, minImportance: 0.3 });
        if (memories.length < 3) {
          const fallback = store.queryMemories({ limit: 10 - memories.length, minImportance: 0.4 });
          const existing = new Set(memories.map(m => m.id));
          memories.push(...fallback.filter(m => !existing.has(m.id)));
        }
      } else {
        memories = store.queryMemories({ limit: 10, minImportance: 0.4 });
      }

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
      if (updateNotification && !updateShownInPrompt) {
        output.system.push(`\n<update_available>\n${updateNotification}\n</update_available>`);
        updateShownInPrompt = true;
      }
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
      store.recordToolExecution(toolName, !(h as { error?: unknown }).error);
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return;
      if (!reflectionEnabled) return;
      store.setSessionId(event.properties.sessionID);
      const existing = store.getLatestReflection();
      if (existing) {
        const meta = existing.metadata as Record<string, unknown>;
        const age = Date.now() - ((meta.generatedAt as number) ?? 0);
        if (age < REFLECTION_THROTTLE_MS) return;
      }
      const reflection = store.generateReflection();
      if (reflection) {
        console.log(`[Memory] Auto-reflection stored for session ${event.properties.sessionID}`);
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
        description: "Add a memory. Default layer='project'. Use layer='global' for cross-project preferences. Sensitive content auto-redacted in global layer. Auto-detects conflicts with existing memories.",
        args: {
          type:       tool.schema.enum(["fact","preference","skill"]),
          content:    tool.schema.string().describe("Max 10KB"),
          importance: tool.schema.number().min(0).max(1).optional(),
          layer:      tool.schema.enum(["project","global"]).optional(),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const layer = (args.layer as MemoryLayer) ?? "project";
          const conflicts = store.detectConflicts(args.content, args.type as MemoryType, layer);
          const conflictWarning = conflicts.length > 0
            ? `\n⚠️ ${conflicts.length} possible conflict(s) detected:\n` + conflicts.map(c => `  - [${c.reason}] ${c.content}`).join("\n")
            : "";
          const id = store.addMemory({ type: args.type, content: args.content,
            metadata: { addedBy: "agent" }, importance: args.importance ?? 0.5 }, layer);
          return id ? `Memory stored: ${id} (layer: ${layer})${conflictWarning}` : `Failed to store memory.${conflictWarning}`;
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

      memory_query_context: tool({
        description: "Retrieve memories relevant to current context (active task + recent tools + recent conversation). Use this to surface what the agent should know right now.",
        args: {
          limit: tool.schema.number().optional(),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const ctx = store.getSessionContext();
          const recentConvs = store.getRecentConversations(8);
          const contextQuery = store.buildContextQuery(recentConvs, ctx?.currentTask, ctx?.recentTools);
          if (!contextQuery.trim()) {
            return "No context signals. Set a task with memory_set_task or start a conversation first.";
          }
          const mems = store.queryMemoriesHybrid(contextQuery, { limit: args.limit ?? 10 });
          if (mems.length === 0) {
            return `Context query: "${contextQuery}"\nNo relevant memories found.`;
          }
          return `Context query: "${contextQuery}"\nFound ${mems.length} context-relevant memories:\n` +
            mems.map(m => `- [${m.type}${m.layer === "global" ? "/global" : ""}] (id: ${m.id}) ${m.content} (score: ${m.decayScore?.toFixed(3)})`).join("\n");
        },
      }),

      memory_archive: tool({
        description: "Manually trigger archival: moves memories with decayScore < 0.05 + access < 2 + age > 30d to archived_memories, and archives experience-type memories older than 7 days. Returns counts.",
        args: {},
        async execute(_, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const archiveResult = store.archiveOldMemories();
          const expResult     = store.cleanupExperiences();
          const total = archiveResult.projectArchived + archiveResult.globalArchived + expResult.projectArchived;
          return [
            `Archival complete: ${total} memories archived`,
            `- Low-score (project): ${archiveResult.projectArchived}`,
            `- Low-score (global):  ${archiveResult.globalArchived}`,
            `- Old experiences:     ${expResult.projectArchived}`,
          ].join("\n");
        },
      }),

      memory_list_archived: tool({
        description: "List archived memories. Use memory_restore to move one back to active.",
        args: {
          limit: tool.schema.number().optional(),
          layer: tool.schema.enum(["project","global"]).optional(),
          type:  tool.schema.enum(["fact","experience","preference","skill"]).optional(),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const archived = store.listArchivedMemories({
            limit: args.limit ?? 20,
            layer: args.layer as MemoryLayer | undefined,
            type:  args.type,
          });
          if (archived.length === 0) return "No archived memories found.";
          return `${archived.length} archived memories:\n` +
            archived.map(m => {
              const preview     = m.content.slice(0, 80) + (m.content.length > 80 ? "…" : "");
              const archivedDate = new Date(m.archivedAt).toISOString().split("T")[0];
              return `[${m.type}/${m.layer}] ${m.id}  archived:${archivedDate}  reason:${m.archiveReason ?? "unknown"}  "${preview}"`;
            }).join("\n");
        },
      }),

      memory_restore: tool({
        description: "Restore an archived memory back to active memories.",
        args: { id: tool.schema.string() },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          return store.restoreMemory(args.id)
            ? `Memory ${args.id} restored to active memories.`
            : `Memory ${args.id} not found in archive.`;
        },
      }),

      memory_check_conflicts: tool({
        description: "Scan memories for potential conflicts using Jaccard similarity, negation pattern analysis, and semantic embedding comparison. Returns ranked conflict list.",
        args: {
          type:  tool.schema.enum(["fact","preference","skill"]).optional(),
          layer: tool.schema.enum(["project","global"]).optional(),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const layer = (args.layer as MemoryLayer) ?? "project";
          const checkType = (args.type as MemoryType) ?? "fact";
          const db = layer === "global" ? (store as unknown as { globalDb: unknown }).globalDb : (store as unknown as { projectDb: unknown }).projectDb;
          if (!db) return "No database available.";

          const conflicts: Array<{ id: string; content: string; reason: string; score: number }> = [];
          try {
            const rows = (db as { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } }).prepare(
              "SELECT id, content, type, embedding FROM memories WHERE session_id = ? AND type = ?"
            ).all(layer === "global" ? "__global__" : store.getSessionId(), checkType) as { id: string; content: string; type: string; embedding: Buffer | null }[];

            for (let i = 0; i < rows.length; i++) {
              const others = rows.slice(i + 1);
              const wordsA = new Set(rows[i].content.toLowerCase().split(/\s+/).filter(w => w.length > 3));
              for (const other of others) {
                const wordsB = new Set(other.content.toLowerCase().split(/\s+/).filter(w => w.length > 3));
                if (wordsA.size === 0 || wordsB.size === 0) continue;
                const overlap = [...wordsA].filter(w => wordsB.has(w)).length;
                const jaccard = overlap / (wordsA.size + wordsB.size - overlap);
                if (jaccard >= CONSOLIDATION_SIMILARITY) {
                  conflicts.push({ id: other.id, content: other.content.slice(0, 120), reason: `high_similarity(jaccard=${jaccard.toFixed(2)})`, score: jaccard });
                }

                const negationPatterns = [
                  /\b(not|never|don't|doesn't|isn't|aren't|wasn't|weren't|no |without|disabled)\b/gi,
                  /\b(use|uses|using|prefer|avoid|disable|enable|skip)\b/gi,
                ];
                const aHasNegation = negationPatterns.some(p => p.test(rows[i].content));
                const bHasNegation = negationPatterns.some(p => p.test(other.content));
                if (aHasNegation !== bHasNegation) {
                  const sharedTerms = [...wordsA].filter(w => wordsB.has(w));
                  if (sharedTerms.length >= 3) {
                    conflicts.push({ id: other.id, content: other.content.slice(0, 120), reason: `possible_contradiction(shared=${sharedTerms.slice(0, 3).join(",")})`, score: sharedTerms.length / Math.max(wordsA.size, wordsB.size) });
                  }
                }
              }
            }
          } catch { /* ignore */ }

          if (conflicts.length === 0) return `No conflicts found among ${checkType} memories.`;
          const sorted = conflicts.sort((a, b) => b.score - a.score);
          return `Found ${sorted.length} potential conflict(s):\n` +
            sorted.map(c => `  - [${c.reason}] (score: ${c.score.toFixed(2)}) ${c.content}`).join("\n");
        },
      }),

      memory_resolve_conflict: tool({
        description: "Resolve a detected conflict between two memories. Strategies: 'time' (keep newest), 'confidence' (keep highest confidence), 'access' (keep most accessed), 'manual' (user decides).",
        args: {
          source_id: tool.schema.string().describe("First memory ID in conflict"),
          target_id: tool.schema.string().describe("Second memory ID in conflict"),
          strategy:  tool.schema.enum(["time","confidence","access","manual"]).optional().describe("Resolution strategy (default: confidence)"),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const result = store.resolveConflict(args.source_id, args.target_id, (args.strategy as "time" | "confidence" | "access" | "manual") ?? "confidence");
          return result.success ? `✅ ${result.details}` : `❌ ${result.details}`;
        },
      }),

      memory_conflict_history: tool({
        description: "View history of detected and resolved conflicts. Shows which memories conflicted and how they were resolved.",
        args: {
          limit: tool.schema.number().optional(),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const history = store.getConflictHistory(args.limit ?? 20);
          if (history.length === 0) return "No conflict history recorded.";
          return `Conflict History (${history.length} events):\n` +
            history.map(h => `  - ${h.type}: ${h.sourceId} ↔ ${h.targetId} | ${h.resolution ?? "unresolved"}${h.resolvedAt ? ` (${new Date(h.resolvedAt).toISOString().split("T")[0]})` : ""}`).join("\n");
        },
      }),

      memory_consolidate: tool({
        description: "Merge similar/overlapping memories to reduce redundancy. Supports aggressive/moderate/conservative policies. Returns group count and merge count.",
        args: {
          dry_run: tool.schema.boolean().optional().describe("Preview merges without executing"),
          policy:  tool.schema.enum(["aggressive","moderate","conservative"]).optional().describe("Similarity threshold policy (default: moderate)"),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const result = store.consolidateMemories(args.dry_run ?? false, (args.policy as "aggressive" | "moderate" | "conservative") ?? "moderate");
          if (result.groups === 0) return "No similar memories found to consolidate.";
          return [
            `Consolidation complete: ${result.groups} group(s), ${result.merged} memories merged.`,
            ...(args.dry_run ? ["(dry run — no changes made)"] : []),
            ...result.details.slice(0, 10),
          ].join("\n");
        },
      }),

      memory_consolidate_with_summary: tool({
        description: "Replace a group of similar memories with an LLM-generated summary. The agent should generate the summary externally and pass it here. Removes source memories after consolidation.",
        args: {
          keeper_id:  tool.schema.string().describe("Memory ID to keep as the consolidated entry"),
          summary:    tool.schema.string().describe("LLM-generated summary of the group"),
          source_ids: tool.schema.array(tool.schema.string()).describe("All memory IDs in the group (including keeper_id)"),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const result = store.consolidateWithSummary(args.keeper_id, args.summary, args.source_ids);
          return result.success ? `✅ ${result.details}` : `❌ ${result.details}`;
        },
      }),

      memory_deconsolidate: tool({
        description: "Reverse a consolidation, restoring the original memory structure.",
        args: { id: tool.schema.string().describe("Consolidated memory ID to restore") },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const result = store.deconsolidateMemory(args.id);
          return result.success ? `✅ ${result.details}` : `❌ ${result.details}`;
        },
      }),

      memory_consolidation_stats: tool({
        description: "View consolidation history and statistics. Shows total consolidations, by abstraction level, and space saved.",
        args: {},
        async execute(_, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const stats = store.consolidationStats();
          return [
            `Consolidation Statistics:`,
            `- Total consolidations: ${stats.totalConsolidations}`,
            `- By level: ${JSON.stringify(stats.byLevel)}`,
            `- Memories saved: ${stats.spaceSaved}`,
          ].join("\n");
        },
      }),

      memory_ablation_test: tool({
        description: "Run an ablation experiment: measure the causal impact of specific memories on agent performance. Temporarily disables memories and computes impact scores based on importance, access patterns, and session metrics.",
        args: {
          memory_ids: tool.schema.array(tool.schema.string()).describe("List of memory IDs to ablate"),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const result = store.runAblationTest(args.memory_ids);
          if (!result.experimentId) return "Ablation experiment failed.";
          return [
            `Ablation Experiment: ${result.experimentId}`,
            `Tested ${result.results.length} memories:`,
            ...result.results.map(r => `  - ${r.memoryId}: [${r.impact.toUpperCase()}] ${r.details}`),
          ].join("\n");
        },
      }),

      memory_ablation_report: tool({
        description: "Generate a report from past ablation experiments. Shows which memories had high/medium/low causal impact on agent performance.",
        args: {
          limit: tool.schema.number().optional(),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const history = store.getAblationHistory(args.limit ?? 10);
          if (history.length === 0) return "No ablation experiments found.";
          return [
            `Ablation History (${history.length} experiments):`,
            ...history.map(h => `  - ${h.id}: ${h.memoryCount} memories tested (${new Date(h.createdAt).toISOString().split("T")[0]})`),
          ].join("\n");
        },
      }),

      memory_session_metrics: tool({
        description: "Show current session metrics: memory count, average importance/strength, tool operation count and success rate.",
        args: {},
        async execute(_, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const m = (store as unknown as { computeSessionMetrics: () => Record<string, number> }).computeSessionMetrics();
          return [
            `Session Metrics:`,
            `- Memories: ${m.totalMemories}`,
            `- Avg importance: ${m.avgImportance.toFixed(3)}`,
            `- Avg strength: ${m.avgStrength.toFixed(3)}`,
            `- Total access: ${m.totalAccess}`,
            `- Tool operations: ${m.toolOps}`,
            `- Tool success rate: ${(m.toolSuccessRate * 100).toFixed(1)}%`,
          ].join("\n");
        },
      }),

      memory_add_relationship: tool({
        description: "Add a relationship between two memories. Types: supports, contradicts, elaborates, depends_on, supersedes, related_to.",
        args: {
          source_id:     tool.schema.string(),
          target_id:     tool.schema.string(),
          relation_type: tool.schema.enum(["supports","contradicts","elaborates","depends_on","supersedes","related_to"]),
          confidence:    tool.schema.number().min(0).max(1).optional(),
          derived_from:  tool.schema.string().optional().describe("How this relationship was derived"),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const result = store.addRelationship(args.source_id, args.target_id, args.relation_type, args.confidence, args.derived_from);
          return result.success ? `✅ ${result.details}` : `❌ ${result.details}`;
        },
      }),

      memory_relationships: tool({
        description: "Query relationships for a specific memory. Shows incoming, outgoing, or both.",
        args: {
          memory_id:     tool.schema.string(),
          direction:     tool.schema.enum(["outgoing","incoming","both"]).optional().describe("Default: outgoing"),
          relation_type: tool.schema.enum(["supports","contradicts","elaborates","depends_on","supersedes","related_to"]).optional(),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const rels = store.queryRelationships(args.memory_id, (args.direction as "outgoing" | "incoming" | "both") ?? "outgoing", args.relation_type);
          if (rels.length === 0) return `No relationships found for ${args.memory_id}.`;
          return `Relationships for ${args.memory_id}:\n` +
            rels.map(r => `  ${r.sourceId} -[${r.type} (${r.confidence.toFixed(2)})]-> ${r.targetId}`).join("\n");
        },
      }),

      memory_query_graph: tool({
        description: "Traverse the memory relationship graph from a starting point. Supports BFS and DFS strategies.",
        args: {
          start_id:  tool.schema.string().describe("Starting memory ID"),
          max_depth: tool.schema.number().min(1).max(10).optional().describe("Max traversal depth (default: 3)"),
          strategy:  tool.schema.enum(["bfs","dfs"]).optional().describe("Traversal strategy (default: bfs)"),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const nodes = store.graphTraversal(args.start_id, args.max_depth ?? 3, (args.strategy as "bfs" | "dfs") ?? "bfs");
          if (nodes.length === 0) return `No connected memories found from ${args.start_id}.`;
          return `Graph traversal from ${args.start_id} (${nodes.length} nodes):\n` +
            nodes.map(n => `  [depth ${n.depth}] ${n.id} via ${n.relations.join(" → ")}`).join("\n");
        },
      }),

      memory_delete_relationship: tool({
        description: "Remove a relationship between two memories.",
        args: {
          source_id:     tool.schema.string(),
          target_id:     tool.schema.string(),
          relation_type: tool.schema.enum(["supports","contradicts","elaborates","depends_on","supersedes","related_to"]),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const result = store.deleteRelationship(args.source_id, args.target_id, args.relation_type);
          return result.success ? `✅ ${result.details}` : `❌ ${result.details}`;
        },
      }),

      memory_graph_export: tool({
        description: "Export the memory relationship graph as Mermaid or Graphviz format for visualization.",
        args: {
          format: tool.schema.enum(["mermaid","graphviz"]).optional().describe("Export format (default: mermaid)"),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const graph = store.exportGraph((args.format as "mermaid" | "graphviz") ?? "mermaid");
          if (!graph) return "No relationships found to export.";
          return graph;
        },
      }),

      memory_forgetting_report: tool({
        description: "View forgetting analytics for all tracked memories. Shows decay model, retrieval success rate, and adjusted decay rates.",
        args: {},
        async execute(_, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const report = store.forgettingReport();
          if (report.length === 0) return "No forgetting analytics data. Enable with MEMORY_ADAPTIVE_DECAY=true.";
          return `Forgetting Report (${report.length} memories):\n` +
            report.map(r => `  - ${r.memoryId}: model=${r.model}, rate=${r.decayRate.toFixed(3)}, retrievals=${r.retrievalCount}, success=${(r.successRate * 100).toFixed(0)}%, adjusted=${r.adjustedRate.toFixed(3)}`).join("\n");
        },
      }),

      memory_set_decay_model: tool({
        description: "Set the decay model for a specific memory. Models: exponential, power_law, step_function, forgetting_curve.",
        args: {
          memory_id: tool.schema.string(),
          model:     tool.schema.enum(["exponential","power_law","step_function","forgetting_curve"]),
        },
        async execute(args, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const result = store.setMemoryDecayModel(args.memory_id, args.model);
          return result.success ? `✅ ${result.details}` : `❌ ${result.details}`;
        },
      }),

      memory_get_reflection: tool({
        description: "Retrieve the latest auto-generated session reflection — a rule-based summary of tasks attempted, outcomes, lessons learned, tool usage patterns, and activity stats. Auto-generated on session.idle when memory_reflection is enabled.",
        args: {},
        async execute(_, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const mem = store.getLatestReflection();
          if (!mem) return "No auto-reflection found. Reflection is stored the first time the session becomes idle (or call memory_get_reflection after activity).";
          const meta = mem.metadata as Record<string, unknown>;
          const generatedAt = meta.generatedAt
            ? new Date(meta.generatedAt as number).toISOString()
            : "unknown";
          return `Latest auto-reflection (generated: ${generatedAt}, importance: ${mem.importance.toFixed(2)}):\n\n${mem.content}`;
        },
      }),

      memory_version: tool({
        description: "Show current plugin version, schema version, and update status.",
        args: {},
        async execute(_, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const info = await versionChecker.check();
          const lines = [
            `Package:  v${info.currentVersion}`,
            `Schema:   v${SCHEMA_VERSION}`,
            `Latest:   v${info.latestVersion}`,
            info.updateAvailable
              ? `Update available: ${info.releaseType.toUpperCase()} (${info.releaseUrl})`
              : "Up to date.",
          ];
          return lines.join("\n");
        },
      }),

      memory_check_update: tool({
        description: "Manually check for available updates from GitHub releases.",
        args: {},
        async execute(_, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const info = await versionChecker.check();
          if (!info.updateAvailable) return `Already up to date (v${info.currentVersion}).`;
          const typeLabel = info.releaseType.toUpperCase();
          const changelog = info.releaseNotes
            .split("\n")
            .filter(l => l.trim().startsWith("-"))
            .slice(0, 8)
            .join("\n");
          return [
            `Update available: v${info.currentVersion} → v${info.latestVersion} (${typeLabel})`,
            changelog ? `\nChangelog:\n${changelog}` : "",
            `Release: ${info.releaseUrl}`,
            `Run memory_update to install.`,
          ].filter(Boolean).join("\n");
        },
      }),

      memory_update_plugin: tool({
        description: "Download and install the latest plugin version. Backs up current files before updating. Requires git and bun. Prompts user to restart OpenCode after completion.",
        args: {},
        async execute(_, { sessionID }) {
          store.setSessionId(sid(sessionID));
          const info = await versionChecker.check();
          if (!info.updateAvailable) return `Already up to date (v${info.currentVersion}). Nothing to update.`;

          const pluginDir = join(homedir(), ".config", "opencode", "plugins", "memory-system");
          const backupDir = join(homedir(), ".local", "share", "opencode", "memory", "backup");
          const tmpDir = `/tmp/opencode-owl-update-${Date.now()}`;

          try {
            const backupTs = new Date().toISOString().replace(/[:.]/g, "-");
            const backupPath = `${backupDir}/${backupTs}`;
            if (existsSync(pluginDir)) {
              mkdirSync(backupPath, { recursive: true });
              copyFileSync(join(pluginDir, "index.js"), join(backupPath, "index.js"));
              copyFileSync(join(pluginDir, "package.json"), join(backupPath, "package.json"));
            }

            await execAsync(`git clone --depth 1 --branch v${info.latestVersion} https://github.com/DevSecOpsLab-CSIE-NPU/opencode-owl.git ${tmpDir}`);
            await execAsync(`cd ${tmpDir} && bun install && bun run build`);

            mkdirSync(pluginDir, { recursive: true });
            await execAsync(`cp -r ${tmpDir}/dist/* ${pluginDir}/`);
            await execAsync(`cp ${tmpDir}/package.json ${pluginDir}/`);
            await execAsync(`rm -rf ${tmpDir}`);

            return [
              `Updated to v${info.latestVersion}!`,
              `Backup saved to: ${backupPath}`,
              ``,
              `Restart OpenCode to activate the new version.`,
            ].join("\n");
          } catch (e: unknown) {
            const errMsg = e instanceof Error ? e.message : String(e);
            await execAsync(`rm -rf ${tmpDir}`).catch(() => {});
            return [
              `Update failed: ${errMsg}`,
              `Your current version (v${info.currentVersion}) is unchanged.`,
              `Backup available at: ${backupDir}/`,
              `Try manual update: curl -fsSL https://raw.githubusercontent.com/DevSecOpsLab-CSIE-NPU/opencode-owl/main/update.sh | bash`,
            ].join("\n");
          }
        },
      }),

      "owl:status": tool({
        description: "Get OpenCode-Owl memory system status including hit rate and MCP server availability.",
        args: {},
        async execute(_, { sessionID }) {
          store.setSessionId(sid(sessionID));
          if (!cachedStatus) {
            cachedStatus = await statusManager.getStatus();
          }

          const status = cachedStatus ?? (await statusManager.getStatus());
          if (status) {
            cachedStatus = status;
            return statusManager.formatStatus(status);
          }
          return "Error: Failed to fetch memory status. Check if MCP server is running on port 3100.";
        },
      }),
    },
  };
};

export default MemoryPlugin;
