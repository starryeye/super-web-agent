import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  evaluateArtifactEvidence,
  parsePackagingPlatformReport,
  renderArtifactDecision,
} from "../src/artifact-decision.js";
import type { PackagingPlatformReport } from "../src/packaging-report.js";

async function readExistingReport(path: string): Promise<PackagingPlatformReport | undefined> {
  try {
    return parsePackagingPlatformReport(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function main(): Promise<void> {
  const [outputPath, ...reportPaths] = process.argv.slice(2);
  if (outputPath === undefined || reportPaths.length !== 2) {
    throw new Error("usage: write-artifact-decision OUTPUT_MD DARWIN_REPORT_JSON WINDOWS_REPORT_JSON");
  }
  const reports = (await Promise.all(reportPaths.map(readExistingReport))).filter(
    (report): report is PackagingPlatformReport => report !== undefined,
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderArtifactDecision(reports));
  console.log(outputPath);
  const state = evaluateArtifactEvidence(reports).state;
  if (state === "fail") process.exitCode = 1;
  if (state === "incomplete") process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
