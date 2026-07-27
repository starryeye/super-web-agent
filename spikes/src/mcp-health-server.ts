import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export interface RuntimeIdentity {
  readonly runtimeSessionId: string;
  readonly runtimeBuildId: string;
}

export interface HealthServerLifecycle {
  readonly onCrashRequested?: () => void;
}

export function buildHealthServer(identity: RuntimeIdentity, lifecycle?: HealthServerLifecycle): McpServer {
  const server = new McpServer({
    name: "super-web-agent-runtime-spike",
    version: "0.0.0-spike",
  });
  server.registerTool(
    "swa_spike_health",
    {
      description: "Return disposable SWA Runtime artifact-spike health.",
      inputSchema: { nonce: z.string().min(1) },
      outputSchema: {
        status: z.literal("ok"),
        nonce: z.string(),
        pid: z.number().int().positive(),
        platform: z.string(),
        runtimeSessionId: z.string(),
        runtimeBuildId: z.string(),
      },
    },
    async ({ nonce }) => {
      const output = {
        status: "ok" as const,
        nonce,
        pid: process.pid,
        platform: `${process.platform}-${process.arch}`,
        ...identity,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
  server.registerTool(
    "swa_spike_bridge_status",
    {
      description: "Return the deterministic pre-bridge Runtime status.",
      inputSchema: {},
      outputSchema: {
        runtime: z.literal("ready"),
        bridge: z.object({ state: z.literal("not-installed") }),
      },
    },
    async () => {
      const output = {
        runtime: "ready" as const,
        bridge: { state: "not-installed" as const },
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
  server.registerTool(
    "swa_spike_crash",
    {
      description: "Schedule the disposable SWA Runtime to exit for lifecycle evidence.",
      inputSchema: {},
      outputSchema: {
        status: z.literal("crash-scheduled"),
        pid: z.number().int().positive(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const output = {
        status: "crash-scheduled" as const,
        pid: process.pid,
      };
      if (lifecycle?.onCrashRequested !== undefined) {
        lifecycle.onCrashRequested();
      } else {
        setTimeout(() => process.exit(86), 50).unref();
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
  return server;
}

export async function startHealthServer(identity: RuntimeIdentity, lifecycle?: HealthServerLifecycle): Promise<void> {
  await buildHealthServer(identity, lifecycle).connect(new StdioServerTransport());
}
