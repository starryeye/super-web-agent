import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import {
  evaluateKeylessLifecycleEvidence,
  renderKeylessLifecycleDecision,
} from "../src/keyless-lifecycle-decision.js";
import type { KeylessLifecyclePlatformReport } from "../src/keyless-lifecycle-report.js";

function reportFor(platform: "darwin-arm64" | "win32-x64"): KeylessLifecyclePlatformReport {
  const windows = platform === "win32-x64";
  const firstDigest = windows
    ? "1111111111111111111111111111111111111111111111111111111111111111"
    : "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const secondDigest = windows
    ? "2222222222222222222222222222222222222222222222222222222222222222"
    : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const artifact = windows ? "super-web-agent-runtime.exe" : "super-web-agent-runtime";
  return {
    schemaVersion: 1, sourceCommit: "0123456789abcdef0123456789abcdef01234567", platform, nodeVersion: "v24.14.0",
    pluginName: "super-web-agent-lifecycle-evidence",
    providerDependencies: { apiKeysRequired: false, providerCliInvoked: false, modelInvoked: false },
    artifacts: {
      "0.0.1": { artifact, sha256: firstDigest, bytes: 123456, buildId: "0.0.1" },
      "0.0.2": { artifact, sha256: secondDigest, bytes: 123457, buildId: "0.0.2" },
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
    windowsStaging: windows ? { mode: "powershell-acl", passed: true } : { mode: "not-applicable", passed: true }, errors: [],
  };
}

it("accepts exactly one passing native report from each required platform", () => {
  expect(evaluateKeylessLifecycleEvidence([reportFor("darwin-arm64"), reportFor("win32-x64")])).toEqual({
    state: "accepted",
    reasons: ["both native keyless lifecycle evidence cells passed"],
    followUps: ["signed-in Codex Desktop acceptance remains required"],
  });
});

it.each([
  ["missing platform", [reportFor("darwin-arm64")]],
  ["duplicate platform", [reportFor("darwin-arm64"), reportFor("darwin-arm64"), reportFor("win32-x64")]],
  ["malformed report", [{ schemaVersion: 1 }, reportFor("win32-x64")]],
  ["wrong platform", [
    { ...reportFor("darwin-arm64"), platform: "linux-x64" },
    reportFor("win32-x64"),
  ]],
  ["mixed commit", (() => { const windows = reportFor("win32-x64"); windows.sourceCommit = "fedcba9876543210fedcba9876543210fedcba98"; return [reportFor("darwin-arm64"), windows]; })()],
  ["digest disagreement", (() => { const windows = reportFor("win32-x64"); windows.phases.update.observedRuntimeSha256 = "3333333333333333333333333333333333333333333333333333333333333333"; return [reportFor("darwin-arm64"), windows]; })()],
  ["failed Windows ACL", (() => { const windows = reportFor("win32-x64"); windows.windowsStaging = { mode: "powershell-acl", passed: false }; return [reportFor("darwin-arm64"), windows]; })()],
  ["provider dependency", (() => { const mac = reportFor("darwin-arm64") as unknown as { providerDependencies: { apiKeysRequired: boolean } }; mac.providerDependencies.apiKeysRequired = true; return [mac, reportFor("win32-x64")]; })()],
])("rejects %s without partial acceptance", (_name, reports) => {
  expect(evaluateKeylessLifecycleEvidence(reports)).toMatchObject({ state: "rejected" });
});

it("renders deterministic sanitized Markdown", () => {
  const markdown = renderKeylessLifecycleDecision([reportFor("win32-x64"), reportFor("darwin-arm64")]);
  expect(markdown).toContain("# Keyless Plugin Lifecycle Evidence Decision\n\nStatus: Accepted");
  expect(markdown).toContain("This ADR evaluates deterministic native Runtime packaging and MCP lifecycle\nevidence only. Signed-in Codex Desktop acceptance remains separate.");
  expect(markdown).toContain("| darwin-arm64 | passed | 123456 | aaaaaaaa | 123457 | bbbbbbbb |");
  expect(markdown).toContain("| win32-x64 | passed | 123456 | 11111111 | 123457 | 22222222 |");
  expect(markdown).not.toContain("runtime/super-web-agent-runtime");
  expect(markdown).not.toContain("0123456789abcdef0123456789abcdef01234567");
});

it("writes a rejected decision from two explicit malformed inputs and prints only its path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keyless-decision-"));
  const output = join(directory, "decision.md");
  const mac = join(directory, "mac.json");
  const windows = join(directory, "windows.json");
  await writeFile(mac, "not json");
  await writeFile(windows, JSON.stringify(reportFor("win32-x64")));
  const build = await new Promise<number | null>((done) => {
    const child = spawn(process.execPath, [
      "/Users/starryeye/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.cjs",
      "build",
    ]);
    child.on("close", done);
  });
  expect(build).toBe(0);
  const script = resolve("dist/scripts/write-keyless-lifecycle-decision.js");
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [script, output, mac, windows]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
  expect(result).toEqual({ code: 1, stdout: `${output}\n`, stderr: "" });
  expect(await readFile(output, "utf8")).toContain("Status: Rejected");
});
