import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isAbsolute, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runKeylessLifecycle,
  type RunKeylessLifecycleInput,
} from "../src/keyless-lifecycle-harness.js";
import {
  evaluateKeylessLifecyclePlatformReport,
  parseKeylessLifecyclePlatformReport,
  type KeylessLifecyclePlatformReport,
} from "../src/keyless-lifecycle-report.js";

const usage =
  "usage: run-keyless-lifecycle FIXTURE_ROOT REPORT_JSON SOURCE_COMMIT";

export type RunKeylessLifecycleExecute = (
  input: RunKeylessLifecycleInput,
) => Promise<KeylessLifecyclePlatformReport>;

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function parseArguments(args: readonly string[]): {
  fixtureRoot: string;
  reportPath: string;
  sourceCommit: string;
} {
  const [fixtureRoot, reportPath, sourceCommit] = args;
  if (
    args.length !== 3 ||
    fixtureRoot === undefined ||
    reportPath === undefined ||
    sourceCommit === undefined ||
    !isAbsolute(fixtureRoot) ||
    !isAbsolute(reportPath) ||
    !/^[0-9a-f]{40}$/.test(sourceCommit)
  ) {
    throw new Error(usage);
  }
  return {
    fixtureRoot: resolve(fixtureRoot),
    reportPath: resolve(reportPath),
    sourceCommit,
  };
}

async function validateExistingReport(path: string): Promise<void> {
  let reportStat;
  try {
    reportStat = await lstat(path);
  } catch (error) {
    if (isMissingPath(error)) return;
    throw new Error("unsafe report path");
  }
  if (reportStat.isSymbolicLink() || !reportStat.isFile()) {
    throw new Error("unsafe report path");
  }
  if (process.platform !== "win32" && (reportStat.mode & 0o777) !== 0o600) {
    throw new Error("report permissions must be 0600");
  }
}

async function writePrivateReport(
  path: string,
  report: KeylessLifecyclePlatformReport,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await validateExistingReport(path);
  const temporaryPath = `${path}.tmp-${randomBytes(16).toString("hex")}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function runKeylessLifecycleCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  execute: RunKeylessLifecycleExecute = runKeylessLifecycle,
): Promise<number> {
  void environment;
  const { fixtureRoot, reportPath, sourceCommit } = parseArguments(args);
  await validateExistingReport(reportPath);
  const report = parseKeylessLifecyclePlatformReport(
    await execute({ fixtureRoot, sourceCommit }),
  );
  if (report.sourceCommit !== sourceCommit) {
    throw new Error("lifecycle report source commit mismatch");
  }
  await writePrivateReport(reportPath, report);
  process.stdout.write(`${reportPath}\n`);
  return evaluateKeylessLifecyclePlatformReport(report).state === "accepted"
    ? 0
    : 1;
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runKeylessLifecycleCli(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      const message =
        error instanceof Error && error.message === usage
          ? usage
          : "run-keyless-lifecycle failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}
