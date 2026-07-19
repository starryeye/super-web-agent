import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  evaluatePluginLifecycleEvidence,
  renderPluginLifecycleDecision,
} from "../src/plugin-lifecycle-decision.js";
import { parsePluginLifecycleHostReport, type PluginLifecycleHostReport } from "../src/plugin-lifecycle-report.js";

async function readExistingReport(path: string): Promise<PluginLifecycleHostReport | undefined> {
  try {
    return parsePluginLifecycleHostReport(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function main(): Promise<void> {
  const [outputPath, ...paths] = process.argv.slice(2);
  if (outputPath === undefined || paths.length !== 4) {
    throw new Error("usage: write-plugin-lifecycle-decision OUTPUT_MD CLAUDE_MAC_JSON CLAUDE_WINDOWS_JSON CODEX_MAC_JSON CODEX_WINDOWS_JSON");
  }
  const reports = (await Promise.all(paths.map(readExistingReport))).filter(
    (report): report is PluginLifecycleHostReport => report !== undefined,
  );
  const decision = evaluatePluginLifecycleEvidence(reports);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderPluginLifecycleDecision(reports));
  process.stdout.write(`${outputPath}\n`);
  if (decision.state === "fail") process.exitCode = 1;
  if (decision.state === "incomplete") process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
