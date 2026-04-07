import { describe, it, expect } from "bun:test";
import MemoryPlugin from "./index";

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

const mockInput = {
  directory: "/tmp/test",
} as Parameters<typeof MemoryPlugin>[0];

describe("Tool Name Validation", () => {
  it("all registered tools must match Anthropic API naming constraints", async () => {
    const plugin = await MemoryPlugin(mockInput);
    const tools = plugin.tool ?? {};

    const invalidTools: string[] = [];
    for (const name of Object.keys(tools)) {
      if (!TOOL_NAME_PATTERN.test(name)) {
        invalidTools.push(name);
      }
    }

    expect(invalidTools).toHaveLength(0);
  });

  it("no tool name should contain colon (:) which is not allowed by Anthropic", async () => {
    const plugin = await MemoryPlugin(mockInput);
    const tools = plugin.tool ?? {};

    const colonTools: string[] = [];
    for (const name of Object.keys(tools)) {
      if (name.includes(":")) {
        colonTools.push(name);
      }
    }

    expect(colonTools).toHaveLength(0);
  });

  it("all tool names should be <= 128 characters", async () => {
    const plugin = await MemoryPlugin(mockInput);
    const tools = plugin.tool ?? {};

    const tooLong: string[] = [];
    for (const name of Object.keys(tools)) {
      if (name.length > 128) {
        tooLong.push(`${name} (${name.length} chars)`);
      }
    }

    expect(tooLong).toHaveLength(0);
  });

  it("owl_status tool should use snake_case, not colon notation", async () => {
    const plugin = await MemoryPlugin(mockInput);
    const tools = plugin.tool ?? {};

    expect(tools).toHaveProperty("owl_status");
    expect(tools).not.toHaveProperty("owl:status");
  });
});
