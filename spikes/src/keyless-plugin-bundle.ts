import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  parseRuntimeManifest,
  verifyRuntimeArtifact,
  type RuntimeManifest,
} from "./runtime-manifest.js";

export type PluginFixtureVersion = "0.0.1" | "0.0.2";
export type KeylessPluginPlatform = "darwin-arm64" | "win32-x64";

export interface RuntimeFixtureMetadata {
  artifact: "super-web-agent-runtime" | "super-web-agent-runtime.exe";
  sha256: string;
  bytes: number;
  buildId: PluginFixtureVersion;
}

export interface KeylessPluginFixtureIndex {
  schemaVersion: 1;
  platform: KeylessPluginPlatform;
  pluginName: "super-web-agent-lifecycle-evidence";
  versions: ["0.0.1", "0.0.2"];
  runtimeArtifacts: Record<PluginFixtureVersion, RuntimeFixtureMetadata>;
}

export interface ResolvedPluginLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  pluginRoot: string;
  runtimeRelativePath: string;
}

export interface StagedKeylessPlugin {
  pluginRoot: string;
  launch: ResolvedPluginLaunch;
  cleanup(): Promise<void>;
}

export interface SignedRuntimeFixture {
  artifactPath: string;
  manifest: RuntimeManifest;
  publicKeyPem: string;
}

export interface BuildKeylessPluginFixturesInput {
  outputRoot: string;
  platform: KeylessPluginPlatform;
  runtimes: Record<PluginFixtureVersion, SignedRuntimeFixture>;
}

export interface StageKeylessPluginVersionInput {
  fixtureRoot: string;
  index: KeylessPluginFixtureIndex;
  version: PluginFixtureVersion;
}

const pluginName = "super-web-agent-lifecycle-evidence" as const;
const fixtureVersions = ["0.0.1", "0.0.2"] as const;
const manifestDescription =
  "Deterministic Super Web Agent Runtime lifecycle evidence.";

const pluginManifestKeys = [
  "author",
  "description",
  "interface",
  "license",
  "mcpServers",
  "name",
  "skills",
  "version",
] as const;
const pluginInterfaceKeys = [
  "capabilities",
  "category",
  "defaultPrompt",
  "developerName",
  "displayName",
  "longDescription",
  "shortDescription",
] as const;
const serverKeys = [
  "args",
  "command",
  "cwd",
  "env",
  "startup_timeout_sec",
  "tool_timeout_sec",
] as const;

function currentPlatform(): KeylessPluginPlatform {
  const platform = `${process.platform}-${process.arch}`;
  if (platform !== "darwin-arm64" && platform !== "win32-x64") {
    throw new Error(`platform-mismatch: unsupported native platform ${platform}`);
  }
  return platform;
}

function executableName(
  platform: KeylessPluginPlatform,
): RuntimeFixtureMetadata["artifact"] {
  return platform === "win32-x64"
    ? "super-web-agent-runtime.exe"
    : "super-web-agent-runtime";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function requireExactKeys(
  value: unknown,
  keys: readonly string[],
  code: "fixture-index-invalid" | "bundle-contract-invalid",
): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    throw new Error(`${code}: invalid object keys`);
  }
  return value;
}

function requireAbsolutePath(name: string, path: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`bundle-contract-invalid: ${name} must be absolute`);
  }
}

function assertLexicallyContained(root: string, path: string): void {
  const pathFromRoot = relative(root, path);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("path-escape: path leaves plugin root");
  }
}

async function assertReallyContained(root: string, path: string): Promise<void> {
  const realRoot = await realpath(root);
  const realPath = await realpath(path);
  assertLexicallyContained(realRoot, realPath);
}

async function readJson(path: string, code: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${code}: unreadable JSON`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parsePluginVersion(value: unknown): PluginFixtureVersion {
  if (value !== "0.0.1" && value !== "0.0.2") {
    throw new Error("bundle-contract-invalid: unsupported plugin version");
  }
  return value;
}

function parsePluginManifest(value: unknown): PluginFixtureVersion {
  const manifest = requireExactKeys(
    value,
    pluginManifestKeys,
    "bundle-contract-invalid",
  );
  const author = requireExactKeys(
    manifest.author,
    ["name"],
    "bundle-contract-invalid",
  );
  const pluginInterface = requireExactKeys(
    manifest.interface,
    pluginInterfaceKeys,
    "bundle-contract-invalid",
  );
  const version = parsePluginVersion(manifest.version);
  if (
    manifest.name !== pluginName ||
    manifest.description !== manifestDescription ||
    manifest.license !== "Apache-2.0" ||
    manifest.skills !== "./skills/" ||
    manifest.mcpServers !== "./.mcp.json" ||
    author.name !== "Super Web Agent" ||
    pluginInterface.displayName !== "Super Web Agent Lifecycle Evidence" ||
    pluginInterface.shortDescription !==
      "Deterministic local Runtime lifecycle evidence." ||
    pluginInterface.longDescription !==
      "Installs a self-contained Super Web Agent Runtime for deterministic lifecycle acceptance." ||
    pluginInterface.developerName !== "Super Web Agent" ||
    pluginInterface.category !== "Productivity" ||
    !Array.isArray(pluginInterface.capabilities) ||
    pluginInterface.capabilities.length !== 1 ||
    pluginInterface.capabilities[0] !== "Local MCP" ||
    !Array.isArray(pluginInterface.defaultPrompt) ||
    pluginInterface.defaultPrompt.length !== 1 ||
    pluginInterface.defaultPrompt[0] !==
      "Run deterministic Runtime lifecycle evidence."
  ) {
    throw new Error("bundle-contract-invalid: invalid plugin manifest");
  }
  return version;
}

function parseMcpConfig(
  value: unknown,
  version: PluginFixtureVersion,
): {
  command: string;
  args: string[];
  cwd: ".";
  env: Record<string, string>;
} {
  const config = requireExactKeys(
    value,
    ["swa_lifecycle"],
    "bundle-contract-invalid",
  );
  const server = requireExactKeys(
    config.swa_lifecycle,
    serverKeys,
    "bundle-contract-invalid",
  );
  const env = requireExactKeys(
    server.env,
    ["PATH", "SWA_SPIKE_PLUGIN_VERSION"],
    "bundle-contract-invalid",
  );
  if (
    typeof server.command !== "string" ||
    !Array.isArray(server.args) ||
    server.args.length !== 0 ||
    server.cwd !== "." ||
    env.PATH !== "" ||
    env.SWA_SPIKE_PLUGIN_VERSION !== version ||
    server.startup_timeout_sec !== 20 ||
    server.tool_timeout_sec !== 20
  ) {
    throw new Error("bundle-contract-invalid: invalid MCP launch contract");
  }
  return {
    command: server.command,
    args: [],
    cwd: ".",
    env: {
      PATH: "",
      SWA_SPIKE_PLUGIN_VERSION: version,
    },
  };
}

function parseRuntimeMetadata(
  value: unknown,
  version: PluginFixtureVersion,
  platform: KeylessPluginPlatform,
): RuntimeFixtureMetadata {
  const metadata = requireExactKeys(
    value,
    ["artifact", "buildId", "bytes", "sha256"],
    "fixture-index-invalid",
  );
  if (
    metadata.artifact !== executableName(platform) ||
    typeof metadata.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(metadata.sha256) ||
    !Number.isSafeInteger(metadata.bytes) ||
    (metadata.bytes as number) <= 0 ||
    metadata.buildId !== version
  ) {
    throw new Error("fixture-index-invalid: invalid Runtime metadata");
  }
  return {
    artifact: executableName(platform),
    sha256: metadata.sha256,
    bytes: metadata.bytes as number,
    buildId: version,
  };
}

export function parseKeylessPluginFixtureIndex(
  value: unknown,
): KeylessPluginFixtureIndex {
  const index = requireExactKeys(
    value,
    [
      "platform",
      "pluginName",
      "runtimeArtifacts",
      "schemaVersion",
      "versions",
    ],
    "fixture-index-invalid",
  );
  if (
    index.schemaVersion !== 1 ||
    index.pluginName !== pluginName ||
    !Array.isArray(index.versions) ||
    index.versions.length !== 2 ||
    index.versions[0] !== "0.0.1" ||
    index.versions[1] !== "0.0.2"
  ) {
    throw new Error("fixture-index-invalid: invalid fixture index");
  }
  const nativePlatform = currentPlatform();
  if (index.platform !== nativePlatform) {
    throw new Error("platform-mismatch: fixture is not native");
  }
  const artifacts = requireExactKeys(
    index.runtimeArtifacts,
    fixtureVersions,
    "fixture-index-invalid",
  );
  const runtimeA = parseRuntimeMetadata(
    artifacts["0.0.1"],
    "0.0.1",
    nativePlatform,
  );
  const runtimeB = parseRuntimeMetadata(
    artifacts["0.0.2"],
    "0.0.2",
    nativePlatform,
  );
  if (runtimeA.sha256 === runtimeB.sha256) {
    throw new Error("fixture-index-invalid: Runtime digests must differ");
  }
  return {
    schemaVersion: 1,
    platform: nativePlatform,
    pluginName,
    versions: ["0.0.1", "0.0.2"],
    runtimeArtifacts: {
      "0.0.1": runtimeA,
      "0.0.2": runtimeB,
    },
  };
}

function pluginManifest(version: PluginFixtureVersion): Record<string, unknown> {
  return {
    name: pluginName,
    version,
    description: manifestDescription,
    author: {
      name: "Super Web Agent",
    },
    license: "Apache-2.0",
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    interface: {
      displayName: "Super Web Agent Lifecycle Evidence",
      shortDescription: "Deterministic local Runtime lifecycle evidence.",
      longDescription:
        "Installs a self-contained Super Web Agent Runtime for deterministic lifecycle acceptance.",
      developerName: "Super Web Agent",
      category: "Productivity",
      capabilities: ["Local MCP"],
      defaultPrompt: ["Run deterministic Runtime lifecycle evidence."],
    },
  };
}

function mcpConfig(
  version: PluginFixtureVersion,
  artifact: RuntimeFixtureMetadata["artifact"],
): Record<string, unknown> {
  return {
    swa_lifecycle: {
      command: `./bin/${artifact}`,
      args: [],
      cwd: ".",
      env: {
        PATH: "",
        SWA_SPIKE_PLUGIN_VERSION: version,
      },
      startup_timeout_sec: 20,
      tool_timeout_sec: 20,
    },
  };
}

function marketplace(): Record<string, unknown> {
  return {
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
  };
}

async function validateRuntimeInput(
  runtime: SignedRuntimeFixture,
  version: PluginFixtureVersion,
  platform: KeylessPluginPlatform,
): Promise<RuntimeFixtureMetadata> {
  requireAbsolutePath("runtime artifact", runtime.artifactPath);
  if (
    runtime.manifest.runtimeVersion !== version ||
    runtime.manifest.platform !== platform ||
    runtime.manifest.artifact !== executableName(platform) ||
    basename(runtime.artifactPath) !== executableName(platform)
  ) {
    throw new Error("artifact-invalid: Runtime identity mismatch");
  }
  try {
    await verifyRuntimeArtifact({
      artifactPath: runtime.artifactPath,
      manifest: runtime.manifest,
      publicKeyPem: runtime.publicKeyPem,
    });
  } catch {
    throw new Error("artifact-invalid: Runtime verification failed");
  }
  const artifactStat = await stat(runtime.artifactPath);
  return {
    artifact: executableName(platform),
    sha256: runtime.manifest.sha256,
    bytes: artifactStat.size,
    buildId: version,
  };
}

export async function buildKeylessPluginFixtures(
  input: BuildKeylessPluginFixturesInput,
): Promise<KeylessPluginFixtureIndex> {
  requireAbsolutePath("outputRoot", input.outputRoot);
  if (input.platform !== currentPlatform()) {
    throw new Error("platform-mismatch: fixtures must be built natively");
  }
  const runtimeArtifacts = {
    "0.0.1": await validateRuntimeInput(
      input.runtimes["0.0.1"],
      "0.0.1",
      input.platform,
    ),
    "0.0.2": await validateRuntimeInput(
      input.runtimes["0.0.2"],
      "0.0.2",
      input.platform,
    ),
  };
  const index = parseKeylessPluginFixtureIndex({
    schemaVersion: 1,
    platform: input.platform,
    pluginName,
    versions: ["0.0.1", "0.0.2"],
    runtimeArtifacts,
  });

  for (const version of fixtureVersions) {
    const versionRoot = join(input.outputRoot, "versions", version);
    const root = join(versionRoot, "plugins", pluginName);
    const binRoot = join(root, "bin");
    const manifestRoot = join(root, ".codex-plugin");
    const skillRoot = join(root, "skills", "lifecycle");
    const marketplaceRoot = join(versionRoot, ".agents", "plugins");
    await Promise.all([
      mkdir(binRoot, { recursive: true }),
      mkdir(manifestRoot, { recursive: true }),
      mkdir(skillRoot, { recursive: true }),
      mkdir(marketplaceRoot, { recursive: true }),
    ]);
    const runtime = input.runtimes[version];
    const artifact = executableName(input.platform);
    const packagedRuntime = join(binRoot, artifact);
    await copyFile(runtime.artifactPath, packagedRuntime);
    await chmod(packagedRuntime, 0o755);
    await Promise.all([
      writeJson(join(manifestRoot, "plugin.json"), pluginManifest(version)),
      writeJson(join(root, ".mcp.json"), mcpConfig(version, artifact)),
      writeJson(join(binRoot, "runtime-manifest.json"), runtime.manifest),
      writeFile(
        join(binRoot, "runtime-public-key.pem"),
        runtime.publicKeyPem.endsWith("\n")
          ? runtime.publicKeyPem
          : `${runtime.publicKeyPem}\n`,
      ),
      writeFile(
        join(skillRoot, "SKILL.md"),
        `---
name: lifecycle
description: Exercise deterministic Super Web Agent Runtime lifecycle evidence.
---

Use only the MCP tools \`swa_spike_health\`, \`swa_spike_bridge_status\`, or \`swa_spike_crash\`.
Do not use shell commands, provider tools, models, or any other tools.
`,
      ),
      writeJson(join(marketplaceRoot, "marketplace.json"), marketplace()),
    ]);
  }
  await mkdir(input.outputRoot, { recursive: true });
  await writeJson(join(input.outputRoot, "fixture-index.json"), index);
  return index;
}

export async function resolveKeylessPluginLaunch(
  pluginRoot: string,
): Promise<ResolvedPluginLaunch> {
  const resolvedRoot = resolve(pluginRoot);
  const realRoot = await realpath(resolvedRoot).catch(() => {
    throw new Error("bundle-contract-invalid: missing plugin root");
  });
  if (basename(realRoot) !== pluginName) {
    throw new Error("bundle-contract-invalid: plugin folder name mismatch");
  }
  const manifestPath = join(resolvedRoot, ".codex-plugin", "plugin.json");
  const mcpPath = join(resolvedRoot, ".mcp.json");
  try {
    await assertReallyContained(resolvedRoot, manifestPath);
    await assertReallyContained(resolvedRoot, mcpPath);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("path-escape:")) {
      throw error;
    }
    throw new Error("bundle-contract-invalid: missing plugin contract");
  }
  const version = parsePluginManifest(
    await readJson(manifestPath, "bundle-contract-invalid"),
  );
  const launch = parseMcpConfig(
    await readJson(mcpPath, "bundle-contract-invalid"),
    version,
  );
  if (isAbsolute(launch.command)) {
    throw new Error("path-escape: absolute Runtime command");
  }
  const lexicalRuntime = resolve(resolvedRoot, launch.command);
  assertLexicallyContained(resolvedRoot, lexicalRuntime);
  if (launch.command !== `./bin/${executableName(currentPlatform())}`) {
    throw new Error("bundle-contract-invalid: unexpected Runtime command");
  }
  try {
    await assertReallyContained(resolvedRoot, lexicalRuntime);
  } catch {
    throw new Error("path-escape: Runtime real path leaves plugin root");
  }
  const runtimeManifestPath = join(
    resolvedRoot,
    "bin",
    "runtime-manifest.json",
  );
  const publicKeyPath = join(resolvedRoot, "bin", "runtime-public-key.pem");
  try {
    await assertReallyContained(resolvedRoot, runtimeManifestPath);
    await assertReallyContained(resolvedRoot, publicKeyPath);
    const manifest = parseRuntimeManifest(
      await readJson(runtimeManifestPath, "artifact-invalid"),
    );
    if (manifest.runtimeVersion !== version) {
      throw new Error("Runtime build ID mismatch");
    }
    await verifyRuntimeArtifact({
      artifactPath: lexicalRuntime,
      manifest,
      publicKeyPem: await readFile(publicKeyPath, "utf8"),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("path-escape:")) {
      throw error;
    }
    throw new Error("artifact-invalid: packaged Runtime verification failed");
  }
  const runtimeRelativePath = relative(resolvedRoot, lexicalRuntime).replaceAll(
    "\\",
    "/",
  );
  return {
    command: lexicalRuntime,
    args: launch.args,
    cwd: resolvedRoot,
    env: launch.env,
    pluginRoot: resolvedRoot,
    runtimeRelativePath,
  };
}

async function verifyAgainstIndex(
  launch: ResolvedPluginLaunch,
  metadata: RuntimeFixtureMetadata,
): Promise<void> {
  const bytes = await readFile(launch.command);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (
    basename(launch.command) !== metadata.artifact ||
    bytes.length !== metadata.bytes ||
    digest !== metadata.sha256 ||
    launch.env.SWA_SPIKE_PLUGIN_VERSION !== metadata.buildId
  ) {
    throw new Error("artifact-invalid: fixture index does not match Runtime");
  }
}

export async function stageKeylessPluginVersion(
  input: StageKeylessPluginVersionInput,
): Promise<StagedKeylessPlugin> {
  requireAbsolutePath("fixtureRoot", input.fixtureRoot);
  const index = parseKeylessPluginFixtureIndex(input.index);
  const sourceRoot = join(
    input.fixtureRoot,
    "versions",
    input.version,
    "plugins",
    pluginName,
  );
  assertLexicallyContained(resolve(input.fixtureRoot), resolve(sourceRoot));
  try {
    await assertReallyContained(resolve(input.fixtureRoot), resolve(sourceRoot));
  } catch {
    throw new Error("path-escape: fixture plugin leaves fixture root");
  }
  const sourceLaunch = await resolveKeylessPluginLaunch(sourceRoot);
  await verifyAgainstIndex(
    sourceLaunch,
    index.runtimeArtifacts[input.version],
  );

  const installedRoot = await mkdtemp(
    join(tmpdir(), "swa-keyless-plugin-installed-"),
  );
  await chmod(installedRoot, 0o700);
  const stagedRoot = join(installedRoot, "plugins", pluginName);
  try {
    await mkdir(join(installedRoot, "plugins"), { recursive: true });
    await cp(sourceRoot, stagedRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const stagedLaunch = await resolveKeylessPluginLaunch(stagedRoot);
    await verifyAgainstIndex(
      stagedLaunch,
      index.runtimeArtifacts[input.version],
    );
    let removed = false;
    return {
      pluginRoot: stagedRoot,
      launch: stagedLaunch,
      async cleanup(): Promise<void> {
        if (removed) return;
        removed = true;
        await rm(installedRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(installedRoot, { recursive: true, force: true });
    throw error;
  }
}
