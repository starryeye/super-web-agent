import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export function buildHealthServer(): McpServer {
  const server = new McpServer({ name: "navact-runtime-spike", version: "0.0.0-spike" });
  server.registerTool(
    "navact_spike_health",
    {
      description: "Return disposable Runtime artifact-spike health.",
      inputSchema: { nonce: z.string().min(1) },
      outputSchema: {
        status: z.literal("ok"),
        nonce: z.string(),
        pid: z.number().int().positive(),
        platform: z.string(),
      },
    },
    async ({ nonce }) => {
      const output = {
        status: "ok" as const,
        nonce,
        pid: process.pid,
        platform: `${process.platform}-${process.arch}`,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
  return server;
}

export async function startHealthServer(): Promise<void> {
  await buildHealthServer().connect(new StdioServerTransport());
}
