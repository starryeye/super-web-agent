import { expect, it } from "vitest";
import { evaluatePackagingPlatform, type PackagingPlatformReport } from "../src/packaging-report.js";

const passing: PackagingPlatformReport = {
  schemaVersion: 1,
  runtimeVersion: "0.0.0-spike",
  platform: "darwin-arm64",
  nodeVersion: "v24.14.0",
  artifactSignatureMode: "ephemeral-test-key",
  osCodeSigning: "ad-hoc",
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
      artifact: "self-contained/navact-runtime",
      bytes: 90_000_000,
      requiresHostNode: false,
      healthPassed: true,
      cleanupPassed: true,
      startsMs: [20, 21, 19],
      errors: [],
    },
  ],
};

it("passes when control and self-contained variants complete three probes", () => {
  expect(evaluatePackagingPlatform(passing)).toEqual({ gate: "pass", selected: "self-contained" });
});

it("fails rather than selecting Host Node when SEA health fails", () => {
  const report = structuredClone(passing);
  report.variants[1]!.healthPassed = false;
  report.variants[1]!.errors.push("MCP connection closed");
  expect(evaluatePackagingPlatform(report)).toEqual({
    gate: "fail",
    reason: "self-contained artifact did not pass health and cleanup",
  });
});

it("fails when the candidate relies on Host Node", () => {
  const requiresNode = structuredClone(passing);
  requiresNode.variants[1]!.requiresHostNode = true;
  expect(evaluatePackagingPlatform(requiresNode)).toEqual({
    gate: "fail",
    reason: "self-contained artifact requires Host Node",
  });
});

it("fails when the candidate lacks three samples", () => {
  const missingSamples = structuredClone(passing);
  missingSamples.variants[1]!.startsMs.pop();
  expect(evaluatePackagingPlatform(missingSamples)).toEqual({
    gate: "fail",
    reason: "self-contained artifact lacks three start samples",
  });
});
