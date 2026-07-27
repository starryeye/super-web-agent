import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildHealthServer } from "../src/mcp-health-server.js";

let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

it("returns process identity and the deterministic pre-bridge state", async () => {
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
  const first = await client.callTool({
    name: "swa_spike_health",
    arguments: { nonce: "n-1" },
  });
  expect(first.structuredContent).toMatchObject({
    status: "ok",
    nonce: "n-1",
    platform: `${process.platform}-${process.arch}`,
    runtimeSessionId: expect.stringMatching(/^rt_[0-9a-f]{32}$/),
    runtimeBuildId: "direct-test",
  });
  const firstIdentity = first.structuredContent as { pid: number; runtimeSessionId: string } | undefined;
  expect(firstIdentity?.pid).toEqual(expect.any(Number));
  expect(Number.isInteger(firstIdentity?.pid)).toBe(true);
  expect(firstIdentity?.pid).toBeGreaterThan(0);

  const second = await client.callTool({
    name: "swa_spike_health",
    arguments: { nonce: "n-2" },
  });
  expect(second.structuredContent).toMatchObject({
    pid: firstIdentity?.pid,
    runtimeSessionId: firstIdentity?.runtimeSessionId,
  });

  const bridge = await client.callTool({
    name: "swa_spike_bridge_status",
    arguments: {},
  });
  expect(bridge.structuredContent).toEqual({
    runtime: "ready",
    bridge: { state: "not-installed" },
  });
});

it("acknowledges the closed crash tool through the safe lifecycle callback", async () => {
  const onCrashRequested = vi.fn();
  const server = buildHealthServer(
    {
      runtimeSessionId: "rt_0123456789abcdef0123456789abcdef",
      runtimeBuildId: "direct-test",
    },
    { onCrashRequested },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const crashClient = new Client({
    name: "super-web-agent-crash-tool-test",
    version: "0.0.0",
  });

  try {
    await Promise.all([
      server.connect(serverTransport),
      crashClient.connect(clientTransport),
    ]);
    const tools = await crashClient.listTools();
    expect(tools.tools.map(({ name }) => name)).toEqual([
      "swa_spike_health",
      "swa_spike_bridge_status",
      "swa_spike_crash",
    ]);
    expect(tools.tools[2]?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });

    const crash = await crashClient.callTool({
      name: "swa_spike_crash",
      arguments: {},
    });

    expect(crash.structuredContent).toEqual({
      status: "crash-scheduled",
      pid: process.pid,
    });
    expect(onCrashRequested).toHaveBeenCalledOnce();
  } finally {
    await crashClient.close();
    await server.close();
  }
});
