import {
  evaluatePluginLifecycleHostReport,
  parsePluginLifecycleHostReport,
  type PluginLifecycleHostReport,
} from "./plugin-lifecycle-report.js";

export type LifecycleDecisionState = "pass" | "fail" | "incomplete";

export interface PluginLifecycleDecision {
  state: LifecycleDecisionState;
  reasons: string[];
  followUps: string[];
}

type Host = PluginLifecycleHostReport["host"];
type Platform = PluginLifecycleHostReport["platform"];
type Cell = readonly [Host, Platform];

const requiredCells: readonly Cell[] = [
  ["claude-code", "darwin-arm64"],
  ["claude-code", "win32-x64"],
  ["codex", "darwin-arm64"],
  ["codex", "win32-x64"],
];

const platforms: readonly Platform[] = ["darwin-arm64", "win32-x64"];

function cellLabel(host: Host, platform: Platform): string {
  return `${host}/${platform}`;
}

function statusLabel(state: LifecycleDecisionState): "Accepted" | "Rejected" | "Incomplete" {
  if (state === "pass") return "Accepted";
  if (state === "fail") return "Rejected";
  return "Incomplete";
}

function strictReports(reports: readonly unknown[]): PluginLifecycleHostReport[] {
  return reports.map((report) => parsePluginLifecycleHostReport(report));
}

export function evaluatePluginLifecycleEvidence(reports: readonly unknown[]): PluginLifecycleDecision {
  let parsed: PluginLifecycleHostReport[];
  try {
    parsed = strictReports(reports);
  } catch {
    return { state: "fail", reasons: ["malformed plugin lifecycle evidence"], followUps: [] };
  }

  const duplicates = requiredCells.filter(([host, platform]) =>
    parsed.filter((report) => report.host === host && report.platform === platform).length > 1,
  );
  if (duplicates.length > 0) {
    return { state: "fail", reasons: duplicates.map(([host, platform]) => `duplicate evidence for ${cellLabel(host, platform)}`), followUps: [] };
  }

  const missing = requiredCells.filter(([host, platform]) =>
    !parsed.some((report) => report.host === host && report.platform === platform),
  );
  if (missing.length > 0) {
    return { state: "incomplete", reasons: missing.map(([host, platform]) => `missing evidence for ${cellLabel(host, platform)}`), followUps: [] };
  }

  const failures: string[] = [];
  for (const [host, platform] of requiredCells) {
    const report = parsed.find((candidate) => candidate.host === host && candidate.platform === platform)!;
    const gate = evaluatePluginLifecycleHostReport(report);
    if (gate.gate === "fail") failures.push(`${cellLabel(host, platform)}: ${gate.reason}`);
    if (report.runtimeArtifacts["0.0.1"].sha256 === report.runtimeArtifacts["0.0.2"].sha256) {
      failures.push(`${cellLabel(host, platform)}: Runtime 0.0.1 and 0.0.2 digests must differ`);
    }
  }
  for (const platform of platforms) {
    const claude = parsed.find((report) => report.host === "claude-code" && report.platform === platform)!;
    const codex = parsed.find((report) => report.host === "codex" && report.platform === platform)!;
    for (const version of ["0.0.1", "0.0.2"] as const) {
      const left = claude.runtimeArtifacts[version];
      const right = codex.runtimeArtifacts[version];
      if (left.sha256 !== right.sha256 || left.bytes !== right.bytes) {
        failures.push(`${platform}: hosts disagree on Runtime ${version} digest or byte count`);
      }
    }
  }
  if (failures.length > 0) return { state: "fail", reasons: failures, followUps: [] };

  const followUps: string[] = [];
  for (const [host, platform] of requiredCells) {
    const report = parsed.find((candidate) => candidate.host === host && candidate.platform === platform)!;
    if (!report.crashRecovery.sameSessionRestartObserved) {
      followUps.push(`${cellLabel(host, platform)}: same-session crash restart was not observed`);
    }
    if (report.removal.hostManagedResiduePaths.length > 0) {
      followUps.push(`${cellLabel(host, platform)}: host-managed cache residue recorded`);
    }
  }
  return { state: "pass", reasons: ["all four host and platform lifecycle evidence cells passed"], followUps };
}

function markdownRows(reports: readonly PluginLifecycleHostReport[]): string[] {
  return requiredCells.map(([host, platform]) => {
    const report = reports.find((candidate) => candidate.host === host && candidate.platform === platform);
    const name = host === "claude-code" ? "Claude Code" : "Codex";
    if (report === undefined) return `| ${name} | ${platform} | missing | — | — | — | — | — | — | — | incomplete |`;
    const v1 = report.runtimeArtifacts["0.0.1"];
    const v2 = report.runtimeArtifacts["0.0.2"];
    const gate = evaluatePluginLifecycleHostReport(report).gate;
    return `| ${name} | ${platform} | ${report.hostVersion} | ${v1.bytes} / ${v1.sha256.slice(0, 8)} | ${v2.bytes} / ${v2.sha256.slice(0, 8)} | ${report.initial.startupLatencyMs.toFixed(2)} | ${report.initial.healthLatencyMs.toFixed(2)} | ${report.update.observedRuntimeBuildId === "0.0.2" ? "yes" : "no"} | ${report.crashRecovery.freshSessionRecoveryPassed ? "fresh session" : "no"} | ${report.removal.noLiveRuntime ? "yes" : "no"} | ${gate} |`;
  });
}

export function renderPluginLifecycleDecision(reports: readonly unknown[]): string {
  const decision = evaluatePluginLifecycleEvidence(reports);
  let parsed: PluginLifecycleHostReport[] = [];
  try { parsed = strictReports(reports); } catch { /* The calculated decision presents malformed evidence without its contents. */ }
  const reasonLines = decision.reasons.map((reason) => `- ${reason}`).join("\n");
  const followUpLines = decision.followUps.length === 0 ? "- None recorded." : decision.followUps.map((followUp) => `- ${followUp}`).join("\n");
  const consequence = decision.state === "pass"
    ? "Proceed to the separate localhost pairing/security spike using the integration-owned Runtime architecture."
    : decision.state === "fail"
      ? "Stop browser integration and reopen the plugin lifecycle and packaging architecture."
      : "Do not choose lifecycle architecture until all four cells exist.";
  return `# Plugin Lifecycle Spike Decision

Status: ${statusLabel(decision.state)}

## Decision boundary

This ADR evaluates only the four-cell Claude Code and Codex plugin lifecycle spike. It does not approve production signing, localhost pairing, Chrome Extension behavior, browser automation, Page Model, actions, policy, benchmarks, or release-readiness claims.

## Evidence

| Host | Platform | Host version | Runtime 0.0.1 (bytes / SHA-256) | Runtime 0.0.2 (bytes / SHA-256) | Runtime startup (ms) | Model-mediated health (ms) | Build update verified | Crash recovery | Clean removal | Gate |
| --- | --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- |
${markdownRows(parsed).join("\n")}

## Reasons

${reasonLines}

## Follow-ups

${followUpLines}

## Consequence

${consequence}
`;
}
