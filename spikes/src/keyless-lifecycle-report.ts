import type { PluginFixtureVersion, RuntimeFixtureMetadata } from "./keyless-plugin-bundle.js";
import type { TargetPlatform } from "./packaging-report.js";

export type KeylessLifecycleFailureCode =
  | "artifact-invalid"
  | "bundle-contract-invalid"
  | "path-escape"
  | "platform-mismatch"
  | "runtime-launch-failed"
  | "mcp-initialize-failed"
  | "mcp-tool-missing"
  | "mcp-call-invalid"
  | "runtime-exit-unobserved"
  | "recovery-failed"
  | "update-not-applied"
  | "residue-detected"
  | "desktop-acceptance-required";

export interface LifecyclePhaseResult {
  passed: boolean;
  observedRuntimeBuildId: PluginFixtureVersion;
  observedRuntimeSha256: string;
  healthNonceMatched: boolean;
  pidChanged: boolean;
  runtimeSessionChanged: boolean;
  cleanStopObserved: boolean;
}

export interface BridgeStatusPhaseResult {
  passed: boolean;
  runtime: "ready";
  bridgeState: "not-installed";
}

export interface CrashPhaseResult {
  passed: boolean;
  crashAcknowledged: boolean;
  finalCloseObserved: boolean;
  exitCode: 86;
  signal: null;
}

export interface RemovalPhaseResult {
  passed: boolean;
  stagedPluginRemoved: boolean;
  noLiveRuntime: boolean;
  swaOwnedResidueCount: 0;
}

export type KeylessLifecyclePhase =
  | "fixture"
  | "initial"
  | "bridge-status"
  | "crash"
  | "recovery"
  | "update"
  | "removal";

export interface KeylessLifecycleFailure {
  code: KeylessLifecycleFailureCode;
  phase: KeylessLifecyclePhase;
}

export interface KeylessLifecyclePlatformReport {
  schemaVersion: 1;
  sourceCommit: string;
  platform: TargetPlatform;
  nodeVersion: "v24.14.0";
  pluginName: "super-web-agent-lifecycle-evidence";
  providerDependencies: {
    apiKeysRequired: false;
    providerCliInvoked: false;
    modelInvoked: false;
  };
  artifacts: Record<PluginFixtureVersion, RuntimeFixtureMetadata>;
  launch: {
    runtimeRelativePath: string;
    cwd: ".";
    pathContained: true;
  };
  phases: {
    initial: LifecyclePhaseResult;
    bridgeStatus: BridgeStatusPhaseResult;
    crash: CrashPhaseResult;
    recovery: LifecyclePhaseResult;
    update: LifecyclePhaseResult;
    removal: RemovalPhaseResult;
  };
  windowsStaging:
    | { mode: "not-applicable"; passed: true }
    | { mode: "powershell-acl"; passed: boolean };
  errors: KeylessLifecycleFailure[];
}

export interface KeylessLifecyclePlatformEvaluation {
  state: "accepted" | "rejected";
  reasons: string[];
}

const failureCodes: readonly KeylessLifecycleFailureCode[] = [
  "artifact-invalid", "bundle-contract-invalid", "path-escape", "platform-mismatch",
  "runtime-launch-failed", "mcp-initialize-failed", "mcp-tool-missing", "mcp-call-invalid",
  "runtime-exit-unobserved", "recovery-failed", "update-not-applied", "residue-detected",
  "desktop-acceptance-required",
];
const phaseOrder: readonly KeylessLifecyclePhase[] = [
  "fixture", "initial", "bridge-status", "crash", "recovery", "update", "removal",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireExactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw new Error(`invalid lifecycle ${label} keys`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`invalid lifecycle ${label}`);
  return value;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`invalid lifecycle ${label}`);
  }
  return value;
}

function requireBuildId(value: unknown, label: string): PluginFixtureVersion {
  if (value !== "0.0.1" && value !== "0.0.2") throw new Error(`invalid lifecycle ${label}`);
  return value;
}

function parseArtifact(
  value: unknown,
  version: PluginFixtureVersion,
  platform: KeylessLifecyclePlatformReport["platform"],
): RuntimeFixtureMetadata {
  const artifact = requireExactRecord(value, ["artifact", "sha256", "bytes", "buildId"], "artifact");
  const expectedArtifact = platform === "win32-x64" ? "super-web-agent-runtime.exe" : "super-web-agent-runtime";
  if (artifact.artifact !== expectedArtifact || artifact.buildId !== version) {
    throw new Error("invalid lifecycle artifact");
  }
  if (typeof artifact.bytes !== "number" || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
    throw new Error("invalid lifecycle artifact");
  }
  return {
    artifact: expectedArtifact,
    sha256: requireSha256(artifact.sha256, "artifact digest"),
    bytes: artifact.bytes,
    buildId: version,
  };
}

function parseLifecyclePhase(
  value: unknown,
  expectedBuild: PluginFixtureVersion,
  expectedDigest: string,
  restartExpected: boolean,
): LifecyclePhaseResult {
  const phase = requireExactRecord(value, [
    "passed", "observedRuntimeBuildId", "observedRuntimeSha256", "healthNonceMatched",
    "pidChanged", "runtimeSessionChanged", "cleanStopObserved",
  ], "phase");
  if (
    phase.observedRuntimeBuildId !== expectedBuild ||
    requireSha256(phase.observedRuntimeSha256, "observed Runtime digest") !== expectedDigest ||
    requireBoolean(phase.pidChanged, "PID transition") !== restartExpected ||
    requireBoolean(phase.runtimeSessionChanged, "Runtime Session transition") !== restartExpected
  ) {
    throw new Error("invalid lifecycle Runtime observation");
  }
  return {
    passed: requireBoolean(phase.passed, "phase pass flag"),
    observedRuntimeBuildId: expectedBuild,
    observedRuntimeSha256: expectedDigest,
    healthNonceMatched: requireBoolean(phase.healthNonceMatched, "health nonce"),
    pidChanged: restartExpected,
    runtimeSessionChanged: restartExpected,
    cleanStopObserved: requireBoolean(phase.cleanStopObserved, "clean stop"),
  };
}

function parseFailures(value: unknown): KeylessLifecycleFailure[] {
  if (!Array.isArray(value)) throw new Error("invalid lifecycle failures");
  let priorPhase = -1;
  return value.map((entry) => {
    const failure = requireExactRecord(entry, ["code", "phase"], "failure");
    if (!failureCodes.includes(failure.code as KeylessLifecycleFailureCode) ||
      !phaseOrder.includes(failure.phase as KeylessLifecyclePhase)) {
      throw new Error("invalid lifecycle failure");
    }
    const phase = failure.phase as KeylessLifecyclePhase;
    const phaseIndex = phaseOrder.indexOf(phase);
    if (phaseIndex < priorPhase) throw new Error("lifecycle failures must be ordered by lifecycle phase");
    priorPhase = phaseIndex;
    return { code: failure.code as KeylessLifecycleFailureCode, phase };
  });
}

export function parseKeylessLifecyclePlatformReport(value: unknown): KeylessLifecyclePlatformReport {
  const report = requireExactRecord(value, [
    "schemaVersion", "sourceCommit", "platform", "nodeVersion", "pluginName", "providerDependencies",
    "artifacts", "launch", "phases", "windowsStaging", "errors",
  ], "report");
  if (report.schemaVersion !== 1 || typeof report.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(report.sourceCommit) ||
    (report.platform !== "darwin-arm64" && report.platform !== "win32-x64") ||
    report.nodeVersion !== "v24.14.0" || report.pluginName !== "super-web-agent-lifecycle-evidence") {
    throw new Error("invalid lifecycle report identity");
  }
  const providerDependencies = requireExactRecord(report.providerDependencies,
    ["apiKeysRequired", "providerCliInvoked", "modelInvoked"], "provider dependencies");
  if (providerDependencies.apiKeysRequired !== false || providerDependencies.providerCliInvoked !== false ||
    providerDependencies.modelInvoked !== false) throw new Error("invalid lifecycle provider dependencies");

  const artifacts = requireExactRecord(report.artifacts, ["0.0.1", "0.0.2"], "artifacts");
  const firstArtifact = parseArtifact(artifacts["0.0.1"], "0.0.1", report.platform);
  const secondArtifact = parseArtifact(artifacts["0.0.2"], "0.0.2", report.platform);
  if (firstArtifact.sha256 === secondArtifact.sha256) throw new Error("invalid lifecycle artifact digests");

  const launch = requireExactRecord(report.launch, ["runtimeRelativePath", "cwd", "pathContained"], "launch");
  if (typeof launch.runtimeRelativePath !== "string" || launch.runtimeRelativePath.length === 0 ||
    launch.runtimeRelativePath.startsWith("/") || launch.runtimeRelativePath.startsWith("\\") ||
    launch.runtimeRelativePath.includes("..") || launch.runtimeRelativePath.includes("\\") ||
    launch.runtimeRelativePath.includes(":") || launch.cwd !== "." || launch.pathContained !== true) {
    throw new Error("invalid lifecycle launch");
  }

  const phases = requireExactRecord(report.phases,
    ["initial", "bridgeStatus", "crash", "recovery", "update", "removal"], "phases");
  const initial = parseLifecyclePhase(phases.initial, "0.0.1", firstArtifact.sha256, false);
  const recovery = parseLifecyclePhase(phases.recovery, "0.0.1", firstArtifact.sha256, true);
  const update = parseLifecyclePhase(phases.update, "0.0.2", secondArtifact.sha256, true);
  const bridgeStatus = requireExactRecord(phases.bridgeStatus, ["passed", "runtime", "bridgeState"], "bridge phase");
  if (bridgeStatus.runtime !== "ready" || bridgeStatus.bridgeState !== "not-installed") {
    throw new Error("invalid lifecycle bridge phase");
  }
  const crash = requireExactRecord(phases.crash,
    ["passed", "crashAcknowledged", "finalCloseObserved", "exitCode", "signal"], "crash phase");
  if (crash.crashAcknowledged !== true || crash.finalCloseObserved !== true || crash.exitCode !== 86 || crash.signal !== null) {
    throw new Error("invalid lifecycle crash phase");
  }
  const removal = requireExactRecord(phases.removal,
    ["passed", "stagedPluginRemoved", "noLiveRuntime", "swaOwnedResidueCount"], "removal phase");
  if (removal.stagedPluginRemoved !== true || removal.noLiveRuntime !== true || removal.swaOwnedResidueCount !== 0) {
    throw new Error("invalid lifecycle removal phase");
  }

  const windowsStaging = requireExactRecord(report.windowsStaging, ["mode", "passed"], "Windows staging");
  if (report.platform === "win32-x64") {
    if (windowsStaging.mode !== "powershell-acl" || typeof windowsStaging.passed !== "boolean") {
      throw new Error("invalid lifecycle Windows staging");
    }
  } else if (windowsStaging.mode !== "not-applicable" || windowsStaging.passed !== true) {
    throw new Error("invalid lifecycle Windows staging");
  }
  const errors = parseFailures(report.errors);
  const phasePassed = [initial.passed, bridgeStatus.passed, crash.passed, recovery.passed, update.passed, removal.passed];
  if (phasePassed.every(Boolean) && errors.length > 0) throw new Error("successful lifecycle phases cannot record failures");

  return {
    schemaVersion: 1, sourceCommit: report.sourceCommit, platform: report.platform, nodeVersion: "v24.14.0",
    pluginName: "super-web-agent-lifecycle-evidence",
    providerDependencies: { apiKeysRequired: false, providerCliInvoked: false, modelInvoked: false },
    artifacts: { "0.0.1": firstArtifact, "0.0.2": secondArtifact },
    launch: { runtimeRelativePath: launch.runtimeRelativePath, cwd: ".", pathContained: true },
    phases: {
      initial,
      bridgeStatus: { passed: requireBoolean(bridgeStatus.passed, "bridge pass flag"), runtime: "ready", bridgeState: "not-installed" },
      crash: { passed: requireBoolean(crash.passed, "crash pass flag"), crashAcknowledged: true, finalCloseObserved: true, exitCode: 86, signal: null },
      recovery, update,
      removal: { passed: requireBoolean(removal.passed, "removal pass flag"), stagedPluginRemoved: true, noLiveRuntime: true, swaOwnedResidueCount: 0 },
    },
    windowsStaging: report.platform === "win32-x64"
      ? { mode: "powershell-acl", passed: windowsStaging.passed as boolean }
      : { mode: "not-applicable", passed: true },
    errors,
  };
}

export function evaluateKeylessLifecyclePlatformReport(report: unknown): KeylessLifecyclePlatformEvaluation {
  let parsed: KeylessLifecyclePlatformReport;
  try {
    parsed = parseKeylessLifecyclePlatformReport(report);
  } catch {
    return { state: "rejected", reasons: ["invalid lifecycle platform report"] };
  }
  if (parsed.errors.length > 0) {
    return { state: "rejected", reasons: parsed.errors.map((failure) => `${failure.phase}: ${failure.code}`) };
  }
  if (!parsed.phases.initial.passed || !parsed.phases.bridgeStatus.passed || !parsed.phases.crash.passed ||
    !parsed.phases.recovery.passed || !parsed.phases.update.passed || !parsed.phases.removal.passed) {
    return { state: "rejected", reasons: ["one or more lifecycle phases failed"] };
  }
  if (!parsed.windowsStaging.passed) return { state: "rejected", reasons: ["Windows staging failed"] };
  return { state: "accepted", reasons: ["native keyless lifecycle platform report passed"] };
}
