import { chmod, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, dirname, extname } from "node:path";
import { evaluatePluginLifecycleHostReport } from "../src/plugin-lifecycle-report.js";
import { runPluginLifecycle } from "../src/plugin-lifecycle-harness.js";
import type { HostCliLaunch } from "../src/plugin-host-adapters.js";

function requireAbsolute(value: string): string { const result = resolve(process.cwd(), value); if (!isAbsolute(result)) throw new Error("invalid lifecycle arguments"); return result; }
function launch(host: "claude-code" | "codex", cliPath: string): HostCliLaunch { const displayName = host === "claude-code" ? "claude" : "codex"; return [".js", ".cjs", ".mjs"].includes(extname(cliPath)) ? { displayName, executable: process.execPath, prefixArgs: [cliPath] } : { displayName, executable: cliPath, prefixArgs: [] }; }
async function main(): Promise<void> {
  const [hostArgument, cliArgument, fixtureArgument, reportArgument, projectArgument, ...extra] = process.argv.slice(2);
  if ((hostArgument !== "claude-code" && hostArgument !== "codex") || cliArgument === undefined || fixtureArgument === undefined || reportArgument === undefined || projectArgument === undefined || extra.length !== 0) throw new Error("invalid lifecycle arguments");
  const host = hostArgument; const cliPath = requireAbsolute(cliArgument); const fixtureOutputRoot = requireAbsolute(fixtureArgument); const reportPath = requireAbsolute(reportArgument); const projectDirectory = requireAbsolute(projectArgument); const evidenceDirectory = resolve(dirname(reportPath), "evidence");
  if ((host === "claude-code" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) === undefined) throw new Error("matching API key is required");
  const report = await runPluginLifecycle({ host, cliLaunch: launch(host, cliPath), fixtureOutputRoot, projectDirectory, evidenceDirectory, environment: process.env });
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); await chmod(reportPath, 0o600);
  if (evaluatePluginLifecycleHostReport(report).gate !== "pass") process.exitCode = 1;
}
main().catch(() => { process.stderr.write("plugin lifecycle run failed\n"); process.exitCode = 1; });
