import { afterEach, describe, expect, test } from "bun:test";
import { dispatch, type MemoryStore } from "./mcp-server";

const originalTtl = process.env.MEMORY_QUERY_CACHE_TTL_MS;

class FakeMemoryStore {
  sessionId = "";
  queryCalls = 0;

  setSessionId(sessionId: string) {
    this.sessionId = sessionId;
  }

  queryMemories() {
    this.queryCalls++;
    return [{ id: `result-${this.queryCalls}`, sessionId: this.sessionId }];
  }

  addMemory() {
    return "mem_1";
  }

  updateMemory() {
    return true;
  }

  deleteMemory() {
    return true;
  }

  getAccessAnalytics() {
    return { totalQueries: 0 };
  }
}

function callDispatch(store: FakeMemoryStore, method: string, params: Record<string, unknown>) {
  return dispatch(store as unknown as MemoryStore, method, params);
}

afterEach(() => {
  if (originalTtl === undefined) {
    delete process.env.MEMORY_QUERY_CACHE_TTL_MS;
  } else {
    process.env.MEMORY_QUERY_CACHE_TTL_MS = originalTtl;
  }
});

describe("memory_query result cache", () => {
  test("returns cached results for identical queries within the TTL", async () => {
    process.env.MEMORY_QUERY_CACHE_TTL_MS = "30000";
    const store = new FakeMemoryStore();
    const params = { session_id: "cache-hit-session", query: "typescript skill", limit: 3 };

    const first = await callDispatch(store, "memory_query", params);
    const second = await callDispatch(store, "memory_query", params);

    expect(second).toBe(first);
    expect(store.queryCalls).toBe(1);
  });

  test("invalidates cached results after memory_add for the same session", async () => {
    process.env.MEMORY_QUERY_CACHE_TTL_MS = "30000";
    const store = new FakeMemoryStore();
    const params = { session_id: "cache-invalidate-session", query: "testing skill", limit: 2 };

    const first = await callDispatch(store, "memory_query", params);
    await callDispatch(store, "memory_add", {
      session_id: "cache-invalidate-session",
      type: "fact",
      content: "new testing skill memory",
    });
    const second = await callDispatch(store, "memory_query", params);

    expect(second).not.toBe(first);
    expect(store.queryCalls).toBe(2);
  });

  test("invalidates cached results after memory_update and memory_delete for the same session", async () => {
    process.env.MEMORY_QUERY_CACHE_TTL_MS = "30000";
    const store = new FakeMemoryStore();
    const params = { session_id: "cache-update-delete-session", query: "mutable skill", limit: 2 };

    await callDispatch(store, "memory_query", params);
    await callDispatch(store, "memory_query", params);
    expect(store.queryCalls).toBe(1);

    await callDispatch(store, "memory_update", {
      session_id: "cache-update-delete-session",
      id: "mem_1",
      content: "updated skill memory",
    });
    await callDispatch(store, "memory_query", params);
    expect(store.queryCalls).toBe(2);

    await callDispatch(store, "memory_delete", {
      session_id: "cache-update-delete-session",
      id: "mem_1",
    });
    await callDispatch(store, "memory_query", params);
    expect(store.queryCalls).toBe(3);
  });

  test("honors MEMORY_QUERY_CACHE_TTL_MS", async () => {
    process.env.MEMORY_QUERY_CACHE_TTL_MS = "1";
    const store = new FakeMemoryStore();
    const params = { session_id: "cache-ttl-session", query: "short ttl", limit: 1 };

    const first = await callDispatch(store, "memory_query", params);
    await Bun.sleep(5);
    const second = await callDispatch(store, "memory_query", params);

    expect(second).not.toBe(first);
    expect(store.queryCalls).toBe(2);
  });

  test("surfaces query cache stats in memory_access_analytics", async () => {
    process.env.MEMORY_QUERY_CACHE_TTL_MS = "30000";
    const store = new FakeMemoryStore();
    const params = { session_id: "cache-stats-session", query: "stats", limit: 1 };

    await callDispatch(store, "memory_query", params);
    await callDispatch(store, "memory_query", params);
    const analytics = await callDispatch(store, "memory_access_analytics", {
      session_id: "cache-stats-session",
    }) as { queryCacheHits?: number; queryCacheMisses?: number };

    expect(analytics.queryCacheHits).toBeGreaterThanOrEqual(1);
    expect(analytics.queryCacheMisses).toBeGreaterThanOrEqual(1);
  });
});
