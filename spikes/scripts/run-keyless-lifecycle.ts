import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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

interface ProtectedReportTarget {
  readonly requestedPath: string;
  readonly canonicalDirectory: string;
  readonly canonicalPath: string;
  readonly directoryDevice: number;
  readonly directoryInode: number;
}

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
  if (
    process.platform !== "win32" &&
    process.getuid !== undefined &&
    reportStat.uid !== process.getuid()
  ) {
    throw new Error("unsafe report path");
  }
  if (process.platform !== "win32" && (reportStat.mode & 0o777) !== 0o600) {
    throw new Error("report permissions must be 0600");
  }
}

async function validateReportAncestorChain(directory: string): Promise<void> {
  const uid =
    process.platform === "win32" || process.getuid === undefined
      ? undefined
      : process.getuid();
  let current = resolve(directory);
  while (true) {
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        if (uid === undefined || entry.uid === uid) {
          throw new Error("unsafe report directory");
        }
        return;
      }
      if (!entry.isDirectory()) {
        throw new Error("unsafe report directory");
      }
      if (uid !== undefined) {
        if (entry.uid !== uid) return;
        if ((entry.mode & 0o022) !== 0) {
          throw new Error("unsafe report directory");
        }
      }
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function prepareProtectedReportTarget(
  requestedPath: string,
): Promise<ProtectedReportTarget> {
  const requestedDirectory = dirname(requestedPath);
  await validateReportAncestorChain(requestedDirectory);
  if (process.platform === "win32") {
    try {
      const directoryStat = await lstat(requestedDirectory);
      if (
        directoryStat.isSymbolicLink() ||
        !directoryStat.isDirectory()
      ) {
        throw new Error("unsafe report directory");
      }
    } catch (error) {
      if (isMissingPath(error)) {
        throw new Error("report directory must be protected");
      }
      throw error;
    }
  } else {
    await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
  }
  await validateReportAncestorChain(requestedDirectory);
  const directoryStat = await lstat(requestedDirectory);
  if (
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory()
  ) {
    throw new Error("unsafe report directory");
  }
  if (
    process.platform !== "win32" &&
    (process.getuid === undefined ||
      directoryStat.uid !== process.getuid() ||
      (directoryStat.mode & 0o777) !== 0o700)
  ) {
    throw new Error("report directory must be protected");
  }
  const canonicalDirectory = await realpath(requestedDirectory);
  const canonicalStat = await lstat(canonicalDirectory);
  if (
    canonicalStat.isSymbolicLink() ||
    !canonicalStat.isDirectory() ||
    canonicalStat.dev !== directoryStat.dev ||
    canonicalStat.ino !== directoryStat.ino
  ) {
    throw new Error("unsafe report directory");
  }
  return {
    requestedPath,
    canonicalDirectory,
    canonicalPath: join(canonicalDirectory, basename(requestedPath)),
    directoryDevice: canonicalStat.dev,
    directoryInode: canonicalStat.ino,
  };
}

async function requireSameReportDirectory(
  prior: ProtectedReportTarget,
): Promise<ProtectedReportTarget> {
  const current = await prepareProtectedReportTarget(prior.requestedPath);
  if (
    current.canonicalDirectory !== prior.canonicalDirectory ||
    current.directoryDevice !== prior.directoryDevice ||
    current.directoryInode !== prior.directoryInode
  ) {
    throw new Error("unsafe report directory");
  }
  return current;
}

async function writePrivateReport(
  target: ProtectedReportTarget,
  report: KeylessLifecyclePlatformReport,
): Promise<void> {
  await validateExistingReport(target.canonicalPath);
  const temporaryPath = join(
    target.canonicalDirectory,
    `${basename(target.canonicalPath)}.tmp-${randomBytes(16).toString("hex")}`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    await requireSameReportDirectory(target);
    await rename(temporaryPath, target.canonicalPath);
    await requireSameReportDirectory(target);
    await validateExistingReport(target.canonicalPath);
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
  const target = await prepareProtectedReportTarget(reportPath);
  await validateExistingReport(target.canonicalPath);
  const report = parseKeylessLifecyclePlatformReport(
    await execute({ fixtureRoot, sourceCommit }),
  );
  if (report.sourceCommit !== sourceCommit) {
    throw new Error("lifecycle report source commit mismatch");
  }
  const stableTarget = await requireSameReportDirectory(target);
  await validateExistingReport(stableTarget.canonicalPath);
  await writePrivateReport(stableTarget, report);
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
