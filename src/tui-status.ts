import { Database } from "bun:sqlite";

export type StatusColor = "green" | "yellow" | "red" | "gray";

export interface TUIStatus {
  isAvailable: boolean;
  hitRate: number;
  color: StatusColor;
  label: string;
  shortLabel: string;
  tooltip: {
    title: string;
    lines: string[];
  };
  lastUpdate: number;
  responseTime: number;
}

export class TUIStatusManager {
  private db: Database | null = null;
  private cache: { status: TUIStatus | null; timestamp: number } = {
    status: null,
    timestamp: 0,
  };
  private readonly CACHE_TTL = 60 * 1000; // 60 seconds
  private healthCheck: { isHealthy: boolean; lastCheck: number } = {
    isHealthy: false,
    lastCheck: 0,
  };
  private readonly HEALTH_CHECK_TTL = 5 * 1000; // 5 seconds

  constructor(memoryDb: Database | null = null) {
    this.db = memoryDb;
    if (memoryDb) {
      this.performHealthCheck();
    }
  }

  setDatabase(db: Database): void {
    this.db = db;
    this.performHealthCheck();
  }

  async getStatus(): Promise<TUIStatus> {
    const now = Date.now();

    if (
      this.cache.status &&
      now - this.cache.timestamp < this.CACHE_TTL
    ) {
      return this.cache.status;
    }

    this.performHealthCheck();

    const startTime = performance.now();
    let status: TUIStatus;

    if (!this.db) {
      status = this.createUnavailableStatus("Database not initialized");
    } else if (!this.healthCheck.isHealthy) {
      status = this.createUnavailableStatus("Service unavailable");
    } else {
      try {
        const hitRateData = this.getHitRateFromDb();
        status = this.createAvailableStatus(hitRateData);
      } catch (error) {
        status = this.createUnavailableStatus(`Error: ${String(error)}`);
      }
    }

    const responseTime = performance.now() - startTime;
    status.responseTime = Math.round(responseTime);

    this.cache = { status, timestamp: now };
    return status;
  }

  private performHealthCheck(): void {
    const now = Date.now();
    if (now - this.healthCheck.lastCheck < this.CACHE_TTL) {
      return;
    }

    try {
      if (!this.db) {
        this.healthCheck = { isHealthy: false, lastCheck: now };
        return;
      }

      this.db.prepare("SELECT 1").get();
      this.healthCheck = { isHealthy: true, lastCheck: now };
    } catch (e) {
      this.healthCheck = { isHealthy: false, lastCheck: now };
      console.debug("[TUI] Health check failed:", e);
    }
  }

  private getHitRateFromDb(): { hitRate: number; total: number; hits: number } {
    if (!this.db) {
      throw new Error("Database not available");
    }

    const now = Date.now();
    const last24h = now - 24 * 60 * 60 * 1000;

    const result = this.db
      .prepare(
        `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN access_type IN ('query_hit', 'partial_hit') THEN 1 ELSE 0 END) as hits
      FROM memory_access_log
      WHERE timestamp > ?`
      )
      .get(last24h) as { total: number; hits: number };

    const total = result.total || 0;
    const hits = result.hits || 0;
    const hitRate =
      total > 0 ? Math.round((hits / total) * 100 * 100) / 100 : 0;

    return { hitRate, total, hits };
  }

  private createAvailableStatus(data: {
    hitRate: number;
    total: number;
    hits: number;
  }): TUIStatus {
    const { hitRate, total, hits } = data;
    const color = this.getColorForHitRate(hitRate);
    const hitRateStr = hitRate.toFixed(1);

    return {
      isAvailable: true,
      hitRate,
      color,
      label: `owl (${hitRateStr}%)`,
      shortLabel: `owl`,
      tooltip: {
        title: "OpenCode-Owl Memory System",
        lines: [
          `Hit Rate: ${hitRateStr}%`,
          `Last 24h: ${hits}/${total} queries`,
          `Status: ✓ Active`,
          `Color: ${this.getColorName(color)}`,
        ],
      },
      lastUpdate: Date.now(),
      responseTime: 0,
    };
  }

  private createUnavailableStatus(reason: string): TUIStatus {
    return {
      isAvailable: false,
      hitRate: 0,
      color: "gray",
      label: "owl (--%) ",
      shortLabel: "owl",
      tooltip: {
        title: "OpenCode-Owl Memory System",
        lines: [
          `Status: ⚠️ ${reason}`,
          `Action: Start owl MCP server or check database connection`,
          `Command: bun run mcp`,
        ],
      },
      lastUpdate: Date.now(),
      responseTime: 0,
    };
  }

  private getColorForHitRate(hitRate: number): StatusColor {
    if (hitRate >= 70) return "green";
    if (hitRate >= 30) return "yellow";
    if (hitRate > 0) return "red";
    return "gray";
  }

  private getColorName(color: StatusColor): string {
    const names: Record<StatusColor, string> = {
      green: "Green (70%+)",
      yellow: "Yellow (30-70%)",
      red: "Red (<30%)",
      gray: "Gray (unavailable)",
    };
    return names[color];
  }

  getStatusString(): string {
    const status = this.cache.status;
    if (!status || !status.isAvailable) {
      return "owl (--%)";
    }
    return `owl (${status.hitRate.toFixed(0)}%)`;
  }

  getStatusWithColor(): { label: string; color: StatusColor } {
    const status = this.cache.status;
    if (!status) {
      return { label: "owl (--%) ", color: "gray" };
    }
    return { label: status.label, color: status.color };
  }

  getTooltip(): string {
    const status = this.cache.status;
    if (!status) {
      return "Fetching status...";
    }

    const { title, lines } = status.tooltip;
    return [title, ...lines].join("\n");
  }

  getCacheInfo(): { isCached: boolean; age: number; ttl: number } {
    const now = Date.now();
    const age = now - this.cache.timestamp;
    const isCached = age < this.CACHE_TTL && this.cache.status !== null;
    return {
      isCached,
      age: Math.round(age / 1000),
      ttl: Math.round(this.CACHE_TTL / 1000),
    };
  }

  clearCache(): void {
    this.cache = { status: null, timestamp: 0 };
  }

  invalidateHealthCheck(): void {
    this.healthCheck = { isHealthy: false, lastCheck: 0 };
  }
}
