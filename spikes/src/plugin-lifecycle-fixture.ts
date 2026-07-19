import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

export type PluginHost = "claude-code" | "codex";
export type PluginFixtureVersion = "0.0.1" | "0.0.2";

export interface PluginLifecycleFixtureIndex {
  schemaVersion: 1;
  platform: "darwin-arm64" | "win32-x64";
  versions: ["0.0.1", "0.0.2"];
  runtimeArtifacts: Record<PluginFixtureVersion, { sha256: string; bytes: number }>;
}

const hosts: readonly PluginHost[] = ["claude-code", "codex"];
const versions: ["0.0.1", "0.0.2"] = ["0.0.1", "0.0.2"];
const pluginName = "navact-lifecycle-spike";
const skill = `---
name: lifecycle-probe
description: Use only when explicitly asked to run the disposable Navact plugin lifecycle health or crash probe.
---

Use only the \`navact_lifecycle\` MCP server.

- For a health probe, call \`navact_spike_health\` exactly once with the nonce supplied by the prompt.
- For a crash/recovery probe, call \`navact_spike_crash\` exactly once. If the host reconnects the server in the same session, call \`navact_spike_health\` exactly once with the recovery nonce.
- Do not run shell commands, edit files, or call any other tool.
`;

function requireAbsolutePath(name: string, value: string): void {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
}

function requireHost(value: string): asserts value is PluginHost {
  if (!hosts.includes(value as PluginHost)) throw new Error(`unsupported plugin host: ${value}`);
}

function requireVersion(value: string): asserts value is PluginFixtureVersion {
  if (!versions.includes(value as PluginFixtureVersion)) throw new Error(`unsupported plugin fixture version: ${value}`);
}

function expectedPlatform(): "darwin-arm64" | "win32-x64" {
  const value = `${process.platform}-${process.arch}`;
  if (value !== "darwin-arm64" && value !== "win32-x64") throw new Error(`unsupported fixture platform: ${value}`);
  return value;
}

function expectedExecutableName(): string {
  return process.platform === "win32" ? "navact-runtime.exe" : "navact-runtime";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function writeJson(path: string, value: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function digest(path: string): Promise<{ sha256: string; bytes: number }> {
  const bytes = await readFile(path);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
}

function pluginManifest(host: PluginHost, version: PluginFixtureVersion): Record<string, unknown> {
  const base = {
    name: pluginName,
    version,
    description: "Disposable Navact Runtime lifecycle evidence.",
    author: { name: "Navact contributors" },
    license: "Apache-2.0",
    skills: "./skills/",
    mcpServers: "./.mcp.json",
  };
  if (host === "claude-code") return base;
  return {
    ...base,
    interface: {
      displayName: "Navact Lifecycle Spike",
      shortDescription: "Verify managed Runtime lifecycle",
      longDescription: "Disposable evidence for installing and managing the Navact Runtime.",
      developerName: "Navact contributors",
      category: "Productivity",
      capabilities: ["Local MCP"],
    },
  };
}

function mcpConfig(host: PluginHost, version: PluginFixtureVersion): Record<string, unknown> {
  const executable = expectedExecutableName();
  if (host === "claude-code") {
    return {
      mcpServers: {
        navact_lifecycle: {
          type: "stdio",
          command: `\${CLAUDE_PLUGIN_ROOT}/bin/${executable}`,
          args: [],
          env: {
            PATH: "",
            NAVACT_SPIKE_HOST: "claude-code",
            NAVACT_SPIKE_PLUGIN_VERSION: version,
            NAVACT_SPIKE_EVIDENCE_PATH: "${NAVACT_SPIKE_EVIDENCE_PATH}",
            NAVACT_SPIKE_RUN_ID: "${NAVACT_SPIKE_RUN_ID}",
          },
        },
      },
    };
  }
  return {
    mcpServers: {
      navact_lifecycle: {
        command: `./bin/${executable}`,
        args: [],
        cwd: ".",
        env: {
          PATH: "",
          NAVACT_SPIKE_HOST: "codex",
          NAVACT_SPIKE_PLUGIN_VERSION: version,
        },
        env_vars: ["NAVACT_SPIKE_EVIDENCE_PATH", "NAVACT_SPIKE_RUN_ID"],
        startup_timeout_sec: 20,
        tool_timeout_sec: 20,
      },
    },
  };
}

async function renderHost(input: {
  artifact: string;
  host: PluginHost;
  outputRoot: string;
  version: PluginFixtureVersion;
}): Promise<string> {
  const hostRoot = join(input.outputRoot, "versions", input.version, input.host);
  const pluginRoot = join(hostRoot, "plugins", pluginName);
  const descriptorDirectory = join(pluginRoot, input.host === "claude-code" ? ".claude-plugin" : ".codex-plugin");
  const executable = join(pluginRoot, "bin", expectedExecutableName());
  await mkdir(join(pluginRoot, "skills", "lifecycle-probe"), { recursive: true });
  await mkdir(descriptorDirectory, { recursive: true });
  await mkdir(join(pluginRoot, "bin"), { recursive: true });
  await copyFile(input.artifact, executable);
  if (process.platform !== "win32") await chmod(executable, 0o500);
  await writeJson(join(descriptorDirectory, "plugin.json"), pluginManifest(input.host, input.version));
  await writeJson(join(pluginRoot, ".mcp.json"), mcpConfig(input.host, input.version));
  await writeFile(join(pluginRoot, "skills", "lifecycle-probe", "SKILL.md"), skill);
  const marketplaceDirectory = input.host === "claude-code"
    ? join(hostRoot, ".claude-plugin")
    : join(hostRoot, ".agents", "plugins");
  await mkdir(marketplaceDirectory, { recursive: true });
  await writeJson(join(marketplaceDirectory, "marketplace.json"), {
    name: input.host === "claude-code" ? "navact-lifecycle-spike-claude" : "navact-lifecycle-spike-codex",
    plugins: [{ name: pluginName, source: `./plugins/${pluginName}` }],
  });
  return executable;
}

export function parsePluginLifecycleFixtureIndex(value: unknown): PluginLifecycleFixtureIndex {
  if (!isObject(value) || !hasExactKeys(value, ["schemaVersion", "platform", "versions", "runtimeArtifacts"])) {
    throw new Error("invalid plugin lifecycle fixture index keys");
  }
  if (value.schemaVersion !== 1) throw new Error("unsupported plugin lifecycle fixture index schema");
  if (value.platform !== "darwin-arm64" && value.platform !== "win32-x64") throw new Error("unsupported plugin lifecycle fixture platform");
  if (!Array.isArray(value.versions) || value.versions.length !== 2 || value.versions[0] !== "0.0.1" || value.versions[1] !== "0.0.2") {
    throw new Error("invalid plugin lifecycle fixture versions");
  }
  if (!isObject(value.runtimeArtifacts) || !hasExactKeys(value.runtimeArtifacts, versions)) {
    throw new Error("invalid plugin lifecycle fixture runtime artifacts");
  }
  const runtimeArtifacts = {} as PluginLifecycleFixtureIndex["runtimeArtifacts"];
  for (const version of versions) {
    const artifact = value.runtimeArtifacts[version];
    if (!isObject(artifact) || !hasExactKeys(artifact, ["sha256", "bytes"]) ||
      typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      typeof artifact.bytes !== "number" || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
      throw new Error(`invalid plugin lifecycle fixture artifact: ${version}`);
    }
    runtimeArtifacts[version] = { sha256: artifact.sha256, bytes: artifact.bytes };
  }
  if (runtimeArtifacts["0.0.1"].sha256 === runtimeArtifacts["0.0.2"].sha256) {
    throw new Error("plugin lifecycle fixture versions must have distinct artifacts");
  }
  return {
    schemaVersion: 1,
    platform: value.platform,
    versions: ["0.0.1", "0.0.2"],
    runtimeArtifacts,
  };
}

export async function buildPluginLifecycleFixtures(input: {
  artifacts: Record<PluginFixtureVersion, string>;
  outputRoot: string;
  platform: "darwin-arm64" | "win32-x64";
}): Promise<PluginLifecycleFixtureIndex> {
  requireAbsolutePath("outputRoot", input.outputRoot);
  if (input.platform !== expectedPlatform()) throw new Error(`fixture platform does not match current process: ${input.platform}`);
  const executableName = expectedExecutableName();
  for (const version of versions) {
    const artifact = input.artifacts[version];
    requireAbsolutePath(`artifacts.${version}`, artifact);
    if (basename(artifact) !== executableName) throw new Error(`unexpected Runtime artifact name: ${basename(artifact)}`);
    const metadata = await stat(artifact);
    if (!metadata.isFile()) throw new Error(`Runtime artifact is not a regular file: ${artifact}`);
  }
  const runtimeArtifacts = {
    "0.0.1": await digest(input.artifacts["0.0.1"]),
    "0.0.2": await digest(input.artifacts["0.0.2"]),
  };
  if (runtimeArtifacts["0.0.1"].sha256 === runtimeArtifacts["0.0.2"].sha256) {
    throw new Error("plugin lifecycle fixture versions must have distinct artifacts");
  }
  await rm(join(input.outputRoot, "versions"), { recursive: true, force: true });
  await rm(join(input.outputRoot, "active"), { recursive: true, force: true });
  await mkdir(join(input.outputRoot, "versions"), { recursive: true });
  await mkdir(join(input.outputRoot, "active"), { recursive: true });
  for (const version of versions) {
    for (const host of hosts) {
      const executable = await renderHost({ artifact: input.artifacts[version], host, outputRoot: input.outputRoot, version });
      const copied = await digest(executable);
      if (copied.sha256 !== runtimeArtifacts[version].sha256) throw new Error(`cross-host Runtime digest mismatch: ${host} ${version}`);
    }
  }
  const index = parsePluginLifecycleFixtureIndex({ schemaVersion: 1, platform: input.platform, versions, runtimeArtifacts });
  await writeJson(join(input.outputRoot, "fixture-index.json"), index);
  return index;
}

export async function activatePluginFixtureVersion(input: {
  outputRoot: string;
  host: PluginHost;
  version: PluginFixtureVersion;
}): Promise<string> {
  requireAbsolutePath("outputRoot", input.outputRoot);
  requireHost(input.host);
  requireVersion(input.version);
  const source = join(input.outputRoot, "versions", input.version, input.host);
  const sourceMetadata = await stat(source);
  if (!sourceMetadata.isDirectory()) throw new Error(`plugin fixture source is not a directory: ${source}`);
  const active = join(input.outputRoot, "active", input.host);
  await rm(active, { recursive: true, force: true });
  await mkdir(join(input.outputRoot, "active"), { recursive: true });
  await cp(source, active, { recursive: true });
  if (process.platform !== "win32") {
    await chmod(join(active, "plugins", pluginName, "bin", expectedExecutableName()), 0o500);
  }
  return active;
}
