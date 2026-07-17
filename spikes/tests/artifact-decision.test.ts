import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  evaluateArtifactEvidence,
  parsePackagingPlatformReport,
  renderArtifactDecision,
} from "../src/artifact-decision.js";
import type { PackagingPlatformReport, TargetPlatform } from "../src/packaging-report.js";

function passingReport(platform: TargetPlatform): PackagingPlatformReport {
  const windows = platform === "win32-x64";
  return {
    schemaVersion: 1,
    runtimeVersion: "0.0.0-spike",
    platform,
    nodeVersion: "v24.14.0",
    artifactSignatureMode: "ephemeral-test-key",
    osCodeSigning: windows ? "unsigned-test" : "ad-hoc",
    variants: [
      {
        kind: "host-node",
        artifact: "host-node/navact-runtime.cjs",
        bytes: 1000,
        requiresHostNode: true,
        healthPassed: true,
        cleanupPassed: true,
        startsMs: [10, 11, 9],
        errors: [],
      },
      {
        kind: "self-contained",
        artifact: windows ? "self-contained/navact-runtime.exe" : "self-contained/navact-runtime",
        bytes: 90_000_000,
        requiresHostNode: false,
        healthPassed: true,
        cleanupPassed: true,
        startsMs: [20, 21, 19],
        errors: [],
      },
    ],
  };
}

it("accepts only complete passing macOS ARM64 and Windows x64 evidence", () => {
  const reports = [passingReport("darwin-arm64"), passingReport("win32-x64")];
  expect(evaluateArtifactEvidence(reports)).toEqual({
    state: "pass",
    reasons: ["both target platforms passed the self-contained Runtime artifact gate"],
    followUps: [
      "darwin-arm64 uses ad-hoc code signing; production signing and notarization remain unresolved",
      "win32-x64 uses an unsigned test binary; production Authenticode signing remains unresolved",
    ],
  });
});

it("reports incomplete rather than passing when a platform is absent", () => {
  expect(evaluateArtifactEvidence([passingReport("darwin-arm64")])).toEqual({
    state: "incomplete",
    reasons: ["missing evidence for win32-x64"],
    followUps: [],
  });
});

it("rejects the hypothesis when either platform gate fails", () => {
  const mac = passingReport("darwin-arm64");
  const windows = passingReport("win32-x64");
  windows.variants[1]!.healthPassed = false;
  windows.variants[1]!.errors.push("MCP connection closed");
  const decision = evaluateArtifactEvidence([mac, windows]);
  expect(decision.state).toBe("fail");
  expect(decision.reasons).toEqual([
    "win32-x64: self-contained artifact did not pass health and cleanup",
  ]);
});

it.each([
  { reports: [passingReport("darwin-arm64"), passingReport("win32-x64")], status: "Accepted" },
  { reports: [passingReport("darwin-arm64")], status: "Incomplete" },
  {
    reports: (() => {
      const mac = passingReport("darwin-arm64");
      const windows = passingReport("win32-x64");
      windows.variants[1]!.healthPassed = false;
      windows.variants[1]!.errors.push("MCP connection closed");
      return [mac, windows];
    })(),
    status: "Rejected",
  },
])("renders calculated $status status", ({ reports, status }) => {
  expect(renderArtifactDecision(reports)).toContain(`Status: ${status}`);
});

it.each([
  { platform: "darwin-arm64" as const, signing: "unsigned-test" as const },
  { platform: "win32-x64" as const, signing: "ad-hoc" as const },
])("rejects $signing signing evidence for $platform", ({ platform, signing }) => {
  const report = passingReport(platform);
  report.osCodeSigning = signing;
  expect(() => parsePackagingPlatformReport(report)).toThrow("unexpected OS signing mode for platform");
});

it("requires exactly one Host-Node and one self-contained variant", () => {
  const report = passingReport("darwin-arm64");
  report.variants[1] = structuredClone(report.variants[0]!);
  expect(() => parsePackagingPlatformReport(report)).toThrow("one variant of each kind");
});

it.each([
  { kind: "host-node" as const, requiresHostNode: false },
  { kind: "self-contained" as const, requiresHostNode: true },
])("rejects contradictory $kind Host Node metadata", ({ kind, requiresHostNode }) => {
  const report = passingReport("darwin-arm64");
  report.variants.find((variant) => variant.kind === kind)!.requiresHostNode = requiresHostNode;
  expect(() => parsePackagingPlatformReport(report)).toThrow("variant Host Node requirement contradicts kind");
});

it("rejects successful probes that still record errors", () => {
  const report = passingReport("darwin-arm64");
  report.variants[1]!.errors.push("ignored failure");
  expect(() => parsePackagingPlatformReport(report)).toThrow("packaging probe result contradicts errors");
});

it.each(["bytes", "start sample"])("rejects non-finite %s from valid JSON", (field) => {
  const report = passingReport("darwin-arm64");
  const overflow = JSON.parse("1e400") as number;
  if (field === "bytes") report.variants[1]!.bytes = overflow;
  else report.variants[1]!.startsMs[0] = overflow;
  expect(() => parsePackagingPlatformReport(report)).toThrow("invalid packaging");
});

it("uploads reports from the ignored hidden artifact directory", async () => {
  const workflow = await readFile(resolve("..", ".github", "workflows", "architecture-spikes.yml"), "utf8");
  expect(workflow).toContain("include-hidden-files: true");
  expect(workflow).toContain("if-no-files-found: error");
});
