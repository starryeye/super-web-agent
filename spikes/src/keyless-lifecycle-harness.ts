import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseKeylessPluginFixtureIndex,
  stageKeylessPluginVersion,
  type KeylessPluginFixtureIndex,
  type PluginFixtureVersion,
  type ResolvedPluginLaunch,
  type StagedKeylessPlugin,
} from "./keyless-plugin-bundle.js";
import type {
  KeylessLifecycleFailureCode,
  KeylessLifecyclePhase,
  KeylessLifecyclePlatformReport,
} from "./keyless-lifecycle-report.js";
import {
  RuntimeStdioTransport,
  type RuntimeExitObservation,
} from "./runtime-stdio-transport.js";

const lifecycleToolNames = [
  "swa_spike_health",
  "swa_spike_bridge_status",
  "swa_spike_crash",
] as const;
const allowedLaunchEnvironment = ["PATH", "SWA_SPIKE_PLUGIN_VERSION"] as const;

export interface RunKeylessLifecycleInput {
  readonly fixtureRoot: string;
  readonly sourceCommit: string;
}

export interface LifecycleMcpClient {
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(input: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{ structuredContent?: unknown }>;
  close(): Promise<void>;
}

export interface LifecycleRuntimeTransport {
  readonly processOwnershipResolved: boolean;
  readonly exitObservation: Readonly<RuntimeExitObservation> | undefined;
  close(): Promise<void>;
  waitForFinalClose(timeoutMs: number): Promise<boolean>;
}

export interface ConnectedPackagedRuntime {
  readonly client: LifecycleMcpClient;
  readonly transport: LifecycleRuntimeTransport;
}

export interface LifecycleResidueObservation {
  readonly stagedPluginRemoved: boolean;
  readonly noLiveRuntime: boolean;
  readonly swaOwnedResidueCount: number;
}

export interface KeylessLifecycleDependencies {
  readonly filesystem: {
    readFixtureIndex(fixtureRoot: string): Promise<unknown>;
    digestFile(path: string): Promise<{ sha256: string; bytes: number }>;
  };
  readonly clock: {
    finalCloseTimeoutMs(): number;
  };
  readonly stagePlugin: (input: {
    fixtureRoot: string;
    index: KeylessPluginFixtureIndex;
    version: PluginFixtureVersion;
  }) => Promise<StagedKeylessPlugin>;
  readonly connectRuntime: (
    launch: ResolvedPluginLaunch,
  ) => Promise<ConnectedPackagedRuntime>;
  readonly processObservation: {
    inspectResidue(input: {
      stagedPluginRoots: readonly string[];
      observedPids: readonly number[];
    }): Promise<LifecycleResidueObservation>;
  };
}

interface HealthObservation {
  readonly pid: number;
  readonly runtimeSessionId: string;
  readonly runtimeBuildId: PluginFixtureVersion;
}

class LifecycleCondition extends Error {
  constructor(
    readonly code: KeylessLifecycleFailureCode,
    readonly phase?: KeylessLifecyclePhase,
  ) {
    super(code);
  }
}

interface RuntimeConnectionFailure {
  readonly kind: "runtime-connection-failure";
  readonly code: "runtime-launch-failed" | "mcp-initialize-failed";
  readonly pid: number | null;
  readonly transport: LifecycleRuntimeTransport;
}

function isRuntimeConnectionFailure(
  value: unknown,
): value is RuntimeConnectionFailure {
  return (
    isRecord(value) &&
    value.kind === "runtime-connection-failure" &&
    (value.code === "runtime-launch-failed" ||
      value.code === "mcp-initialize-failed") &&
    (value.pid === null ||
      (Number.isSafeInteger(value.pid) && (value.pid as number) > 0)) &&
    isRecord(value.transport) &&
    typeof value.transport.close === "function" &&
    typeof value.transport.waitForFinalClose === "function"
  );
}

function currentPlatform(): KeylessLifecyclePlatformReport["platform"] {
  const platform = `${process.platform}-${process.arch}`;
  if (platform !== "darwin-arm64" && platform !== "win32-x64") {
    throw new LifecycleCondition("platform-mismatch");
  }
  return platform;
}

function executableName(
  platform: KeylessLifecyclePlatformReport["platform"],
): "super-web-agent-runtime" | "super-web-agent-runtime.exe" {
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

function initialReport(
  input: RunKeylessLifecycleInput,
  platform: KeylessLifecyclePlatformReport["platform"],
): KeylessLifecyclePlatformReport {
  const artifact = executableName(platform);
  const firstDigest = "0".repeat(64);
  const secondDigest = "1".repeat(64);
  return {
    schemaVersion: 1,
    sourceCommit: input.sourceCommit,
    platform,
    nodeVersion: "v24.14.0",
    pluginName: "super-web-agent-lifecycle-evidence",
    providerDependencies: {
      apiKeysRequired: false,
      providerCliInvoked: false,
      modelInvoked: false,
    },
    artifacts: {
      "0.0.1": {
        artifact,
        sha256: firstDigest,
        bytes: 1,
        buildId: "0.0.1",
      },
      "0.0.2": {
        artifact,
        sha256: secondDigest,
        bytes: 1,
        buildId: "0.0.2",
      },
    },
    launch: {
      runtimeRelativePath: `bin/${artifact}`,
      cwd: ".",
      pathContained: true,
    },
    phases: {
      initial: {
        passed: false,
        observedRuntimeBuildId: "0.0.1",
        observedRuntimeSha256: firstDigest,
        healthNonceMatched: false,
        pidChanged: false,
        runtimeSessionChanged: false,
        cleanStopObserved: false,
      },
      bridgeStatus: {
        passed: false,
        runtime: "ready",
        bridgeState: "not-installed",
      },
      crash: {
        passed: false,
        crashAcknowledged: true,
        finalCloseObserved: true,
        exitCode: 86,
        signal: null,
      },
      recovery: {
        passed: false,
        observedRuntimeBuildId: "0.0.1",
        observedRuntimeSha256: firstDigest,
        healthNonceMatched: false,
        pidChanged: true,
        runtimeSessionChanged: true,
        cleanStopObserved: false,
      },
      update: {
        passed: false,
        observedRuntimeBuildId: "0.0.2",
        observedRuntimeSha256: secondDigest,
        healthNonceMatched: false,
        pidChanged: true,
        runtimeSessionChanged: true,
        cleanStopObserved: false,
      },
      removal: {
        passed: false,
        stagedPluginRemoved: true,
        noLiveRuntime: true,
        swaOwnedResidueCount: 0,
      },
    },
    windowsStaging:
      platform === "win32-x64"
        ? { mode: "powershell-acl", passed: false }
        : { mode: "not-applicable", passed: true },
    errors: [],
  };
}

function recordFailure(
  report: KeylessLifecyclePlatformReport,
  phase: KeylessLifecyclePhase,
  error: unknown,
  fallback: KeylessLifecycleFailureCode,
): void {
  if (report.errors.length > 0) return;
  report.errors.push({
    code: error instanceof LifecycleCondition ? error.code : fallback,
    phase,
  });
}

function mapFixtureFailure(error: unknown): LifecycleCondition {
  if (error instanceof LifecycleCondition) return error;
  if (error instanceof Error) {
    for (const code of [
      "artifact-invalid",
      "bundle-contract-invalid",
      "path-escape",
      "platform-mismatch",
    ] as const) {
      if (error.message.startsWith(code)) return new LifecycleCondition(code);
    }
  }
  return new LifecycleCondition("artifact-invalid");
}

function assertClosedLaunchEnvironment(
  launch: ResolvedPluginLaunch,
  version: PluginFixtureVersion,
): void {
  if (
    !hasExactKeys(launch.env, allowedLaunchEnvironment) ||
    launch.env.PATH !== "" ||
    launch.env.SWA_SPIKE_PLUGIN_VERSION !== version
  ) {
    throw new LifecycleCondition("runtime-launch-failed");
  }
}

async function verifyStagedDigest(
  launch: ResolvedPluginLaunch,
  version: PluginFixtureVersion,
  index: KeylessPluginFixtureIndex,
  filesystem: KeylessLifecycleDependencies["filesystem"],
): Promise<void> {
  const observed = await filesystem.digestFile(launch.command);
  const expected = index.runtimeArtifacts[version];
  if (
    observed.sha256 !== expected.sha256 ||
    observed.bytes !== expected.bytes
  ) {
    throw new LifecycleCondition("artifact-invalid");
  }
}

async function requireLifecycleTools(client: LifecycleMcpClient): Promise<void> {
  const listed = await client.listTools();
  const names = listed.tools.map(({ name }) => name);
  for (const [name, phase] of [
    ["swa_spike_health", "initial"],
    ["swa_spike_bridge_status", "bridge-status"],
    ["swa_spike_crash", "crash"],
  ] as const) {
    if (!names.includes(name)) {
      throw new LifecycleCondition("mcp-tool-missing", phase);
    }
  }
  if (
    names.length !== lifecycleToolNames.length ||
    lifecycleToolNames.some((name) => !names.includes(name))
  ) {
    throw new LifecycleCondition("mcp-tool-missing");
  }
}

function parseHealth(
  value: unknown,
  nonce: string,
  expectedBuild: PluginFixtureVersion,
  expectedPlatform: KeylessLifecyclePlatformReport["platform"],
  buildMismatchCode: KeylessLifecycleFailureCode = "mcp-call-invalid",
): HealthObservation {
  if (!isRecord(value) || !hasExactKeys(value, [
    "status",
    "nonce",
    "pid",
    "platform",
    "runtimeSessionId",
    "runtimeBuildId",
  ])) {
    throw new LifecycleCondition("mcp-call-invalid");
  }
  if (
    value.status !== "ok" ||
    value.nonce !== nonce ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    value.platform !== expectedPlatform ||
    typeof value.runtimeSessionId !== "string" ||
    !/^rt_[0-9a-f]{32}$/.test(value.runtimeSessionId)
  ) {
    throw new LifecycleCondition("mcp-call-invalid");
  }
  if (value.runtimeBuildId !== expectedBuild) {
    throw new LifecycleCondition(buildMismatchCode);
  }
  return {
    pid: value.pid as number,
    runtimeSessionId: value.runtimeSessionId,
    runtimeBuildId: expectedBuild,
  };
}

function parseBridge(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["runtime", "bridge"]) ||
    value.runtime !== "ready" ||
    !isRecord(value.bridge) ||
    !hasExactKeys(value.bridge, ["state"]) ||
    value.bridge.state !== "not-installed"
  ) {
    throw new LifecycleCondition("mcp-call-invalid");
  }
}

function parseCrashAcknowledgement(value: unknown, pid: number): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["status", "pid"]) ||
    value.status !== "crash-scheduled" ||
    value.pid !== pid
  ) {
    throw new LifecycleCondition("mcp-call-invalid");
  }
}

async function closeIfOwned(
  connected: ConnectedPackagedRuntime | undefined,
): Promise<void> {
  if (
    connected !== undefined &&
    !connected.transport.processOwnershipResolved
  ) {
    await connected.client.close();
  }
}

async function readFixtureIndex(fixtureRoot: string): Promise<unknown> {
  return JSON.parse(
    await readFile(join(fixtureRoot, "fixture-index.json"), "utf8"),
  );
}

async function digestFile(
  path: string,
): Promise<{ sha256: string; bytes: number }> {
  const bytes = await readFile(path);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      isRecord(error) &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isRecord(error) && "code" in error && error.code === "ESRCH");
  }
}

async function inspectResidue(input: {
  stagedPluginRoots: readonly string[];
  observedPids: readonly number[];
}): Promise<LifecycleResidueObservation> {
  const roots = await Promise.all(input.stagedPluginRoots.map(pathExists));
  const live = input.observedPids.filter(processIsAlive);
  const residueCount = roots.filter(Boolean).length;
  return {
    stagedPluginRemoved: residueCount === 0,
    noLiveRuntime: live.length === 0,
    swaOwnedResidueCount: residueCount,
  };
}

export async function connectPackagedRuntime(
  launch: ResolvedPluginLaunch,
): Promise<ConnectedPackagedRuntime> {
  const transport = new RuntimeStdioTransport({
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd,
    env: launch.env,
    stderr: "pipe",
  });
  const client = new Client({
    name: "super-web-agent-keyless-evidence",
    version: "0.0.0-spike",
  });
  try {
    await client.connect(transport);
    const lifecycleClient: LifecycleMcpClient = {
      async listTools() {
        const result = await client.listTools();
        return {
          tools: result.tools.map(({ name }) => ({ name })),
        };
      },
      async callTool(input) {
        const result = await client.callTool(input);
        return "structuredContent" in result
          ? { structuredContent: result.structuredContent }
          : {};
      },
      close() {
        return client.close();
      },
    };
    return { client: lifecycleClient, transport };
  } catch {
    const pid = transport.pid;
    const code =
      pid === null
        ? "runtime-launch-failed"
        : "mcp-initialize-failed";
    try {
      await transport.close();
    } catch {
      // The harness retains the transport and retries its bounded cleanup.
    }
    throw Object.assign(new Error(code), {
      kind: "runtime-connection-failure" as const,
      code,
      pid,
      transport,
    });
  }
}

const productionDependencies: KeylessLifecycleDependencies = {
  filesystem: {
    readFixtureIndex,
    digestFile,
  },
  clock: {
    finalCloseTimeoutMs: () => 10_000,
  },
  stagePlugin: stageKeylessPluginVersion,
  connectRuntime: connectPackagedRuntime,
  processObservation: {
    inspectResidue,
  },
};

export async function runKeylessLifecycle(
  input: RunKeylessLifecycleInput,
  dependencies: KeylessLifecycleDependencies = productionDependencies,
): Promise<KeylessLifecyclePlatformReport> {
  let platform: KeylessLifecyclePlatformReport["platform"];
  let platformSupported = true;
  try {
    platform = currentPlatform();
  } catch {
    platform = "darwin-arm64";
    platformSupported = false;
  }
  const report = initialReport(input, platform);
  const stagedPluginRoots: string[] = [];
  const observedPids: number[] = [];
  let cleanupFailed = false;
  let index: KeylessPluginFixtureIndex | undefined;
  let initialIdentity: HealthObservation | undefined;
  let recoveryIdentity: HealthObservation | undefined;

  if (!platformSupported) {
    recordFailure(
      report,
      "fixture",
      new LifecycleCondition("platform-mismatch"),
      "platform-mismatch",
    );
  } else {
    try {
      if (process.version !== "v24.14.0") {
        throw new LifecycleCondition("platform-mismatch");
      }
      index = parseKeylessPluginFixtureIndex(
        await dependencies.filesystem.readFixtureIndex(input.fixtureRoot),
      );
      if (index.platform !== platform) {
        throw new LifecycleCondition("platform-mismatch");
      }
      report.artifacts = index.runtimeArtifacts;
      report.phases.initial.observedRuntimeSha256 =
        index.runtimeArtifacts["0.0.1"].sha256;
      report.phases.recovery.observedRuntimeSha256 =
        index.runtimeArtifacts["0.0.1"].sha256;
      report.phases.update.observedRuntimeSha256 =
        index.runtimeArtifacts["0.0.2"].sha256;
      report.windowsStaging =
        index.platform === "win32-x64"
          ? { mode: "powershell-acl", passed: true }
          : { mode: "not-applicable", passed: true };
    } catch (error) {
      recordFailure(
        report,
        "fixture",
        mapFixtureFailure(error),
        "artifact-invalid",
      );
    }
  }

  if (index !== undefined && report.errors.length === 0) {
    let staged: StagedKeylessPlugin | undefined;
    let connected: ConnectedPackagedRuntime | undefined;
    let activePhase: KeylessLifecyclePhase = "initial";
    let fallbackCode: KeylessLifecycleFailureCode =
      "runtime-launch-failed";
    try {
      staged = await dependencies.stagePlugin({
        fixtureRoot: input.fixtureRoot,
        index,
        version: "0.0.1",
      });
      stagedPluginRoots.push(staged.pluginRoot);
      report.launch.runtimeRelativePath = staged.launch.runtimeRelativePath;
      assertClosedLaunchEnvironment(staged.launch, "0.0.1");
      await verifyStagedDigest(
        staged.launch,
        "0.0.1",
        index,
        dependencies.filesystem,
      );
      connected = await dependencies.connectRuntime(staged.launch);
      fallbackCode = "mcp-initialize-failed";
      await requireLifecycleTools(connected.client);
      const nonce = randomBytes(16).toString("hex");
      fallbackCode = "mcp-call-invalid";
      const health = await connected.client.callTool({
        name: "swa_spike_health",
        arguments: { nonce },
      });
      initialIdentity = parseHealth(
        health.structuredContent,
        nonce,
        "0.0.1",
        index.platform,
      );
      observedPids.push(initialIdentity.pid);
      report.phases.initial = {
        ...report.phases.initial,
        passed: true,
        healthNonceMatched: true,
      };
      activePhase = "bridge-status";
      const bridge = await connected.client.callTool({
        name: "swa_spike_bridge_status",
        arguments: {},
      });
      parseBridge(bridge.structuredContent);
      report.phases.bridgeStatus.passed = true;
      activePhase = "crash";
      const crash = await connected.client.callTool({
        name: "swa_spike_crash",
        arguments: {},
      });
      parseCrashAcknowledgement(crash.structuredContent, initialIdentity.pid);
      const finalClose = await connected.transport.waitForFinalClose(
        dependencies.clock.finalCloseTimeoutMs(),
      );
      const exit = connected.transport.exitObservation;
      if (
        !finalClose ||
        exit?.code !== 86 ||
        exit.signal !== null ||
        exit.premature !== true
      ) {
        throw new LifecycleCondition("runtime-exit-unobserved");
      }
      report.phases.crash.passed = true;
    } catch (error) {
      let failure = error;
      if (isRuntimeConnectionFailure(error)) {
        if (error.pid !== null && !observedPids.includes(error.pid)) {
          observedPids.push(error.pid);
        }
        if (!error.transport.processOwnershipResolved) {
          try {
            await error.transport.close();
          } catch {
            // Ownership state below determines the closed failure code.
          }
        }
        failure = new LifecycleCondition(
          error.transport.processOwnershipResolved
            ? error.code
            : "runtime-exit-unobserved",
        );
      }
      const failurePhase =
        failure instanceof LifecycleCondition && failure.phase !== undefined
          ? failure.phase
          : activePhase;
      recordFailure(report, failurePhase, failure, fallbackCode);
    } finally {
      try {
        await closeIfOwned(connected);
      } catch {
        recordFailure(
          report,
          "initial",
          new LifecycleCondition("runtime-exit-unobserved"),
          "runtime-exit-unobserved",
        );
      }
      if (staged !== undefined) {
        try {
          await staged.cleanup();
        } catch {
          cleanupFailed = true;
          recordFailure(
            report,
            "removal",
            new LifecycleCondition("residue-detected"),
            "residue-detected",
          );
        }
      }
    }
  }

  if (
    index !== undefined &&
    initialIdentity !== undefined &&
    report.errors.length === 0
  ) {
    let staged: StagedKeylessPlugin | undefined;
    let connected: ConnectedPackagedRuntime | undefined;
    try {
      staged = await dependencies.stagePlugin({
        fixtureRoot: input.fixtureRoot,
        index,
        version: "0.0.1",
      });
      stagedPluginRoots.push(staged.pluginRoot);
      assertClosedLaunchEnvironment(staged.launch, "0.0.1");
      await verifyStagedDigest(
        staged.launch,
        "0.0.1",
        index,
        dependencies.filesystem,
      );
      connected = await dependencies.connectRuntime(staged.launch);
      await requireLifecycleTools(connected.client);
      const nonce = randomBytes(16).toString("hex");
      const health = await connected.client.callTool({
        name: "swa_spike_health",
        arguments: { nonce },
      });
      recoveryIdentity = parseHealth(
        health.structuredContent,
        nonce,
        "0.0.1",
        index.platform,
      );
      observedPids.push(recoveryIdentity.pid);
      if (
        recoveryIdentity.pid === initialIdentity.pid ||
        recoveryIdentity.runtimeSessionId === initialIdentity.runtimeSessionId
      ) {
        throw new LifecycleCondition("recovery-failed");
      }
      await connected.client.close();
      if (!connected.transport.processOwnershipResolved) {
        throw new LifecycleCondition("runtime-exit-unobserved");
      }
      report.phases.recovery = {
        ...report.phases.recovery,
        passed: true,
        healthNonceMatched: true,
        cleanStopObserved: true,
      };
    } catch (error) {
      recordFailure(report, "recovery", error, "recovery-failed");
    } finally {
      try {
        await closeIfOwned(connected);
      } catch {
        recordFailure(
          report,
          "recovery",
          new LifecycleCondition("runtime-exit-unobserved"),
          "runtime-exit-unobserved",
        );
      }
      if (staged !== undefined) {
        try {
          await staged.cleanup();
        } catch {
          cleanupFailed = true;
          recordFailure(
            report,
            "removal",
            new LifecycleCondition("residue-detected"),
            "residue-detected",
          );
        }
      }
    }
  }

  if (
    index !== undefined &&
    recoveryIdentity !== undefined &&
    report.errors.length === 0
  ) {
    let staged: StagedKeylessPlugin | undefined;
    let connected: ConnectedPackagedRuntime | undefined;
    try {
      staged = await dependencies.stagePlugin({
        fixtureRoot: input.fixtureRoot,
        index,
        version: "0.0.2",
      });
      stagedPluginRoots.push(staged.pluginRoot);
      assertClosedLaunchEnvironment(staged.launch, "0.0.2");
      await verifyStagedDigest(
        staged.launch,
        "0.0.2",
        index,
        dependencies.filesystem,
      );
      connected = await dependencies.connectRuntime(staged.launch);
      await requireLifecycleTools(connected.client);
      const nonce = randomBytes(16).toString("hex");
      const health = await connected.client.callTool({
        name: "swa_spike_health",
        arguments: { nonce },
      });
      const updateIdentity = parseHealth(
        health.structuredContent,
        nonce,
        "0.0.2",
        index.platform,
        "update-not-applied",
      );
      observedPids.push(updateIdentity.pid);
      if (
        updateIdentity.pid === recoveryIdentity.pid ||
        updateIdentity.runtimeSessionId === recoveryIdentity.runtimeSessionId
      ) {
        throw new LifecycleCondition("update-not-applied");
      }
      await connected.client.close();
      if (!connected.transport.processOwnershipResolved) {
        throw new LifecycleCondition("runtime-exit-unobserved");
      }
      report.phases.update = {
        ...report.phases.update,
        passed: true,
        healthNonceMatched: true,
        cleanStopObserved: true,
      };
    } catch (error) {
      recordFailure(report, "update", error, "update-not-applied");
    } finally {
      try {
        await closeIfOwned(connected);
      } catch {
        recordFailure(
          report,
          "update",
          new LifecycleCondition("runtime-exit-unobserved"),
          "runtime-exit-unobserved",
        );
      }
      if (staged !== undefined) {
        try {
          await staged.cleanup();
        } catch {
          cleanupFailed = true;
          recordFailure(
            report,
            "removal",
            new LifecycleCondition("residue-detected"),
            "residue-detected",
          );
        }
      }
    }
  }

  try {
    const residue = await dependencies.processObservation.inspectResidue({
      stagedPluginRoots,
      observedPids,
    });
    const passed =
      !cleanupFailed &&
      residue.stagedPluginRemoved &&
      residue.noLiveRuntime &&
      residue.swaOwnedResidueCount === 0;
    report.phases.removal.passed = passed;
    if (!passed) {
      recordFailure(
        report,
        "removal",
        new LifecycleCondition("residue-detected"),
        "residue-detected",
      );
    }
  } catch {
    recordFailure(
      report,
      "removal",
      new LifecycleCondition("residue-detected"),
      "residue-detected",
    );
  }

  return report;
}
