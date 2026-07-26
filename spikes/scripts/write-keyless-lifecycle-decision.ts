import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  evaluateKeylessLifecycleEvidence,
  renderKeylessLifecycleDecision,
} from "../src/keyless-lifecycle-decision.js";

async function readNamedReport(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const [outputPath, macPath, windowsPath, ...extra] = process.argv.slice(2);
  if (outputPath === undefined || macPath === undefined || windowsPath === undefined || extra.length !== 0) {
    process.stderr.write("usage: write-keyless-lifecycle-decision OUTPUT_MD MAC_JSON WINDOWS_JSON\n");
    process.exitCode = 1;
    return;
  }
  const reports = await Promise.all([readNamedReport(macPath), readNamedReport(windowsPath)]);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderKeylessLifecycleDecision(reports));
  process.stdout.write(`${outputPath}\n`);
  if (evaluateKeylessLifecycleEvidence(reports).state !== "accepted") process.exitCode = 1;
}

void main();
