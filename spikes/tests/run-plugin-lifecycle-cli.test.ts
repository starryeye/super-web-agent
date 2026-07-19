import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runPluginLifecycleCli } from "../scripts/run-plugin-lifecycle.js";
import type { PluginLifecycleHostReport } from "../src/plugin-lifecycle-report.js";

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => execFile(process.execPath, ["dist/scripts/run-plugin-lifecycle.js", ...args], { cwd: process.cwd(), env: {} }, (error, stdout, stderr) => resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr })));
}

it("rejects relative lifecycle paths before attempting an authenticated host", async () => {
  const result = await run(["claude-code", "relative-cli", "/fixtures", "/report.json", "/project"]);
  expect(result).toEqual({ code: 1, stdout: "", stderr: "plugin lifecycle run failed\n" });
});

it("requires only the matching key without printing environment values", async () => {
  const result = await run(["codex", "/host/codex", "/fixtures", "/report.json", "/project"]);
  expect(result.code).toBe(1);
  expect(`${result.stdout}${result.stderr}`).not.toContain("OPENAI_API_KEY");
});

it("writes a mode-0600 strict report and maps a failed gate to exit 1", async () => {
  const root = await mkdtemp(join(tmpdir(), "navact-cli-"));
  try {
    const path = join(root, "report.json");
    expect(await runPluginLifecycleCli(["claude-code", "/host/claude", "/fixtures", path, "/project"], { ANTHROPIC_API_KEY: "present" }, async () => report(false))).toBe(1);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ schemaVersion: 1, host: "claude-code" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

function report(pass: boolean): PluginLifecycleHostReport {
  const a = "a".repeat(64); const b = "b".repeat(64);
  return { schemaVersion: 1, runtimeVersion: "0.0.0-spike", host: "claude-code", hostVersion: "1.2.3", platform: `${process.platform}-${process.arch}` as "darwin-arm64" | "win32-x64", runtimeArtifacts: { "0.0.1": { sha256: a, bytes: 1 }, "0.0.2": { sha256: b, bytes: 2 } }, pluginVersions: ["0.0.1", "0.0.2"], installUserSteps: 2, updateUserSteps: 2, removalUserSteps: 2, manualConfigEdits: 0, administratorPrivilegesRequested: false, separateInstallerUsed: false, hostNodeRequired: false, initial: { healthPassed: true, cleanStopPassed: true, launchedFromHostCache: true, pid: 1, startupLatencyMs: 0, healthLatencyMs: 0, observedRuntimeBuildId: "0.0.1", observedRuntimeSha256: a }, update: { healthPassed: true, cleanStopPassed: true, launchedFromHostCache: true, pid: 2, observedPluginVersion: "0.0.2", observedRuntimeBuildId: "0.0.2", observedRuntimeSha256: b }, crashRecovery: { crashObserved: true, sameSessionRestartObserved: false, freshSessionRecoveryPassed: pass, reinstallRequired: false, launchedFromHostCache: true, recoveredPid: 3, observedRuntimeBuildId: "0.0.2", observedRuntimeSha256: b }, removal: { pluginRemoved: true, marketplaceRemoved: true, noLiveRuntime: true, hostManagedResiduePaths: [], navactOwnedResiduePaths: [] }, commands: ["claude --version"], errors: pass ? [] : ["failed gate"] };
}
