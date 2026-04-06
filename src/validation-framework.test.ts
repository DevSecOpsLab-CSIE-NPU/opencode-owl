import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ValidationFramework } from "./validation-framework";

describe("ValidationFramework", () => {
  let db: Database;
  let framework: ValidationFramework;

  beforeEach(() => {
    db = new Database(":memory:");
    framework = new ValidationFramework(db);

    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        type TEXT NOT NULL, content TEXT NOT NULL,
        metadata TEXT DEFAULT '{}', importance REAL DEFAULT 0.5,
        access_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE memory_access_log (
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
  });

  afterEach(() => {
    db.close();
  });

  it("should calculate Layer 1 metrics with no data", async () => {
    const metrics = await framework.getLayer1Metrics(7);
    expect(metrics.hitRate).toBe(0);
    expect(metrics.totalQueries).toBe(0);
    expect(metrics.hits).toBe(0);
  });

  it("should calculate Layer 1 metrics with sample data", async () => {
    const now = Date.now();
    const sessionId = "test_session";

    const addMemory = db.prepare(
      "INSERT INTO memories (id, session_id, type, content, importance, created_at, updated_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    addMemory.run("mem_1", sessionId, "fact", "Test memory 1", 0.9, now, now, now);
    addMemory.run("mem_2", sessionId, "fact", "Test memory 2", 0.8, now, now, now);

    const addLog = db.prepare(
      "INSERT INTO memory_access_log (memory_id, session_id, access_type, query_text, result_rank, relevance_score, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );

    addLog.run("mem_1", sessionId, "query_hit", "search 1", 1, 0.95, now);
    addLog.run("mem_2", sessionId, "query_hit", "search 2", 2, 0.85, now);
    addLog.run(null, sessionId, "query_miss", "search 3", null, null, now);
    addLog.run("mem_1", sessionId, "partial_hit", "search 4", 5, 0.7, now);

    const metrics = await framework.getLayer1Metrics(1);

    expect(metrics.totalQueries).toBe(4);
    expect(metrics.hits).toBe(2);
    expect(metrics.partialHits).toBe(1);
    expect(metrics.misses).toBe(1);
    expect(metrics.hitRate).toBe(50);
  });

  it("should calculate Layer 1 hit distribution", async () => {
    const now = Date.now();
    const sessionId = "test_session";

    const addMemory = db.prepare(
      "INSERT INTO memories (id, session_id, type, content, importance, created_at, updated_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    addMemory.run("mem_1", sessionId, "fact", "Test memory", 0.9, now, now, now);

    const addLog = db.prepare(
      "INSERT INTO memory_access_log (memory_id, session_id, access_type, query_text, result_rank, relevance_score, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );

    addLog.run("mem_1", sessionId, "query_hit", "search", 1, 0.95, now);
    addLog.run("mem_1", sessionId, "query_hit", "search", 2, 0.9, now);
    addLog.run("mem_1", sessionId, "query_hit", "search", 3, 0.85, now);
    addLog.run("mem_1", sessionId, "partial_hit", "search", 5, 0.7, now);
    addLog.run("mem_1", sessionId, "partial_hit", "search", 8, 0.6, now);
    addLog.run(null, sessionId, "query_miss", "search", null, null, now);

    const metrics = await framework.getLayer1Metrics(1);

    expect(metrics.hitDistribution.rank1To3).toBe(3);
    expect(metrics.hitDistribution.rank4To10).toBe(2);
    expect(metrics.hitDistribution.noRank).toBe(1);
  });

  it("should identify top hit memories", async () => {
    const now = Date.now();
    const sessionId = "test_session";

    const addMemory = db.prepare(
      "INSERT INTO memories (id, session_id, type, content, importance, created_at, updated_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    addMemory.run("mem_1", sessionId, "fact", "Frequently hit memory", 0.9, now, now, now);
    addMemory.run("mem_2", sessionId, "fact", "Rarely hit memory", 0.5, now, now, now);

    const addLog = db.prepare(
      "INSERT INTO memory_access_log (memory_id, session_id, access_type, query_text, result_rank, relevance_score, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );

    for (let i = 0; i < 10; i++) {
      addLog.run("mem_1", sessionId, "query_hit", "search", 1, 0.95, now + i * 1000);
    }
    addLog.run("mem_2", sessionId, "query_hit", "search", 1, 0.8, now);

    const metrics = await framework.getLayer1Metrics(1);

    expect(metrics.topHitMemories.length).toBeGreaterThan(0);
    expect(metrics.topHitMemories[0].memoryId).toBe("mem_1");
    expect(metrics.topHitMemories[0].accessCount).toBe(10);
  });

  it("should detect miss patterns", async () => {
    const now = Date.now();
    const sessionId = "test_session";

    const addLog = db.prepare(
      "INSERT INTO memory_access_log (memory_id, session_id, access_type, query_text, result_rank, relevance_score, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );

    for (let i = 0; i < 5; i++) {
      addLog.run(null, sessionId, "query_miss", "common query", null, null, now + i * 1000);
    }
    for (let i = 0; i < 2; i++) {
      addLog.run(null, sessionId, "query_miss", "rare query", null, null, now + i * 1000);
    }

    const metrics = await framework.getLayer1Metrics(1);

    expect(metrics.missPatterns.length).toBeGreaterThan(0);
    const commonQuery = metrics.missPatterns.find((p) => p.queryText === "common query");
    expect(commonQuery?.frequency).toBe("frequent");
  });

  it("should calculate Layer 3 metrics - memory reuse", async () => {
    const now = Date.now();
    const sessionId = "test_session";

    const addMemory = db.prepare(
      "INSERT INTO memories (id, session_id, type, content, importance, created_at, updated_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );

    addMemory.run("mem_1", sessionId, "fact", "Memory 1", 0.9, now, now, now);
    addMemory.run("mem_2", sessionId, "fact", "Memory 2", 0.8, now, now, now);
    addMemory.run("mem_3", sessionId, "fact", "Memory 3", 0.7, now, now, now);

    const addLog = db.prepare(
      "INSERT INTO memory_access_log (memory_id, session_id, access_type, query_text, result_rank, relevance_score, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    addLog.run("mem_1", sessionId, "query_hit", "search", 1, 0.95, now);
    addLog.run("mem_1", sessionId, "query_hit", "search", 1, 0.95, now);
    addLog.run("mem_2", sessionId, "query_hit", "search", 1, 0.9, now);

    const metrics = await framework.getLayer3Metrics(1);

    expect(metrics.memoryReuseScore.reusedMemoriesPct).toBeGreaterThanOrEqual(0);
    expect(metrics.memoryReuseScore.deadMemoriesPct).toBeGreaterThanOrEqual(0);
    expect(metrics.timePeriod.days).toBe(1);
  });

  it("should generate daily trend data", async () => {
    const now = Date.now();
    const sessionId = "test_session";
    const dayAgo = now - 24 * 60 * 60 * 1000;

    const addMemory = db.prepare(
      "INSERT INTO memories (id, session_id, type, content, importance, created_at, updated_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    addMemory.run("mem_1", sessionId, "fact", "Test memory", 0.9, dayAgo, dayAgo, dayAgo);

    const addLog = db.prepare(
      "INSERT INTO memory_access_log (memory_id, session_id, access_type, query_text, result_rank, relevance_score, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );

    addLog.run("mem_1", sessionId, "query_hit", "search", 1, 0.95, dayAgo);
    addLog.run("mem_1", sessionId, "query_hit", "search", 1, 0.9, dayAgo + 12 * 60 * 60 * 1000);
    addLog.run(null, sessionId, "query_miss", "search", null, null, now);

    const metrics = await framework.getLayer3Metrics(2);

    expect(metrics.hitRateTrend.length).toBeGreaterThan(0);
    expect(metrics.timePeriod.days).toBe(2);
  });

  it("should format report as Markdown", async () => {
    const report = await framework.generateValidationReport(7);
    const markdown = framework.formatReportAsMarkdown(report);

    expect(markdown).toContain("OpenCode-Owl");
    expect(markdown).toContain("Layer 1");
    expect(markdown).toContain("Layer 3");
    expect(markdown).toContain("命中率");
  });

  it("should format report as JSON", async () => {
    const report = await framework.generateValidationReport(7);
    const json = framework.formatReportAsJSON(report);

    const parsed = JSON.parse(json);
    expect(parsed.layer1).toBeDefined();
    expect(parsed.layer3).toBeDefined();
    expect(parsed.summary).toBeDefined();
  });

  it("should handle empty database gracefully", async () => {
    const metrics = await framework.getLayer1Metrics(7);
    expect(metrics.hitRate).toBe(0);
    expect(metrics.totalQueries).toBe(0);

    const layer3 = await framework.getLayer3Metrics(30);
    expect(layer3.hitRateTrend).toBeInstanceOf(Array);

    const report = await framework.generateValidationReport(7);
    expect(report.summary).toBeDefined();
    expect(report.layer1).toBeDefined();
  });

  it("should generate comprehensive validation report", async () => {
    const now = Date.now();
    const sessionId = "test_session";

    const addMemory = db.prepare(
      "INSERT INTO memories (id, session_id, type, content, importance, created_at, updated_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    addMemory.run("mem_1", sessionId, "fact", "Memory 1", 0.9, now, now, now);

    const addLog = db.prepare(
      "INSERT INTO memory_access_log (memory_id, session_id, access_type, query_text, result_rank, relevance_score, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    for (let i = 0; i < 100; i++) {
      const isHit = i % 3 !== 0;
      if (isHit) {
        addLog.run("mem_1", sessionId, "query_hit", `query ${i}`, 1, 0.95, now + i * 1000);
      } else {
        addLog.run(null, sessionId, "query_miss", `query ${i}`, null, null, now + i * 1000);
      }
    }

    const report = await framework.generateValidationReport(1);

    expect(report.period).toBe("1d");
    expect(report.timestamp).toBeDefined();
    expect(report.layer1.totalQueries).toBe(100);
    expect(report.layer1.hitRate).toBeGreaterThan(50);
    expect(report.summary.isEffective).toBe(true);
  });
});
