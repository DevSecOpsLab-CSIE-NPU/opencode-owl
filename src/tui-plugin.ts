import type { Hooks } from "@opencode-ai/plugin";
import { z } from "zod";

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
  cache?: {
    isCached: boolean;
    age: number;
    ttl: number;
  };
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

  formatStatusLine(status: TUIStatusResponse): string {
    const emoji = this.getStatusEmoji(status.color);
    return `${emoji} owl ${status.label.replace("owl ", "")}`;
  }

  private getStatusEmoji(color: string): string {
    const emojis: Record<string, string> = {
      green: "✅",
      yellow: "⚠️",
      red: "❌",
      gray: "⊙",
    };
    return emojis[color] ?? "⊙";
  }

  formatTooltip(status: TUIStatusResponse): string {
    return [status.tooltip.title, "", ...status.tooltip.lines].join("\n");
  }
}

const statusManager = new OwlStatusManager();
let cachedStatus: TUIStatusResponse | null = null;
let lastStatusFetch = 0;

async function refreshStatus(): Promise<void> {
  const now = Date.now();
  if (lastStatusFetch && now - lastStatusFetch < 1000) return;
  lastStatusFetch = now;
  cachedStatus = await statusManager.getStatus();
}

refreshStatus().catch(err => console.error("[Owl] Init error:", err));
setInterval(() => refreshStatus().catch(err => console.error("[Owl] Refresh error:", err)), 60000);

export default async function MemoryPlugin(): Promise<Hooks> {
  return {
    tool: {
      "owl:status": {
        description: "Get OpenCode-Owl memory system status",
        args: z.object({}).passthrough() as any,
        execute: async () => {
          if (!cachedStatus) {
            await refreshStatus();
          }

          const status = cachedStatus ?? (await statusManager.getStatus());
          if (status) {
            cachedStatus = status;
            const lines = [
              `Status: ${status.label}`,
              `Hit Rate: ${(status.hitRate * 100).toFixed(1)}%`,
              `Available: ${status.isAvailable ? "✅" : "❌"}`,
              "",
              statusManager.formatTooltip(status),
            ];
            return lines.join("\n");
          }
          return "Error: Failed to fetch memory status. Check if MCP server is running on port 3100.";
        },
      },
    },
  };
}
