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

  getColorCode(color: string): string {
    const codes: Record<string, string> = {
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      red: "\x1b[31m",
      gray: "\x1b[90m",
    };
    return codes[color] ?? "\x1b[90m";
  }

  getResetCode(): string {
    return "\x1b[0m";
  }

  formatTooltip(tooltip: TUIStatusResponse["tooltip"]): string {
    return [tooltip.title, ...tooltip.lines].join("\n");
  }
}

export async function tuiPlugin(api: any, options: any, meta: any): Promise<void> {
  const statusManager = new OwlStatusManager();
  let cachedStatusText = "owl (…)";
  let cachedColor = "gray";

  const updateStatusDisplay = async () => {
    const status = await statusManager.getStatus();
    if (status) {
      cachedStatusText = status.label;
      cachedColor = status.color;
    } else {
      cachedStatusText = "owl (—)";
      cachedColor = "gray";
    }
  };

  api.slots.register({
    name: "owl_status_provider",
    render: () => {
      const colorCode = statusManager.getColorCode(cachedColor);
      const resetCode = statusManager.getResetCode();
      return `${colorCode}${cachedStatusText}${resetCode}`;
    },
    slots: {},
  });

  const unregisterCommand = api.command.register(() => [
    {
      title: "Refresh Owl Memory Status",
      value: "owl:refresh-status",
      category: "owl",
      description: "Force refresh memory system status",
      onSelect: async () => {
        await updateStatusDisplay();
        console.log(`[Owl] Status refreshed: ${cachedStatusText}`);
      },
    },
  ]);

  api.lifecycle.onDispose(unregisterCommand);

  await updateStatusDisplay();

  setImmediate(() => {
    const intervalId = setInterval(updateStatusDisplay, 60000);
    api.lifecycle.onDispose(() => clearInterval(intervalId));
  });
}

export default tuiPlugin;
