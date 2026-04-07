import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const tui: TuiPlugin = async (api) => {
  let cachedStatus = { hitRate: 0, color: "gray", label: "owl (0.0%)" }

  const fetchStatus = async () => {
    try {
      const res = await fetch("http://localhost:3100/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "memory_tui_status",
          params: {},
          id: 1,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.result?.label) cachedStatus = data.result
      }
    } catch (e) {
      console.error("[Owl] Fetch error:", e)
    }
  }

  await fetchStatus()

  const colorMap: Record<string, string> = {
    green: "#10b981",
    yellow: "#f59e0b",
    red: "#ef4444",
    gray: "#888",
  }

  api.slots.register({
    slots: {
      home_footer() {
        fetchStatus().catch(() => {})

        return {
          type: "text" as const,
          props: { fg: colorMap[cachedStatus.color] || "#888" },
          text: `🦉 ${cachedStatus.label}`,
        } as any
      },
    },
  })

  api.command.register(() => [
    {
      title: `🦉 ${cachedStatus.label}`,
      value: "owl.status",
      category: "Memory",
      onSelect: async () => {
        await fetchStatus()
        api.ui.toast({
          message: `Hit Rate: ${cachedStatus.label}`,
          variant: "info" as const,
        })
      },
    },
  ])

  setInterval(fetchStatus, 30000)
}

const id = "owl.memory-status"

export default { id, tui } satisfies TuiPluginModule & { id: string }
