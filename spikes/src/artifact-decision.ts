import {
  evaluatePackagingPlatform,
  type PackagingPlatformReport,
  type TargetPlatform,
} from "./packaging-report.js";

export type DecisionState = "pass" | "fail" | "incomplete";

export interface ArtifactDecision {
  state: DecisionState;
  reasons: string[];
  followUps: string[];
}

const requiredPlatforms: TargetPlatform[] = ["darwin-arm64", "win32-x64"];

export function parsePackagingPlatformReport(value: unknown): PackagingPlatformReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("packaging report must be an object");
  }
  const report = value as Record<string, unknown>;
  if (report.schemaVersion !== 1 || report.runtimeVersion !== "0.0.0-spike") {
    throw new Error("unsupported packaging report schema");
  }
  if (report.platform !== "darwin-arm64" && report.platform !== "win32-x64") {
    throw new Error("unsupported packaging report platform");
  }
  if (typeof report.nodeVersion !== "string" || report.nodeVersion !== "v24.14.0") {
    throw new Error("unexpected packaging Node version");
  }
  if (report.artifactSignatureMode !== "ephemeral-test-key") {
    throw new Error("unexpected artifact signature mode");
  }
  if (report.osCodeSigning !== "ad-hoc" && report.osCodeSigning !== "unsigned-test") {
    throw new Error("unexpected OS signing mode");
  }
  if (!Array.isArray(report.variants) || report.variants.length !== 2) {
    throw new Error("packaging report must contain two variants");
  }
  for (const value of report.variants) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("invalid packaging variant");
    }
    const variant = value as Record<string, unknown>;
    if (variant.kind !== "host-node" && variant.kind !== "self-contained") {
      throw new Error("invalid packaging variant kind");
    }
    if (typeof variant.artifact !== "string" || typeof variant.bytes !== "number" || variant.bytes < 0) {
      throw new Error("invalid packaging artifact fields");
    }
    if (
      typeof variant.requiresHostNode !== "boolean" ||
      typeof variant.healthPassed !== "boolean" ||
      typeof variant.cleanupPassed !== "boolean"
    ) {
      throw new Error("invalid packaging probe fields");
    }
    if (
      !Array.isArray(variant.startsMs) ||
      !variant.startsMs.every((sample) => typeof sample === "number" && sample >= 0)
    ) {
      throw new Error("invalid packaging start samples");
    }
    if (!Array.isArray(variant.errors) || !variant.errors.every((error) => typeof error === "string")) {
      throw new Error("invalid packaging errors");
    }
  }
  return report as unknown as PackagingPlatformReport;
}

export function evaluateArtifactEvidence(reports: PackagingPlatformReport[]): ArtifactDecision {
  const duplicates = requiredPlatforms.filter(
    (platform) => reports.filter((report) => report.platform === platform).length > 1,
  );
  if (duplicates.length > 0) {
    return {
      state: "fail",
      reasons: duplicates.map((platform) => `duplicate evidence for ${platform}`),
      followUps: [],
    };
  }
  const missing = requiredPlatforms.filter(
    (platform) => !reports.some((report) => report.platform === platform),
  );
  if (missing.length > 0) {
    return {
      state: "incomplete",
      reasons: missing.map((platform) => `missing evidence for ${platform}`),
      followUps: [],
    };
  }
  const failures: string[] = [];
  for (const platform of requiredPlatforms) {
    const report = reports.find((candidate) => candidate.platform === platform)!;
    const gate = evaluatePackagingPlatform(report);
    if (gate.gate === "fail") failures.push(`${platform}: ${gate.reason}`);
  }
  if (failures.length > 0) return { state: "fail", reasons: failures, followUps: [] };
  return {
    state: "pass",
    reasons: ["both target platforms passed the self-contained Runtime artifact gate"],
    followUps: [
      "darwin-arm64 uses ad-hoc code signing; production signing and notarization remain unresolved",
      "win32-x64 uses an unsigned test binary; production Authenticode signing remains unresolved",
    ],
  };
}

function statusLabel(state: DecisionState): "Accepted" | "Rejected" | "Incomplete" {
  if (state === "pass") return "Accepted";
  if (state === "fail") return "Rejected";
  return "Incomplete";
}

export function renderArtifactDecision(reports: PackagingPlatformReport[]): string {
  const decision = evaluateArtifactEvidence(reports);
  const rows = requiredPlatforms.map((platform) => {
    const report = reports.find((candidate) => candidate.platform === platform);
    if (report === undefined) return `| ${platform} | missing | — | — | — |`;
    const candidate = report.variants.find((variant) => variant.kind === "self-contained");
    const gate = evaluatePackagingPlatform(report).gate;
    const starts = candidate?.startsMs.map((value) => value.toFixed(2)).join(", ") ?? "—";
    return `| ${platform} | ${gate} | ${candidate?.bytes ?? 0} | ${starts} | ${report.osCodeSigning} |`;
  });
  const reasonLines = decision.reasons.map((reason) => `- ${reason}`).join("\n");
  const followUpLines =
    decision.followUps.length === 0
      ? "- None recorded."
      : decision.followUps.map((item) => `- ${item}`).join("\n");
  const consequence =
    decision.state === "pass"
      ? "Proceed to the separate Claude Code and Codex plugin lifecycle spike using this artifact format."
      : decision.state === "fail"
        ? "Stop host-integration implementation and reopen the self-contained Runtime packaging architecture."
        : "Do not choose an architecture until both platform reports exist.";
  return `# Runtime Artifact Spike Decision

Status: ${statusLabel(decision.state)}

## Decision boundary

This ADR evaluates only whether one minimal MCP Runtime can run as a self-contained artifact on darwin-arm64 and win32-x64 without Host Node on PATH. It does not approve production signing, host plugin lifecycle, localhost pairing, browser automation, or performance claims.

## Evidence

| Platform | Gate | SEA bytes | Start samples (ms) | OS signing |
| --- | --- | ---: | --- | --- |
${rows.join("\n")}

## Reasons

${reasonLines}

## Follow-ups

${followUpLines}

## Consequence

${consequence}

Ephemeral Ed25519 keys, ad-hoc macOS signatures, and unsigned Windows test binaries are not production release artifacts.
`;
}
