import { expect, it } from "vitest";
import {
  evaluatePluginLifecycleHostReport,
  parsePluginLifecycleHostReport,
  type PluginLifecycleHostReport,
} from "../src/plugin-lifecycle-report.js";
import type { LifecycleHost } from "../src/lifecycle-events.js";
import type { TargetPlatform } from "../src/packaging-report.js";

function passingReport(host: LifecycleHost, platform: TargetPlatform): PluginLifecycleHostReport {
  return {
    schemaVersion: 1,
    runtimeVersion: "0.0.0-spike",
    host,
    hostVersion: host === "claude-code" ? "2.1.197" : "codex-cli 0.145.0-alpha.23",
    platform,
    runtimeArtifacts: {
      "0.0.1": { sha256: "a".repeat(64), bytes: 100_000_000 },
      "0.0.2": { sha256: "b".repeat(64), bytes: 100_000_100 },
    },
    pluginVersions: ["0.0.1", "0.0.2"],
    installUserSteps: 2,
    updateUserSteps: host === "claude-code" ? 2 : 1,
    removalUserSteps: 2,
    manualConfigEdits: 0,
    administratorPrivilegesRequested: false,
    separateInstallerUsed: false,
    hostNodeRequired: false,
    initial: {
      healthPassed: true,
      cleanStopPassed: true,
      launchedFromHostCache: true,
      pid: 101,
      startupLatencyMs: 150,
      healthLatencyMs: 400,
      observedRuntimeBuildId: "0.0.1",
      observedRuntimeSha256: "a".repeat(64),
    },
    update: {
      healthPassed: true,
      cleanStopPassed: true,
      launchedFromHostCache: true,
      pid: 102,
      observedPluginVersion: "0.0.2",
      observedRuntimeBuildId: "0.0.2",
      observedRuntimeSha256: "b".repeat(64),
    },
    crashRecovery: {
      crashObserved: true,
      sameSessionRestartObserved: false,
      freshSessionRecoveryPassed: true,
      reinstallRequired: false,
      launchedFromHostCache: true,
      recoveredPid: 104,
      observedRuntimeBuildId: "0.0.2",
      observedRuntimeSha256: "b".repeat(64),
    },
    removal: {
      pluginRemoved: true,
      marketplaceRemoved: true,
      noLiveRuntime: true,
      hostManagedResiduePaths: [],
      swaOwnedResiduePaths: [],
    },
    commands: [host === "claude-code" ? "claude --version" : "codex --version"],
    errors: [],
  };
}

function parsedPassingReport(): PluginLifecycleHostReport {
  return parsePluginLifecycleHostReport(passingReport("claude-code", "darwin-arm64"));
}

it("accepts a complete passing host lifecycle report", () => {
  expect(evaluatePluginLifecycleHostReport(parsedPassingReport())).toEqual({ gate: "pass" });
});

it.each([
  ["manual configuration", (report: PluginLifecycleHostReport) => { report.manualConfigEdits = 1; }, "manual MCP configuration was required"],
  ["administrator privilege", (report: PluginLifecycleHostReport) => { report.administratorPrivilegesRequested = true; }, "administrator privileges were requested"],
  ["separate installer", (report: PluginLifecycleHostReport) => { report.separateInstallerUsed = true; }, "a separate installer was used"],
  ["Host Node", (report: PluginLifecycleHostReport) => { report.hostNodeRequired = true; }, "the Runtime required Host Node"],
  ["outside-cache launch", (report: PluginLifecycleHostReport) => { report.initial.launchedFromHostCache = false; }, "the Runtime launched outside the installed host plugin cache"],
  ["update outside-cache launch", (report: PluginLifecycleHostReport) => { report.update.launchedFromHostCache = false; }, "the Runtime launched outside the installed host plugin cache"],
  ["recovery outside-cache launch", (report: PluginLifecycleHostReport) => { report.crashRecovery.launchedFromHostCache = false; }, "the Runtime launched outside the installed host plugin cache"],
  ["initial failed health", (report: PluginLifecycleHostReport) => { report.initial.healthPassed = false; }, "initial plugin did not launch Runtime build 0.0.1 cleanly"],
  ["initial unclean stop", (report: PluginLifecycleHostReport) => { report.initial.cleanStopPassed = false; }, "initial plugin did not launch Runtime build 0.0.1 cleanly"],
  ["initial wrong build", (report: PluginLifecycleHostReport) => { report.initial.observedRuntimeBuildId = "0.0.2"; }, "initial plugin did not launch Runtime build 0.0.1 cleanly"],
  ["initial wrong digest", (report: PluginLifecycleHostReport) => { report.initial.observedRuntimeSha256 = "c".repeat(64); }, "initial plugin did not launch Runtime build 0.0.1 cleanly"],
  ["update wrong plugin version", (report: PluginLifecycleHostReport) => { report.update.observedPluginVersion = "unexpected"; }, "plugin update did not launch Runtime build 0.0.2 cleanly"],
  ["update wrong build", (report: PluginLifecycleHostReport) => { report.update.observedRuntimeBuildId = "0.0.1"; }, "plugin update did not launch Runtime build 0.0.2 cleanly"],
  ["update wrong digest", (report: PluginLifecycleHostReport) => { report.update.observedRuntimeSha256 = "c".repeat(64); }, "plugin update did not launch Runtime build 0.0.2 cleanly"],
  ["crash not observed", (report: PluginLifecycleHostReport) => { report.crashRecovery.crashObserved = false; }, "Runtime crash was not observed"],
  ["reinstall required", (report: PluginLifecycleHostReport) => { report.crashRecovery.reinstallRequired = true; }, "fresh-session recovery did not launch Runtime build 0.0.2 cleanly"],
  ["recovery wrong build", (report: PluginLifecycleHostReport) => { report.crashRecovery.observedRuntimeBuildId = "0.0.1"; }, "fresh-session recovery did not launch Runtime build 0.0.2 cleanly"],
  ["live Runtime", (report: PluginLifecycleHostReport) => { report.removal.noLiveRuntime = false; }, "plugin removal left a live Runtime"],
  ["failed plugin removal", (report: PluginLifecycleHostReport) => { report.removal.pluginRemoved = false; }, "plugin or marketplace removal failed"],
  ["Super Web Agent residue", (report: PluginLifecycleHostReport) => { report.removal.swaOwnedResiduePaths.push("/tmp/super-web-agent"); }, "SWA-owned residue remained outside host-managed roots"],
  ["recorded error", (report: PluginLifecycleHostReport) => { report.errors.push("host command failed"); }, "host command failed"],
] as const)("fails the gate for %s", (_name, mutate, reason) => {
  const report = parsedPassingReport();
  mutate(report);
  expect(evaluatePluginLifecycleHostReport(report)).toEqual({ gate: "fail", reason });
});

it("retains host-managed cache residue without failing the gate", () => {
  const report = passingReport("codex", "win32-x64");
  report.removal.hostManagedResiduePaths.push("C:\\Users\\user\\.codex\\plugins\\cache\\0.0.1");
  const parsed = parsePluginLifecycleHostReport(report);
  expect(parsed.removal.hostManagedResiduePaths).toEqual(report.removal.hostManagedResiduePaths);
  expect(evaluatePluginLifecycleHostReport(parsed)).toEqual({ gate: "pass" });
});

it("records same-session restart without changing the Spike 24.1 gate", () => {
  const report = parsedPassingReport();
  report.crashRecovery.sameSessionRestartObserved = true;
  expect(evaluatePluginLifecycleHostReport(report)).toEqual({ gate: "pass" });
});

it.each([
  ["empty command list", (report: PluginLifecycleHostReport) => { report.commands = []; }],
  ["empty command entry", (report: PluginLifecycleHostReport) => { report.commands = [""]; }],
  ["empty error entry", (report: PluginLifecycleHostReport) => { report.errors = [""]; report.initial.healthPassed = false; }],
  ["empty residue entry", (report: PluginLifecycleHostReport) => { report.removal.hostManagedResiduePaths = [""]; }],
  ["empty SWA-owned residue entry", (report: PluginLifecycleHostReport) => { report.removal.swaOwnedResiduePaths = [""]; }],
  ["non-finite bytes", (report: PluginLifecycleHostReport) => { report.runtimeArtifacts["0.0.1"].bytes = JSON.parse("1e400") as number; }],
  ["non-finite latency", (report: PluginLifecycleHostReport) => { report.initial.startupLatencyMs = JSON.parse("1e400") as number; }],
  ["invalid PID", (report: PluginLifecycleHostReport) => { report.initial.pid = 0; }],
  ["invalid digest", (report: PluginLifecycleHostReport) => { report.runtimeArtifacts["0.0.1"].sha256 = "A".repeat(64); }],
  ["duplicate plugin versions", (report: PluginLifecycleHostReport) => { report.pluginVersions = ["0.0.1", "0.0.1"] as unknown as ["0.0.1", "0.0.2"]; }],
  ["success plus errors", (report: PluginLifecycleHostReport) => { report.errors = ["unexpected error"]; }],
] as const)("rejects %s", (_name, mutate) => {
  const report = passingReport("claude-code", "darwin-arm64");
  mutate(report);
  expect(() => parsePluginLifecycleHostReport(report)).toThrow("invalid plugin lifecycle host report");
});

type RawReport = Record<string, unknown>;

function rawPassingReport(): RawReport {
  return structuredClone(passingReport("claude-code", "darwin-arm64")) as unknown as RawReport;
}

function nestedObject(report: RawReport, ...keys: string[]): Record<string, unknown> {
  let current: unknown = report;
  for (const key of keys) current = (current as Record<string, unknown>)[key];
  return current as Record<string, unknown>;
}

const exactKeyObjects: readonly [string, (report: RawReport) => Record<string, unknown>, string][] = [
  ["root", (report) => report, "host"],
  ["runtimeArtifacts", (report) => nestedObject(report, "runtimeArtifacts"), "0.0.1"],
  ["Runtime 0.0.1 artifact", (report) => nestedObject(report, "runtimeArtifacts", "0.0.1"), "sha256"],
  ["Runtime 0.0.2 artifact", (report) => nestedObject(report, "runtimeArtifacts", "0.0.2"), "bytes"],
  ["initial phase", (report) => nestedObject(report, "initial"), "pid"],
  ["update phase", (report) => nestedObject(report, "update"), "pid"],
  ["crash recovery phase", (report) => nestedObject(report, "crashRecovery"), "recoveredPid"],
  ["removal phase", (report) => nestedObject(report, "removal"), "pluginRemoved"],
];

it.each(exactKeyObjects)("rejects a missing key in %s", (_name, select, key) => {
  const report = rawPassingReport();
  delete select(report)[key];
  expect(() => parsePluginLifecycleHostReport(report)).toThrow("invalid plugin lifecycle host report");
});

it.each(exactKeyObjects)("rejects an unknown key in %s", (_name, select) => {
  const report = rawPassingReport();
  select(report).unexpected = true;
  expect(() => parsePluginLifecycleHostReport(report)).toThrow("invalid plugin lifecycle host report");
});

it.each([
  ["schema version", (report: RawReport) => { report.schemaVersion = 2; }],
  ["runtime version", (report: RawReport) => { report.runtimeVersion = "0.0.0"; }],
  ["host", (report: RawReport) => { report.host = "other"; }],
  ["platform", (report: RawReport) => { report.platform = "linux-x64"; }],
  ["equal Runtime digests", (report: RawReport) => { nestedObject(report, "runtimeArtifacts", "0.0.2").sha256 = "a".repeat(64); }],
  ["reversed plugin versions", (report: RawReport) => { report.pluginVersions = ["0.0.2", "0.0.1"]; }],
] as const)("rejects invalid exact lifecycle metadata: %s", (_name, mutate) => {
  const report = rawPassingReport();
  mutate(report);
  expect(() => parsePluginLifecycleHostReport(report)).toThrow("invalid plugin lifecycle host report");
});

it.each([
  ["0.0.1", 0],
  ["0.0.1", 1.5],
  ["0.0.1", Number.MAX_SAFE_INTEGER + 1],
  ["0.0.2", 0],
  ["0.0.2", 1.5],
  ["0.0.2", Number.MAX_SAFE_INTEGER + 1],
] as const)("rejects invalid Runtime %s byte count", (version, bytes) => {
  const report = rawPassingReport();
  nestedObject(report, "runtimeArtifacts", version).bytes = bytes;
  expect(() => parsePluginLifecycleHostReport(report)).toThrow("invalid plugin lifecycle host report");
});

it.each([
  ["installUserSteps", -1],
  ["installUserSteps", 1.5],
  ["installUserSteps", Number.MAX_SAFE_INTEGER + 1],
  ["updateUserSteps", -1],
  ["updateUserSteps", 1.5],
  ["updateUserSteps", Number.MAX_SAFE_INTEGER + 1],
  ["removalUserSteps", -1],
  ["removalUserSteps", 1.5],
  ["removalUserSteps", Number.MAX_SAFE_INTEGER + 1],
  ["manualConfigEdits", -1],
  ["manualConfigEdits", 1.5],
  ["manualConfigEdits", Number.MAX_SAFE_INTEGER + 1],
] as const)("rejects invalid non-negative count %s", (field, value) => {
  const report = rawPassingReport();
  report[field] = value;
  expect(() => parsePluginLifecycleHostReport(report)).toThrow("invalid plugin lifecycle host report");
});

it.each([
  ["initial.startupLatencyMs", ["initial", "startupLatencyMs"], -1],
  ["initial.startupLatencyMs", ["initial", "startupLatencyMs"], Number.POSITIVE_INFINITY],
  ["initial.healthLatencyMs", ["initial", "healthLatencyMs"], -1],
  ["initial.healthLatencyMs", ["initial", "healthLatencyMs"], Number.POSITIVE_INFINITY],
] as const)("rejects invalid latency %s", (_name, [phase, field], value) => {
  const report = rawPassingReport();
  nestedObject(report, phase)[field] = value;
  expect(() => parsePluginLifecycleHostReport(report)).toThrow("invalid plugin lifecycle host report");
});

it.each([
  ["initial", "pid"],
  ["update", "pid"],
  ["crashRecovery", "recoveredPid"],
] as const)("rejects zero, negative, and unsafe %s.%s", (phase, field) => {
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const report = rawPassingReport();
    nestedObject(report, phase)[field] = value;
    expect(() => parsePluginLifecycleHostReport(report)).toThrow("invalid plugin lifecycle host report");
  }
});

it.each([
  ["administratorPrivilegesRequested", []],
  ["separateInstallerUsed", []],
  ["hostNodeRequired", []],
  ["healthPassed", ["initial"]],
  ["cleanStopPassed", ["initial"]],
  ["launchedFromHostCache", ["initial"]],
  ["healthPassed", ["update"]],
  ["cleanStopPassed", ["update"]],
  ["launchedFromHostCache", ["update"]],
  ["crashObserved", ["crashRecovery"]],
  ["sameSessionRestartObserved", ["crashRecovery"]],
  ["freshSessionRecoveryPassed", ["crashRecovery"]],
  ["reinstallRequired", ["crashRecovery"]],
  ["launchedFromHostCache", ["crashRecovery"]],
  ["pluginRemoved", ["removal"]],
  ["marketplaceRemoved", ["removal"]],
  ["noLiveRuntime", ["removal"]],
] as const)("rejects non-boolean %s", (field, path) => {
  const report = rawPassingReport();
  nestedObject(report, ...path)[field] = "true";
  expect(() => parsePluginLifecycleHostReport(report)).toThrow("invalid plugin lifecycle host report");
});

it.each([
  ["hostVersion", []],
  ["observedRuntimeBuildId", ["initial"]],
  ["observedRuntimeBuildId", ["update"]],
  ["observedPluginVersion", ["update"]],
  ["observedRuntimeBuildId", ["crashRecovery"]],
] as const)("rejects empty required string %s", (field, path) => {
  const report = rawPassingReport();
  nestedObject(report, ...path)[field] = "";
  expect(() => parsePluginLifecycleHostReport(report)).toThrow("invalid plugin lifecycle host report");
});

it.each([
  ["runtime 0.0.1", ["runtimeArtifacts", "0.0.1"], "sha256"],
  ["runtime 0.0.2", ["runtimeArtifacts", "0.0.2"], "sha256"],
  ["initial", ["initial"], "observedRuntimeSha256"],
  ["update", ["update"], "observedRuntimeSha256"],
  ["crash recovery", ["crashRecovery"], "observedRuntimeSha256"],
] as const)("rejects an empty digest in %s", (_name, path, field) => {
  const report = rawPassingReport();
  nestedObject(report, ...path)[field] = "";
  expect(() => parsePluginLifecycleHostReport(report)).toThrow("invalid plugin lifecycle host report");
});

it.each([
  ["update health", (report: PluginLifecycleHostReport) => { report.update.healthPassed = false; }, "plugin update did not launch Runtime build 0.0.2 cleanly"],
  ["update clean stop", (report: PluginLifecycleHostReport) => { report.update.cleanStopPassed = false; }, "plugin update did not launch Runtime build 0.0.2 cleanly"],
  ["recovery health", (report: PluginLifecycleHostReport) => { report.crashRecovery.freshSessionRecoveryPassed = false; }, "fresh-session recovery did not launch Runtime build 0.0.2 cleanly"],
  ["recovery digest", (report: PluginLifecycleHostReport) => { report.crashRecovery.observedRuntimeSha256 = "c".repeat(64); }, "fresh-session recovery did not launch Runtime build 0.0.2 cleanly"],
  ["marketplace removal", (report: PluginLifecycleHostReport) => { report.removal.marketplaceRemoved = false; }, "plugin or marketplace removal failed"],
  ["first recorded error", (report: PluginLifecycleHostReport) => { report.errors = ["first error", "second error"]; }, "first error"],
] as const)("covers the remaining gate condition: %s", (_name, mutate, reason) => {
  const report = parsedPassingReport();
  mutate(report);
  expect(evaluatePluginLifecycleHostReport(report)).toEqual({ gate: "fail", reason });
});

const orderedGateMutations: readonly [(report: PluginLifecycleHostReport) => void, string][] = [
  [(report) => { report.manualConfigEdits = 1; }, "manual MCP configuration was required"],
  [(report) => { report.administratorPrivilegesRequested = true; }, "administrator privileges were requested"],
  [(report) => { report.separateInstallerUsed = true; }, "a separate installer was used"],
  [(report) => { report.hostNodeRequired = true; }, "the Runtime required Host Node"],
  [(report) => { report.initial.launchedFromHostCache = false; }, "the Runtime launched outside the installed host plugin cache"],
  [(report) => { report.initial.healthPassed = false; }, "initial plugin did not launch Runtime build 0.0.1 cleanly"],
  [(report) => { report.update.healthPassed = false; }, "plugin update did not launch Runtime build 0.0.2 cleanly"],
  [(report) => { report.crashRecovery.crashObserved = false; }, "Runtime crash was not observed"],
  [(report) => { report.crashRecovery.freshSessionRecoveryPassed = false; }, "fresh-session recovery did not launch Runtime build 0.0.2 cleanly"],
  [(report) => { report.removal.noLiveRuntime = false; }, "plugin removal left a live Runtime"],
  [(report) => { report.removal.marketplaceRemoved = false; }, "plugin or marketplace removal failed"],
  [(report) => { report.removal.swaOwnedResiduePaths = ["/tmp/super-web-agent"]; }, "SWA-owned residue remained outside host-managed roots"],
  [(report) => { report.errors = ["first error", "second error"]; }, "first error"],
];

it.each(orderedGateMutations.map((_, index) => [index + 1]))(
  "returns gate reason %i before every lower-priority simultaneous failure",
  (priority) => {
    const report = parsedPassingReport();
    for (const [mutate] of orderedGateMutations.slice(priority - 1)) mutate(report);
    expect(evaluatePluginLifecycleHostReport(report)).toEqual({ gate: "fail", reason: orderedGateMutations[priority - 1]![1] });
  },
);

it.each([
  ["unknown top-level key", (report: Record<string, unknown>) => { report.extra = true; }],
  ["missing top-level key", (report: Record<string, unknown>) => { delete report.host; }],
  ["unknown nested key", (report: Record<string, unknown>) => { (report.initial as Record<string, unknown>).extra = true; }],
  ["missing nested key", (report: Record<string, unknown>) => { delete (report.runtimeArtifacts as Record<string, unknown>)["0.0.2"]; }],
] as const)("rejects %s", (_name, mutate) => {
  const report = structuredClone(passingReport("claude-code", "darwin-arm64")) as unknown as Record<string, unknown>;
  mutate(report);
  expect(() => parsePluginLifecycleHostReport(report)).toThrow("invalid plugin lifecycle host report");
});
