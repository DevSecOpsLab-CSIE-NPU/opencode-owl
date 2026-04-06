#!/bin/bash
set -e

echo "============================================"
echo "opencode-owl v1.2.6 Hit-Rate Tracking Tests"
echo "============================================"
echo ""

echo "📦 Building test environment..."
echo "Node version: $(node --version 2>/dev/null || echo 'N/A')"
echo "Bun version: $(bun --version)"
echo "Working directory: $(pwd)"
echo ""

echo "🧪 Running test suite: src/hitrate.test.ts"
echo "-------------------------------------------"

bun test src/hitrate.test.ts --timeout 30000

echo ""
echo "✅ Test execution completed"
echo ""
echo "Summary:"
echo "  - Test file: src/hitrate.test.ts"
echo "  - Framework: bun:test"
echo "  - Database: SQLite (in-memory)"
echo ""
echo "Test Cases:"
echo "  1. 建立 memory_access_log 表"
echo "  2. memory_access_log 索引完整"
echo "  3. 記錄查詢命中 (query_hit)"
echo "  4. 記錄查詢未命中 (query_miss)"
echo "  5. 記錄部分命中 (partial_hit, rank > 3)"
echo "  6. 計算命中率 (getHitRate)"
echo "  7. 時間窗口過濾"
echo "  8. 分析頂部命中記憶"
echo "  9. 檢測未命中模式"
echo " 10. 平均相關分數計算"
echo " 11. 強化記憶記錄 (reinforced)"
echo ""
echo "============================================"
