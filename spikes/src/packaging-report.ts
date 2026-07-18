export type TargetPlatform = "darwin-arm64" | "win32-x64";

export interface PackagingVariantReport {
  kind: "host-node" | "self-contained";
  artifact: string;
  bytes: number;
  requiresHostNode: boolean;
  healthPassed: boolean;
  cleanupPassed: boolean;
  startsMs: number[];
  errors: string[];
}

export interface PackagingPlatformReport {
  schemaVersion: 1;
  runtimeVersion: "0.0.0-spike";
  platform: TargetPlatform;
  nodeVersion: string;
  artifactSignatureMode: "ephemeral-test-key";
  osCodeSigning: "ad-hoc" | "unsigned-test";
  variants: PackagingVariantReport[];
}

export type PackagingGate =
  | { gate: "pass"; selected: "self-contained" }
  | { gate: "fail"; reason: string };

export function evaluatePackagingPlatform(report: PackagingPlatformReport): PackagingGate {
  const control = report.variants.find((variant) => variant.kind === "host-node");
  if (!control?.healthPassed || !control.cleanupPassed || control.startsMs.length !== 3) {
    return { gate: "fail", reason: "Host-Node control did not complete three health and cleanup probes" };
  }
  const candidate = report.variants.find((variant) => variant.kind === "self-contained");
  if (!candidate?.healthPassed || !candidate.cleanupPassed) {
    return { gate: "fail", reason: "self-contained artifact did not pass health and cleanup" };
  }
  if (candidate.requiresHostNode) {
    return { gate: "fail", reason: "self-contained artifact requires Host Node" };
  }
  if (candidate.startsMs.length !== 3) {
    return { gate: "fail", reason: "self-contained artifact lacks three start samples" };
  }
  if (candidate.bytes <= 0) {
    return { gate: "fail", reason: "self-contained artifact is empty" };
  }
  return { gate: "pass", selected: "self-contained" };
}
