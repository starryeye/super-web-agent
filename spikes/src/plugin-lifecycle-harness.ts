import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { activatePluginFixtureVersion, parsePluginLifecycleFixtureIndex, type PluginLifecycleFixtureIndex } from "./plugin-lifecycle-fixture.js";
import { parseLifecycleEventLine, type LifecycleEvent, type LifecycleEventName, type LifecycleHost } from "./lifecycle-events.js";
import { parsePluginLifecycleHostReport, type PluginLifecycleHostReport } from "./plugin-lifecycle-report.js";
import { crashPrompt, createPluginHostAdapter, healthPrompt, type CommandObservation, type HostCliLaunch, type PluginHostAdapter } from "./plugin-host-adapters.js";

type Version = "0.0.1" | "0.0.2";
export interface PluginLifecycleHarnessInput { host: LifecycleHost; cliLaunch: HostCliLaunch; fixtureOutputRoot: string; projectDirectory: string; evidenceDirectory: string; environment: NodeJS.ProcessEnv; }
export interface PluginLifecycleHarnessDependencies {
  createAdapter(host: LifecycleHost, launch: HostCliLaunch): PluginHostAdapter;
  activateFixture(input: { outputRoot: string; host: LifecycleHost; version: Version }): Promise<string>;
  readFixtureIndex(path: string): Promise<PluginLifecycleFixtureIndex>;
  readEvents(path: string, runId: string): Promise<LifecycleEvent[]>;
  waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean>;
  findHostManagedResidue(host: LifecycleHost): Promise<string[]>;
  findSwaOwnedResidue(): Promise<string[]>;
  sha256File(path: string): Promise<string>;
  resolveRealpath(path: string): Promise<string>;
  now(): number;
  prepareEvidenceDirectory(path: string): Promise<void>;
}

const platform = (): "darwin-arm64" | "win32-x64" => {
  const value = `${process.platform}-${process.arch}`;
  if (value !== "darwin-arm64" && value !== "win32-x64") throw new Error("unsupported lifecycle platform");
  return value;
};
const defaults: PluginLifecycleHarnessDependencies = {
  createAdapter: createPluginHostAdapter, activateFixture: activatePluginFixtureVersion,
  readFixtureIndex: async (path) => parsePluginLifecycleFixtureIndex(JSON.parse(await readFile(path, "utf8"))),
  readEvents: readRunEvents, waitForProcessExit, findHostManagedResidue, findSwaOwnedResidue, sha256File, resolveRealpath: realpath,
  now: () => Date.now(), prepareEvidenceDirectory: async (path) => { await rm(path, { recursive: true, force: true }); await mkdir(path, { recursive: true, mode: 0o700 }); },
};

function inside(path: string, root: string): boolean { const value = relative(root, path); return value !== "" && !value.startsWith("..") && !isAbsolute(value); }
function cacheRoot(host: LifecycleHost): string { return join(homedir(), host === "claude-code" ? ".claude" : ".codex", "plugins", "cache"); }
function requireAbsolutePaths(input: PluginLifecycleHarnessInput): void { for (const value of [input.fixtureOutputRoot, input.projectDirectory, input.evidenceDirectory, input.cliLaunch.executable, ...input.cliLaunch.prefixArgs]) if (!isAbsolute(value)) throw new Error("lifecycle paths must be absolute"); }
function hostVersion(observation: CommandObservation): string { return observation.stdout.match(/\d+\.\d+(?:\.\d+)?(?:[-+][a-z0-9.-]+)?/i)?.[0] ?? "unavailable"; }
function expectedHostVersion(host: LifecycleHost): string { return host === "claude-code" ? "2.1.197" : "0.145.0-alpha.23"; }
function eventError(): never { throw new Error("invalid lifecycle journal"); }
function validateJournal(events: LifecycleEvent[], host: LifecycleHost, target: string, runId: string, expectedVersion: Version): void {
  let previousAt = -1; const sequences = new Map<number, number>();
  for (const event of events) {
    const priorSequence = sequences.get(event.pid) ?? 0;
    if (event.host !== host || event.platform !== target || event.runId !== runId || event.observedAtMs <= previousAt || event.sequence <= priorSequence || !inside(event.executablePath, cacheRoot(host))) eventError();
    previousAt = event.observedAtMs; sequences.set(event.pid, event.sequence);
    if (event.pluginVersion !== expectedVersion || event.runtimeBuildId !== expectedVersion) eventError();
  }
}
function requireEvent(events: LifecycleEvent[], name: LifecycleEventName, nonce?: string): LifecycleEvent { const found = events.filter((event) => event.event === name && (nonce === undefined || event.nonce === nonce)); if (found.length !== 1) eventError(); return found[0]!; }
export function requireSingleEvent(events: LifecycleEvent[], name: LifecycleEventName): LifecycleEvent { return requireEvent(events, name); }
function sameRuntime(a: LifecycleEvent, b: LifecycleEvent): boolean { return a.pid === b.pid && a.executablePath === b.executablePath; }
async function verifyPhase(input: { d: PluginLifecycleHarnessDependencies; host: LifecycleHost; target: string; events: LifecycleEvent[]; nonce: string; expectedVersion: Version; command: CommandObservation; priorPids: Set<number>; priorPath?: string; }): Promise<{ started: LifecycleEvent; health: LifecycleEvent; digest: string; clean: boolean }> {
  validateJournal(input.events, input.host, input.target, input.nonce, input.expectedVersion);
  const started = requireEvent(input.events, "started"); const health = requireEvent(input.events, "health", input.nonce);
  if (!sameRuntime(started, health) || (input.priorPath !== undefined && started.executablePath === input.priorPath) || input.priorPids.has(started.pid) || started.observedAtMs < input.command.startedAtMs || health.observedAtMs < started.observedAtMs) eventError();
  const [realExecutable, realCache] = await Promise.all([input.d.resolveRealpath(started.executablePath), input.d.resolveRealpath(cacheRoot(input.host))]);
  if (!inside(realExecutable, realCache)) eventError();
  const digest = await input.d.sha256File(started.executablePath);
  if (digest.length !== 64) eventError();
  return { started, health, digest, clean: await input.d.waitForProcessExit(started.pid, 10_000) };
}

export async function runPluginLifecycle(input: PluginLifecycleHarnessInput, injected: Partial<PluginLifecycleHarnessDependencies> = {}): Promise<PluginLifecycleHostReport> {
  const d = { ...defaults, ...injected }; if (input.host !== "claude-code" && input.host !== "codex") throw new Error("unsupported lifecycle host"); requireAbsolutePaths(input); const target = platform();
  if ((input.host === "claude-code" ? input.environment.ANTHROPIC_API_KEY : input.environment.OPENAI_API_KEY) === undefined) throw new Error("matching API key is required");
  await d.prepareEvidenceDirectory(input.evidenceDirectory);
  const index = await d.readFixtureIndex(join(input.fixtureOutputRoot, "fixture-index.json"));
  if (index.platform !== target || index.runtimeArtifacts["0.0.1"].sha256 === index.runtimeArtifacts["0.0.2"].sha256) throw new Error("invalid fixture index for current platform");
  const commands: string[] = []; const errors: string[] = []; const pids = new Set<number>();
  const report = emptyReport(input.host, target, index, commands, errors);
  const adapter = d.createAdapter(input.host, input.cliLaunch); let ownsMarketplace = false; let ownsPlugin = false;
  const captureFailure = (error: unknown, fallback = "lifecycle operation failed"): void => {
    const observation = typeof error === "object" && error !== null && "observation" in error ? (error as { observation?: CommandObservation }).observation : undefined;
    const partial = typeof error === "object" && error !== null && "partialObservations" in error ? (error as { partialObservations?: CommandObservation[] }).partialObservations : undefined;
    for (const value of partial ?? []) commands.push(value.command);
    if (observation !== undefined && observation.command.length > 0) commands.push(observation.command);
    errors.push(observation === undefined ? fallback : `host command failed (${observation.exitCode})`);
  };
  const prompt = async (runId: string, version: Version, text: string, allowFailure = false): Promise<{ command: CommandObservation; events: LifecycleEvent[] }> => {
    const evidencePath = join(input.evidenceDirectory, `${runId}.jsonl`);
    const environment = { ...input.environment, SWA_SPIKE_EVIDENCE_PATH: evidencePath, SWA_SPIKE_HOST: input.host, SWA_SPIKE_RUN_ID: runId, SWA_SPIKE_PLUGIN_VERSION: version };
    const command = await adapter.runPrompt(text, input.projectDirectory, environment, allowFailure); commands.push(command.command);
    const events = await d.readEvents(evidencePath, runId); return { command, events };
  };
  try {
    const version = await adapter.version(input.projectDirectory); commands.push(version.command); report.hostVersion = hostVersion(version);
    if (report.hostVersion !== expectedHostVersion(input.host)) { errors.push(`expected ${expectedHostVersion(input.host)} host CLI version`); return parsePluginLifecycleHostReport(report); }
    const active = await d.activateFixture({ outputRoot: input.fixtureOutputRoot, host: input.host, version: "0.0.1" }); const add = await adapter.addMarketplace(active, input.projectDirectory); commands.push(add.command); ownsMarketplace = true;
    const install = await adapter.install(input.projectDirectory); commands.push(install.command); ownsPlugin = true;
    const initialId = `initial-${input.host}`; const initial = await prompt(initialId, "0.0.1", healthPrompt(initialId)); for (const event of initial.events) pids.add(event.pid); const first = await verifyPhase({ d, host: input.host, target, events: initial.events, nonce: initialId, expectedVersion: "0.0.1", command: initial.command, priorPids: new Set() });
    if (first.digest !== index.runtimeArtifacts["0.0.1"].sha256) eventError();
    report.initial = { healthPassed: true, cleanStopPassed: first.clean, launchedFromHostCache: true, pid: first.started.pid, startupLatencyMs: first.started.observedAtMs - initial.command.startedAtMs, healthLatencyMs: first.health.observedAtMs - first.started.observedAtMs, observedRuntimeBuildId: first.started.runtimeBuildId, observedRuntimeSha256: first.digest };
    await d.activateFixture({ outputRoot: input.fixtureOutputRoot, host: input.host, version: "0.0.2" });
    let updateCommandFailed = false;
    try { for (const update of await adapter.update(input.projectDirectory)) { commands.push(update.command); if (update.exitCode !== 0) { errors.push(`host command failed (${update.exitCode})`); updateCommandFailed = true; } } } catch (error) { captureFailure(error); updateCommandFailed = true; }
    const updateId = `updated-${input.host}`; const priorUpdatePids = new Set(pids); const updated = await prompt(updateId, "0.0.2", healthPrompt(updateId)); for (const event of updated.events) pids.add(event.pid); const second = await verifyPhase({ d, host: input.host, target, events: updated.events, nonce: updateId, expectedVersion: "0.0.2", command: updated.command, priorPids: priorUpdatePids, priorPath: first.started.executablePath });
    if (second.digest !== index.runtimeArtifacts["0.0.2"].sha256) eventError();
    report.update = { healthPassed: !updateCommandFailed, cleanStopPassed: second.clean, launchedFromHostCache: true, pid: second.started.pid, observedPluginVersion: second.health.pluginVersion, observedRuntimeBuildId: second.started.runtimeBuildId, observedRuntimeSha256: second.digest };
    const crashId = `crash-${input.host}`;
    try {
      const priorCrashPids = new Set(pids); const crash = await prompt(crashId, "0.0.2", crashPrompt(`recovery-${input.host}`), true);
      for (const event of crash.events) pids.add(event.pid); validateJournal(crash.events, input.host, target, crashId, "0.0.2");
      const requested = requireEvent(crash.events, "crash-requested"); const starts = crash.events.filter((event) => event.event === "started");
      const healthEvents = crash.events.filter((event) => event.event === "health");
      const recoveries = healthEvents.filter((event) => event.nonce === `recovery-${input.host}`);
      if (starts.length < 1 || starts.length > 2 || starts[0]!.pid === second.started.pid || !sameRuntime(requested, starts[0]!)) eventError();
      const restarted = starts[1]; const recovery = recoveries[0];
      const startIndex = crash.events.indexOf(starts[0]!); const crashIndex = crash.events.indexOf(requested); const restartIndex = restarted === undefined ? -1 : crash.events.indexOf(restarted); const recoveryIndex = recovery === undefined ? -1 : crash.events.indexOf(recovery);
      if (startIndex >= crashIndex || (restartIndex !== -1 && (crashIndex >= restartIndex || recoveryIndex <= restartIndex))) eventError();
      if (healthEvents.length > 1 || (healthEvents.length === 1 && recoveries.length !== 1)) eventError();
      const [realCrash, realCache] = await Promise.all([d.resolveRealpath(starts[0]!.executablePath), d.resolveRealpath(cacheRoot(input.host))]);
      if (!inside(realCrash, realCache)) eventError();
      if ((restarted === undefined) !== (recovery === undefined)) eventError();
      if (restarted !== undefined && recovery !== undefined) {
        const [realRestarted, realCache] = await Promise.all([d.resolveRealpath(restarted.executablePath), d.resolveRealpath(cacheRoot(input.host))]);
        if (requested.observedAtMs >= restarted.observedAtMs || restarted.pid === starts[0]!.pid || !sameRuntime(restarted, recovery) || !inside(realRestarted, realCache) || priorCrashPids.has(restarted.pid) || (await d.sha256File(restarted.executablePath)) !== index.runtimeArtifacts["0.0.2"].sha256) eventError();
      }
      report.crashRecovery.crashObserved = true; report.crashRecovery.sameSessionRestartObserved = restarted !== undefined;
    } catch (error) { error instanceof Error && error.message === "invalid lifecycle journal" ? errors.push(error.message) : captureFailure(error); }
  } catch (error) { error instanceof Error && error.message === "invalid lifecycle journal" ? errors.push(error.message) : captureFailure(error); }
  // Fresh recovery is intentionally independent of same-session crash behavior.
  if (ownsPlugin) {
    try {
      const freshId = `fresh-${input.host}`; const priorFreshPids = new Set(pids); const fresh = await prompt(freshId, "0.0.2", healthPrompt(freshId)); for (const event of fresh.events) pids.add(event.pid); const phase = await verifyPhase({ d, host: input.host, target, events: fresh.events, nonce: freshId, expectedVersion: "0.0.2", command: fresh.command, priorPids: priorFreshPids });
      if (phase.digest !== index.runtimeArtifacts["0.0.2"].sha256) eventError();
      report.crashRecovery = { ...report.crashRecovery, freshSessionRecoveryPassed: phase.clean, reinstallRequired: false, launchedFromHostCache: true, recoveredPid: phase.started.pid, observedRuntimeBuildId: phase.started.runtimeBuildId, observedRuntimeSha256: phase.digest };
      if (!phase.clean) errors.push("fresh Runtime did not exit cleanly");
    } catch (error) { error instanceof Error && error.message === "invalid lifecycle journal" ? errors.push(error.message) : captureFailure(error); }
  }
  if (ownsPlugin) { try { const command = await adapter.uninstall(input.projectDirectory); commands.push(command.command); report.removal.pluginRemoved = command.exitCode === 0; if (command.exitCode !== 0) errors.push(`host command failed (${command.exitCode})`); } catch (error) { captureFailure(error, "plugin cleanup failed"); } }
  if (ownsMarketplace) { try { const command = await adapter.removeMarketplace(input.projectDirectory); commands.push(command.command); report.removal.marketplaceRemoved = command.exitCode === 0; if (command.exitCode !== 0) errors.push(`host command failed (${command.exitCode})`); } catch (error) { captureFailure(error, "marketplace cleanup failed"); } }
  report.removal.noLiveRuntime = (await Promise.all([...pids].map((pid) => d.waitForProcessExit(pid, 10_000)))).every(Boolean);
  try { report.removal.hostManagedResiduePaths = await d.findHostManagedResidue(input.host); report.removal.swaOwnedResiduePaths = await d.findSwaOwnedResidue(); } catch { errors.push("host residue inspection failed"); report.removal.noLiveRuntime = false; }
  return parsePluginLifecycleHostReport(report);
}

function emptyReport(host: LifecycleHost, target: "darwin-arm64" | "win32-x64", index: PluginLifecycleFixtureIndex, commands: string[], errors: string[]): PluginLifecycleHostReport {
  const unknown = "unknown"; const zero = "0".repeat(64);
  return { schemaVersion: 1, runtimeVersion: "0.0.0-spike", host, hostVersion: unknown, platform: target, runtimeArtifacts: index.runtimeArtifacts, pluginVersions: ["0.0.1", "0.0.2"], installUserSteps: 2, updateUserSteps: host === "claude-code" ? 2 : 1, removalUserSteps: 2, manualConfigEdits: 0, administratorPrivilegesRequested: false, separateInstallerUsed: false, hostNodeRequired: false, initial: { healthPassed: false, cleanStopPassed: false, launchedFromHostCache: false, pid: 1, startupLatencyMs: 0, healthLatencyMs: 0, observedRuntimeBuildId: unknown, observedRuntimeSha256: zero }, update: { healthPassed: false, cleanStopPassed: false, launchedFromHostCache: false, pid: 1, observedPluginVersion: unknown, observedRuntimeBuildId: unknown, observedRuntimeSha256: zero }, crashRecovery: { crashObserved: false, sameSessionRestartObserved: false, freshSessionRecoveryPassed: false, reinstallRequired: false, launchedFromHostCache: false, recoveredPid: 1, observedRuntimeBuildId: unknown, observedRuntimeSha256: zero }, removal: { pluginRemoved: false, marketplaceRemoved: false, noLiveRuntime: false, hostManagedResiduePaths: [], swaOwnedResiduePaths: [] }, commands, errors };
}
export async function readRunEvents(path: string, runId: string): Promise<LifecycleEvent[]> { return (await readFile(path, "utf8")).split("\n").filter(Boolean).map(parseLifecycleEventLine).filter((event) => event.runId === runId); }
export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> { const end = Date.now() + timeoutMs; do { try { process.kill(pid, 0); } catch (error: unknown) { const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined; if (code === "ESRCH") return true; } await new Promise((done) => setTimeout(done, 25)); } while (Date.now() < end); return false; }
export async function findNamedResidue(roots: string[], includeExistingRoot = false): Promise<string[]> { const result: string[] = []; const visit = async (directory: string, root = false): Promise<void> => { let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch (error: unknown) { const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined; if (code === "ENOENT") return; throw error; } if (root && includeExistingRoot) result.push(directory); for (const entry of entries) { const path = join(directory, entry.name); if (entry.name.includes("super-web-agent-lifecycle-spike")) result.push(path); if (entry.isDirectory()) await visit(path); } }; for (const root of roots) await visit(root, true); return result; }
export async function findHostManagedResidue(host: LifecycleHost): Promise<string[]> { return findNamedResidue([join(homedir(), host === "claude-code" ? ".claude" : ".codex", "plugins", "cache"), join(homedir(), host === "claude-code" ? ".claude" : ".codex", "plugins", "data")]); }
export async function findSwaOwnedResidue(): Promise<string[]> { return findNamedResidue([join(homedir(), ".super-web-agent"), join(homedir(), ".local", "share", "super-web-agent"), join(homedir(), "Library", "Application Support", "Super Web Agent"), join(homedir(), "AppData", "Roaming", "Super Web Agent")], true); }
export async function sha256File(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
