import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { activatePluginFixtureVersion, parsePluginLifecycleFixtureIndex, type PluginLifecycleFixtureIndex } from "./plugin-lifecycle-fixture.js";
import { parseLifecycleEventLine, type LifecycleEvent, type LifecycleEventName, type LifecycleHost } from "./lifecycle-events.js";
import { type PluginLifecycleHostReport } from "./plugin-lifecycle-report.js";
import { crashPrompt, createPluginHostAdapter, healthPrompt, type HostCliLaunch, type PluginHostAdapter } from "./plugin-host-adapters.js";

export interface PluginLifecycleHarnessInput { host: LifecycleHost; cliLaunch: HostCliLaunch; fixtureOutputRoot: string; projectDirectory: string; evidenceDirectory: string; environment: NodeJS.ProcessEnv; }
export interface PluginLifecycleHarnessDependencies {
  createAdapter(host: LifecycleHost, launch: HostCliLaunch): PluginHostAdapter;
  activateFixture(input: { outputRoot: string; host: LifecycleHost; version: "0.0.1" | "0.0.2" }): Promise<string>;
  readFixtureIndex(path: string): Promise<PluginLifecycleFixtureIndex>;
  readEvents(path: string, runId: string): Promise<LifecycleEvent[]>;
  waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean>;
  findHostManagedResidue(host: LifecycleHost): Promise<string[]>;
  sha256File(path: string): Promise<string>;
  now(): number;
  prepareEvidenceDirectory(path: string): Promise<void>;
}

const supported = new Set(["darwin-arm64", "win32-x64"]);
const hasAbsolute = (value: string) => isAbsolute(value);
const defaults: PluginLifecycleHarnessDependencies = {
  createAdapter: createPluginHostAdapter, activateFixture: activatePluginFixtureVersion,
  readFixtureIndex: async (path) => parsePluginLifecycleFixtureIndex(JSON.parse(await readFile(path, "utf8"))),
  readEvents: readRunEvents, waitForProcessExit, findHostManagedResidue, sha256File,
  now: () => Date.now(), prepareEvidenceDirectory: async (path) => { await rm(path, { recursive: true, force: true }); await mkdir(path, { recursive: true, mode: 0o700 }); },
};
function requireEvent(events: LifecycleEvent[], name: LifecycleEventName, nonce?: string): LifecycleEvent { const found = events.filter((event) => event.event === name && (nonce === undefined || event.nonce === nonce)); if (found.length !== 1) throw new Error("missing lifecycle event"); return found[0]!; }
export function requireSingleEvent(events: LifecycleEvent[], name: LifecycleEventName): LifecycleEvent { return requireEvent(events, name); }
function inside(path: string, root: string): boolean { const value = relative(root, path); return value !== "" && !value.startsWith("..") && !isAbsolute(value); }
function cachePath(host: LifecycleHost, path: string): boolean { return inside(path, join(homedir(), host === "claude-code" ? ".claude" : ".codex", "plugins", "cache")); }
function observed(host: LifecycleHost, event: LifecycleEvent, expectedVersion: "0.0.1" | "0.0.2", digest: string, actual: string): void { if (event.pluginVersion !== expectedVersion || event.runtimeBuildId !== expectedVersion || actual !== digest || !cachePath(host, event.executablePath)) throw new Error("lifecycle evidence did not match installed Runtime"); }
function safeError(error: unknown): string { const code = typeof error === "object" && error !== null && "observation" in error ? (error as { observation?: { exitCode?: unknown } }).observation?.exitCode : undefined; return typeof code === "number" ? `host command failed (${code})` : "lifecycle harness failed"; }

export async function runPluginLifecycle(input: PluginLifecycleHarnessInput, injected: Partial<PluginLifecycleHarnessDependencies> = {}): Promise<PluginLifecycleHostReport> {
  const d = { ...defaults, ...injected }; const platform = `${process.platform}-${process.arch}`;
  if (!supported.has(platform) || !hasAbsolute(input.fixtureOutputRoot) || !hasAbsolute(input.projectDirectory) || !hasAbsolute(input.evidenceDirectory)) throw new Error("invalid lifecycle harness paths or platform");
  if ((input.host === "claude-code" ? input.environment.ANTHROPIC_API_KEY : input.environment.OPENAI_API_KEY) === undefined) throw new Error("matching API key is required");
  await d.prepareEvidenceDirectory(input.evidenceDirectory);
  const index = await d.readFixtureIndex(join(input.fixtureOutputRoot, "fixture-index.json"));
  if (index.runtimeArtifacts["0.0.1"].sha256 === index.runtimeArtifacts["0.0.2"].sha256) throw new Error("fixture Runtime digests must differ");
  const adapter = d.createAdapter(input.host, input.cliLaunch); const commands: string[] = []; const errors: string[] = []; const pids = new Set<number>();
  let installed = false; let marketplace = false; let hostVersion = "unknown";
  const blank = { healthPassed: false, cleanStopPassed: false, launchedFromHostCache: false, pid: 1, startupLatencyMs: 0, healthLatencyMs: 0, observedRuntimeBuildId: "unknown", observedRuntimeSha256: "0".repeat(64) };
  const report: PluginLifecycleHostReport = { schemaVersion: 1, runtimeVersion: "0.0.0-spike", host: input.host, hostVersion, platform: platform as "darwin-arm64" | "win32-x64", runtimeArtifacts: index.runtimeArtifacts, pluginVersions: ["0.0.1", "0.0.2"], installUserSteps: 2, updateUserSteps: input.host === "claude-code" ? 2 : 1, removalUserSteps: 2, manualConfigEdits: 0, administratorPrivilegesRequested: false, separateInstallerUsed: false, hostNodeRequired: false, initial: { ...blank }, update: { healthPassed: false, cleanStopPassed: false, launchedFromHostCache: false, pid: 1, observedPluginVersion: "unknown", observedRuntimeBuildId: "unknown", observedRuntimeSha256: "0".repeat(64) }, crashRecovery: { crashObserved: false, sameSessionRestartObserved: false, freshSessionRecoveryPassed: false, reinstallRequired: false, launchedFromHostCache: false, recoveredPid: 1, observedRuntimeBuildId: "unknown", observedRuntimeSha256: "0".repeat(64) }, removal: { pluginRemoved: false, marketplaceRemoved: false, noLiveRuntime: false, hostManagedResiduePaths: [], navactOwnedResiduePaths: [] }, commands, errors };
  const prompt = async (runId: string, text: string, allowFailure = false) => { const env = { ...input.environment, NAVACT_SPIKE_EVIDENCE_PATH: join(input.evidenceDirectory, `${runId}.jsonl`), NAVACT_SPIKE_HOST: input.host, NAVACT_SPIKE_RUN_ID: runId, NAVACT_SPIKE_PLUGIN_VERSION: runId.startsWith("initial") ? "0.0.1" : "0.0.2" }; const command = await adapter.runPrompt(text, input.projectDirectory, env, allowFailure); commands.push(command.command); return { command, events: await d.readEvents(env.NAVACT_SPIKE_EVIDENCE_PATH, runId) }; };
  try {
    const version = await adapter.version(input.projectDirectory); commands.push(version.command); hostVersion = "observed"; report.hostVersion = hostVersion;
    const active1 = await d.activateFixture({ outputRoot: input.fixtureOutputRoot, host: input.host, version: "0.0.1" }); const added = await adapter.addMarketplace(active1, input.projectDirectory); commands.push(added.command); marketplace = true; const install = await adapter.install(input.projectDirectory); commands.push(install.command); installed = true;
    const initialId = `initial-${input.host}`; const initial = await prompt(initialId, healthPrompt(initialId)); const started1 = requireEvent(initial.events, "started"); const health1 = requireEvent(initial.events, "health", initialId); const digest1 = await d.sha256File(started1.executablePath); observed(input.host, started1, "0.0.1", index.runtimeArtifacts["0.0.1"].sha256, digest1); observed(input.host, health1, "0.0.1", index.runtimeArtifacts["0.0.1"].sha256, digest1); pids.add(started1.pid); report.initial = { healthPassed: true, cleanStopPassed: await d.waitForProcessExit(started1.pid, 10_000), launchedFromHostCache: cachePath(input.host, started1.executablePath), pid: started1.pid, startupLatencyMs: started1.observedAtMs - initial.command.startedAtMs, healthLatencyMs: health1.observedAtMs - started1.observedAtMs, observedRuntimeBuildId: started1.runtimeBuildId, observedRuntimeSha256: digest1 };
    await d.activateFixture({ outputRoot: input.fixtureOutputRoot, host: input.host, version: "0.0.2" }); for (const command of await adapter.update(input.projectDirectory)) commands.push(command.command);
    const updatedId = `updated-${input.host}`; const updated = await prompt(updatedId, healthPrompt(updatedId)); const started2 = requireEvent(updated.events, "started"); const health2 = requireEvent(updated.events, "health", updatedId); const digest2 = await d.sha256File(started2.executablePath); observed(input.host, started2, "0.0.2", index.runtimeArtifacts["0.0.2"].sha256, digest2); observed(input.host, health2, "0.0.2", index.runtimeArtifacts["0.0.2"].sha256, digest2); pids.add(started2.pid); report.update = { healthPassed: true, cleanStopPassed: await d.waitForProcessExit(started2.pid, 10_000), launchedFromHostCache: cachePath(input.host, started2.executablePath), pid: started2.pid, observedPluginVersion: health2.pluginVersion, observedRuntimeBuildId: started2.runtimeBuildId, observedRuntimeSha256: digest2 };
    const crashId = `crash-${input.host}`; const crash = await prompt(crashId, crashPrompt(`recovery-${input.host}`), true); for (const event of crash.events.filter((value) => value.event === "started")) pids.add(event.pid); const crashEvent = crash.events.find((event) => event.event === "crash-requested"); const secondStart = crash.events.filter((event) => event.event === "started")[1]; const recovery = crash.events.find((event) => event.event === "health" && event.nonce === `recovery-${input.host}`); if (secondStart !== undefined) observed(input.host, secondStart, "0.0.2", index.runtimeArtifacts["0.0.2"].sha256, await d.sha256File(secondStart.executablePath)); if (recovery !== undefined) observed(input.host, recovery, "0.0.2", index.runtimeArtifacts["0.0.2"].sha256, secondStart === undefined ? "" : await d.sha256File(secondStart.executablePath)); report.crashRecovery.crashObserved = crashEvent !== undefined; report.crashRecovery.sameSessionRestartObserved = secondStart !== undefined && recovery !== undefined;
    const freshId = `fresh-${input.host}`; const fresh = await prompt(freshId, healthPrompt(freshId)); const started4 = requireEvent(fresh.events, "started"); const health4 = requireEvent(fresh.events, "health", freshId); const digest4 = await d.sha256File(started4.executablePath); observed(input.host, started4, "0.0.2", index.runtimeArtifacts["0.0.2"].sha256, digest4); observed(input.host, health4, "0.0.2", index.runtimeArtifacts["0.0.2"].sha256, digest4); pids.add(started4.pid); report.crashRecovery = { ...report.crashRecovery, freshSessionRecoveryPassed: health4.pluginVersion === "0.0.2", launchedFromHostCache: cachePath(input.host, started4.executablePath), recoveredPid: started4.pid, observedRuntimeBuildId: started4.runtimeBuildId, observedRuntimeSha256: digest4 };
  } catch (error) { errors.push(safeError(error)); } finally {
    if (installed) { try { const command = await adapter.uninstall(input.projectDirectory); commands.push(command.command); report.removal.pluginRemoved = true; } catch { errors.push("plugin cleanup failed"); } }
    if (marketplace) { try { const command = await adapter.removeMarketplace(input.projectDirectory); commands.push(command.command); report.removal.marketplaceRemoved = true; } catch { errors.push("marketplace cleanup failed"); } }
    report.removal.noLiveRuntime = (await Promise.all([...pids].map((pid) => d.waitForProcessExit(pid, 10_000)))).every(Boolean);
    report.removal.hostManagedResiduePaths = await d.findHostManagedResidue(input.host);
  }
  return report;
}

export async function readRunEvents(path: string, runId: string): Promise<LifecycleEvent[]> { try { return (await readFile(path, "utf8")).split("\n").filter(Boolean).map(parseLifecycleEventLine).filter((event) => event.runId === runId); } catch { return []; } }
export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> { const end = Date.now() + timeoutMs; while (Date.now() < end) { try { process.kill(pid, 0); } catch (error: unknown) { if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ESRCH") return true; if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EPERM") return false; } await new Promise((resolvePromise) => setTimeout(resolvePromise, 25)); } return false; }
export async function findHostManagedResidue(host: LifecycleHost): Promise<string[]> { const root = host === "claude-code" ? join(homedir(), ".claude", "plugins") : join(homedir(), ".codex", "plugins"); const paths: string[] = []; for (const part of ["cache", "data"]) { const directory = join(root, part); try { for (const child of await readdir(directory)) if (child.includes("navact-lifecycle-spike")) paths.push(join(directory, child)); } catch {} } return paths; }
export async function sha256File(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
