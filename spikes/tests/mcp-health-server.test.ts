import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

it("answers a real MCP tool call over stdio", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/src/mcp-health-entry.js")],
    stderr: "pipe",
  });
  client = new Client({
    name: "super-web-agent-spike-test",
    version: "0.0.0",
  });
  await client.connect(transport);
  expect(client.getServerVersion()).toMatchObject({
    name: "super-web-agent-runtime-spike",
    version: "0.0.0-spike",
  });
  const tools = await client.listTools();
  expect(tools.tools).toContainEqual(
    expect.objectContaining({
      name: "swa_spike_health",
      description: "Return disposable SWA Runtime artifact-spike health.",
    }),
  );
  const result = await client.callTool({
    name: "swa_spike_health",
    arguments: { nonce: "n-1" },
  });
  expect(result.structuredContent).toMatchObject({
    status: "ok",
    nonce: "n-1",
    platform: `${process.platform}-${process.arch}`,
  });
});
