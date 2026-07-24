import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseLifecycleEventLine } from "../src/lifecycle-events.js";
import { RuntimeStdioTransport } from "../src/runtime-stdio-transport.js";

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

it("records start, health, and exit without writing diagnostics to stdout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "navact-health-evidence-"));
  const evidencePath = join(directory, "events.jsonl");
  const transport = new RuntimeStdioTransport({
    command: process.execPath,
    args: [resolve("dist/src/mcp-health-entry.js")],
    stderr: "pipe",
    env: {
      NAVACT_SPIKE_EVIDENCE_PATH: evidencePath,
      NAVACT_SPIKE_HOST: "codex",
      NAVACT_SPIKE_RUN_ID: "health-journal",
      NAVACT_SPIKE_PLUGIN_VERSION: "0.0.1",
    },
  });
  const evidenceClient = new Client({ name: "navact-lifecycle-test", version: "0.0.0" });
  try {
    await evidenceClient.connect(transport);
    await evidenceClient.callTool({ name: "navact_spike_health", arguments: { nonce: "journal-1" } });
    await evidenceClient.close();
    const events = (await readFile(evidencePath, "utf8")).trim().split("\n").map(parseLifecycleEventLine);
    expect(events.map((event) => event.event)).toEqual(["started", "health", "exiting"]);
    expect(events[0]).toMatchObject({
      executablePath: process.execPath,
      host: "codex",
      runtimeBuildId: "direct-test",
    });
    expect(events[1]).toMatchObject({ nonce: "journal-1", host: "codex" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("records an induced crash and exits with the reserved code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "navact-crash-evidence-"));
  const evidencePath = join(directory, "events.jsonl");
  const transport = new RuntimeStdioTransport({
    command: process.execPath,
    args: [resolve("dist/src/mcp-health-entry.js")],
    stderr: "pipe",
    env: {
      NAVACT_SPIKE_EVIDENCE_PATH: evidencePath,
      NAVACT_SPIKE_HOST: "claude-code",
      NAVACT_SPIKE_RUN_ID: "crash-journal",
      NAVACT_SPIKE_PLUGIN_VERSION: "0.0.1",
    },
  });
  const crashClient = new Client({ name: "navact-lifecycle-test", version: "0.0.0" });
  try {
    await crashClient.connect(transport);
    await expect(
      crashClient.callTool({ name: "navact_spike_crash", arguments: {} }),
    ).resolves.toMatchObject({ structuredContent: { status: "crash-scheduled" } });
    const deadline = Date.now() + 2_000;
    while (!transport.exitObserved && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    expect(transport.exitObservation).toMatchObject({ code: 86, signal: null, premature: true });
    const events = (await readFile(evidencePath, "utf8")).trim().split("\n").map(parseLifecycleEventLine);
    expect(events.map((event) => event.event)).toEqual(["started", "crash-requested", "exiting"]);
  } finally {
    await crashClient.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
