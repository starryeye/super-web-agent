import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  activatePluginFixtureVersion,
  buildPluginLifecycleFixtures,
  parsePluginLifecycleFixtureIndex,
} from "../src/plugin-lifecycle-fixture.js";

const directories: string[] = [];
const versions = ["0.0.1", "0.0.2"] as const;
const hosts = ["claude-code", "codex"] as const;
const skill = `---
name: lifecycle-probe
description: Use only when explicitly asked to run the disposable Navact plugin lifecycle health or crash probe.
---

Use only the \`navact_lifecycle\` MCP server.

- For a health probe, call \`navact_spike_health\` exactly once with the nonce supplied by the prompt.
- For a crash/recovery probe, call \`navact_spike_crash\` exactly once. If the host reconnects the server in the same session, call \`navact_spike_health\` exactly once with the recovery nonce.
- Do not run shell commands, edit files, or call any other tool.
`;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "navact-plugin-fixture-"));
  directories.push(directory);
  const executableName = process.platform === "win32" ? "navact-runtime.exe" : "navact-runtime";
  const v1 = join(directory, "runtime-v1", executableName);
  const v2 = join(directory, "runtime-v2", executableName);
  await mkdir(join(directory, "runtime-v1"));
  await mkdir(join(directory, "runtime-v2"));
  await writeFile(v1, "self-contained-runtime-v1");
  await writeFile(v2, "self-contained-runtime-v2");
  return { directory, executableName, v1, v2 };
}

function platform(): "darwin-arm64" | "win32-x64" {
  return `${process.platform}-${process.arch}` as "darwin-arm64" | "win32-x64";
}

function validIndex(): unknown {
  return {
    schemaVersion: 1,
    platform: platform(),
    versions: ["0.0.1", "0.0.2"],
    runtimeArtifacts: {
      "0.0.1": { sha256: "a".repeat(64), bytes: 1 },
      "0.0.2": { sha256: "b".repeat(64), bytes: 2 },
    },
  };
}

it.each([
  ["an unknown top-level key", () => ({ ...(validIndex() as Record<string, unknown>), unknown: true })],
  ["a missing top-level key", () => {
    const { platform: _platform, ...withoutPlatform } = validIndex() as Record<string, unknown>;
    return withoutPlatform;
  }],
  ["an unsupported platform", () => ({ ...(validIndex() as Record<string, unknown>), platform: "linux-x64" })],
  ["a zero byte count", () => ({ ...(validIndex() as Record<string, unknown>), runtimeArtifacts: { "0.0.1": { sha256: "a".repeat(64), bytes: 0 }, "0.0.2": { sha256: "b".repeat(64), bytes: 2 } } })],
  ["a negative byte count", () => ({ ...(validIndex() as Record<string, unknown>), runtimeArtifacts: { "0.0.1": { sha256: "a".repeat(64), bytes: -1 }, "0.0.2": { sha256: "b".repeat(64), bytes: 2 } } })],
  ["a malformed digest", () => ({ ...(validIndex() as Record<string, unknown>), runtimeArtifacts: { "0.0.1": { sha256: "not-a-digest", bytes: 1 }, "0.0.2": { sha256: "b".repeat(64), bytes: 2 } } })],
  ["equal version digests", () => ({ ...(validIndex() as Record<string, unknown>), runtimeArtifacts: { "0.0.1": { sha256: "a".repeat(64), bytes: 1 }, "0.0.2": { sha256: "a".repeat(64), bytes: 2 } } })],
  ["a reordered version tuple", () => ({ ...(validIndex() as Record<string, unknown>), versions: ["0.0.2", "0.0.1"] })],
] as const)("rejects %s in a fixture index", (_reason, createValue) => {
  expect(() => parsePluginLifecycleFixtureIndex(createValue())).toThrow();
});

it("rejects invalid fixture build inputs before rendering", async () => {
  const value = await fixture();
  const outputRoot = join(value.directory, "output");
  const base = { artifacts: { "0.0.1": value.v1, "0.0.2": value.v2 }, outputRoot, platform: platform() };
  const wrongName = join(value.directory, "wrong-name");
  const directoryArtifact = join(value.directory, "directory-artifact", value.executableName);
  const equalArtifact = join(value.directory, "equal", value.executableName);
  await writeFile(wrongName, "wrong-name");
  await mkdir(directoryArtifact, { recursive: true });
  await mkdir(join(value.directory, "equal"));
  await writeFile(equalArtifact, "same-runtime");
  const otherPlatform = platform() === "darwin-arm64" ? "win32-x64" : "darwin-arm64";
  const relativeOutputName = `navact-relative-output-${process.pid}-${directories.length}`;
  const relativeOutputPath = join(process.cwd(), relativeOutputName);
  directories.push(relativeOutputPath);
  await rm(relativeOutputPath, { recursive: true, force: true });
  await expect(buildPluginLifecycleFixtures({ ...base, outputRoot: relativeOutputName })).rejects.toThrow("outputRoot must be an absolute path");
  await expect(stat(relativeOutputPath)).rejects.toThrow();
  await expect(buildPluginLifecycleFixtures({ ...base, artifacts: { ...base.artifacts, "0.0.1": "relative-runtime" } })).rejects.toThrow("artifacts.0.0.1 must be an absolute path");
  await expect(buildPluginLifecycleFixtures({ ...base, platform: otherPlatform })).rejects.toThrow("fixture platform does not match current process");
  await expect(buildPluginLifecycleFixtures({ ...base, artifacts: { ...base.artifacts, "0.0.1": wrongName } })).rejects.toThrow("unexpected Runtime artifact name");
  await expect(buildPluginLifecycleFixtures({ ...base, artifacts: { ...base.artifacts, "0.0.1": directoryArtifact } })).rejects.toThrow("Runtime artifact is not a regular file");
  await expect(buildPluginLifecycleFixtures({ ...base, artifacts: { "0.0.1": equalArtifact, "0.0.2": equalArtifact } })).rejects.toThrow("versions must have distinct artifacts");
});

it("uses identical Runtime bytes across hosts but distinct bytes across versions", async () => {
  const value = await fixture();
  const index = await buildPluginLifecycleFixtures({
    artifacts: { "0.0.1": value.v1, "0.0.2": value.v2 },
    outputRoot: join(value.directory, "output"),
    platform: platform(),
  });
  expect(index.versions).toEqual(["0.0.1", "0.0.2"]);
  expect(parsePluginLifecycleFixtureIndex(JSON.parse(
    await readFile(join(value.directory, "output", "fixture-index.json"), "utf8"),
  ))).toEqual(index);
  expect(index.runtimeArtifacts["0.0.1"].sha256).not.toBe(index.runtimeArtifacts["0.0.2"].sha256);
  for (const version of versions) {
    const expectedDigest = createHash("sha256")
      .update(await readFile(version === "0.0.1" ? value.v1 : value.v2))
      .digest("hex");
    expect(index.runtimeArtifacts[version].sha256).toBe(expectedDigest);
    for (const host of hosts) {
      const executable = join(
        value.directory,
        "output",
        "versions",
        version,
        host,
        "plugins",
        "navact-lifecycle-spike",
        "bin",
        value.executableName,
      );
      expect(createHash("sha256").update(await readFile(executable)).digest("hex")).toBe(expectedDigest);
      if (process.platform !== "win32") {
        expect((await stat(executable)).mode & 0o111).not.toBe(0);
      }
    }
  }
});

it("renders host-specific cache-safe MCP launch paths with an empty PATH", async () => {
  const value = await fixture();
  await buildPluginLifecycleFixtures({
    artifacts: { "0.0.1": value.v1, "0.0.2": value.v2 },
    outputRoot: join(value.directory, "output"),
    platform: platform(),
  });
  const claude = JSON.parse(
    await readFile(join(value.directory, "output", "versions", "0.0.1", "claude-code", "plugins", "navact-lifecycle-spike", ".mcp.json"), "utf8"),
  );
  const codex = JSON.parse(
    await readFile(join(value.directory, "output", "versions", "0.0.1", "codex", "plugins", "navact-lifecycle-spike", ".mcp.json"), "utf8"),
  );
  expect(claude.mcpServers.navact_lifecycle.command).toBe(
    `\${CLAUDE_PLUGIN_ROOT}/bin/${value.executableName}`,
  );
  expect(claude.mcpServers.navact_lifecycle.env.PATH).toBe("");
  expect(codex.mcpServers.navact_lifecycle).toMatchObject({
    command: `./bin/${value.executableName}`,
    cwd: ".",
    env: { PATH: "", NAVACT_SPIKE_HOST: "codex" },
    env_vars: ["NAVACT_SPIKE_EVIDENCE_PATH", "NAVACT_SPIKE_RUN_ID"],
  });
  const marketplace = JSON.parse(
    await readFile(join(value.directory, "output", "versions", "0.0.1", "codex", ".agents", "plugins", "marketplace.json"), "utf8"),
  );
  expect(marketplace).toMatchObject({
    name: "navact-lifecycle-spike-codex",
    plugins: [{ name: "navact-lifecycle-spike", source: "./plugins/navact-lifecycle-spike" }],
  });
});

it("renders complete Claude and Codex fixtures for both versions", async () => {
  const value = await fixture();
  const outputRoot = join(value.directory, "output");
  await buildPluginLifecycleFixtures({ artifacts: { "0.0.1": value.v1, "0.0.2": value.v2 }, outputRoot, platform: platform() });
  for (const version of versions) {
    const claudeRoot = join(outputRoot, "versions", version, "claude-code");
    const codexRoot = join(outputRoot, "versions", version, "codex");
    const claudePlugin = join(claudeRoot, "plugins", "navact-lifecycle-spike");
    const codexPlugin = join(codexRoot, "plugins", "navact-lifecycle-spike");
    expect(JSON.parse(await readFile(join(claudePlugin, ".claude-plugin", "plugin.json"), "utf8"))).toEqual({
      name: "navact-lifecycle-spike", version, description: "Disposable Navact Runtime lifecycle evidence.", author: { name: "Navact contributors" }, license: "Apache-2.0", skills: "./skills/", mcpServers: "./.mcp.json",
    });
    expect(JSON.parse(await readFile(join(claudePlugin, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: { navact_lifecycle: { type: "stdio", command: `\${CLAUDE_PLUGIN_ROOT}/bin/${value.executableName}`, args: [], env: { PATH: "", NAVACT_SPIKE_HOST: "claude-code", NAVACT_SPIKE_PLUGIN_VERSION: version, NAVACT_SPIKE_EVIDENCE_PATH: "${NAVACT_SPIKE_EVIDENCE_PATH}", NAVACT_SPIKE_RUN_ID: "${NAVACT_SPIKE_RUN_ID}" } } },
    });
    expect(JSON.parse(await readFile(join(claudeRoot, ".claude-plugin", "marketplace.json"), "utf8"))).toEqual({ name: "navact-lifecycle-spike-claude", plugins: [{ name: "navact-lifecycle-spike", source: "./plugins/navact-lifecycle-spike" }] });
    expect(JSON.parse(await readFile(join(codexPlugin, ".codex-plugin", "plugin.json"), "utf8"))).toEqual({
      name: "navact-lifecycle-spike", version, description: "Disposable Navact Runtime lifecycle evidence.", author: { name: "Navact contributors" }, license: "Apache-2.0", skills: "./skills/", mcpServers: "./.mcp.json",
      interface: { displayName: "Navact Lifecycle Spike", shortDescription: "Verify managed Runtime lifecycle", longDescription: "Disposable evidence for installing and managing the Navact Runtime.", developerName: "Navact contributors", category: "Productivity", capabilities: ["Local MCP"] },
    });
    expect(JSON.parse(await readFile(join(codexPlugin, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: { navact_lifecycle: { command: `./bin/${value.executableName}`, args: [], cwd: ".", env: { PATH: "", NAVACT_SPIKE_HOST: "codex", NAVACT_SPIKE_PLUGIN_VERSION: version }, env_vars: ["NAVACT_SPIKE_EVIDENCE_PATH", "NAVACT_SPIKE_RUN_ID"], startup_timeout_sec: 20, tool_timeout_sec: 20 } },
    });
    expect(JSON.parse(await readFile(join(codexRoot, ".agents", "plugins", "marketplace.json"), "utf8"))).toEqual({ name: "navact-lifecycle-spike-codex", plugins: [{ name: "navact-lifecycle-spike", source: "./plugins/navact-lifecycle-spike" }] });
    expect(await readFile(join(claudePlugin, "skills", "lifecycle-probe", "SKILL.md"), "utf8")).toBe(skill);
    expect(await readFile(join(codexPlugin, "skills", "lifecycle-probe", "SKILL.md"), "utf8")).toBe(skill);
  }
});

it("activates one complete version without linking to its source directory", async () => {
  const value = await fixture();
  await buildPluginLifecycleFixtures({
    artifacts: { "0.0.1": value.v1, "0.0.2": value.v2 },
    outputRoot: join(value.directory, "output"),
    platform: platform(),
  });
  const active = await activatePluginFixtureVersion({
    outputRoot: join(value.directory, "output"),
    host: "codex",
    version: "0.0.2",
  });
  expect(JSON.parse(await readFile(join(active, "plugins", "navact-lifecycle-spike", ".codex-plugin", "plugin.json"), "utf8"))).toMatchObject({
    name: "navact-lifecycle-spike",
    version: "0.0.2",
    mcpServers: "./.mcp.json",
  });
});

it("activates an isolated copy rather than a source alias", async () => {
  const value = await fixture();
  const outputRoot = join(value.directory, "output");
  await buildPluginLifecycleFixtures({ artifacts: { "0.0.1": value.v1, "0.0.2": value.v2 }, outputRoot, platform: platform() });
  const active = await activatePluginFixtureVersion({ outputRoot, host: "codex", version: "0.0.2" });
  const sourceManifest = join(outputRoot, "versions", "0.0.2", "codex", "plugins", "navact-lifecycle-spike", ".codex-plugin", "plugin.json");
  const activeManifest = join(active, "plugins", "navact-lifecycle-spike", ".codex-plugin", "plugin.json");
  expect((await lstat(active)).isSymbolicLink()).toBe(false);
  const sourceBytes = await readFile(sourceManifest, "utf8");
  await writeFile(activeManifest, "{\"active\":true}\n");
  expect(await readFile(sourceManifest, "utf8")).toBe(sourceBytes);
});
