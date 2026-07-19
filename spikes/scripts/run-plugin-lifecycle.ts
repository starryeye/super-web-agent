import { chmod, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, dirname, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluatePluginLifecycleHostReport, type PluginLifecycleHostReport } from "../src/plugin-lifecycle-report.js";
import { runPluginLifecycle } from "../src/plugin-lifecycle-harness.js";
import type { HostCliLaunch } from "../src/plugin-host-adapters.js";

function requireAbsolute(value: string): string { if (!isAbsolute(value)) throw new Error("invalid lifecycle arguments"); return resolve(value); }
export function hostCliLaunch(host: "claude-code" | "codex", cliPath: string): HostCliLaunch { const displayName = host === "claude-code" ? "claude" : "codex"; return [".js", ".cjs", ".mjs"].includes(extname(cliPath)) ? { displayName, executable: process.execPath, prefixArgs: [cliPath] } : { displayName, executable: cliPath, prefixArgs: [] }; }
export async function runPluginLifecycleCli(args: string[], environment: NodeJS.ProcessEnv = process.env, execute = runPluginLifecycle): Promise<number> {
  const [hostArgument, cliArgument, fixtureArgument, reportArgument, projectArgument, ...extra] = args;
  if ((hostArgument !== "claude-code" && hostArgument !== "codex") || cliArgument === undefined || fixtureArgument === undefined || reportArgument === undefined || projectArgument === undefined || extra.length !== 0) throw new Error("invalid lifecycle arguments");
  const host = hostArgument; const cliPath = requireAbsolute(cliArgument); const fixtureOutputRoot = requireAbsolute(fixtureArgument); const reportPath = requireAbsolute(reportArgument); const projectDirectory = requireAbsolute(projectArgument); const evidenceDirectory = resolve(dirname(reportPath), "evidence");
  if ((host === "claude-code" ? environment.ANTHROPIC_API_KEY : environment.OPENAI_API_KEY) === undefined) throw new Error("matching API key is required");
  const report = await execute({ host, cliLaunch: hostCliLaunch(host, cliPath), fixtureOutputRoot, projectDirectory, evidenceDirectory, environment });
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); await chmod(reportPath, 0o600);
  return evaluatePluginLifecycleHostReport(report).gate === "pass" ? 0 : 1;
}
async function main(): Promise<void> { try { process.exitCode = await runPluginLifecycleCli(process.argv.slice(2)); } catch { process.stderr.write("plugin lifecycle run failed\n"); process.exitCode = 1; } }
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
