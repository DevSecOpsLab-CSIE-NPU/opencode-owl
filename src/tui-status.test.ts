import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { TUIStatusManager } from "./tui-status";

describe("TUIStatusManager", () => {
  let db: Database;
  let manager: TUIStatusManager;

  beforeEach(() => {
    db = new Database(":memory:");
    manager = new TUIStatusManager(db);

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
        timestamp INTEGER NOT NULL
      )
    `);
  });

  afterEach(() => {
    db.close();
  });

  it("should handle unavailable service (no database)", async () => {
    const nullManager = new TUIStatusManager(null);
    const status = await nullManager.getStatus();

    expect(status.isAvailable).toBe(false);
    expect(status.color).toBe("gray");
    expect(status.label).toContain("--");
    expect(status.tooltip.lines.length).toBeGreaterThan(0);
  });

  it("should return green status for high hit rate (>=70%)", async () => {
    const now = Date.now();
    const sessionId = "test_session";

    const addMemory = db.prepare(
      "INSERT INTO memories (id, session_id, type, content, importance, created_at, updated_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    addMemory.run("mem_1", sessionId, "fact", "Test memory", 0.9, now, now, now);

    const addLog = db.prepare(
      "INSERT INTO memory_access_log (memory_id, session_id, access_type, query_text, result_rank, relevance_score, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );

    for (let i = 0; i < 100; i++) {
      if (i < 75) {
        addLog.run(
          "mem_1",
          sessionId,
          "query_hit",
          "search",
          1,
          0.95,
          now + i * 1000
        );
      } else {
        addLog.run(
          null,
          sessionId,
          "query_miss",
          "search",
          null,
          null,
          now + i * 1000
        );
      }
    }

    const status = await manager.getStatus();
    expect(status.isAvailable).toBe(true);
    expect(status.color).toBe("green");
    expect(status.hitRate).toBeGreaterThanOrEqual(70);
  });

  it("should return yellow status for medium hit rate (30-70%)", async () => {
    const now = Date.now();
    const sessionId = "test_session";

    const addMemory = db.prepare(
      "INSERT INTO memories (id, session_id, type, content, importance, created_at, updated_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    addMemory.run("mem_1", sessionId, "fact", "Test memory", 0.9, now, now, now);

    const addLog = db.prepare(
      "INSERT INTO memory_access_log (memory_id, session_id, access_type, query_text, result_rank, relevance_score, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );

    for (let i = 0; i < 100; i++) {
      if (i < 50) {
        addLog.run(
          "mem_1",
          sessionId,
          "query_hit",
          "search",
          1,
          0.95,
          now + i * 1000
        );
      } else {
        addLog.run(
          null,
          sessionId,
          "query_miss",
          "search",
          null,
          null,
          now + i * 1000
        );
      }
    }

    const status = await manager.getStatus();
    expect(status.isAvailable).toBe(true);
    expect(status.color).toBe("yellow");
    expect(status.hitRate).toBeLessThanOrEqual(70);
    expect(status.hitRate).toBeGreaterThanOrEqual(30);
  });

  it("should return red status for low hit rate (<30%)", async () => {
    const now = Date.now();
    const sessionId = "test_session";

    const addMemory = db.prepare(
      "INSERT INTO memories (id, session_id, type, content, importance, created_at, updated_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    addMemory.run("mem_1", sessionId, "fact", "Test memory", 0.9, now, now, now);

    const addLog = db.prepare(
      "INSERT INTO memory_access_log (memory_id, session_id, access_type, query_text, result_rank, relevance_score, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );

    for (let i = 0; i < 100; i++) {
      if (i < 20) {
        addLog.run(
          "mem_1",
          sessionId,
          "query_hit",
          "search",
          1,
          0.95,
          now + i * 1000
        );
      } else {
        addLog.run(
          null,
          sessionId,
          "query_miss",
          "search",
          null,
          null,
          now + i * 1000
        );
      }
    }

    const status = await manager.getStatus();
    expect(status.isAvailable).toBe(true);
    expect(status.color).toBe("red");
    expect(status.hitRate).toBeLessThan(30);
  });

  it("should cache status for 60 seconds", async () => {
    const now = Date.now();
    const sessionId = "test_session";

    const addMemory = db.prepare(
      "INSERT INTO memories (id, session_id, type, content, importance, created_at, updated_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    addMemory.run("mem_1", sessionId, "fact", "Test memory", 0.9, now, now, now);

    const addLog = db.prepare(
      "INSERT INTO memory_access_log (memory_id, session_id, access_type, query_text, result_rank, relevance_score, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    addLog.run(
      "mem_1",
      sessionId,
      "query_hit",
      "search",
      1,
      0.95,
      now
    );
    addLog.run(
      null,
      sessionId,
      "query_miss",
      "search",
      null,
      null,
      now
    );

    const status1 = await manager.getStatus();

    const status2 = await manager.getStatus();
    const cacheInfo2 = manager.getCacheInfo();

    expect(status2.hitRate).toBe(status1.hitRate);
    expect(cacheInfo2.isCached).toBe(true);
    expect(cacheInfo2.age).toBeLessThanOrEqual(cacheInfo2.ttl);
  });

  it("should provide readable status labels", async () => {
    const now = Date.now();
    const sessionId = "test_session";

    const addMemory = db.prepare(
      "INSERT INTO memories (id, session_id, type, content, importance, created_at, updated_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    addMemory.run("mem_1", sessionId, "fact", "Test memory", 0.9, now, now, now);

    const addLog = db.prepare(
      "INSERT INTO memory_access_log (memory_id, session_id, access_type, query_text, result_rank, relevance_score, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    addLog.run(
      "mem_1",
      sessionId,
      "query_hit",
      "search",
      1,
      0.95,
      now
    );

    const status = await manager.getStatus();
    expect(status.label).toMatch(/owl \(\d+\.\d%\)/);
    expect(status.shortLabel).toBe("owl");
    expect(status.isAvailable).toBe(true);
  });

  it("should generate tooltip with information", async () => {
    const now = Date.now();
    const sessionId = "test_session";

    const addMemory = db.prepare(
      "INSERT INTO memories (id, session_id, type, content, importance, created_at, updated_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    addMemory.run("mem_1", sessionId, "fact", "Test memory", 0.9, now, now, now);

    const addLog = db.prepare(
      "INSERT INTO memory_access_log (memory_id, session_id, access_type, query_text, result_rank, relevance_score, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    for (let i = 0; i < 10; i++) {
      addLog.run(
        "mem_1",
        sessionId,
        "query_hit",
        "search",
        1,
        0.95,
        now + i * 1000
      );
    }

    await manager.getStatus();
    const tooltip = manager.getTooltip();
    expect(tooltip).toContain("OpenCode-Owl");
    expect(tooltip).toContain("Hit Rate");
    expect(tooltip).toContain("Status");
  });

  it("should handle clear cache", async () => {
    const now = Date.now();
    const sessionId = "test_session";

    const addMemory = db.prepare(
      "INSERT INTO memories (id, session_id, type, content, importance, created_at, updated_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    addMemory.run("mem_1", sessionId, "fact", "Test memory", 0.9, now, now, now);

    const addLog = db.prepare(
      "INSERT INTO memory_access_log (memory_id, session_id, access_type, query_text, result_rank, relevance_score, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    addLog.run(
      "mem_1",
      sessionId,
      "query_hit",
      "search",
      1,
      0.95,
      now
    );

    await manager.getStatus();
    let cacheInfo = manager.getCacheInfo();
    expect(cacheInfo.isCached).toBe(true);

    manager.clearCache();
    cacheInfo = manager.getCacheInfo();
    expect(cacheInfo.isCached).toBe(false);
  });

  it("should measure response time", async () => {
    const now = Date.now();
    const sessionId = "test_session";

    const addMemory = db.prepare(
      "INSERT INTO memories (id, session_id, type, content, importance, created_at, updated_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    addMemory.run("mem_1", sessionId, "fact", "Test memory", 0.9, now, now, now);

    const status = await manager.getStatus();
    expect(status.responseTime).toBeGreaterThanOrEqual(0);
    expect(typeof status.responseTime).toBe("number");
  });
});
