import { Database } from "bun:sqlite";

/**
 * OpenCode-Owl Memory System Validation Framework
 *
 * 三層驗證指標：
 * Layer 1: 系統內部指標（hit rate, relevance, patterns）
 * Layer 2: 跨 opencode 執行效果（token efficiency, response time）
 * Layer 3: 長期趨勢（時間序列分析、衰減機制有效性）
 */

export interface Layer1Metrics {
  hitRate: number; // percentage: 0-100
  totalQueries: number;
  hits: number;
  partialHits: number;
  misses: number;
  hitDistribution: {
    rank1To3: number; // strong hits
    rank4To10: number; // partial hits
    noRank: number; // misses
  };
  averageRelevanceScore: number; // 0-1
  averageRankWhenHit: number; // 1-10
  topHitMemories: Array<{
    memoryId: string;
    accessCount: number;
    hitRate: number;
    relevanceScores: number[];
  }>;
  missPatterns: Array<{
    queryText: string;
    count: number;
    frequency: "rare" | "occasional" | "frequent";
  }>;
  reinforcementFrequency: number; // per day
}

export interface Layer3Metrics {
  timePeriod: {
    from: string; // ISO date
    to: string;
    days: number;
  };
  hitRateTrend: Array<{
    date: string;
    hitRate: number;
    queries: number;
    hits: number;
  }>;
  memoryReuseScore: {
    averageAccessCount: number;
    newMemoriesPerDay: number;
    reusedMemoriesPct: number; // % accessed 2+ times
    deadMemoriesPct: number; // % never accessed
  };
  decayMechanismEffectiveness: {
    newMemoriesHitRate: number; // memories < 7 days
    oldMemoriesHitRate: number; // memories > 30 days
    decayBenefit: number; // difference (should be positive if decay works)
  };
  memoryLifecycleMetrics: {
    averageTimeToFirstHit: string; // e.g. "2.5 days"
    averageTimeToSecondHit: string;
    mostActiveDayOfWeek: string;
  };
}

export interface Layer2Config {
  description: string;
  useMemory: boolean; // Control flag for A/B test
  sessionPrefix: string; // e.g., "ab_with_memory_", "ab_no_memory_"
}

export interface Layer2Results {
  withMemory: {
    avgResponseTime: number; // ms
    avgTokenUsage: number;
    taskCompletionRate: number; // %
    qualityScore: number; // 0-1
  };
  withoutMemory: {
    avgResponseTime: number;
    avgTokenUsage: number;
    taskCompletionRate: number;
    qualityScore: number;
  };
  improvement: {
    responseTimePct: number;
    tokenEfficiencyPct: number;
    completionRatePct: number;
    qualityImprovementPct: number;
  };
  statistical: {
    sampleSize: number;
    confidence95: boolean; // >= 30 samples
    significantDifference: boolean; // p-value < 0.05
  };
}

export interface KPIMetrics {
  memoryQuality: {
    averageImportance: number; // 0-1
    averageConfidence: number; // 0-1
    conflictDensity: number; // conflicts per 100 memories
    consolidationRatio: number; // consolidated / total
  };
  businessImpact: {
    agentErrorRate: number; // errors / total tasks
    agentRefinementCount: number; // avg refinements per task
    memoryInformedDecisions: number; // % of actions informed by memory
    estimatedProductivityGain: number; // %
  };
}

export interface ValidationReport {
  timestamp: string; // ISO
  period: string; // "7d" | "30d" | "all"
  layer1: Layer1Metrics;
  layer3: Layer3Metrics;
  layer2?: Layer2Results;
  kpi?: KPIMetrics;
  summary: {
    isEffective: boolean; // hit rate > 50%
    confidence: "low" | "medium" | "high"; // based on data volume
    recommendations: string[];
  };
}

export class ValidationFramework {
  constructor(private memoryDb: Database, private opencodeDb?: Database) {}

  /**
   * Layer 1: 系統內部指標
   */
  async getLayer1Metrics(daysBack: number = 7): Promise<Layer1Metrics> {
    const now = Date.now();
    const cutoff = now - daysBack * 24 * 60 * 60 * 1000;

    // 確保 memory_access_log 表存在
    this.ensureAccessLogExists();

    // Total queries
    const totalResult = this.memoryDb
      .prepare(
        `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN access_type IN ('query_hit') THEN 1 ELSE 0 END) as hits,
        SUM(CASE WHEN access_type = 'partial_hit' THEN 1 ELSE 0 END) as partial_hits,
        SUM(CASE WHEN access_type = 'query_miss' THEN 1 ELSE 0 END) as misses
      FROM memory_access_log WHERE timestamp > ?`
      )
      .get(cutoff) as {
      total: number;
      hits: number;
      partial_hits: number;
      misses: number;
    };

    const totalQueries = totalResult.total || 0;
    const hits = totalResult.hits || 0;
    const partialHits = totalResult.partial_hits || 0;
    const misses = totalResult.misses || 0;

    const hitRate = totalQueries > 0 ? (hits / totalQueries) * 100 : 0;

    // Hit distribution
    const rankDist = this.memoryDb
      .prepare(
        `SELECT 
        SUM(CASE WHEN result_rank BETWEEN 1 AND 3 THEN 1 ELSE 0 END) as rank_1_to_3,
        SUM(CASE WHEN result_rank BETWEEN 4 AND 10 THEN 1 ELSE 0 END) as rank_4_to_10,
        SUM(CASE WHEN result_rank IS NULL THEN 1 ELSE 0 END) as no_rank
      FROM memory_access_log WHERE timestamp > ?`
      )
      .get(cutoff) as { rank_1_to_3: number; rank_4_to_10: number; no_rank: number };

    // Average relevance score
    const relevanceResult = this.memoryDb
      .prepare(
        `SELECT AVG(relevance_score) as avg_relevance, AVG(result_rank) as avg_rank
      FROM memory_access_log WHERE timestamp > ? AND relevance_score IS NOT NULL`
      )
      .get(cutoff) as { avg_relevance: number; avg_rank: number };

    // Top hit memories
    const topHitMemories = this.memoryDb
      .prepare(
        `SELECT 
        memory_id,
        COUNT(*) as access_count,
        SUM(CASE WHEN access_type = 'query_hit' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as hit_rate,
        GROUP_CONCAT(relevance_score, ',') as relevance_scores
      FROM memory_access_log
      WHERE timestamp > ? AND memory_id IS NOT NULL
      GROUP BY memory_id
      ORDER BY hit_rate DESC, access_count DESC
      LIMIT 10`
      )
      .all(cutoff) as Array<{
      memory_id: string;
      access_count: number;
      hit_rate: number;
      relevance_scores: string;
    }>;

    // Miss patterns (query texts with no results)
    const missPatterns = this.memoryDb
      .prepare(
        `SELECT 
        query_text,
        COUNT(*) as count
      FROM memory_access_log
      WHERE timestamp > ? AND access_type = 'query_miss' AND query_text IS NOT NULL
      GROUP BY query_text
      ORDER BY count DESC
      LIMIT 20`
      )
      .all(cutoff) as Array<{ query_text: string; count: number }>;

    // Reinforcement frequency (per day)
    const reinforceCount = this.memoryDb
      .prepare(
        `SELECT COUNT(*) as count FROM memory_access_log WHERE timestamp > ? AND access_type = 'reinforced'`
      )
      .get(cutoff) as { count: number };
    const reinforcementFrequency = (reinforceCount.count || 0) / Math.max(daysBack, 1);

    return {
      hitRate,
      totalQueries,
      hits,
      partialHits,
      misses,
      hitDistribution: {
        rank1To3: rankDist.rank_1_to_3 || 0,
        rank4To10: rankDist.rank_4_to_10 || 0,
        noRank: rankDist.no_rank || 0,
      },
      averageRelevanceScore: relevanceResult.avg_relevance || 0,
      averageRankWhenHit: relevanceResult.avg_rank || 0,
      topHitMemories: topHitMemories.map((m) => ({
        memoryId: m.memory_id,
        accessCount: m.access_count,
        hitRate: m.hit_rate * 100,
        relevanceScores: m.relevance_scores
          ? m.relevance_scores.split(",").map((s) => parseFloat(s))
          : [],
      })),
      missPatterns: missPatterns.map((p) => ({
        queryText: p.query_text || "(empty)",
        count: p.count,
        frequency:
          p.count >= 5 ? "frequent" : p.count >= 2 ? "occasional" : "rare",
      })),
      reinforcementFrequency,
    };
  }

  /**
   * Layer 3: 長期趨勢分析
   */
  async getLayer3Metrics(daysBack: number = 30): Promise<Layer3Metrics> {
    const now = Date.now();
    const cutoff = now - daysBack * 24 * 60 * 60 * 1000;

    this.ensureAccessLogExists();

    // Daily hit rate trend
    const dailyTrend = this.memoryDb
      .prepare(
        `SELECT 
        DATE(timestamp / 1000, 'unixepoch') as date,
        COUNT(*) as total_queries,
        SUM(CASE WHEN access_type IN ('query_hit', 'partial_hit') THEN 1 ELSE 0 END) as total_hits
      FROM memory_access_log
      WHERE timestamp > ?
      GROUP BY DATE(timestamp / 1000, 'unixepoch')
      ORDER BY date ASC`
      )
      .all(cutoff) as Array<{
      date: string;
      total_queries: number;
      total_hits: number;
    }>;

    const hitRateTrend = dailyTrend.map((d) => ({
      date: d.date,
      hitRate:
        d.total_queries > 0
          ? Math.round((d.total_hits / d.total_queries) * 10000) / 100
          : 0,
      queries: d.total_queries,
      hits: d.total_hits,
    }));

    // Memory reuse analysis
    const accessDistribution = this.memoryDb
      .prepare(
        `SELECT 
        COUNT(*) as total_memories,
        AVG(access_count) as avg_access_count,
        SUM(CASE WHEN access_count = 0 THEN 1 ELSE 0 END) as dead_memories
      FROM memories`
      )
      .get() as {
      total_memories: number;
      avg_access_count: number;
      dead_memories: number;
    };

    const newMemoriesPerDay =
      (this.memoryDb
        .prepare(
          `SELECT COUNT(*) as count FROM memories WHERE created_at > ?`
        )
        .get(cutoff) as { count: number }).count / Math.max(daysBack, 1);

    const reusedMemoriesPct =
      accessDistribution.total_memories > 0
        ? ((accessDistribution.total_memories - (accessDistribution.dead_memories || 0)) /
            accessDistribution.total_memories) *
          100
        : 0;

    // Decay mechanism effectiveness
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    const newMemoriesHitRate = this.calculateMemoryHitRateByAge(
      now,
      sevenDaysAgo
    );
    const oldMemoriesHitRate = this.calculateMemoryHitRateByAge(
      thirtyDaysAgo,
      now - 100 * 24 * 60 * 60 * 1000
    ); // older than 30 days

    // Lifecycle metrics
    const firstHitData = this.memoryDb
      .prepare(
        `SELECT AVG((SELECT MIN(timestamp) FROM memory_access_log mal WHERE mal.memory_id = m.id) - m.created_at) as avg_time_to_first_hit
      FROM memories m`
      )
      .get() as { avg_time_to_first_hit: number };

    const timeToFirstHitDays = firstHitData.avg_time_to_first_hit
      ? Math.round(
          (firstHitData.avg_time_to_first_hit / (24 * 60 * 60 * 1000)) * 10
        ) / 10
      : 0;

    const dayOfWeekDistribution = this.memoryDb
      .prepare(
        `SELECT 
        CASE CAST(STRFTIME('%w', timestamp / 1000, 'unixepoch') AS INTEGER)
          WHEN 0 THEN 'Sunday'
          WHEN 1 THEN 'Monday'
          WHEN 2 THEN 'Tuesday'
          WHEN 3 THEN 'Wednesday'
          WHEN 4 THEN 'Thursday'
          WHEN 5 THEN 'Friday'
          WHEN 6 THEN 'Saturday'
        END as day_of_week,
        COUNT(*) as count
      FROM memory_access_log
      WHERE timestamp > ?
      GROUP BY STRFTIME('%w', timestamp / 1000, 'unixepoch')
      ORDER BY count DESC
      LIMIT 1`
      )
      .get(cutoff) as { day_of_week: string; count: number };

    return {
      timePeriod: {
        from: new Date(cutoff).toISOString().split("T")[0],
        to: new Date(now).toISOString().split("T")[0],
        days: daysBack,
      },
      hitRateTrend,
      memoryReuseScore: {
        averageAccessCount:
          Math.round((accessDistribution.avg_access_count || 0) * 100) / 100,
        newMemoriesPerDay: Math.round(newMemoriesPerDay * 100) / 100,
        reusedMemoriesPct: Math.round(reusedMemoriesPct * 100) / 100,
        deadMemoriesPct:
          Math.round(
            ((accessDistribution.dead_memories || 0) /
              accessDistribution.total_memories) *
              10000
          ) / 100,
      },
      decayMechanismEffectiveness: {
        newMemoriesHitRate: Math.round(newMemoriesHitRate * 100) / 100,
        oldMemoriesHitRate: Math.round(oldMemoriesHitRate * 100) / 100,
        decayBenefit:
          Math.round((newMemoriesHitRate - oldMemoriesHitRate) * 10000) / 100,
      },
      memoryLifecycleMetrics: {
        averageTimeToFirstHit: `${timeToFirstHitDays} days`,
        averageTimeToSecondHit: "N/A",
        mostActiveDayOfWeek:
          dayOfWeekDistribution?.day_of_week || "N/A",
      },
    };
  }

  /**
   * Layer 2: A/B 測試框架（需要 opencode 日誌關聯）
   */
  async getLayer2Results(
    withMemorySessionPrefix: string = "memory_enabled_",
    withoutMemorySessionPrefix: string = "memory_disabled_"
  ): Promise<Layer2Results> {
    // TODO: Integrate with opencode event logs
    // This requires parsing opencode.db event table and correlating with our sessions

    return {
      withMemory: {
        avgResponseTime: 0,
        avgTokenUsage: 0,
        taskCompletionRate: 0,
        qualityScore: 0,
      },
      withoutMemory: {
        avgResponseTime: 0,
        avgTokenUsage: 0,
        taskCompletionRate: 0,
        qualityScore: 0,
      },
      improvement: {
        responseTimePct: 0,
        tokenEfficiencyPct: 0,
        completionRatePct: 0,
        qualityImprovementPct: 0,
      },
      statistical: {
        sampleSize: 0,
        confidence95: false,
        significantDifference: false,
      },
    };
  }

  /**
   * KPI: 業務影響指標
   */
  async getKPIMetrics(): Promise<KPIMetrics> {
    let memoryStats = {
      avg_importance: 0,
      avg_confidence: 0.8,
      total_memories: 0,
    };

    try {
      const result = this.memoryDb
        .prepare(
          `SELECT 
          AVG(importance) as avg_importance,
          COUNT(*) as total_memories
        FROM memories`
        )
        .get() as {
        avg_importance: number | null;
        total_memories: number;
      };
      memoryStats.avg_importance = result.avg_importance || 0;
      memoryStats.total_memories = result.total_memories;

      try {
        const confResult = this.memoryDb
          .prepare(`SELECT AVG(confidence) as avg_confidence FROM memories`)
          .get() as { avg_confidence: number | null };
        memoryStats.avg_confidence = confResult.avg_confidence || 0.8;
      } catch {
        memoryStats.avg_confidence = 0.8;
      }
    } catch (err) {
      console.error("[Validation] KPI metrics calculation failed:", err);
    }

    let conflictDensity = 0;
    try {
      const conflictResult = this.memoryDb
        .prepare(`SELECT COUNT(*) as count FROM conflict_log LIMIT 1`)
        .get() as { count: number };
      const totalMemories = memoryStats.total_memories || 1;
      conflictDensity =
        (((conflictResult?.count || 0) / totalMemories) * 100) || 0;
    } catch {
      // conflict_log may not exist in this version
    }

    return {
      memoryQuality: {
        averageImportance: Math.round((memoryStats.avg_importance || 0) * 100) / 100,
        averageConfidence: Math.round((memoryStats.avg_confidence || 0) * 100) / 100,
        conflictDensity: Math.round(conflictDensity * 100) / 100,
        consolidationRatio: 0,
      },
      businessImpact: {
        agentErrorRate: 0,
        agentRefinementCount: 0,
        memoryInformedDecisions: 0,
        estimatedProductivityGain: 0,
      },
    };
  }

  /**
   * 生成完整驗證報告
   */
  async generateValidationReport(
    daysBack: number = 7
  ): Promise<ValidationReport> {
    const layer1 = await this.getLayer1Metrics(daysBack);
    const layer3 = await this.getLayer3Metrics(daysBack);
    const kpi = await this.getKPIMetrics();

    const recommendations: string[] = [];

    // Analysis and recommendations
    if (layer1.hitRate < 30) {
      recommendations.push(
        "⚠️ 低命中率（<30%）：記憶檢索可能不夠精確，建議檢查查詢文本或增加記憶。"
      );
    } else if (layer1.hitRate >= 70) {
      recommendations.push(
        "✅ 優秀命中率（≥70%）：記憶系統運作效果良好。"
      );
    }

    if (layer1.missPatterns.length > 0) {
      const frequentMisses = layer1.missPatterns.filter(
        (p) => p.frequency === "frequent"
      ).length;
      if (frequentMisses > 0) {
        recommendations.push(
          `⚠️ 發現 ${frequentMisses} 個高頻未命中查詢，建議添加相關記憶。`
        );
      }
    }

    if (kpi.memoryQuality.averageConfidence < 0.7) {
      recommendations.push(
        "⚠️ 記憶信心度偏低（<0.7）：建議進行人工審核和強化。"
      );
    }

    const isEffective = layer1.hitRate > 50;
    const confidence =
      layer1.totalQueries >= 100 ? "high" : layer1.totalQueries >= 30
        ? "medium"
        : "low";

    return {
      timestamp: new Date().toISOString(),
      period: `${daysBack}d`,
      layer1,
      layer3,
      kpi,
      summary: {
        isEffective,
        confidence: confidence as "low" | "medium" | "high",
        recommendations,
      },
    };
  }

  /**
   * 輸出為 Markdown 報告
   */
  formatReportAsMarkdown(report: ValidationReport): string {
    const { layer1, layer3, kpi, summary } = report;

    const md = `# OpenCode-Owl 記憶驗證報告

**生成時間**: ${report.timestamp}  
**分析週期**: ${report.period}  
**系統狀態**: ${summary.isEffective ? "✅ 有效" : "⚠️ 需改進"}  
**資料信心度**: ${summary.confidence.toUpperCase()}

---

## Layer 1：系統內部指標

### 命中率統計
- **總查詢數**: ${layer1.totalQueries}
- **命中次數**: ${layer1.hits} (${Math.round(layer1.hitRate)}%)
- **部分命中**: ${layer1.partialHits}
- **未命中**: ${layer1.misses}

### 命中分佈
| 排名範圍 | 次數 |
|---------|-----|
| Rank 1-3 (強命中) | ${layer1.hitDistribution.rank1To3} |
| Rank 4-10 (部分命中) | ${layer1.hitDistribution.rank4To10} |
| 無排名 (未命中) | ${layer1.hitDistribution.noRank} |

### 品質指標
- **平均相關性分數**: ${Math.round(layer1.averageRelevanceScore * 100) / 100}
- **命中時平均排名**: ${Math.round(layer1.averageRankWhenHit * 10) / 10}
- **強化頻率**: ${Math.round(layer1.reinforcementFrequency * 100) / 100}/天

### 高效記憶 TOP 10
${
  layer1.topHitMemories.length > 0
    ? layer1.topHitMemories
        .map(
          (m, i) =>
            `${i + 1}. **${m.memoryId}**: 訪問 ${m.accessCount}x, 命中率 ${Math.round(m.hitRate)}%, 相關性 ${m.relevanceScores.length > 0 ? (Math.round(m.relevanceScores.reduce((a, b) => a + b) / m.relevanceScores.length * 100) / 100) : "N/A"}`
        )
        .join("\n")
    : "無足夠數據"
}

### 未命中模式
${
  layer1.missPatterns.length > 0
    ? "| 查詢 | 次數 | 頻率 |\n|------|-----|------|\n" +
      layer1.missPatterns
        .slice(0, 10)
        .map((p) => `| \`${p.queryText}\` | ${p.count} | ${p.frequency} |`)
        .join("\n")
    : "無記錄"
}

---

## Layer 3：長期趨勢分析

### 時間範圍
- **從**: ${layer3.timePeriod.from}
- **至**: ${layer3.timePeriod.to}
- **天數**: ${layer3.timePeriod.days}

### 每日命中率趨勢
${
  layer3.hitRateTrend.length > 0
    ? layer3.hitRateTrend
        .map(
          (d) =>
            `- **${d.date}**: ${Math.round(d.hitRate)}% (${d.hits}/${d.queries})`
        )
        .join("\n")
    : "無數據"
}

### 記憶重用指標
- **平均訪問次數**: ${layer3.memoryReuseScore.averageAccessCount}
- **每日新增記憶**: ${layer3.memoryReuseScore.newMemoriesPerDay}
- **已重用記憶 %**: ${layer3.memoryReuseScore.reusedMemoriesPct}%
- **未使用記憶 %**: ${layer3.memoryReuseScore.deadMemoriesPct}%

### 衰減機制有效性
- **新記憶 (<7天) 命中率**: ${layer3.decayMechanismEffectiveness.newMemoriesHitRate}%
- **舊記憶 (>30天) 命中率**: ${layer3.decayMechanismEffectiveness.oldMemoriesHitRate}%
- **衰減收益**: ${layer3.decayMechanismEffectiveness.decayBenefit > 0 ? "✅" : "⚠️"} ${Math.abs(layer3.decayMechanismEffectiveness.decayBenefit)}%

### 記憶生命週期
- **首次命中時間**: ${layer3.memoryLifecycleMetrics.averageTimeToFirstHit}
- **最活躍日**: ${layer3.memoryLifecycleMetrics.mostActiveDayOfWeek}

---

## KPI：業務影響

### 記憶品質
- **平均重要性**: ${kpi ? kpi.memoryQuality.averageImportance : "N/A"}
- **平均信心度**: ${kpi ? kpi.memoryQuality.averageConfidence : "N/A"}
- **衝突密度**: ${kpi ? kpi.memoryQuality.conflictDensity : "N/A"} conflicts/100 memories
- **整合率**: ${kpi ? (kpi.memoryQuality.consolidationRatio * 100) : "N/A"}%

### 業務影響
- **Agent 錯誤率**: ${kpi ? kpi.businessImpact.agentErrorRate : "N/A"}%
- **平均細化次數**: ${kpi ? kpi.businessImpact.agentRefinementCount : "N/A"}
- **由記憶驅動決策 %**: ${kpi ? kpi.businessImpact.memoryInformedDecisions : "N/A"}%
- **估計生產力提升**: ${kpi ? kpi.businessImpact.estimatedProductivityGain : "N/A"}%

---

## 總結與建議

**系統有效性**: ${summary.isEffective ? "✅ 是" : "❌ 否"}  
**資料可信度**: ${summary.confidence}

### 建議行動
${summary.recommendations.length > 0 ? summary.recommendations.map((r) => `- ${r}`).join("\n") : "- 系統運作良好，無緊急建議"}

---

*報告生成於 ${new Date(report.timestamp).toLocaleString("zh-TW")}*
`;

    return md;
  }

  /**
   * 輸出為 JSON
   */
  formatReportAsJSON(report: ValidationReport): string {
    return JSON.stringify(report, null, 2);
  }

  /**
   * 輔助方法：確保 memory_access_log 表存在
   */
  private ensureAccessLogExists(): void {
    try {
      this.memoryDb.prepare(
        "SELECT 1 FROM memory_access_log LIMIT 1"
      ).get();
    } catch {
      // Table doesn't exist, create it
      this.memoryDb.exec(`
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
      this.memoryDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_access_log_memory ON memory_access_log(memory_id)"
      );
      this.memoryDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_access_log_session ON memory_access_log(session_id)"
      );
      this.memoryDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_access_log_time ON memory_access_log(timestamp)"
      );
      this.memoryDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_access_log_type ON memory_access_log(access_type)"
      );
    }
  }

  /**
   * 輔助方法：計算特定年齡範圍內的記憶命中率
   */
  private calculateMemoryHitRateByAge(
    createdBefore: number,
    createdAfter: number
  ): number {
    const result = this.memoryDb
      .prepare(
        `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN m.id IN (
          SELECT DISTINCT memory_id FROM memory_access_log 
          WHERE access_type IN ('query_hit', 'partial_hit')
        ) THEN 1 ELSE 0 END) as hits
      FROM memories m
      WHERE m.created_at < ? AND m.created_at > ?`
      )
      .get(createdBefore, createdAfter) as {
      total: number;
      hits: number;
    };

    if ((result.total || 0) === 0) return 0;
    return ((result.hits || 0) / result.total) * 100;
  }
}
