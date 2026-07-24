import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  evaluatePluginLifecycleEvidence,
  renderPluginLifecycleDecision,
} from "../src/plugin-lifecycle-decision.js";
import type { PluginLifecycleHostReport } from "../src/plugin-lifecycle-report.js";

type LifecycleHost = PluginLifecycleHostReport["host"];
type TargetPlatform = PluginLifecycleHostReport["platform"];

function passingReport(host: LifecycleHost, platform: TargetPlatform): PluginLifecycleHostReport {
  const platformDigest = platform === "darwin-arm64" ? "a" : "c";
  const otherDigest = platform === "darwin-arm64" ? "b" : "d";
  return {
    schemaVersion: 1,
    runtimeVersion: "0.0.0-spike",
    host,
    hostVersion: host === "claude-code" ? "2.1.197" : "0.145.0-alpha.23",
    platform,
    runtimeArtifacts: {
      "0.0.1": { sha256: platformDigest.repeat(64), bytes: 100_000 },
      "0.0.2": { sha256: otherDigest.repeat(64), bytes: 100_100 },
    },
    pluginVersions: ["0.0.1", "0.0.2"],
    installUserSteps: 2,
    updateUserSteps: 1,
    removalUserSteps: 2,
    manualConfigEdits: 0,
    administratorPrivilegesRequested: false,
    separateInstallerUsed: false,
    hostNodeRequired: false,
    initial: {
      healthPassed: true, cleanStopPassed: true, launchedFromHostCache: true, pid: 11,
      startupLatencyMs: 12.5, healthLatencyMs: 34.5, observedRuntimeBuildId: "0.0.1", observedRuntimeSha256: platformDigest.repeat(64),
    },
    update: {
      healthPassed: true, cleanStopPassed: true, launchedFromHostCache: true, pid: 12,
      observedPluginVersion: "0.0.2", observedRuntimeBuildId: "0.0.2", observedRuntimeSha256: otherDigest.repeat(64),
    },
    crashRecovery: {
      crashObserved: true, sameSessionRestartObserved: false, freshSessionRecoveryPassed: true,
      reinstallRequired: false, launchedFromHostCache: true, recoveredPid: 13,
      observedRuntimeBuildId: "0.0.2", observedRuntimeSha256: otherDigest.repeat(64),
    },
    removal: {
      pluginRemoved: true, marketplaceRemoved: true, noLiveRuntime: true,
      hostManagedResiduePaths: [], swaOwnedResiduePaths: [],
    },
    commands: ["redacted host command"],
    errors: [],
  };
}

function allPassingReports(): PluginLifecycleHostReport[] {
  return [
    passingReport("claude-code", "darwin-arm64"),
    passingReport("claude-code", "win32-x64"),
    passingReport("codex", "darwin-arm64"),
    passingReport("codex", "win32-x64"),
  ];
}

it("accepts exactly one passing report for every host and platform cell", () => {
  expect(evaluatePluginLifecycleEvidence(allPassingReports())).toEqual({
    state: "pass",
    reasons: ["all four host and platform lifecycle evidence cells passed"],
    followUps: [
      "claude-code/darwin-arm64: same-session crash restart was not observed",
      "claude-code/win32-x64: same-session crash restart was not observed",
      "codex/darwin-arm64: same-session crash restart was not observed",
      "codex/win32-x64: same-session crash restart was not observed",
    ],
  });
});

it("calculates missing evidence as Incomplete", () => {
  expect(evaluatePluginLifecycleEvidence(allPassingReports().slice(0, 3))).toEqual({
    state: "incomplete",
    reasons: ["missing evidence for codex/win32-x64"],
    followUps: [],
  });
});

it("rejects a duplicate host and platform cell", () => {
  const reports = allPassingReports();
  reports.push(passingReport("claude-code", "darwin-arm64"));
  expect(evaluatePluginLifecycleEvidence(reports)).toEqual({
    state: "fail",
    reasons: ["duplicate evidence for claude-code/darwin-arm64"],
    followUps: [],
  });
});

it("prefixes a per-cell gate failure with its host and platform", () => {
  const reports = allPassingReports();
  reports[2]!.initial.healthPassed = false;
  reports[2]!.errors = ["initial health failure"];
  expect(evaluatePluginLifecycleEvidence(reports)).toEqual({
    state: "fail",
    reasons: ["codex/darwin-arm64: initial plugin did not launch Runtime build 0.0.1 cleanly"],
    followUps: [],
  });
});

it("rejects host artifact disagreement on one platform but permits cross-platform digests", () => {
  const reports = allPassingReports();
  reports[2]!.runtimeArtifacts["0.0.1"].bytes = 1;
  expect(evaluatePluginLifecycleEvidence(reports)).toEqual({
    state: "fail",
    reasons: ["darwin-arm64: hosts disagree on Runtime 0.0.1 digest or byte count"],
    followUps: [],
  });
});

it("rejects malformed evidence whose two Runtime builds share a digest", () => {
  const reports = allPassingReports();
  reports[1]!.runtimeArtifacts["0.0.2"].sha256 = reports[1]!.runtimeArtifacts["0.0.1"].sha256;
  expect(evaluatePluginLifecycleEvidence(reports)).toEqual({
    state: "fail",
    reasons: ["malformed plugin lifecycle evidence"],
    followUps: [],
  });
});

it("renders non-gating restart and host residue observations as follow-ups", () => {
  const reports = allPassingReports();
  reports[3]!.crashRecovery.sameSessionRestartObserved = true;
  reports[3]!.removal.hostManagedResiduePaths = ["host-cache/super-web-agent-lifecycle-spike"];
  const markdown = renderPluginLifecycleDecision(reports);
  expect(markdown).toContain("Status: Accepted");
  expect(markdown).toContain("codex/win32-x64: host-managed cache residue recorded");
  expect(markdown).not.toContain("codex/win32-x64: same-session crash restart was not observed");
  expect(markdown).toContain("| Claude Code | darwin-arm64 | 2.1.197 | 100000 / aaaaaaaa | 100100 / bbbbbbbb | 12.50 | 34.50 | yes | yes | yes | pass |");
  expect(markdown).toContain("separate localhost pairing/security spike");
  expect(markdown).toContain("does not approve production signing, localhost pairing, Chrome Extension behavior, browser automation, Page Model, actions, policy, benchmarks, or release-readiness claims");
});

it("never renders command output, errors, or absolute evidence paths", () => {
  const reports = allPassingReports();
  reports[0]!.commands = ["/private/tmp/secret-command-output"];
  reports[0]!.removal.hostManagedResiduePaths = ["/private/tmp/super-web-agent-lifecycle-spike"];
  const markdown = renderPluginLifecycleDecision(reports);
  expect(markdown).toContain("host-managed cache residue recorded");
  expect(markdown).not.toContain("secret-command-output");
  expect(markdown).not.toContain("/private/tmp/super-web-agent-lifecycle-spike");
});

it("writes a sanitized deterministic Rejected ADR for malformed existing writer input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "super-web-agent-decision-"));
  const output = join(directory, "decision.md");
  const inputs = ["claude-mac.json", "claude-windows.json", "codex-mac.json", "codex-windows.json"].map((name) => join(directory, name));
  try {
    await writeFile(inputs[0]!, "{not-json");
    const malformed = await runWriter([output, ...inputs]);
    expect(malformed.code).toBe(1);
    const rejected = await readFile(output, "utf8");
    expect(rejected).toContain("Status: Rejected");
    expect(rejected).toContain("malformed plugin lifecycle evidence");
    expect(rejected).not.toContain("{not-json");
    expect(malformed.stderr).not.toContain("SyntaxError");
    await writeFile(inputs[0]!, JSON.stringify(passingReport("claude-code", "darwin-arm64")));
    const incomplete = await runWriter([output, ...inputs]);
    expect(incomplete.code).toBe(2);
    expect(await readFile(output, "utf8")).toContain("Status: Incomplete");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("renders failed update, recovery, and removal cells using complete phase predicates", () => {
  const reports = allPassingReports();
  reports[0]!.update.cleanStopPassed = false;
  reports[0]!.errors = ["update cleanup failed"];
  reports[1]!.crashRecovery.reinstallRequired = true;
  reports[1]!.errors = ["reinstall required"];
  reports[2]!.removal.pluginRemoved = false;
  reports[2]!.errors = ["plugin remained"];
  const markdown = renderPluginLifecycleDecision(reports);
  expect(markdown).toContain("| Claude Code | darwin-arm64 | 2.1.197 | 100000 / aaaaaaaa | 100100 / bbbbbbbb | 12.50 | 34.50 | no | yes | yes | fail |");
  expect(markdown).toContain("| Claude Code | win32-x64 | 2.1.197 | 100000 / cccccccc | 100100 / dddddddd | 12.50 | 34.50 | yes | no | yes | fail |");
  expect(markdown).toContain("| Codex | darwin-arm64 | 0.145.0-alpha.23 | 100000 / aaaaaaaa | 100100 / bbbbbbbb | 12.50 | 34.50 | yes | yes | no | fail |");
});

it("writes a calculated Rejected decision and exits 1 for a failed existing cell", async () => {
  const directory = await mkdtemp(join(tmpdir(), "super-web-agent-decision-rejected-"));
  const output = join(directory, "decision.md");
  const inputs = ["claude-mac.json", "claude-windows.json", "codex-mac.json", "codex-windows.json"].map((name) => join(directory, name));
  const reports = allPassingReports();
  reports[3]!.removal.noLiveRuntime = false;
  reports[3]!.errors = ["Runtime remained"];
  try {
    await Promise.all(inputs.map((path, index) => writeFile(path, JSON.stringify(reports[index]!))));
    const rejected = await runWriter([output, ...inputs]);
    expect(rejected.code).toBe(1);
    expect(await readFile(output, "utf8")).toContain("Status: Rejected");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("enforces the manual-only workflow topology and safe host CLI setup", async () => {
  const workflow = (await readFile(resolve("..", ".github", "workflows", "plugin-lifecycle-spike.yml"), "utf8")).replace(/\r\n/g, "\n");
  expect(workflow).toMatch(/^on:\n  workflow_dispatch:$/m);
  expect(workflow).not.toMatch(/^\s*(push|pull_request):/m);
  for (const runner of ["macos-15", "windows-2025"]) expect(workflow).toContain(`runner: ${runner}`);
  expect(workflow).toContain("version: 11.9.0");
  expect(workflow).toContain("node-version: 24.14.0");
  expect(workflow).toContain("pnpm install --frozen-lockfile");
  expect(workflow).toContain("runtime-artifact-${{ matrix.target }}");
  expect(workflow).toContain("spikes/.artifacts/packaging/${{ matrix.target }}/");
  expect(workflow).toContain("spikes/.artifacts/plugin-lifecycle/${{ matrix.target }}/");
  expect(workflow.match(/path: spikes\/\.artifacts$/gm)).toHaveLength(2);
  expect(workflow).toContain("if: always()");
  expect(workflow).toContain("include-hidden-files: true");
  expect(workflow).toContain("if-no-files-found: error");
  expect(workflow).toContain("@anthropic-ai/claude-code@2.1.197");
  expect(workflow).toContain("@openai/codex@0.145.0-alpha.23");
  expect(workflow).toContain("shell: pwsh");
  expect(workflow).toContain("pnpm -C spikes build");
  expect(workflow).toContain("$cli = pnpm --silent -C spikes resolve:host-cli \".artifacts/host-cli/claude-code\"");
  expect(workflow).toContain("$cli = pnpm --silent -C spikes resolve:host-cli \".artifacts/host-cli/codex\"");
  expect(workflow).toContain("../docs/decisions/0003-plugin-lifecycle-spike.md .artifacts/downloaded-reports/claude-code-darwin-arm64.json");
  expect(workflow).toContain("path: docs/decisions/0003-plugin-lifecycle-spike.md");
  expect(workflow).not.toMatch(/\.cmd|\.bat|shell:\s*true|npm\s+(install|i)\s+-g/);
  expect(workflow).not.toMatch(/ANTHROPIC_API_KEY.*OPENAI_API_KEY|OPENAI_API_KEY.*ANTHROPIC_API_KEY/);
  expect(workflow.match(/continue-on-error: true/g)).toHaveLength(1);
});

function runWriter(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const pnpmEntry = process.env.npm_execpath;
  if (pnpmEntry === undefined || !isAbsolute(pnpmEntry)) return Promise.reject(new Error("pnpm did not provide a valid npm_execpath"));
  return new Promise((complete, reject) => execFile(process.execPath, [pnpmEntry, "write:plugin-lifecycle-decision", ...args], { cwd: process.cwd() }, (error, stdout, stderr) => {
    if (error !== null && typeof error.code !== "number") { reject(error); return; }
    complete({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
  }));
}
