import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export interface HealthServerLifecycle {
  onHealth(nonce: string): void;
  onCrashRequested(): void;
}

export function buildHealthServer(lifecycle?: HealthServerLifecycle): McpServer {
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
      lifecycle?.onHealth(nonce);
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
  server.registerTool(
    "navact_spike_crash",
    {
      description: "Terminate the disposable Runtime lifecycle spike after acknowledging the request.",
      inputSchema: {},
      outputSchema: {
        status: z.literal("crash-scheduled"),
        pid: z.number().int().positive(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      lifecycle?.onCrashRequested();
      const output = { status: "crash-scheduled" as const, pid: process.pid };
      setTimeout(() => process.exit(86), 100);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
  return server;
}

export async function startHealthServer(lifecycle?: HealthServerLifecycle): Promise<void> {
  await buildHealthServer(lifecycle).connect(new StdioServerTransport());
}
