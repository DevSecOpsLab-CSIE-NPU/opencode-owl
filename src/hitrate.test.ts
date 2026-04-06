import { test, expect, beforeEach, describe } from "bun:test";
import { Database } from "bun:sqlite";

describe("opencode-owl v1.2.6 Hit-Rate Tracking", () => {
  let db: Database;
  const sessionId = "test_session";

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
  });

  test("建立 memory_access_log 表", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_access_log'")
      .all() as any[];
    expect(tables.length).toBe(1);
  });

  test("memory_access_log 索引完整", () => {
    const indices = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_access_log'")
      .all() as any[];
    const names = indices.map((i) => i.name);
    expect(names).toContain("idx_access_log_memory");
    expect(names).toContain("idx_access_log_session");
  });

  test("記錄查詢命中 (query_hit)", () => {
    const memId = "mem_001";
    insertMemory(db, memId, sessionId, "Test memory");

    logAccess(db, {
      memory_id: memId,
      session_id: sessionId,
      access_type: "query_hit",
      query_text: "test",
      result_rank: 1,
      relevance_score: 0.85,
      timestamp: Date.now(),
    });

    const logs = db.query("SELECT * FROM memory_access_log WHERE memory_id = ? AND access_type = ?").all(
      memId,
      "query_hit"
    ) as any[];

    expect(logs.length).toBe(1);
    expect(logs[0].query_text).toBe("test");
    expect(logs[0].result_rank).toBe(1);
  });

  test("記錄查詢未命中 (query_miss)", () => {
    logAccess(db, {
      memory_id: null,
      session_id: sessionId,
      access_type: "query_miss",
      query_text: "nonexistent_pattern",
      result_rank: null,
      relevance_score: null,
      timestamp: Date.now(),
    });

    const logs = db
      .query("SELECT * FROM memory_access_log WHERE access_type = ? AND query_text = ?")
      .all("query_miss", "nonexistent_pattern") as any[];

    expect(logs.length).toBe(1);
    expect(logs[0].result_rank).toBeNull();
  });

  test("記錄部分命中 (partial_hit, rank > 3)", () => {
    const memId = "mem_004";
    insertMemory(db, memId, sessionId, "Far result");

    logAccess(db, {
      memory_id: memId,
      session_id: sessionId,
      access_type: "partial_hit",
      query_text: "test",
      result_rank: 5,
      relevance_score: 0.42,
      timestamp: Date.now(),
    });

    const logs = db
      .query("SELECT * FROM memory_access_log WHERE access_type = ? AND memory_id = ?")
      .all("partial_hit", memId) as any[];

    expect(logs.length).toBe(1);
    expect(logs[0].result_rank).toBeGreaterThan(3);
  });

  test("計算命中率 (getHitRate)", () => {
    const now = Date.now();

    logAccess(db, {
      memory_id: "mem_1",
      session_id: sessionId,
      access_type: "query_hit",
      query_text: "q1",
      result_rank: 1,
      relevance_score: 0.9,
      timestamp: now,
    });

    logAccess(db, {
      memory_id: null,
      session_id: sessionId,
      access_type: "query_miss",
      query_text: "q2",
      result_rank: null,
      relevance_score: null,
      timestamp: now,
    });

    logAccess(db, {
      memory_id: "mem_1",
      session_id: sessionId,
      access_type: "query_hit",
      query_text: "q3",
      result_rank: 1,
      relevance_score: 0.88,
      timestamp: now,
    });

    const result = getHitRate(db, sessionId, 24);

    expect(result.total).toBe(3);
    expect(result.hits).toBe(2);
    expect(parseFloat(result.hitRate)).toBeCloseTo((2 / 3) * 100, 1);
  });

  test("時間窗口過濾", () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 3600000;

    logAccess(db, {
      memory_id: "mem_1",
      session_id: sessionId,
      access_type: "query_hit",
      query_text: "old",
      result_rank: 1,
      relevance_score: 0.8,
      timestamp: twoHoursAgo,
    });

    logAccess(db, {
      memory_id: "mem_1",
      session_id: sessionId,
      access_type: "query_hit",
      query_text: "new",
      result_rank: 1,
      relevance_score: 0.85,
      timestamp: now,
    });

    const rate1h = getHitRate(db, sessionId, 1);
    const rate24h = getHitRate(db, sessionId, 24);

    expect(rate1h.total).toBeLessThan(rate24h.total);
    expect(rate1h.total).toBe(1);
    expect(rate24h.total).toBe(2);
  });

  test("分析頂部命中記憶", () => {
    insertMemory(db, "mem_hot", sessionId, "Frequently accessed");
    insertMemory(db, "mem_cold", sessionId, "Rarely accessed");

    for (let i = 0; i < 5; i++) {
      logAccess(db, {
        memory_id: "mem_hot",
        session_id: sessionId,
        access_type: "query_hit",
        query_text: "hot",
        result_rank: 1,
        relevance_score: 0.9,
        timestamp: Date.now(),
      });
    }

    logAccess(db, {
      memory_id: "mem_cold",
      session_id: sessionId,
      access_type: "query_hit",
      query_text: "cold",
      result_rank: 1,
      relevance_score: 0.7,
      timestamp: Date.now(),
    });

    const analytics = getAccessAnalytics(db, sessionId);

    expect(analytics.topHitMemories.length).toBeGreaterThan(0);
    expect(analytics.topHitMemories[0].memory_id).toBe("mem_hot");
    expect(analytics.topHitMemories[0].hits).toBe(5);
  });

  test("檢測未命中模式", () => {
    const now = Date.now();

    for (let i = 0; i < 3; i++) {
      logAccess(db, {
        memory_id: null,
        session_id: sessionId,
        access_type: "query_miss",
        query_text: "missing_xyz",
        result_rank: null,
        relevance_score: null,
        timestamp: now + i,
      });
    }

    logAccess(db, {
      memory_id: null,
      session_id: sessionId,
      access_type: "query_miss",
      query_text: "missing_abc",
      result_rank: null,
      relevance_score: null,
      timestamp: now,
    });

    const analytics = getAccessAnalytics(db, sessionId);

    expect(analytics.missPatterns.length).toBeGreaterThan(0);
    expect(analytics.missPatterns[0].misses).toBe(3);
  });

  test("平均相關分數計算", () => {
    logAccess(db, {
      memory_id: "mem_1",
      session_id: sessionId,
      access_type: "query_hit",
      query_text: "test",
      result_rank: 1,
      relevance_score: 0.5,
      timestamp: Date.now(),
    });

    logAccess(db, {
      memory_id: "mem_2",
      session_id: sessionId,
      access_type: "query_hit",
      query_text: "test",
      result_rank: 2,
      relevance_score: 0.8,
      timestamp: Date.now(),
    });

    const analytics = getAccessAnalytics(db, sessionId);

    expect(analytics.averageRelevance).toBeCloseTo(0.65, 1);
  });

  test("強化記憶記錄 (reinforced)", () => {
    const memId = "mem_reinforced";
    insertMemory(db, memId, sessionId, "Important memory");

    logAccess(db, {
      memory_id: memId,
      session_id: sessionId,
      access_type: "reinforced",
      query_text: null,
      result_rank: null,
      relevance_score: null,
      timestamp: Date.now(),
    });

    const logs = db
      .query("SELECT * FROM memory_access_log WHERE memory_id = ? AND access_type = ?")
      .all(memId, "reinforced") as any[];

    expect(logs.length).toBe(1);
  });
});

function initSchema(db: Database) {
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      importance REAL DEFAULT 0.5,
      access_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL
    );

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
    );

    CREATE INDEX idx_access_log_memory ON memory_access_log(memory_id);
    CREATE INDEX idx_access_log_session ON memory_access_log(session_id);
    CREATE INDEX idx_access_log_time ON memory_access_log(timestamp);
    CREATE INDEX idx_access_log_type ON memory_access_log(access_type);
  `);
}

function insertMemory(db: Database, id: string, sessionId: string, content: string) {
  db.query(
    "INSERT INTO memories (id, session_id, type, content, created_at, updated_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, sessionId, "fact", content, Date.now(), Date.now(), Date.now());
}

function logAccess(
  db: Database,
  log: {
    memory_id: string | null;
    session_id: string;
    access_type: string;
    query_text: string | null;
    result_rank: number | null;
    relevance_score: number | null;
    timestamp: number;
  }
) {
  db.query(
    "INSERT INTO memory_access_log (memory_id, session_id, access_type, query_text, result_rank, relevance_score, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    log.memory_id,
    log.session_id,
    log.access_type,
    log.query_text,
    log.result_rank,
    log.relevance_score,
    log.timestamp
  );
}

function getHitRate(db: Database, sessionId: string, hours: number) {
  const since = Date.now() - hours * 3600000;

  const total = (
    db.query("SELECT COUNT(*) as c FROM memory_access_log WHERE session_id = ? AND timestamp > ?").get(
      sessionId,
      since
    ) as any
  )?.c || 0;

  const hits = (
    db
      .query("SELECT COUNT(*) as c FROM memory_access_log WHERE session_id = ? AND access_type = 'query_hit' AND timestamp > ?")
      .get(sessionId, since) as any
  )?.c || 0;

  const rate = total > 0 ? ((hits / total) * 100).toFixed(2) : "0.00";

  return { total, hits, hitRate: rate + "%" };
}

function getAccessAnalytics(db: Database, sessionId: string) {
  const hitRate = getHitRate(db, sessionId, 24);

  const topHitMemories = db
    .query(
      "SELECT memory_id, COUNT(*) as hits FROM memory_access_log WHERE access_type IN ('query_hit', 'partial_hit') AND session_id = ? GROUP BY memory_id ORDER BY hits DESC LIMIT 10"
    )
    .all(sessionId) as any[];

  const avgRow = db
    .query(
      "SELECT AVG(relevance_score) as avg FROM memory_access_log WHERE access_type IN ('query_hit', 'partial_hit') AND session_id = ?"
    )
    .get(sessionId) as any;

  const averageRelevance = avgRow?.avg || 0;

  const missPatterns = db
    .query(
      "SELECT query_text, COUNT(*) as misses FROM memory_access_log WHERE access_type = 'query_miss' AND session_id = ? GROUP BY query_text ORDER BY misses DESC LIMIT 10"
    )
    .all(sessionId) as any[];

  return {
    hitRate,
    topHitMemories,
    averageRelevance,
    totalQueries: hitRate.total,
    missPatterns,
  };
}
