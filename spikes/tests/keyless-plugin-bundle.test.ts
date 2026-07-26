import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseBuildKeylessPluginFixtureArgs } from "../scripts/build-keyless-plugin-fixtures.js";
import {
  buildKeylessPluginFixtures,
  parseKeylessPluginFixtureIndex,
  resolveKeylessPluginLaunch,
  stageKeylessPluginVersion,
  type KeylessPluginFixtureIndex,
  type PluginFixtureVersion,
} from "../src/keyless-plugin-bundle.js";
import {
  canonicalManifestPayload,
  type RuntimeManifest,
} from "../src/runtime-manifest.js";

const pluginName = "super-web-agent-lifecycle-evidence";
const versions = ["0.0.1", "0.0.2"] as const;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

function currentPlatform(): "darwin-arm64" | "win32-x64" {
  const platform = `${process.platform}-${process.arch}`;
  if (platform !== "darwin-arm64" && platform !== "win32-x64") {
    throw new Error(`unsupported test platform: ${platform}`);
  }
  return platform;
}

function otherPlatform(): "darwin-arm64" | "win32-x64" {
  return currentPlatform() === "darwin-arm64" ? "win32-x64" : "darwin-arm64";
}

function executableName():
  | "super-web-agent-runtime"
  | "super-web-agent-runtime.exe" {
  return currentPlatform() === "win32-x64"
    ? "super-web-agent-runtime.exe"
    : "super-web-agent-runtime";
}

function pluginRoot(outputRoot: string, version: PluginFixtureVersion): string {
  return join(outputRoot, "versions", version, "plugins", pluginName);
}

async function createSignedRuntime(
  directory: string,
  version: PluginFixtureVersion,
  bytes: Buffer,
) {
  const artifactPath = join(directory, version, executableName());
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(join(directory, version), { recursive: true }),
  );
  await writeFile(artifactPath, bytes, { mode: 0o755 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const unsigned = {
    runtimeVersion: version,
    coreProtocolRange: "1.0",
    bridgeProtocolRange: "1.0",
    platform: currentPlatform(),
    artifact: executableName(),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const manifest: RuntimeManifest = {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(canonicalManifestPayload(unsigned)),
      privateKey,
    ).toString("base64url"),
  };
  return {
    artifactPath,
    manifest,
    publicKeyPem: publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
  };
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "swa-keyless-plugin-"));
  directories.push(directory);
  const runtimeRoot = join(directory, "runtimes");
  const outputRoot = join(directory, "fixture");
  const runtimeA = await createSignedRuntime(
    runtimeRoot,
    "0.0.1",
    Buffer.from("runtime-a\n"),
  );
  const runtimeB = await createSignedRuntime(
    runtimeRoot,
    "0.0.2",
    Buffer.from("runtime-b!!"),
  );
  const index = await buildKeylessPluginFixtures({
    outputRoot,
    platform: currentPlatform(),
    runtimes: {
      "0.0.1": runtimeA,
      "0.0.2": runtimeB,
    },
  });
  return { directory, outputRoot, index };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function mutateJson(
  path: string,
  mutate: (value: Record<string, unknown>) => void,
): Promise<void> {
  const value = (await readJson(path)) as Record<string, unknown>;
  mutate(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeMcpCommand(root: string, command: string): Promise<void> {
  const path = join(root, ".mcp.json");
  const value = (await readJson(path)) as {
    swa_lifecycle: { command: string };
  };
  value.swa_lifecycle.command = command;
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

it("parses the closed fixture index and rejects unknown keys", () => {
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);
  const expectedIndex = {
    schemaVersion: 1,
    platform: currentPlatform(),
    pluginName,
    versions: ["0.0.1", "0.0.2"],
    runtimeArtifacts: {
      "0.0.1": {
        artifact: executableName(),
        sha256: digestA,
        bytes: 10,
        buildId: "0.0.1",
      },
      "0.0.2": {
        artifact: executableName(),
        sha256: digestB,
        bytes: 11,
        buildId: "0.0.2",
      },
    },
  };

  expect(parseKeylessPluginFixtureIndex(expectedIndex)).toEqual(expectedIndex);
  expect(() =>
    parseKeylessPluginFixtureIndex({ ...expectedIndex, unexpected: true }),
  ).toThrow("fixture-index-invalid");
  expect(() =>
    parseKeylessPluginFixtureIndex({
      ...expectedIndex,
      runtimeArtifacts: {
        ...expectedIndex.runtimeArtifacts,
        "0.0.1": {
          ...expectedIndex.runtimeArtifacts["0.0.1"],
          unexpected: true,
        },
      },
    }),
  ).toThrow("fixture-index-invalid");
});

it("accepts exactly one fixture CLI output root and normalizes it to absolute", () => {
  expect(parseBuildKeylessPluginFixtureArgs(["relative-output"])).toBe(
    resolve("relative-output"),
  );
  expect(() => parseBuildKeylessPluginFixtureArgs([])).toThrow(
    "usage: build-keyless-plugin-fixtures OUTPUT_ROOT",
  );
  expect(() =>
    parseBuildKeylessPluginFixtureArgs(["one", "two"]),
  ).toThrow("usage: build-keyless-plugin-fixtures OUTPUT_ROOT");
});

it("rejects wrong-platform, aliased-build, and equal-digest fixture indexes", () => {
  const base = {
    schemaVersion: 1,
    platform: currentPlatform(),
    pluginName,
    versions: ["0.0.1", "0.0.2"],
    runtimeArtifacts: {
      "0.0.1": {
        artifact: executableName(),
        sha256: "a".repeat(64),
        bytes: 10,
        buildId: "0.0.1",
      },
      "0.0.2": {
        artifact: executableName(),
        sha256: "b".repeat(64),
        bytes: 11,
        buildId: "0.0.2",
      },
    },
  };

  expect(() =>
    parseKeylessPluginFixtureIndex({ ...base, platform: otherPlatform() }),
  ).toThrow("platform-mismatch");
  expect(() =>
    parseKeylessPluginFixtureIndex({
      ...base,
      runtimeArtifacts: {
        ...base.runtimeArtifacts,
        "0.0.2": {
          ...base.runtimeArtifacts["0.0.2"],
          buildId: "0.0.1",
        },
      },
    }),
  ).toThrow("fixture-index-invalid");
  expect(() =>
    parseKeylessPluginFixtureIndex({
      ...base,
      runtimeArtifacts: {
        ...base.runtimeArtifacts,
        "0.0.2": {
          ...base.runtimeArtifacts["0.0.2"],
          sha256: base.runtimeArtifacts["0.0.1"].sha256,
        },
      },
    }),
  ).toThrow("fixture-index-invalid");
});

it("renders exact Codex plugin, MCP, marketplace, and lifecycle skill contracts", async () => {
  const { outputRoot, index } = await createFixture();
  const digestA = createHash("sha256").update("runtime-a\n").digest("hex");
  const digestB = createHash("sha256").update("runtime-b!!").digest("hex");
  const expectedIndex: KeylessPluginFixtureIndex = {
    schemaVersion: 1,
    platform: currentPlatform(),
    pluginName,
    versions: ["0.0.1", "0.0.2"],
    runtimeArtifacts: {
      "0.0.1": {
        artifact: executableName(),
        sha256: digestA,
        bytes: 10,
        buildId: "0.0.1",
      },
      "0.0.2": {
        artifact: executableName(),
        sha256: digestB,
        bytes: 11,
        buildId: "0.0.2",
      },
    },
  };
  expect(index).toEqual(expectedIndex);
  expect(await readJson(join(outputRoot, "fixture-index.json"))).toEqual(
    expectedIndex,
  );

  for (const version of versions) {
    const root = pluginRoot(outputRoot, version);
    const pluginManifest = await readJson(
      join(root, ".codex-plugin", "plugin.json"),
    );
    expect(pluginManifest).toMatchObject({
      name: pluginName,
      version,
      description:
        "Deterministic Super Web Agent Runtime lifecycle evidence.",
      license: "Apache-2.0",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
      interface: {
        displayName: "Super Web Agent Lifecycle Evidence",
        category: "Productivity",
        capabilities: ["Local MCP"],
      },
    });
    expect(pluginManifest).not.toHaveProperty("apps");
    expect(pluginManifest).not.toHaveProperty("hooks");

    expect(await readJson(join(root, ".mcp.json"))).toEqual({
      swa_lifecycle: {
        command: `./bin/${executableName()}`,
        args: [],
        cwd: ".",
        env: {
          PATH: "",
          SWA_SPIKE_PLUGIN_VERSION: version,
        },
        startup_timeout_sec: 20,
        tool_timeout_sec: 20,
      },
    });

    expect(
      await readJson(
        join(
          outputRoot,
          "versions",
          version,
          ".agents",
          "plugins",
          "marketplace.json",
        ),
      ),
    ).toEqual({
      name: "super-web-agent-local-evidence",
      interface: { displayName: "Super Web Agent Local Evidence" },
      plugins: [
        {
          name: pluginName,
          source: {
            source: "local",
            path: "./plugins/super-web-agent-lifecycle-evidence",
          },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          category: "Productivity",
        },
      ],
    });

    expect(await readFile(join(root, "skills", "lifecycle", "SKILL.md"), "utf8"))
      .toBe(`---
name: lifecycle
description: Exercise deterministic Super Web Agent Runtime lifecycle evidence.
---

Use only the MCP tools \`swa_spike_health\`, \`swa_spike_bridge_status\`, or \`swa_spike_crash\`.
Do not use shell commands, provider tools, models, or any other tools.
`);
  }
});

it("resolves a packaged Runtime only after strict manifest and signature validation", async () => {
  const { outputRoot } = await createFixture();
  const root = pluginRoot(outputRoot, "0.0.1");
  const launch = await resolveKeylessPluginLaunch(root);

  expect(launch).toEqual({
    command: join(root, "bin", executableName()),
    args: [],
    cwd: root,
    env: {
      PATH: "",
      SWA_SPIKE_PLUGIN_VERSION: "0.0.1",
    },
    pluginRoot: root,
    runtimeRelativePath: `bin/${executableName()}`,
  });
});

it.each([
  ["absolute command", "/tmp/runtime"],
  ["parent traversal", "../bin/runtime"],
  ["nested traversal", "./bin/../../runtime"],
  ["source-checkout path", resolve(process.cwd(), "src", "mcp-health-entry.ts")],
])("rejects %s", async (_name, command) => {
  const { outputRoot } = await createFixture();
  const root = pluginRoot(outputRoot, "0.0.1");
  await writeMcpCommand(root, command);
  await expect(resolveKeylessPluginLaunch(root)).rejects.toThrow("path-escape");
});

it("rejects a symlinked Runtime that escapes the plugin root", async () => {
  const { directory, outputRoot } = await createFixture();
  const root = pluginRoot(outputRoot, "0.0.1");
  const packagedRuntime = join(root, "bin", executableName());
  const outsideRuntime = join(directory, "outside-runtime");
  await writeFile(outsideRuntime, "runtime-a\n");
  await rm(packagedRuntime);
  await symlink(outsideRuntime, packagedRuntime);
  await expect(resolveKeylessPluginLaunch(root)).rejects.toThrow("path-escape");
});

it("rejects unknown plugin manifest keys", async () => {
  const { outputRoot } = await createFixture();
  const root = pluginRoot(outputRoot, "0.0.1");
  await mutateJson(join(root, ".codex-plugin", "plugin.json"), (manifest) => {
    manifest.unexpected = true;
  });
  await expect(resolveKeylessPluginLaunch(root)).rejects.toThrow(
    "bundle-contract-invalid",
  );
});

it("rejects wrapped and multiple MCP server maps", async () => {
  for (const replacement of [
    {
      mcpServers: {
        swa_lifecycle: {
          command: `./bin/${executableName()}`,
        },
      },
    },
    {
      swa_lifecycle: {
        command: `./bin/${executableName()}`,
        args: [],
        cwd: ".",
        env: { PATH: "", SWA_SPIKE_PLUGIN_VERSION: "0.0.1" },
        startup_timeout_sec: 20,
        tool_timeout_sec: 20,
      },
      second: {
        command: `./bin/${executableName()}`,
        args: [],
        cwd: ".",
        env: { PATH: "", SWA_SPIKE_PLUGIN_VERSION: "0.0.1" },
        startup_timeout_sec: 20,
        tool_timeout_sec: 20,
      },
    },
  ]) {
    const { outputRoot } = await createFixture();
    const root = pluginRoot(outputRoot, "0.0.1");
    await writeFile(
      join(root, ".mcp.json"),
      `${JSON.stringify(replacement, null, 2)}\n`,
    );
    await expect(resolveKeylessPluginLaunch(root)).rejects.toThrow(
      "bundle-contract-invalid",
    );
  }
});

it.each([
  ["provider key", { OPENAI_API_KEY: "inherited" }, "."],
  ["non-empty PATH", { PATH: "/usr/bin" }, "."],
  ["wrong cwd", {}, ".."],
] as const)("rejects %s in the MCP launch contract", async (_name, envPatch, cwd) => {
  const { outputRoot } = await createFixture();
  const root = pluginRoot(outputRoot, "0.0.1");
  await mutateJson(join(root, ".mcp.json"), (config) => {
    const server = config.swa_lifecycle as {
      cwd: string;
      env: Record<string, string>;
    };
    server.cwd = cwd;
    Object.assign(server.env, envPatch);
  });
  await expect(resolveKeylessPluginLaunch(root)).rejects.toThrow(
    "bundle-contract-invalid",
  );
});

it.each(["runtime-manifest.json", "runtime-public-key.pem"])(
  "rejects a missing packaged %s",
  async (file) => {
    const { outputRoot } = await createFixture();
    const root = pluginRoot(outputRoot, "0.0.1");
    await rm(join(root, "bin", file));
    await expect(resolveKeylessPluginLaunch(root)).rejects.toThrow(
      "artifact-invalid",
    );
  },
);

it("rejects artifact mutation between fixture index and staged validation", async () => {
  const { outputRoot, index } = await createFixture();
  const packagedRuntime = join(
    pluginRoot(outputRoot, "0.0.1"),
    "bin",
    executableName(),
  );
  await writeFile(packagedRuntime, "changed");
  await expect(
    stageKeylessPluginVersion({
      fixtureRoot: outputRoot,
      index,
      version: "0.0.1",
    }),
  ).rejects.toThrow("artifact-invalid");
});

it("copies a validated fixture to a private installed-layout and cleans it up", async () => {
  const { outputRoot, index } = await createFixture();
  const sourceRoot = pluginRoot(outputRoot, "0.0.2");
  const staged = await stageKeylessPluginVersion({
    fixtureRoot: outputRoot,
    index,
    version: "0.0.2",
  });
  try {
    expect(staged.pluginRoot).not.toBe(sourceRoot);
    expect(staged.launch.pluginRoot).toBe(staged.pluginRoot);
    expect(staged.launch.command.startsWith(`${staged.pluginRoot}/`)).toBe(true);
    expect(await stat(staged.launch.command)).toMatchObject({ size: 11 });
  } finally {
    await staged.cleanup();
  }
  await expect(lstat(staged.pluginRoot)).rejects.toMatchObject({
    code: "ENOENT",
  });
});
