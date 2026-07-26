import { expect, it } from "vitest";
import {
  evaluateKeylessLifecyclePlatformReport,
  parseKeylessLifecyclePlatformReport,
  type KeylessLifecycleFailureCode,
  type KeylessLifecyclePlatformReport,
} from "../src/keyless-lifecycle-report.js";

function reportFor(platform: "darwin-arm64" | "win32-x64"): KeylessLifecyclePlatformReport {
  const windows = platform === "win32-x64";
  const firstDigest = windows
    ? "1111111111111111111111111111111111111111111111111111111111111111"
    : "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const secondDigest = windows
    ? "2222222222222222222222222222222222222222222222222222222222222222"
    : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const firstArtifact = windows ? "super-web-agent-runtime.exe" : "super-web-agent-runtime";
  return {
    schemaVersion: 1,
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    platform,
    nodeVersion: "v24.14.0",
    pluginName: "super-web-agent-lifecycle-evidence",
    providerDependencies: {
      apiKeysRequired: false,
      providerCliInvoked: false,
      modelInvoked: false,
    },
    artifacts: {
      "0.0.1": { artifact: firstArtifact, sha256: firstDigest, bytes: 123456, buildId: "0.0.1" },
      "0.0.2": { artifact: firstArtifact, sha256: secondDigest, bytes: 123457, buildId: "0.0.2" },
    },
    launch: { runtimeRelativePath: "runtime/super-web-agent-runtime", cwd: ".", pathContained: true },
    phases: {
      initial: { passed: true, observedRuntimeBuildId: "0.0.1", observedRuntimeSha256: firstDigest, healthNonceMatched: true, pidChanged: false, runtimeSessionChanged: false, cleanStopObserved: true },
      bridgeStatus: { passed: true, runtime: "ready", bridgeState: "not-installed" },
      crash: { passed: true, crashAcknowledged: true, finalCloseObserved: true, exitCode: 86, signal: null },
      recovery: { passed: true, observedRuntimeBuildId: "0.0.1", observedRuntimeSha256: firstDigest, healthNonceMatched: true, pidChanged: true, runtimeSessionChanged: true, cleanStopObserved: true },
      update: { passed: true, observedRuntimeBuildId: "0.0.2", observedRuntimeSha256: secondDigest, healthNonceMatched: true, pidChanged: true, runtimeSessionChanged: true, cleanStopObserved: true },
      removal: { passed: true, stagedPluginRemoved: true, noLiveRuntime: true, swaOwnedResidueCount: 0 },
    },
    windowsStaging: windows ? { mode: "powershell-acl", passed: true } : { mode: "not-applicable", passed: true },
    errors: [],
  };
}

it("parses a complete macOS ARM64 lifecycle report", () => {
  expect(parseKeylessLifecyclePlatformReport(reportFor("darwin-arm64"))).toEqual(reportFor("darwin-arm64"));
});

it("rejects an unknown report key", () => {
  const report = { ...reportFor("darwin-arm64"), rawStdout: "secret" };
  expect(() => parseKeylessLifecyclePlatformReport(report)).toThrow("invalid lifecycle report keys");
});

it.each([
  ["wrong Node version", (report: KeylessLifecyclePlatformReport) => { (report as { nodeVersion: string }).nodeVersion = "v24.13.0"; }],
  ["malformed commit SHA", (report: KeylessLifecyclePlatformReport) => { (report as { sourceCommit: string }).sourceCommit = "ABC"; }],
  ["absolute launch path", (report: KeylessLifecyclePlatformReport) => { (report.launch as { runtimeRelativePath: string }).runtimeRelativePath = "/Users/example/runtime"; }],
  ["recovery PID reuse", (report: KeylessLifecyclePlatformReport) => { report.phases.recovery.pidChanged = false; }],
  ["recovery Runtime Session reuse", (report: KeylessLifecyclePlatformReport) => { report.phases.recovery.runtimeSessionChanged = false; }],
  ["update build mismatch", (report: KeylessLifecyclePlatformReport) => { report.phases.update.observedRuntimeBuildId = "0.0.1"; }],
  ["update digest mismatch", (report: KeylessLifecyclePlatformReport) => { report.phases.update.observedRuntimeSha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; }],
  ["Windows without PowerShell ACL", (report: KeylessLifecyclePlatformReport) => { report.windowsStaging = { mode: "not-applicable", passed: true }; }],
  ["macOS with Windows ACL", (report: KeylessLifecyclePlatformReport) => { report.windowsStaging = { mode: "powershell-acl", passed: true }; }],
])("rejects %s", (_name, mutate) => {
  const report = reportFor(_name === "Windows without PowerShell ACL" ? "win32-x64" : "darwin-arm64");
  mutate(report);
  expect(() => parseKeylessLifecyclePlatformReport(report)).toThrow("invalid lifecycle");
});

it("rejects successful phases accompanied by a sanitized failure", () => {
  const report = reportFor("darwin-arm64");
  report.errors = [{ code: "runtime-launch-failed", phase: "initial" }];
  expect(() => parseKeylessLifecyclePlatformReport(report)).toThrow("successful lifecycle phases");
});

it("rejects failure records that expose raw diagnostic fields", () => {
  const report = reportFor("darwin-arm64") as unknown as { errors: unknown[] };
  report.errors = [{ code: "runtime-launch-failed", phase: "initial", stderr: "token" }];
  expect(() => parseKeylessLifecyclePlatformReport(report)).toThrow("invalid lifecycle failure keys");
});

it("rejects failure records that are not ordered by lifecycle phase", () => {
  const report = reportFor("darwin-arm64");
  report.phases.initial.passed = false;
  report.phases.removal.passed = false;
  report.errors = [
    { code: "residue-detected", phase: "removal" },
    { code: "runtime-launch-failed", phase: "initial" },
  ];
  expect(() => parseKeylessLifecyclePlatformReport(report)).toThrow("ordered by lifecycle phase");
});

it.each<KeylessLifecycleFailureCode>([
  "artifact-invalid", "bundle-contract-invalid", "path-escape", "platform-mismatch",
  "runtime-launch-failed", "mcp-initialize-failed", "mcp-tool-missing", "mcp-call-invalid",
  "runtime-exit-unobserved", "recovery-failed", "update-not-applied", "residue-detected",
  "desktop-acceptance-required",
])("rejects report evidence carrying %s", (code) => {
  const report = reportFor("darwin-arm64");
  report.phases.initial.passed = false;
  report.errors = [{ code, phase: "initial" }];
  expect(evaluateKeylessLifecyclePlatformReport(report)).toEqual({
    state: "rejected",
    reasons: [`initial: ${code}`],
  });
});
