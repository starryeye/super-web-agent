import {
  evaluateKeylessLifecyclePlatformReport,
  parseKeylessLifecyclePlatformReport,
  type KeylessLifecyclePlatformReport,
} from "./keyless-lifecycle-report.js";

export interface KeylessLifecycleDecision {
  state: "accepted" | "rejected";
  reasons: string[];
  followUps: string[];
}

const platforms = ["darwin-arm64", "win32-x64"] as const;

export function evaluateKeylessLifecycleEvidence(reports: readonly unknown[]): KeylessLifecycleDecision {
  const parsed: KeylessLifecyclePlatformReport[] = [];
  for (const report of reports) {
    try {
      parsed.push(parseKeylessLifecyclePlatformReport(report));
    } catch {
      return { state: "rejected", reasons: ["malformed native lifecycle evidence"], followUps: [] };
    }
  }
  const duplicates = platforms.filter((platform) => parsed.filter((report) => report.platform === platform).length > 1);
  if (duplicates.length > 0) {
    return { state: "rejected", reasons: duplicates.map((platform) => `duplicate evidence for ${platform}`), followUps: [] };
  }
  const missing = platforms.filter((platform) => !parsed.some((report) => report.platform === platform));
  if (missing.length > 0 || parsed.length !== 2) {
    return { state: "rejected", reasons: missing.length > 0 ? missing.map((platform) => `missing evidence for ${platform}`) : ["invalid evidence cell count"], followUps: [] };
  }
  if (parsed[0]!.sourceCommit !== parsed[1]!.sourceCommit) {
    return { state: "rejected", reasons: ["native evidence was collected from different commits"], followUps: [] };
  }
  const rejected = parsed.flatMap((report) => {
    const evaluation = evaluateKeylessLifecyclePlatformReport(report);
    return evaluation.state === "rejected" ? evaluation.reasons.map((reason) => `${report.platform}: ${reason}`) : [];
  });
  if (rejected.length > 0) return { state: "rejected", reasons: rejected, followUps: [] };
  return {
    state: "accepted",
    reasons: ["both native keyless lifecycle evidence cells passed"],
    followUps: ["signed-in Codex Desktop acceptance remains required"],
  };
}

function statusLabel(state: KeylessLifecycleDecision["state"]): "Accepted" | "Rejected" {
  return state === "accepted" ? "Accepted" : "Rejected";
}

export function renderKeylessLifecycleDecision(reports: readonly unknown[]): string {
  const decision = evaluateKeylessLifecycleEvidence(reports);
  const parsedByPlatform = new Map<string, KeylessLifecyclePlatformReport>();
  for (const report of reports) {
    try {
      const parsed = parseKeylessLifecyclePlatformReport(report);
      if (!parsedByPlatform.has(parsed.platform)) parsedByPlatform.set(parsed.platform, parsed);
    } catch {
      // Invalid evidence must never be echoed into the report.
    }
  }
  const rows = platforms.map((platform) => {
    const report = parsedByPlatform.get(platform);
    if (report === undefined) return `| ${platform} | missing | — | — | — | — |`;
    const gate = evaluateKeylessLifecyclePlatformReport(report).state === "accepted" ? "passed" : "rejected";
    return `| ${platform} | ${gate} | ${report.artifacts["0.0.1"].bytes} | ${report.artifacts["0.0.1"].sha256.slice(0, 8)} | ${report.artifacts["0.0.2"].bytes} | ${report.artifacts["0.0.2"].sha256.slice(0, 8)} |`;
  });
  const reasons = decision.reasons.map((reason) => `- ${reason}`).join("\n");
  const followUps = decision.followUps.length === 0 ? "- None recorded." : decision.followUps.map((item) => `- ${item}`).join("\n");
  return `# Keyless Plugin Lifecycle Evidence Decision

Status: ${statusLabel(decision.state)}

## Decision boundary

This ADR evaluates deterministic native Runtime packaging and MCP lifecycle
evidence only. Signed-in Codex Desktop acceptance remains separate.

## Native evidence

| Platform | Evidence | 0.0.1 bytes | 0.0.1 SHA-256 | 0.0.2 bytes | 0.0.2 SHA-256 |
| --- | --- | ---: | --- | ---: | --- |
${rows.join("\n")}

## Reasons

${reasons}

## Follow-ups

${followUps}
`;
}
