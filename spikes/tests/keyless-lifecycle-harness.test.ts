import { expect, it, vi } from "vitest";
import {
  parseKeylessLifecyclePlatformReport,
  type KeylessLifecycleFailureCode,
  type KeylessLifecyclePhase,
} from "../src/keyless-lifecycle-report.js";
import {
  runKeylessLifecycle,
  type KeylessLifecycleDependencies,
  type LifecycleMcpClient,
  type LifecycleRuntimeTransport,
} from "../src/keyless-lifecycle-harness.js";
import type {
  KeylessPluginFixtureIndex,
  PluginFixtureVersion,
  ResolvedPluginLaunch,
  StagedKeylessPlugin,
} from "../src/keyless-plugin-bundle.js";

const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const firstDigest = "a".repeat(64);
const secondDigest = "b".repeat(64);

function currentPlatform(): "darwin-arm64" | "win32-x64" {
  const platform = `${process.platform}-${process.arch}`;
  if (platform !== "darwin-arm64" && platform !== "win32-x64") {
    throw new Error(`unsupported test platform: ${platform}`);
  }
  return platform;
}

function executableName(): "super-web-agent-runtime" | "super-web-agent-runtime.exe" {
  return currentPlatform() === "win32-x64"
    ? "super-web-agent-runtime.exe"
    : "super-web-agent-runtime";
}

function fixtureIndex(): KeylessPluginFixtureIndex {
  return {
    schemaVersion: 1,
    platform: currentPlatform(),
    pluginName: "super-web-agent-lifecycle-evidence",
    versions: ["0.0.1", "0.0.2"],
    runtimeArtifacts: {
      "0.0.1": {
        artifact: executableName(),
        sha256: firstDigest,
        bytes: 101,
        buildId: "0.0.1",
      },
      "0.0.2": {
        artifact: executableName(),
        sha256: secondDigest,
        bytes: 202,
        buildId: "0.0.2",
      },
    },
  };
}

interface Scenario {
  readonly missingTool?:
    | "swa_spike_health"
    | "swa_spike_bridge_status"
    | "swa_spike_crash";
  readonly nonceMismatch?: boolean;
  readonly malformedHealth?: boolean;
  readonly bridgeState?: string;
  readonly crashExitCode?: number;
  readonly finalCloseObserved?: boolean;
  readonly recoveryPidReuse?: boolean;
  readonly recoverySessionReuse?: boolean;
  readonly updateBuildId?: string;
  readonly mutateDigestBeforeLaunch?: boolean;
  readonly cleanupFailure?: boolean;
  readonly residue?: boolean;
  readonly providerCredential?: string;
}

function lifecycleDependencies(
  calls: string[],
  scenario: Scenario = {},
): KeylessLifecycleDependencies {
  const index = fixtureIndex();
  let stageCount = 0;
  let connectionCount = 0;
  let digestCount = 0;

  return {
    filesystem: {
      async readFixtureIndex() {
        return index;
      },
      async digestFile() {
        digestCount += 1;
        const version = digestCount <= 2 ? "0.0.1" : "0.0.2";
        if (scenario.mutateDigestBeforeLaunch && digestCount === 1) {
          return { sha256: "c".repeat(64), bytes: 101 };
        }
        return {
          sha256: index.runtimeArtifacts[version].sha256,
          bytes: index.runtimeArtifacts[version].bytes,
        };
      },
    },
    clock: {
      finalCloseTimeoutMs() {
        return 1_000;
      },
    },
    async stagePlugin({ version }) {
      stageCount += 1;
      const stageLabel =
        stageCount === 1
          ? "stage-0.0.1"
          : stageCount === 2
            ? "stage-0.0.1"
            : "stage-0.0.2";
      calls.push(stageLabel);
      const cleanupLabel =
        stageCount === 1
          ? "cleanup-0.0.1"
          : stageCount === 2
            ? "cleanup-recovery"
            : "cleanup-0.0.2";
      const root = `/staged/${String(stageCount)}/super-web-agent-lifecycle-evidence`;
      const launch: ResolvedPluginLaunch = {
        command: `${root}/bin/${executableName()}`,
        args: [],
        cwd: root,
        env: {
          PATH: "",
          SWA_SPIKE_PLUGIN_VERSION: version,
          ...(scenario.providerCredential === undefined
            ? {}
            : { OPENAI_API_KEY: scenario.providerCredential }),
        },
        pluginRoot: root,
        runtimeRelativePath: `bin/${executableName()}`,
      };
      return {
        pluginRoot: root,
        launch,
        async cleanup() {
          calls.push(cleanupLabel);
          if (scenario.cleanupFailure && stageCount === 1) {
            throw new Error("raw cleanup failure");
          }
        },
      } satisfies StagedKeylessPlugin;
    },
    async connectRuntime(launch) {
      connectionCount += 1;
      const phase =
        connectionCount === 1
          ? "initial"
          : connectionCount === 2
            ? "recovery"
            : "update";
      calls.push(
        connectionCount === 1
          ? "connect-0.0.1"
          : connectionCount === 2
            ? "connect-recovery"
            : "connect-0.0.2",
      );
      let closed = false;
      let crashCloseObserved = false;
      const pid =
        phase === "initial"
          ? 41_001
          : scenario.recoveryPidReuse
            ? 41_001
            : phase === "recovery"
              ? 41_002
              : 41_003;
      const runtimeSessionId =
        phase === "initial"
          ? "rt_11111111111111111111111111111111"
          : scenario.recoverySessionReuse
            ? "rt_11111111111111111111111111111111"
            : phase === "recovery"
              ? "rt_22222222222222222222222222222222"
              : "rt_33333333333333333333333333333333";
      const expectedBuild = launch.env.SWA_SPIKE_PLUGIN_VERSION as PluginFixtureVersion;

      const client: LifecycleMcpClient = {
        async listTools() {
          const names = [
            "swa_spike_health",
            "swa_spike_bridge_status",
            "swa_spike_crash",
          ].filter((name) => name !== scenario.missingTool);
          return { tools: names.map((name) => ({ name })) };
        },
        async callTool({ name, arguments: toolArguments }) {
          if (name === "swa_spike_health") {
            calls.push(`health-${phase}`);
            if (scenario.malformedHealth && phase === "initial") {
              return { structuredContent: { status: "ok" } };
            }
            const nonce =
              scenario.nonceMismatch && phase === "initial"
                ? "wrong-nonce"
                : toolArguments?.nonce;
            return {
              structuredContent: {
                status: "ok",
                nonce,
                pid,
                platform: currentPlatform(),
                runtimeSessionId,
                runtimeBuildId:
                  phase === "update" && scenario.updateBuildId !== undefined
                    ? scenario.updateBuildId
                    : expectedBuild,
              },
            };
          }
          if (name === "swa_spike_bridge_status") {
            calls.push("bridge-status");
            return {
              structuredContent: {
                runtime: "ready",
                bridge: { state: scenario.bridgeState ?? "not-installed" },
              },
            };
          }
          calls.push("crash");
          return {
            structuredContent: {
              status: "crash-scheduled",
              pid,
            },
          };
        },
        async close() {
          if (!closed) {
            calls.push(`clean-stop-${phase}`);
            closed = true;
          }
        },
      };
      const transport: LifecycleRuntimeTransport = {
        get processOwnershipResolved() {
          return closed || crashCloseObserved;
        },
        get exitObservation() {
          return crashCloseObserved
            ? {
                code: scenario.crashExitCode ?? 86,
                signal: null,
                premature: true,
              }
            : undefined;
        },
        async close() {
          closed = true;
        },
        async waitForFinalClose() {
          calls.push("wait-crash-exit");
          crashCloseObserved = scenario.finalCloseObserved ?? true;
          return crashCloseObserved;
        },
      };
      return { client, transport };
    },
    processObservation: {
      async inspectResidue() {
        calls.push("inspect-residue");
        return scenario.residue
          ? {
              stagedPluginRemoved: false,
              noLiveRuntime: false,
              swaOwnedResidueCount: 1,
            }
          : {
              stagedPluginRemoved: true,
              noLiveRuntime: true,
              swaOwnedResidueCount: 0,
            };
      },
    },
  };
}

it("runs the packaged Runtime lifecycle serially without provider dependencies", async () => {
  const calls: string[] = [];
  const report = await runKeylessLifecycle(
    {
      fixtureRoot: "/absolute/fixture",
      sourceCommit,
    },
    lifecycleDependencies(calls),
  );

  expect(calls).toEqual([
    "stage-0.0.1",
    "connect-0.0.1",
    "health-initial",
    "bridge-status",
    "crash",
    "wait-crash-exit",
    "cleanup-0.0.1",
    "stage-0.0.1",
    "connect-recovery",
    "health-recovery",
    "clean-stop-recovery",
    "cleanup-recovery",
    "stage-0.0.2",
    "connect-0.0.2",
    "health-update",
    "clean-stop-update",
    "cleanup-0.0.2",
    "inspect-residue",
  ]);
  expect(report.providerDependencies).toEqual({
    apiKeysRequired: false,
    providerCliInvoked: false,
    modelInvoked: false,
  });
  expect(report.phases.recovery.pidChanged).toBe(true);
  expect(report.phases.recovery.runtimeSessionChanged).toBe(true);
  expect(report.phases.update.observedRuntimeBuildId).toBe("0.0.2");
  expect(report.errors).toEqual([]);
  expect(parseKeylessLifecyclePlatformReport(report)).toEqual(report);
});

it("rejects an unsupported current platform before fixture or executable phases", async () => {
  const calls: string[] = [];
  const dependencies = lifecycleDependencies(calls);
  const platform = vi
    .spyOn(process, "platform", "get")
    .mockReturnValue("linux");
  const guardedDependencies: KeylessLifecycleDependencies = {
    ...dependencies,
    filesystem: {
      ...dependencies.filesystem,
      async readFixtureIndex(fixtureRoot) {
        calls.push("read-fixture");
        return dependencies.filesystem.readFixtureIndex(fixtureRoot);
      },
    },
  };

  try {
    const report = await runKeylessLifecycle(
      {
        fixtureRoot: "/absolute/fixture",
        sourceCommit,
      },
      guardedDependencies,
    );

    expect(calls).toEqual(["inspect-residue"]);
    expect(report.errors).toEqual([
      { code: "platform-mismatch", phase: "fixture" },
    ]);
    expect(parseKeylessLifecyclePlatformReport(report)).toEqual(report);
  } finally {
    platform.mockRestore();
  }
});

it("rejects a fixture platform different from the supported current platform", async () => {
  const calls: string[] = [];
  const dependencies = lifecycleDependencies(calls);
  const index = fixtureIndex();
  index.platform =
    index.platform === "darwin-arm64" ? "win32-x64" : "darwin-arm64";
  const guardedDependencies: KeylessLifecycleDependencies = {
    ...dependencies,
    filesystem: {
      ...dependencies.filesystem,
      async readFixtureIndex() {
        return index;
      },
    },
  };

  const report = await runKeylessLifecycle(
    {
      fixtureRoot: "/absolute/fixture",
      sourceCommit,
    },
    guardedDependencies,
  );

  expect(calls).toEqual(["inspect-residue"]);
  expect(report.errors).toEqual([
    { code: "platform-mismatch", phase: "fixture" },
  ]);
  expect(parseKeylessLifecyclePlatformReport(report)).toEqual(report);
});

it("retains a rejected connection PID and refuses acceptance when close stays unobserved", async () => {
  const calls: string[] = [];
  const dependencies = lifecycleDependencies(calls);
  let inspectedPids: readonly number[] = [];
  const escapedTransport = {
    processOwnershipResolved: false,
    exitObservation: undefined,
    async waitForFinalClose() {
      return false;
    },
    async close() {
      calls.push("close-rejected-connect");
      throw new Error("raw bounded close failure");
    },
  };
  const guardedDependencies: KeylessLifecycleDependencies = {
    ...dependencies,
    async connectRuntime() {
      calls.push("connect-0.0.1");
      throw Object.assign(new Error("raw initialize failure"), {
        kind: "runtime-connection-failure",
        code: "mcp-initialize-failed",
        pid: 49_001,
        transport: escapedTransport,
      });
    },
    processObservation: {
      async inspectResidue({ observedPids }) {
        calls.push("inspect-residue");
        inspectedPids = observedPids;
        return {
          stagedPluginRemoved: true,
          noLiveRuntime: false,
          swaOwnedResidueCount: 0,
        };
      },
    },
  };

  const report = await runKeylessLifecycle(
    {
      fixtureRoot: "/absolute/fixture",
      sourceCommit,
    },
    guardedDependencies,
  );

  expect(calls).toEqual([
    "stage-0.0.1",
    "connect-0.0.1",
    "close-rejected-connect",
    "cleanup-0.0.1",
    "inspect-residue",
  ]);
  expect(inspectedPids).toEqual([49_001]);
  expect(report.errors).toEqual([
    { code: "runtime-exit-unobserved", phase: "initial" },
  ]);
  expect(JSON.stringify(report)).not.toContain("raw");
  expect(parseKeylessLifecyclePlatformReport(report)).toEqual(report);
});

it.each<{
  name: string;
  scenario: Scenario;
  code: KeylessLifecycleFailureCode;
  phase: KeylessLifecyclePhase;
}>([
  {
    name: "missing health tool",
    scenario: { missingTool: "swa_spike_health" },
    code: "mcp-tool-missing",
    phase: "initial",
  },
  {
    name: "missing bridge tool",
    scenario: { missingTool: "swa_spike_bridge_status" },
    code: "mcp-tool-missing",
    phase: "bridge-status",
  },
  {
    name: "missing crash tool",
    scenario: { missingTool: "swa_spike_crash" },
    code: "mcp-tool-missing",
    phase: "crash",
  },
  {
    name: "health nonce mismatch",
    scenario: { nonceMismatch: true },
    code: "mcp-call-invalid",
    phase: "initial",
  },
  {
    name: "malformed structured content",
    scenario: { malformedHealth: true },
    code: "mcp-call-invalid",
    phase: "initial",
  },
  {
    name: "installed bridge state",
    scenario: { bridgeState: "connected" },
    code: "mcp-call-invalid",
    phase: "bridge-status",
  },
  {
    name: "crash exit code other than 86",
    scenario: { crashExitCode: 1 },
    code: "runtime-exit-unobserved",
    phase: "crash",
  },
  {
    name: "unobserved final close",
    scenario: { finalCloseObserved: false },
    code: "runtime-exit-unobserved",
    phase: "crash",
  },
  {
    name: "recovery PID reuse",
    scenario: { recoveryPidReuse: true },
    code: "recovery-failed",
    phase: "recovery",
  },
  {
    name: "recovery Runtime Session reuse",
    scenario: { recoverySessionReuse: true },
    code: "recovery-failed",
    phase: "recovery",
  },
  {
    name: "stale update build",
    scenario: { updateBuildId: "0.0.1" },
    code: "update-not-applied",
    phase: "update",
  },
  {
    name: "digest mutation before launch",
    scenario: { mutateDigestBeforeLaunch: true },
    code: "artifact-invalid",
    phase: "initial",
  },
  {
    name: "cleanup failure",
    scenario: { cleanupFailure: true },
    code: "residue-detected",
    phase: "removal",
  },
  {
    name: "residue after removal",
    scenario: { residue: true },
    code: "residue-detected",
    phase: "removal",
  },
  {
    name: "attempted inherited provider credential",
    scenario: { providerCredential: "must-not-escape" },
    code: "runtime-launch-failed",
    phase: "initial",
  },
])("returns one sanitized strict report for $name", async ({ scenario, code, phase }) => {
  const calls: string[] = [];
  const report = await runKeylessLifecycle(
    {
      fixtureRoot: "/absolute/fixture",
      sourceCommit,
    },
    lifecycleDependencies(calls, scenario),
  );

  expect(report.errors).toHaveLength(1);
  expect(report.errors[0]).toEqual({ code, phase });
  expect(Object.keys(report.errors[0] ?? {}).sort()).toEqual(["code", "phase"]);
  expect(parseKeylessLifecyclePlatformReport(report)).toEqual(report);
  const serialized = JSON.stringify(report);
  expect(serialized).not.toContain("raw cleanup failure");
  expect(serialized).not.toContain("must-not-escape");
});
