import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runPluginLifecycle } from "../src/plugin-lifecycle-harness.js";
import type { LifecycleEvent, LifecycleHost } from "../src/lifecycle-events.js";
import type { PluginHostAdapter } from "../src/plugin-host-adapters.js";

const digest1 = "a".repeat(64);
const digest2 = "b".repeat(64);
function event(host: LifecycleHost, runId: string, name: LifecycleEvent["event"], version: "0.0.1" | "0.0.2", pid: number, nonce?: string): LifecycleEvent {
  return { schemaVersion: 1, runtimeVersion: "0.0.0-spike", runtimeBuildId: version, host, runId, pluginVersion: version, platform: "darwin-arm64", executablePath: join(homedir(), ".claude", "plugins", "cache", version, "navact-runtime"), pid, parentPid: 1, sequence: 1, observedAtMs: name === "started" ? 110 : 150, event: name, ...(nonce === undefined ? {} : { nonce }) };
}

it("orchestrates v1, v2, crash and fresh recovery without sensitive command outputs", async () => {
  const calls: string[] = [];
  const host: LifecycleHost = "claude-code";
  const adapter: PluginHostAdapter = {
    host, marketplaceName: "market", selector: "selector",
    version: async () => ({ command: "claude --version", exitCode: 0, stdout: "secret output", stderr: "secret stderr", startedAtMs: 100, durationMs: 1 }),
    addMarketplace: async () => { calls.push("add"); return observation("add"); }, install: async () => { calls.push("install"); return observation("install"); },
    update: async () => { calls.push("update"); return [observation("update")]; }, uninstall: async () => { calls.push("uninstall"); return observation("uninstall"); }, removeMarketplace: async () => { calls.push("remove"); return observation("remove"); },
    runPrompt: async (prompt) => { const phase = prompt.includes("initial-") ? "initial" : prompt.includes("updated-") ? "updated" : prompt.includes("fresh-") ? "fresh" : "crash"; calls.push(phase); return observation(phase); },
  };
  const runs: Record<string, LifecycleEvent[]> = {
    "initial-claude-code": [event(host, "initial-claude-code", "started", "0.0.1", 101), event(host, "initial-claude-code", "health", "0.0.1", 101, "initial-claude-code")],
    "updated-claude-code": [event(host, "updated-claude-code", "started", "0.0.2", 102), event(host, "updated-claude-code", "health", "0.0.2", 102, "updated-claude-code")],
    "crash-claude-code": [event(host, "crash-claude-code", "started", "0.0.2", 103), event(host, "crash-claude-code", "crash-requested", "0.0.2", 103)],
    "fresh-claude-code": [event(host, "fresh-claude-code", "started", "0.0.2", 104), event(host, "fresh-claude-code", "health", "0.0.2", 104, "fresh-claude-code")],
  };
  const report = await runPluginLifecycle({ host, cliLaunch: { displayName: "claude", executable: "claude", prefixArgs: [] }, fixtureOutputRoot: "/fixtures", projectDirectory: "/project", evidenceDirectory: "/evidence", environment: { ANTHROPIC_API_KEY: "present" } }, {
    createAdapter: () => adapter,
    activateFixture: async ({ version }) => { calls.push(`activate-${version}`); return "/active"; },
    readFixtureIndex: async () => ({ schemaVersion: 1, platform: "darwin-arm64", versions: ["0.0.1", "0.0.2"], runtimeArtifacts: { "0.0.1": { sha256: digest1, bytes: 1 }, "0.0.2": { sha256: digest2, bytes: 2 } } }),
    readEvents: async (_path, runId) => runs[runId] ?? [], sha256File: async (path) => path.includes("0.0.1") ? digest1 : digest2,
    waitForProcessExit: async () => true, findHostManagedResidue: async () => [], now: () => 1,
    prepareEvidenceDirectory: async () => {},
  });
  expect(calls).toEqual(["activate-0.0.1", "add", "install", "initial", "activate-0.0.2", "update", "updated", "crash", "fresh", "uninstall", "remove"]);
  expect(report.initial).toMatchObject({ observedRuntimeBuildId: "0.0.1", observedRuntimeSha256: digest1, startupLatencyMs: 10, healthLatencyMs: 40 });
  expect(report.update).toMatchObject({ observedPluginVersion: "0.0.2", observedRuntimeBuildId: "0.0.2", observedRuntimeSha256: digest2 });
  expect(report.crashRecovery).toMatchObject({ observedRuntimeBuildId: "0.0.2", observedRuntimeSha256: digest2, freshSessionRecoveryPassed: true });
  expect(JSON.stringify(report)).not.toContain("secret");
});

it("cleans up marketplace ownership in reverse order after a prompt failure", async () => {
  const calls: string[] = [];
  const adapter: PluginHostAdapter = {
    host: "claude-code", marketplaceName: "market", selector: "selector",
    version: async () => observation("version"), addMarketplace: async () => { calls.push("add"); return observation("add"); }, install: async () => { calls.push("install"); return observation("install"); },
    update: async () => [], runPrompt: async () => { calls.push("prompt"); throw Object.assign(new Error("no output retained"), { observation: { exitCode: 23 } }); },
    uninstall: async () => { calls.push("uninstall"); return observation("uninstall"); }, removeMarketplace: async () => { calls.push("remove"); return observation("remove"); },
  };
  const report = await runPluginLifecycle({ host: "claude-code", cliLaunch: { displayName: "claude", executable: "claude", prefixArgs: [] }, fixtureOutputRoot: "/fixtures", projectDirectory: "/project", evidenceDirectory: "/evidence", environment: { ANTHROPIC_API_KEY: "present" } }, {
    createAdapter: () => adapter, activateFixture: async () => "/active", readFixtureIndex: async () => ({ schemaVersion: 1, platform: "darwin-arm64", versions: ["0.0.1", "0.0.2"], runtimeArtifacts: { "0.0.1": { sha256: digest1, bytes: 1 }, "0.0.2": { sha256: digest2, bytes: 2 } } }),
    readEvents: async () => [], sha256File: async () => digest1, waitForProcessExit: async () => true, findHostManagedResidue: async () => [], now: () => 1, prepareEvidenceDirectory: async () => {},
  });
  expect(calls).toEqual(["add", "install", "prompt", "uninstall", "remove"]);
  expect(report.errors).toEqual(["host command failed (23)"]);
});

function observation(command: string) { return { command, exitCode: 0, stdout: "secret", stderr: "secret", startedAtMs: 100, durationMs: 1 }; }
