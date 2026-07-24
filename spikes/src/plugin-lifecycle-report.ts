import type { LifecycleHost } from "./lifecycle-events.js";
import type { TargetPlatform } from "./packaging-report.js";

export interface PluginLifecycleHostReport {
  schemaVersion: 1;
  runtimeVersion: "0.0.0-spike";
  host: LifecycleHost;
  hostVersion: string;
  platform: TargetPlatform;
  runtimeArtifacts: {
    "0.0.1": { sha256: string; bytes: number };
    "0.0.2": { sha256: string; bytes: number };
  };
  pluginVersions: ["0.0.1", "0.0.2"];
  installUserSteps: number;
  updateUserSteps: number;
  removalUserSteps: number;
  manualConfigEdits: number;
  administratorPrivilegesRequested: boolean;
  separateInstallerUsed: boolean;
  hostNodeRequired: boolean;
  initial: {
    healthPassed: boolean;
    cleanStopPassed: boolean;
    launchedFromHostCache: boolean;
    pid: number;
    startupLatencyMs: number;
    healthLatencyMs: number;
    observedRuntimeBuildId: string;
    observedRuntimeSha256: string;
  };
  update: {
    healthPassed: boolean;
    cleanStopPassed: boolean;
    launchedFromHostCache: boolean;
    pid: number;
    observedPluginVersion: string;
    observedRuntimeBuildId: string;
    observedRuntimeSha256: string;
  };
  crashRecovery: {
    crashObserved: boolean;
    sameSessionRestartObserved: boolean;
    freshSessionRecoveryPassed: boolean;
    reinstallRequired: boolean;
    launchedFromHostCache: boolean;
    recoveredPid: number;
    observedRuntimeBuildId: string;
    observedRuntimeSha256: string;
  };
  removal: {
    pluginRemoved: boolean;
    marketplaceRemoved: boolean;
    noLiveRuntime: boolean;
    hostManagedResiduePaths: string[];
    swaOwnedResiduePaths: string[];
  };
  commands: string[];
  errors: string[];
}

export type PluginLifecycleHostGate =
  | { gate: "pass" }
  | { gate: "fail"; reason: string };

const digestPattern = /^[a-f0-9]{64}$/;
const versions = ["0.0.1", "0.0.2"] as const;

function invalid(): never {
  throw new Error("invalid plugin lifecycle host report");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && digestPattern.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function validArtifact(value: unknown): value is { sha256: string; bytes: number } {
  return exactKeys(value, ["sha256", "bytes"]) && isDigest(value.sha256) && isPositiveSafeInteger(value.bytes);
}

function validInitial(value: unknown): value is PluginLifecycleHostReport["initial"] {
  return exactKeys(value, [
    "healthPassed", "cleanStopPassed", "launchedFromHostCache", "pid", "startupLatencyMs", "healthLatencyMs",
    "observedRuntimeBuildId", "observedRuntimeSha256",
  ]) &&
    isBoolean(value.healthPassed) && isBoolean(value.cleanStopPassed) && isBoolean(value.launchedFromHostCache) &&
    isPositiveSafeInteger(value.pid) && isNonNegativeFinite(value.startupLatencyMs) &&
    isNonNegativeFinite(value.healthLatencyMs) && isNonEmptyString(value.observedRuntimeBuildId) &&
    isDigest(value.observedRuntimeSha256);
}

function validUpdate(value: unknown): value is PluginLifecycleHostReport["update"] {
  return exactKeys(value, [
    "healthPassed", "cleanStopPassed", "launchedFromHostCache", "pid", "observedPluginVersion",
    "observedRuntimeBuildId", "observedRuntimeSha256",
  ]) &&
    isBoolean(value.healthPassed) && isBoolean(value.cleanStopPassed) && isBoolean(value.launchedFromHostCache) &&
    isPositiveSafeInteger(value.pid) && isNonEmptyString(value.observedPluginVersion) &&
    isNonEmptyString(value.observedRuntimeBuildId) && isDigest(value.observedRuntimeSha256);
}

function validCrashRecovery(value: unknown): value is PluginLifecycleHostReport["crashRecovery"] {
  return exactKeys(value, [
    "crashObserved", "sameSessionRestartObserved", "freshSessionRecoveryPassed", "reinstallRequired",
    "launchedFromHostCache", "recoveredPid", "observedRuntimeBuildId", "observedRuntimeSha256",
  ]) &&
    isBoolean(value.crashObserved) && isBoolean(value.sameSessionRestartObserved) &&
    isBoolean(value.freshSessionRecoveryPassed) && isBoolean(value.reinstallRequired) &&
    isBoolean(value.launchedFromHostCache) && isPositiveSafeInteger(value.recoveredPid) &&
    isNonEmptyString(value.observedRuntimeBuildId) && isDigest(value.observedRuntimeSha256);
}

function validRemoval(value: unknown): value is PluginLifecycleHostReport["removal"] {
  return exactKeys(value, [
    "pluginRemoved", "marketplaceRemoved", "noLiveRuntime", "hostManagedResiduePaths", "swaOwnedResiduePaths",
  ]) &&
    isBoolean(value.pluginRemoved) && isBoolean(value.marketplaceRemoved) && isBoolean(value.noLiveRuntime) &&
    isStringArray(value.hostManagedResiduePaths) && isStringArray(value.swaOwnedResiduePaths);
}

export function parsePluginLifecycleHostReport(value: unknown): PluginLifecycleHostReport {
  if (!exactKeys(value, [
    "schemaVersion", "runtimeVersion", "host", "hostVersion", "platform", "runtimeArtifacts", "pluginVersions",
    "installUserSteps", "updateUserSteps", "removalUserSteps", "manualConfigEdits", "administratorPrivilegesRequested",
    "separateInstallerUsed", "hostNodeRequired", "initial", "update", "crashRecovery", "removal", "commands", "errors",
  ])) invalid();
  if (value.schemaVersion !== 1 || value.runtimeVersion !== "0.0.0-spike" ||
    (value.host !== "claude-code" && value.host !== "codex") || !isNonEmptyString(value.hostVersion) ||
    (value.platform !== "darwin-arm64" && value.platform !== "win32-x64")) invalid();
  if (!exactKeys(value.runtimeArtifacts, versions) || !validArtifact(value.runtimeArtifacts["0.0.1"]) ||
    !validArtifact(value.runtimeArtifacts["0.0.2"]) ||
    value.runtimeArtifacts["0.0.1"].sha256 === value.runtimeArtifacts["0.0.2"].sha256) invalid();
  if (!Array.isArray(value.pluginVersions) || value.pluginVersions.length !== 2 ||
    value.pluginVersions[0] !== "0.0.1" || value.pluginVersions[1] !== "0.0.2") invalid();
  if (!isNonNegativeSafeInteger(value.installUserSteps) || !isNonNegativeSafeInteger(value.updateUserSteps) ||
    !isNonNegativeSafeInteger(value.removalUserSteps) || !isNonNegativeSafeInteger(value.manualConfigEdits) ||
    !isBoolean(value.administratorPrivilegesRequested) || !isBoolean(value.separateInstallerUsed) ||
    !isBoolean(value.hostNodeRequired) || !validInitial(value.initial) || !validUpdate(value.update) ||
    !validCrashRecovery(value.crashRecovery) || !validRemoval(value.removal) ||
    !isStringArray(value.commands) || value.commands.length === 0 || !isStringArray(value.errors)) invalid();

  const allPhasesSuccessful = value.initial.healthPassed && value.initial.cleanStopPassed && value.initial.launchedFromHostCache &&
    value.update.healthPassed && value.update.cleanStopPassed && value.update.launchedFromHostCache &&
    value.crashRecovery.crashObserved && value.crashRecovery.freshSessionRecoveryPassed &&
    !value.crashRecovery.reinstallRequired && value.crashRecovery.launchedFromHostCache &&
    value.removal.pluginRemoved && value.removal.marketplaceRemoved && value.removal.noLiveRuntime;
  if (allPhasesSuccessful && value.errors.length > 0) invalid();
  return value as unknown as PluginLifecycleHostReport;
}

function initialMatches(report: PluginLifecycleHostReport): boolean {
  const expected = report.runtimeArtifacts["0.0.1"];
  return report.initial.healthPassed && report.initial.cleanStopPassed &&
    report.initial.observedRuntimeBuildId === "0.0.1" && report.initial.observedRuntimeSha256 === expected.sha256;
}

function updateMatches(report: PluginLifecycleHostReport): boolean {
  const expected = report.runtimeArtifacts["0.0.2"];
  return report.update.healthPassed && report.update.cleanStopPassed && report.update.observedPluginVersion === "0.0.2" &&
    report.update.observedRuntimeBuildId === "0.0.2" && report.update.observedRuntimeSha256 === expected.sha256;
}

function recoveryMatches(report: PluginLifecycleHostReport): boolean {
  const expected = report.runtimeArtifacts["0.0.2"];
  return report.crashRecovery.freshSessionRecoveryPassed && !report.crashRecovery.reinstallRequired &&
    report.crashRecovery.launchedFromHostCache && report.crashRecovery.observedRuntimeBuildId === "0.0.2" &&
    report.crashRecovery.observedRuntimeSha256 === expected.sha256;
}

export function evaluatePluginLifecycleHostReport(report: PluginLifecycleHostReport): PluginLifecycleHostGate {
  if (report.manualConfigEdits > 0) return { gate: "fail", reason: "manual MCP configuration was required" };
  if (report.administratorPrivilegesRequested) return { gate: "fail", reason: "administrator privileges were requested" };
  if (report.separateInstallerUsed) return { gate: "fail", reason: "a separate installer was used" };
  if (report.hostNodeRequired) return { gate: "fail", reason: "the Runtime required Host Node" };
  if (!report.initial.launchedFromHostCache || !report.update.launchedFromHostCache || !report.crashRecovery.launchedFromHostCache) {
    return { gate: "fail", reason: "the Runtime launched outside the installed host plugin cache" };
  }
  if (!initialMatches(report)) return { gate: "fail", reason: "initial plugin did not launch Runtime build 0.0.1 cleanly" };
  if (!updateMatches(report)) return { gate: "fail", reason: "plugin update did not launch Runtime build 0.0.2 cleanly" };
  if (!report.crashRecovery.crashObserved) return { gate: "fail", reason: "Runtime crash was not observed" };
  if (!recoveryMatches(report)) return { gate: "fail", reason: "fresh-session recovery did not launch Runtime build 0.0.2 cleanly" };
  if (!report.removal.noLiveRuntime) return { gate: "fail", reason: "plugin removal left a live Runtime" };
  if (!report.removal.pluginRemoved || !report.removal.marketplaceRemoved) {
    return { gate: "fail", reason: "plugin or marketplace removal failed" };
  }
  if (report.removal.swaOwnedResiduePaths.length > 0) {
    return { gate: "fail", reason: "SWA-owned residue remained outside host-managed roots" };
  }
  if (report.errors.length > 0) return { gate: "fail", reason: report.errors[0]! };
  return { gate: "pass" };
}
