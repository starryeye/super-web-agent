import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { findHostManagedResidue, findNamedResidue, runPluginLifecycle, waitForProcessExit } from "../src/plugin-lifecycle-harness.js";
import type { LifecycleEvent, LifecycleHost } from "../src/lifecycle-events.js";
import type { PluginLifecycleHarnessDependencies } from "../src/plugin-lifecycle-harness.js";
import type { PluginHostAdapter } from "../src/plugin-host-adapters.js";

const digest1 = "a".repeat(64);
const digest2 = "b".repeat(64);
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
function event(host: LifecycleHost, runId: string, name: LifecycleEvent["event"], version: "0.0.1" | "0.0.2", pid: number, nonce?: string, sequence = name === "started" ? 1 : 2): LifecycleEvent {
  return { schemaVersion: 1, runtimeVersion: "0.0.0-spike", runtimeBuildId: version, host, runId, pluginVersion: version, platform: "darwin-arm64", executablePath: join(homedir(), host === "claude-code" ? ".claude" : ".codex", "plugins", "cache", version, "navact-runtime"), pid, parentPid: 1, sequence, observedAtMs: sequence > 2 ? 100 + sequence * 100 : name === "started" ? 110 : 150, event: name, ...(nonce === undefined ? {} : { nonce }) };
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
  const report = await runPluginLifecycle({ host, cliLaunch: { displayName: "claude", executable: "/host/claude", prefixArgs: [] }, fixtureOutputRoot: "/fixtures", projectDirectory: "/project", evidenceDirectory: "/evidence", environment: { ANTHROPIC_API_KEY: "present" } }, {
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
    update: async () => [], runPrompt: async () => { calls.push("prompt"); throw Object.assign(new Error("no output retained"), { observation: { ...observation("prompt"), exitCode: 23 } }); },
    uninstall: async () => { calls.push("uninstall"); return observation("uninstall"); }, removeMarketplace: async () => { calls.push("remove"); return observation("remove"); },
  };
  const report = await runPluginLifecycle({ host: "claude-code", cliLaunch: { displayName: "claude", executable: "/host/claude", prefixArgs: [] }, fixtureOutputRoot: "/fixtures", projectDirectory: "/project", evidenceDirectory: "/evidence", environment: { ANTHROPIC_API_KEY: "present" } }, {
    createAdapter: () => adapter, activateFixture: async () => "/active", readFixtureIndex: async () => ({ schemaVersion: 1, platform: "darwin-arm64", versions: ["0.0.1", "0.0.2"], runtimeArtifacts: { "0.0.1": { sha256: digest1, bytes: 1 }, "0.0.2": { sha256: digest2, bytes: 2 } } }),
    readEvents: async () => [], sha256File: async () => digest1, waitForProcessExit: async () => true, findHostManagedResidue: async () => [], now: () => 1, prepareEvidenceDirectory: async () => {},
  });
  expect(calls).toEqual(["add", "install", "prompt", "prompt", "uninstall", "remove"]);
  expect(report.errors).toEqual(["host command failed: prompt (23)", "host command failed: prompt (23)"]);
});

it("runs fresh recovery after an invalid same-session journal and records every observed PID", async () => {
  const calls: string[] = [];
  const waits: number[] = [];
  const host: LifecycleHost = "claude-code";
  const adapter = fakeAdapter(host, calls);
  const runs: Record<string, LifecycleEvent[]> = {
    "initial-claude-code": [event(host, "initial-claude-code", "started", "0.0.1", 101), event(host, "initial-claude-code", "health", "0.0.1", 101, "initial-claude-code")],
    "updated-claude-code": [event(host, "updated-claude-code", "started", "0.0.2", 102), event(host, "updated-claude-code", "health", "0.0.2", 102, "updated-claude-code")],
    "crash-claude-code": [event("codex", "crash-claude-code", "started", "0.0.2", 103), event(host, "crash-claude-code", "crash-requested", "0.0.2", 103)],
    "fresh-claude-code": [event(host, "fresh-claude-code", "started", "0.0.2", 104), event(host, "fresh-claude-code", "health", "0.0.2", 104, "fresh-claude-code")],
  };
  const report = await runHarness(host, adapter, runs, { waitForProcessExit: async (pid: number) => { waits.push(pid); return true; } });
  expect(calls).toContain("fresh");
  expect(report.errors).toContain("invalid lifecycle journal");
  expect(waits).toContain(103);
  expect(report.crashRecovery.freshSessionRecoveryPassed).toBe(true);
});

it("records a valid same-session restart after crash evidence", async () => {
  const host: LifecycleHost = "claude-code";
  const runs: Record<string, LifecycleEvent[]> = {
    "initial-claude-code": [event(host, "initial-claude-code", "started", "0.0.1", 101), event(host, "initial-claude-code", "health", "0.0.1", 101, "initial-claude-code")],
    "updated-claude-code": [event(host, "updated-claude-code", "started", "0.0.2", 102), event(host, "updated-claude-code", "health", "0.0.2", 102, "updated-claude-code")],
    "crash-claude-code": [event(host, "crash-claude-code", "started", "0.0.2", 103, undefined, 1), event(host, "crash-claude-code", "crash-requested", "0.0.2", 103, undefined, 2), event(host, "crash-claude-code", "started", "0.0.2", 104, undefined, 3), event(host, "crash-claude-code", "health", "0.0.2", 104, "recovery-claude-code", 4)],
    "fresh-claude-code": [event(host, "fresh-claude-code", "started", "0.0.2", 105), event(host, "fresh-claude-code", "health", "0.0.2", 105, "fresh-claude-code")],
  };
  const report = await runHarness(host, fakeAdapter(host, []), runs);
  expect(report.crashRecovery.sameSessionRestartObserved).toBe(true);
  expect(report.errors).toEqual([]);
});

it.each(["initial", "updated", "fresh"] as const)("waits observed PID and rejects a malformed %s journal", async (phase) => {
  const host: LifecycleHost = "claude-code"; const waits: number[] = [];
  const runs = validRuns(host);
  const runId = `${phase}-${host}`;
  runs[runId]![0] = { ...runs[runId]![0]!, runId: "wrong-run" };
  const report = await runHarness(host, fakeAdapter(host, []), runs, { waitForProcessExit: async (pid) => { waits.push(pid); return true; } });
  expect(report.errors).toContain("invalid lifecycle journal");
  expect(waits).toContain(phase === "initial" ? 101 : phase === "updated" ? 102 : 104);
});

it.each([
  ["duplicate sequence", (events: LifecycleEvent[]) => { events[1] = { ...events[1]!, sequence: events[0]!.sequence }; }],
  ["out-of-order timestamp", (events: LifecycleEvent[]) => { events[1] = { ...events[1]!, observedAtMs: 1 }; }],
  ["health PID mismatch", (events: LifecycleEvent[]) => { events[1] = { ...events[1]!, pid: 999 }; }],
  ["health executable mismatch", (events: LifecycleEvent[]) => { events[1] = { ...events[1]!, executablePath: join(homedir(), ".claude", "plugins", "cache", "other", "runtime") }; }],
] as const)("rejects exact lifecycle correlation violation: %s", async (_name, mutate) => {
  const host: LifecycleHost = "claude-code"; const runs = validRuns(host); mutate(runs["initial-claude-code"]!);
  const report = await runHarness(host, fakeAdapter(host, []), runs);
  expect(report.errors).toContain("invalid lifecycle journal");
});

it("supports the Codex evidence cell with its own host and key", async () => {
  const host: LifecycleHost = "codex";
  const report = await runHarness(host, fakeAdapter(host, []), validRuns(host));
  expect(report.host).toBe("codex");
  expect(report.errors).toEqual([]);
});

it("uses only non-signalling process probes and treats a missing PID as exited", async () => {
  await expect(waitForProcessExit(999_999_999, 25)).resolves.toBe(true);
});

it("treats absent scoped host residue roots as empty", async () => {
  await expect(findHostManagedResidue("codex")).resolves.toEqual(expect.any(Array));
});

it("polls EPERM with signal zero until ESRCH without sending a signal", async () => {
  const kill = vi.spyOn(process, "kill").mockImplementationOnce(() => { const error = Object.assign(new Error("denied"), { code: "EPERM" }); throw error; }).mockImplementationOnce(() => { const error = Object.assign(new Error("gone"), { code: "ESRCH" }); throw error; });
  await expect(waitForProcessExit(42, 80)).resolves.toBe(true);
  expect(kill.mock.calls).toEqual([[42, 0], [42, 0]]);
});

it("finds nested host and Navact residue under explicit roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "navact-residue-")); directories.push(root);
  const nested = join(root, "cache", "version", "navact-lifecycle-spike", "state"); await mkdir(nested, { recursive: true }); await writeFile(join(nested, "proof"), "x");
  await expect(findNamedResidue([join(root, "cache"), join(root, "missing")])).resolves.toEqual([join(root, "cache", "version", "navact-lifecycle-spike")]);
});

it("records partial update and cleanup command failures without sensitive outputs", async () => {
  const host: LifecycleHost = "claude-code"; const calls: string[] = [];
  const adapter = fakeAdapter(host, calls);
  adapter.update = async () => [{ ...observation("marketplace-update"), exitCode: 0 }, { ...observation("plugin-update"), exitCode: 31 }];
  adapter.uninstall = async () => ({ ...observation("uninstall"), exitCode: 32 }); adapter.removeMarketplace = async () => ({ ...observation("remove"), exitCode: 33 });
  const report = await runHarness(host, adapter, validRuns(host));
  expect(report.commands).toEqual(expect.arrayContaining(["marketplace-update", "plugin-update", "uninstall", "remove"]));
  expect(report.errors).toEqual(expect.arrayContaining(["host command failed: plugin-update (31)", "host command failed: uninstall (32)", "host command failed: remove (33)"]));
  expect(JSON.stringify(report)).not.toContain("secret");
});

function validRuns(host: LifecycleHost): Record<string, LifecycleEvent[]> {
  const tag = host;
  return {
    [`initial-${tag}`]: [event(host, `initial-${tag}`, "started", "0.0.1", 101), event(host, `initial-${tag}`, "health", "0.0.1", 101, `initial-${tag}`)],
    [`updated-${tag}`]: [event(host, `updated-${tag}`, "started", "0.0.2", 102), event(host, `updated-${tag}`, "health", "0.0.2", 102, `updated-${tag}`)],
    [`crash-${tag}`]: [event(host, `crash-${tag}`, "started", "0.0.2", 103), event(host, `crash-${tag}`, "crash-requested", "0.0.2", 103)],
    [`fresh-${tag}`]: [event(host, `fresh-${tag}`, "started", "0.0.2", 104), event(host, `fresh-${tag}`, "health", "0.0.2", 104, `fresh-${tag}`)],
  };
}

function fakeAdapter(host: LifecycleHost, calls: string[]): PluginHostAdapter {
  return { host, marketplaceName: "market", selector: "selector", version: async () => observation("version"), addMarketplace: async () => { calls.push("add"); return observation("add"); }, install: async () => { calls.push("install"); return observation("install"); }, update: async () => { calls.push("update"); return [observation("update")]; }, runPrompt: async (prompt) => { const phase = prompt.includes("initial-") ? "initial" : prompt.includes("updated-") ? "updated" : prompt.includes("fresh-") ? "fresh" : "crash"; calls.push(phase); return observation(phase); }, uninstall: async () => { calls.push("uninstall"); return observation("uninstall"); }, removeMarketplace: async () => { calls.push("remove"); return observation("remove"); } };
}
async function runHarness(host: LifecycleHost, adapter: PluginHostAdapter, runs: Record<string, LifecycleEvent[]>, extra: Partial<PluginLifecycleHarnessDependencies> = {}) {
  return runPluginLifecycle({ host, cliLaunch: { displayName: host === "claude-code" ? "claude" : "codex", executable: "/host/cli", prefixArgs: [] }, fixtureOutputRoot: "/fixtures", projectDirectory: "/project", evidenceDirectory: "/evidence", environment: host === "claude-code" ? { ANTHROPIC_API_KEY: "present" } : { OPENAI_API_KEY: "present" } }, { createAdapter: () => adapter, activateFixture: async () => "/active", readFixtureIndex: async () => ({ schemaVersion: 1, platform: "darwin-arm64", versions: ["0.0.1", "0.0.2"], runtimeArtifacts: { "0.0.1": { sha256: digest1, bytes: 1 }, "0.0.2": { sha256: digest2, bytes: 2 } } }), readEvents: async (_path: string, runId: string) => runs[runId] ?? [], sha256File: async (path: string) => path.includes("0.0.1") ? digest1 : digest2, waitForProcessExit: async () => true, findHostManagedResidue: async () => [], now: () => 1, prepareEvidenceDirectory: async () => {}, ...extra });
}

function observation(command: string) { return { command, exitCode: 0, stdout: "secret", stderr: "secret", startedAtMs: 100, durationMs: 1 }; }
