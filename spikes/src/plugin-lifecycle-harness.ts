import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
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
  sha256File(path: string): Promise<string>;
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
  readEvents: readRunEvents, waitForProcessExit, findHostManagedResidue, sha256File,
  now: () => Date.now(), prepareEvidenceDirectory: async (path) => { await rm(path, { recursive: true, force: true }); await mkdir(path, { recursive: true, mode: 0o700 }); },
};

function inside(path: string, root: string): boolean { const value = relative(root, path); return value !== "" && !value.startsWith("..") && !isAbsolute(value); }
function cacheRoot(host: LifecycleHost): string { return join(homedir(), host === "claude-code" ? ".claude" : ".codex", "plugins", "cache"); }
function requireAbsolutePaths(input: PluginLifecycleHarnessInput): void { for (const value of [input.fixtureOutputRoot, input.projectDirectory, input.evidenceDirectory, input.cliLaunch.executable, ...input.cliLaunch.prefixArgs]) if (!isAbsolute(value)) throw new Error("lifecycle paths must be absolute"); }
function commandFailure(error: unknown): string { const observation = typeof error === "object" && error !== null && "observation" in error ? (error as { observation?: CommandObservation }).observation : undefined; return observation === undefined ? "lifecycle operation failed" : `host command failed: ${observation.command} (${observation.exitCode})`; }
function hostVersion(observation: CommandObservation): string { return observation.stdout.match(/\d+\.\d+(?:\.\d+)?(?:[-+][a-z0-9.-]+)?/i)?.[0] ?? "unavailable"; }
function eventError(): never { throw new Error("invalid lifecycle journal"); }
function validateJournal(events: LifecycleEvent[], host: LifecycleHost, target: string, expectedVersion: Version): void {
  let previous = 0;
  for (const event of events) {
    if (event.host !== host || event.platform !== target || event.runId === "" || event.observedAtMs < previous || !inside(event.executablePath, cacheRoot(host))) eventError();
    previous = event.observedAtMs;
    if (event.pluginVersion !== expectedVersion || event.runtimeBuildId !== expectedVersion) eventError();
  }
}
function requireEvent(events: LifecycleEvent[], name: LifecycleEventName, nonce?: string): LifecycleEvent { const found = events.filter((event) => event.event === name && (nonce === undefined || event.nonce === nonce)); if (found.length !== 1) eventError(); return found[0]!; }
export function requireSingleEvent(events: LifecycleEvent[], name: LifecycleEventName): LifecycleEvent { return requireEvent(events, name); }
function sameRuntime(a: LifecycleEvent, b: LifecycleEvent): boolean { return a.pid === b.pid && a.executablePath === b.executablePath; }
async function verifyPhase(input: { d: PluginLifecycleHarnessDependencies; host: LifecycleHost; target: string; events: LifecycleEvent[]; nonce: string; expectedVersion: Version; command: CommandObservation; priorPids: Set<number>; priorPath?: string; }): Promise<{ started: LifecycleEvent; health: LifecycleEvent; digest: string; clean: boolean }> {
  validateJournal(input.events, input.host, input.target, input.expectedVersion);
  const started = requireEvent(input.events, "started"); const health = requireEvent(input.events, "health", input.nonce);
  if (!sameRuntime(started, health) || (input.priorPath !== undefined && started.executablePath === input.priorPath) || input.priorPids.has(started.pid) || started.observedAtMs < input.command.startedAtMs || health.observedAtMs < started.observedAtMs) eventError();
  const digest = await input.d.sha256File(started.executablePath);
  if (digest.length !== 64) eventError();
  return { started, health, digest, clean: await input.d.waitForProcessExit(started.pid, 10_000) };
}

export async function runPluginLifecycle(input: PluginLifecycleHarnessInput, injected: Partial<PluginLifecycleHarnessDependencies> = {}): Promise<PluginLifecycleHostReport> {
  const d = { ...defaults, ...injected }; requireAbsolutePaths(input); const target = platform();
  if ((input.host === "claude-code" ? input.environment.ANTHROPIC_API_KEY : input.environment.OPENAI_API_KEY) === undefined) throw new Error("matching API key is required");
  await d.prepareEvidenceDirectory(input.evidenceDirectory);
  const index = await d.readFixtureIndex(join(input.fixtureOutputRoot, "fixture-index.json"));
  if (index.platform !== target || index.runtimeArtifacts["0.0.1"].sha256 === index.runtimeArtifacts["0.0.2"].sha256) throw new Error("invalid fixture index for current platform");
  const commands: string[] = []; const errors: string[] = []; const pids = new Set<number>();
  const report = emptyReport(input.host, target, index, commands, errors);
  const adapter = d.createAdapter(input.host, input.cliLaunch); let ownsMarketplace = false; let ownsPlugin = false;
  const prompt = async (runId: string, version: Version, text: string, allowFailure = false): Promise<{ command: CommandObservation; events: LifecycleEvent[] }> => {
    const evidencePath = join(input.evidenceDirectory, `${runId}.jsonl`);
    const environment = { ...input.environment, NAVACT_SPIKE_EVIDENCE_PATH: evidencePath, NAVACT_SPIKE_HOST: input.host, NAVACT_SPIKE_RUN_ID: runId, NAVACT_SPIKE_PLUGIN_VERSION: version };
    const command = await adapter.runPrompt(text, input.projectDirectory, environment, allowFailure); commands.push(command.command);
    const events = await d.readEvents(evidencePath, runId); return { command, events };
  };
  try {
    const version = await adapter.version(input.projectDirectory); commands.push(version.command); report.hostVersion = hostVersion(version);
    const active = await d.activateFixture({ outputRoot: input.fixtureOutputRoot, host: input.host, version: "0.0.1" }); const add = await adapter.addMarketplace(active, input.projectDirectory); commands.push(add.command); ownsMarketplace = true;
    const install = await adapter.install(input.projectDirectory); commands.push(install.command); ownsPlugin = true;
    const initialId = `initial-${input.host}`; const initial = await prompt(initialId, "0.0.1", healthPrompt(initialId)); const first = await verifyPhase({ d, host: input.host, target, events: initial.events, nonce: initialId, expectedVersion: "0.0.1", command: initial.command, priorPids: new Set() });
    if (first.digest !== index.runtimeArtifacts["0.0.1"].sha256) eventError(); for (const event of initial.events) pids.add(event.pid);
    report.initial = { healthPassed: true, cleanStopPassed: first.clean, launchedFromHostCache: true, pid: first.started.pid, startupLatencyMs: first.started.observedAtMs - initial.command.startedAtMs, healthLatencyMs: first.health.observedAtMs - first.started.observedAtMs, observedRuntimeBuildId: first.started.runtimeBuildId, observedRuntimeSha256: first.digest };
    await d.activateFixture({ outputRoot: input.fixtureOutputRoot, host: input.host, version: "0.0.2" });
    try { for (const update of await adapter.update(input.projectDirectory)) { commands.push(update.command); if (update.exitCode !== 0) errors.push(`host command failed: ${update.command} (${update.exitCode})`); } } catch (error) { errors.push(commandFailure(error)); }
    const updateId = `updated-${input.host}`; const updated = await prompt(updateId, "0.0.2", healthPrompt(updateId)); const second = await verifyPhase({ d, host: input.host, target, events: updated.events, nonce: updateId, expectedVersion: "0.0.2", command: updated.command, priorPids: pids, priorPath: first.started.executablePath });
    if (second.digest !== index.runtimeArtifacts["0.0.2"].sha256) eventError(); for (const event of updated.events) pids.add(event.pid);
    report.update = { healthPassed: true, cleanStopPassed: second.clean, launchedFromHostCache: true, pid: second.started.pid, observedPluginVersion: second.health.pluginVersion, observedRuntimeBuildId: second.started.runtimeBuildId, observedRuntimeSha256: second.digest };
    const crashId = `crash-${input.host}`;
    try {
      const crash = await prompt(crashId, "0.0.2", crashPrompt(`recovery-${input.host}`), true);
      for (const event of crash.events) pids.add(event.pid); validateJournal(crash.events, input.host, target, "0.0.2");
      const requested = requireEvent(crash.events, "crash-requested"); const starts = crash.events.filter((event) => event.event === "started");
      if (starts.length === 0 || starts[0]!.pid === second.started.pid || requested.pid !== starts[0]!.pid) eventError();
      const restarted = starts[1]; const recovery = crash.events.find((event) => event.event === "health" && event.nonce === `recovery-${input.host}`);
      if ((restarted === undefined) !== (recovery === undefined)) eventError();
      if (restarted !== undefined && recovery !== undefined && (requested.observedAtMs >= restarted.observedAtMs || !sameRuntime(restarted, recovery) || pids.has(restarted.pid) || (await d.sha256File(restarted.executablePath)) !== index.runtimeArtifacts["0.0.2"].sha256)) eventError();
      report.crashRecovery.crashObserved = true; report.crashRecovery.sameSessionRestartObserved = restarted !== undefined;
    } catch (error) { errors.push(error instanceof Error && error.message === "invalid lifecycle journal" ? error.message : commandFailure(error)); }
  } catch (error) { errors.push(error instanceof Error && error.message === "invalid lifecycle journal" ? error.message : commandFailure(error)); }
  // Fresh recovery is intentionally independent of same-session crash behavior.
  if (ownsPlugin) {
    try {
      const freshId = `fresh-${input.host}`; const fresh = await prompt(freshId, "0.0.2", healthPrompt(freshId)); const phase = await verifyPhase({ d, host: input.host, target, events: fresh.events, nonce: freshId, expectedVersion: "0.0.2", command: fresh.command, priorPids: pids });
      if (phase.digest !== index.runtimeArtifacts["0.0.2"].sha256) eventError(); for (const event of fresh.events) pids.add(event.pid);
      report.crashRecovery = { ...report.crashRecovery, freshSessionRecoveryPassed: true, reinstallRequired: false, launchedFromHostCache: true, recoveredPid: phase.started.pid, observedRuntimeBuildId: phase.started.runtimeBuildId, observedRuntimeSha256: phase.digest };
      if (!phase.clean) errors.push("fresh Runtime did not exit cleanly");
    } catch (error) { errors.push(error instanceof Error && error.message === "invalid lifecycle journal" ? error.message : commandFailure(error)); }
  }
  if (ownsPlugin) { try { const command = await adapter.uninstall(input.projectDirectory); commands.push(command.command); report.removal.pluginRemoved = command.exitCode === 0; if (command.exitCode !== 0) errors.push(`host command failed: ${command.command} (${command.exitCode})`); } catch (error) { errors.push(commandFailure(error)); } }
  if (ownsMarketplace) { try { const command = await adapter.removeMarketplace(input.projectDirectory); commands.push(command.command); report.removal.marketplaceRemoved = command.exitCode === 0; if (command.exitCode !== 0) errors.push(`host command failed: ${command.command} (${command.exitCode})`); } catch (error) { errors.push(commandFailure(error)); } }
  report.removal.noLiveRuntime = (await Promise.all([...pids].map((pid) => d.waitForProcessExit(pid, 10_000)))).every(Boolean);
  try { report.removal.hostManagedResiduePaths = await d.findHostManagedResidue(input.host); report.removal.navactOwnedResiduePaths = report.removal.hostManagedResiduePaths.filter((path) => !inside(path, join(homedir(), input.host === "claude-code" ? ".claude" : ".codex", "plugins"))); } catch { errors.push("host residue inspection failed"); }
  return parsePluginLifecycleHostReport(report);
}

function emptyReport(host: LifecycleHost, target: "darwin-arm64" | "win32-x64", index: PluginLifecycleFixtureIndex, commands: string[], errors: string[]): PluginLifecycleHostReport {
  const unknown = "unknown"; const zero = "0".repeat(64);
  return { schemaVersion: 1, runtimeVersion: "0.0.0-spike", host, hostVersion: unknown, platform: target, runtimeArtifacts: index.runtimeArtifacts, pluginVersions: ["0.0.1", "0.0.2"], installUserSteps: 2, updateUserSteps: host === "claude-code" ? 2 : 1, removalUserSteps: 2, manualConfigEdits: 0, administratorPrivilegesRequested: false, separateInstallerUsed: false, hostNodeRequired: false, initial: { healthPassed: false, cleanStopPassed: false, launchedFromHostCache: false, pid: 1, startupLatencyMs: 0, healthLatencyMs: 0, observedRuntimeBuildId: unknown, observedRuntimeSha256: zero }, update: { healthPassed: false, cleanStopPassed: false, launchedFromHostCache: false, pid: 1, observedPluginVersion: unknown, observedRuntimeBuildId: unknown, observedRuntimeSha256: zero }, crashRecovery: { crashObserved: false, sameSessionRestartObserved: false, freshSessionRecoveryPassed: false, reinstallRequired: false, launchedFromHostCache: false, recoveredPid: 1, observedRuntimeBuildId: unknown, observedRuntimeSha256: zero }, removal: { pluginRemoved: false, marketplaceRemoved: false, noLiveRuntime: false, hostManagedResiduePaths: [], navactOwnedResiduePaths: [] }, commands, errors };
}
export async function readRunEvents(path: string, runId: string): Promise<LifecycleEvent[]> { return (await readFile(path, "utf8")).split("\n").filter(Boolean).map(parseLifecycleEventLine).filter((event) => event.runId === runId); }
export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> { const end = Date.now() + timeoutMs; do { try { process.kill(pid, 0); } catch (error: unknown) { const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined; if (code === "ESRCH") return true; } await new Promise((done) => setTimeout(done, 25)); } while (Date.now() < end); return false; }
export async function findHostManagedResidue(host: LifecycleHost): Promise<string[]> { const root = join(homedir(), host === "claude-code" ? ".claude" : ".codex", "plugins"); const result: string[] = []; const visit = async (directory: string): Promise<void> => { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.name.includes("navact-lifecycle-spike")) result.push(path); if (entry.isDirectory()) await visit(path); } }; for (const part of ["cache", "data"]) await visit(join(root, part)); return result; }
export async function sha256File(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
