import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { LifecycleHost } from "./lifecycle-events.js";

export interface CommandObservation { command: string; exitCode: number; stdout: string; stderr: string; startedAtMs: number; durationMs: number; }
export interface RunCommandInput { executable: string; prefixArgs?: string[]; args: string[]; displayName: "claude" | "codex"; cwd: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean; }
export type RunCommand = (input: RunCommandInput) => Promise<CommandObservation>;
export interface HostCliLaunch { displayName: "claude" | "codex"; executable: string; prefixArgs: string[]; }

export const runCommand: RunCommand = (input) => new Promise((resolvePromise, reject) => {
  const startedAtMs = Date.now(); const startedAt = performance.now();
  execFile(input.executable, [...(input.prefixArgs ?? []), ...input.args], { cwd: input.cwd, env: input.env, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
    const observation = { command: [input.displayName, ...input.args].join(" "), exitCode, stdout, stderr, startedAtMs, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 };
    if (exitCode !== 0 && !input.allowFailure) reject(Object.assign(error ?? new Error("host command failed"), { observation }));
    else resolvePromise(observation);
  });
});

export interface PluginHostAdapter {
  host: LifecycleHost; marketplaceName: string; selector: string;
  version(cwd: string): Promise<CommandObservation>; addMarketplace(root: string, cwd: string): Promise<CommandObservation>;
  install(cwd: string): Promise<CommandObservation>; update(cwd: string): Promise<CommandObservation[]>;
  runPrompt(prompt: string, cwd: string, env: NodeJS.ProcessEnv, allowFailure?: boolean): Promise<CommandObservation>;
  uninstall(cwd: string): Promise<CommandObservation>; removeMarketplace(cwd: string): Promise<CommandObservation>;
}

export function healthPrompt(nonce: string): string { return `Use only the Super Web Agent lifecycle plugin. Call swa_spike_health exactly once with nonce "${nonce}". Do not run shell commands, edit files, or call any other tool. Return only the tool's structured JSON.`; }
export function crashPrompt(recoveryNonce: string): string { return `Use only the Super Web Agent lifecycle plugin. Call swa_spike_crash exactly once. If the MCP server reconnects in this same session, call swa_spike_health exactly once with nonce "${recoveryNonce}". Do not run shell commands, edit files, or call any other tool.`; }

export function createPluginHostAdapter(host: LifecycleHost, cliLaunch: HostCliLaunch, runner: RunCommand = runCommand): PluginHostAdapter {
  const call = (args: string[], cwd: string, env?: NodeJS.ProcessEnv, allowFailure?: boolean) => runner({ executable: cliLaunch.executable, prefixArgs: cliLaunch.prefixArgs, args, displayName: cliLaunch.displayName, cwd, ...(env === undefined ? {} : { env }), ...(allowFailure === undefined ? {} : { allowFailure }) });
  const claude = host === "claude-code";
  const marketplaceName = claude ? "super-web-agent-lifecycle-spike-claude" : "super-web-agent-lifecycle-spike-codex";
  const selector = `super-web-agent-lifecycle-spike@${marketplaceName}`;
  return {
    host, marketplaceName, selector,
    version: (cwd) => call(["--version"], cwd),
    addMarketplace: (root, cwd) => call(claude ? ["plugin", "marketplace", "add", root] : ["plugin", "marketplace", "add", root, "--json"], cwd),
    install: (cwd) => call(claude ? ["plugin", "install", selector, "--scope", "user"] : ["plugin", "add", selector, "--json"], cwd),
    update: async (cwd) => {
      if (!claude) return [await call(["plugin", "add", selector, "--json"], cwd)];
      const observations = [await call(["plugin", "marketplace", "update", marketplaceName], cwd)];
      try { observations.push(await call(["plugin", "update", selector, "--scope", "user"], cwd)); }
      catch (error) { throw Object.assign(error instanceof Error ? error : new Error("host command failed"), { partialObservations: observations }); }
      return observations;
    },
    runPrompt: (prompt, cwd, env, allowFailure) => call(claude ? ["-p", prompt, "--output-format", "json", "--permission-mode", "dontAsk"] : ["exec", "--ephemeral", "--sandbox", "read-only", "-c", 'approval_policy="never"', "--json", prompt], cwd, env, allowFailure),
    uninstall: (cwd) => call(claude ? ["plugin", "uninstall", selector, "--scope", "user"] : ["plugin", "remove", selector, "--json"], cwd),
    removeMarketplace: (cwd) => call(claude ? ["plugin", "marketplace", "remove", marketplaceName] : ["plugin", "marketplace", "remove", marketplaceName, "--json"], cwd),
  };
}

export async function resolveNpmPackageBin(input: { prefix: string; packageName: "@anthropic-ai/claude-code" | "@openai/codex"; binName: "claude" | "codex"; }): Promise<string> {
  if (!isAbsolute(input.prefix)) throw new Error("prefix must be absolute");
  const root = resolve(input.prefix, "node_modules", input.packageName);
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[input.binName];
  if (typeof bin !== "string") throw new Error("missing package bin");
  const target = resolve(root, bin); const relation = relative(root, target);
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) throw new Error("package bin escapes package root");
  if (!(await stat(target)).isFile()) throw new Error("package bin is not a regular file");
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  const realRelation = relative(realRoot, realTarget);
  if (realRelation === "" || realRelation.startsWith("..") || isAbsolute(realRelation)) throw new Error("package bin escapes package root");
  return realTarget;
}
