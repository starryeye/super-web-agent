import {
  lstat,
  mkdir,
  open,
  readlink,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
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
  readonly canonicalDirectory: string;
  readonly canonicalPath: string;
  readonly directoryDevice: number;
  readonly directoryInode: number;
  readonly directoryHandle: FileHandle | undefined;
}

export interface ReportSystemSymlinkPolicyInput {
  readonly currentUid: number;
  readonly symlinkUid: number;
  readonly parentUid: number;
  readonly parentMode: number;
}

export function isTrustedReportSystemSymlink({
  currentUid,
  symlinkUid,
  parentUid,
  parentMode,
}: ReportSystemSymlinkPolicyInput): boolean {
  return (
    currentUid !== 0 &&
    symlinkUid === 0 &&
    symlinkUid !== currentUid &&
    parentUid === 0 &&
    (parentMode & 0o022) === 0
  );
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

function pathComponents(path: string): string[] {
  const root = parse(path).root;
  return relative(root, path)
    .split(sep)
    .filter((component) => component.length > 0);
}

async function canonicalizeReportDirectory(directory: string): Promise<string> {
  const requested = resolve(directory);
  let current = parse(requested).root;
  let remaining = pathComponents(requested);
  let followedSymlinks = 0;
  const uid =
    process.platform === "win32" || process.getuid === undefined
      ? undefined
      : process.getuid();

  while (remaining.length > 0) {
    const [component, ...rest] = remaining;
    if (component === undefined) break;
    const candidate = join(current, component);
    let entry;
    try {
      entry = await lstat(candidate);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      return join(candidate, ...rest);
    }
    if (entry.isSymbolicLink()) {
      if (uid === undefined || followedSymlinks >= 40) {
        throw new Error("unsafe report directory");
      }
      const parent = await lstat(current);
      if (
        !parent.isDirectory() ||
        !isTrustedReportSystemSymlink({
          currentUid: uid,
          symlinkUid: entry.uid,
          parentUid: parent.uid,
          parentMode: parent.mode,
        })
      ) {
        throw new Error("unsafe report directory");
      }
      const target = resolve(current, await readlink(candidate));
      current = parse(target).root;
      remaining = [...pathComponents(target), ...rest];
      followedSymlinks += 1;
      continue;
    }
    if (!entry.isDirectory()) {
      throw new Error("unsafe report directory");
    }
    current = candidate;
    remaining = rest;
  }
  return current;
}

async function validateCanonicalReportChain(
  directory: string,
  directMustExist: boolean,
): Promise<void> {
  const uid =
    process.platform === "win32" || process.getuid === undefined
      ? undefined
      : process.getuid();
  let current = resolve(directory);
  let isDirect = true;
  let protectedUserDirectoryObserved = false;
  while (true) {
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error("unsafe report directory");
      }
      if (uid !== undefined) {
        if (entry.uid !== 0 && entry.uid !== uid) {
          throw new Error("unsafe report directory");
        }
        const mode = entry.mode & 0o7777;
        const isProtectedUserDirectory =
          entry.uid === uid && (mode & 0o777) === 0o700;
        if (isDirect && directMustExist && !isProtectedUserDirectory) {
          throw new Error("report directory must be protected");
        }
        if (
          (mode & 0o022) !== 0 &&
          !(
            entry.uid === 0 &&
            (mode & 0o1000) !== 0 &&
            protectedUserDirectoryObserved
          )
        ) {
          throw new Error("unsafe report directory");
        }
        protectedUserDirectoryObserved ||= isProtectedUserDirectory;
      }
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      if (isDirect && directMustExist) {
        throw new Error("unsafe report directory");
      }
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
    isDirect = false;
  }
}

async function prepareProtectedReportTarget(
  requestedPath: string,
): Promise<ProtectedReportTarget> {
  const canonicalDirectory = await canonicalizeReportDirectory(
    dirname(requestedPath),
  );
  await validateCanonicalReportChain(canonicalDirectory, false);
  if (process.platform === "win32") {
    try {
      const directoryStat = await lstat(canonicalDirectory);
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
    await mkdir(canonicalDirectory, { recursive: true, mode: 0o700 });
  }
  await validateCanonicalReportChain(canonicalDirectory, true);
  const directoryStat = await lstat(canonicalDirectory);
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
  let directoryHandle: FileHandle | undefined;
  try {
    if (process.platform !== "win32") {
      directoryHandle = await open(
        canonicalDirectory,
        fsConstants.O_RDONLY |
          fsConstants.O_NOFOLLOW |
          fsConstants.O_DIRECTORY,
      );
    }
    const pinnedStat =
      directoryHandle === undefined
        ? directoryStat
        : await directoryHandle.stat();
    if (
      !pinnedStat.isDirectory() ||
      pinnedStat.dev !== directoryStat.dev ||
      pinnedStat.ino !== directoryStat.ino
    ) {
      throw new Error("unsafe report directory");
    }
    return {
      canonicalDirectory,
      canonicalPath: join(canonicalDirectory, basename(requestedPath)),
      directoryDevice: pinnedStat.dev,
      directoryInode: pinnedStat.ino,
      directoryHandle,
    };
  } catch (error) {
    await directoryHandle?.close().catch(() => undefined);
    throw error;
  }
}

async function requirePinnedReportDirectory(
  target: ProtectedReportTarget,
): Promise<void> {
  await validateCanonicalReportChain(target.canonicalDirectory, true);
  const pathnameStat = await lstat(target.canonicalDirectory);
  const pinnedStat =
    target.directoryHandle === undefined
      ? pathnameStat
      : await target.directoryHandle.stat();
  if (
    !pathnameStat.isDirectory() ||
    pathnameStat.isSymbolicLink() ||
    !pinnedStat.isDirectory() ||
    pathnameStat.dev !== target.directoryDevice ||
    pathnameStat.ino !== target.directoryInode ||
    pinnedStat.dev !== target.directoryDevice ||
    pinnedStat.ino !== target.directoryInode
  ) {
    throw new Error("unsafe report directory");
  }
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
    // Node has no renameat. The canonical 0700 directory and its validated
    // chain prevent untrusted-account replacement; the retained directory
    // handle detects pathname replacement immediately around this rename.
    await requirePinnedReportDirectory(target);
    await rename(temporaryPath, target.canonicalPath);
    await requirePinnedReportDirectory(target);
    await validateExistingReport(target.canonicalPath);
  } finally {
    await handle.close().catch(() => undefined);
    await requirePinnedReportDirectory(target)
      .then(() => rm(temporaryPath, { force: true }))
      .catch(() => undefined);
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
  try {
    await validateExistingReport(target.canonicalPath);
    const report = parseKeylessLifecyclePlatformReport(
      await execute({ fixtureRoot, sourceCommit }),
    );
    if (report.sourceCommit !== sourceCommit) {
      throw new Error("lifecycle report source commit mismatch");
    }
    await requirePinnedReportDirectory(target);
    await validateExistingReport(target.canonicalPath);
    await writePrivateReport(target, report);
    process.stdout.write(`${reportPath}\n`);
    return evaluateKeylessLifecyclePlatformReport(report).state === "accepted"
      ? 0
      : 1;
  } finally {
    await target.directoryHandle?.close().catch(() => undefined);
  }
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
