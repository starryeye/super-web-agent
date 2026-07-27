import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  runKeylessLifecycleCli,
  type RunKeylessLifecycleExecute,
} from "../scripts/run-keyless-lifecycle.js";
import type { KeylessLifecyclePlatformReport } from "../src/keyless-lifecycle-report.js";

const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const temporaryDirectories: string[] = [];

function currentPlatform(): "darwin-arm64" | "win32-x64" {
  const platform = `${process.platform}-${process.arch}`;
  if (platform !== "darwin-arm64" && platform !== "win32-x64") {
    throw new Error(`unsupported test platform: ${platform}`);
  }
  return platform;
}

function successfulReport(): KeylessLifecyclePlatformReport {
  const platform = currentPlatform();
  const artifact =
    platform === "win32-x64"
      ? "super-web-agent-runtime.exe"
      : "super-web-agent-runtime";
  const firstDigest = "a".repeat(64);
  const secondDigest = "b".repeat(64);
  return {
    schemaVersion: 1,
    sourceCommit,
    platform,
    nodeVersion: "v24.14.0",
    pluginName: "super-web-agent-lifecycle-evidence",
    providerDependencies: {
      apiKeysRequired: false,
      providerCliInvoked: false,
      modelInvoked: false,
    },
    artifacts: {
      "0.0.1": {
        artifact,
        sha256: firstDigest,
        bytes: 101,
        buildId: "0.0.1",
      },
      "0.0.2": {
        artifact,
        sha256: secondDigest,
        bytes: 202,
        buildId: "0.0.2",
      },
    },
    launch: {
      runtimeRelativePath: `bin/${artifact}`,
      cwd: ".",
      pathContained: true,
    },
    phases: {
      initial: {
        passed: true,
        observedRuntimeBuildId: "0.0.1",
        observedRuntimeSha256: firstDigest,
        healthNonceMatched: true,
        pidChanged: false,
        runtimeSessionChanged: false,
        cleanStopObserved: false,
      },
      bridgeStatus: {
        passed: true,
        runtime: "ready",
        bridgeState: "not-installed",
      },
      crash: {
        passed: true,
        crashAcknowledged: true,
        finalCloseObserved: true,
        exitCode: 86,
        signal: null,
      },
      recovery: {
        passed: true,
        observedRuntimeBuildId: "0.0.1",
        observedRuntimeSha256: firstDigest,
        healthNonceMatched: true,
        pidChanged: true,
        runtimeSessionChanged: true,
        cleanStopObserved: true,
      },
      update: {
        passed: true,
        observedRuntimeBuildId: "0.0.2",
        observedRuntimeSha256: secondDigest,
        healthNonceMatched: true,
        pidChanged: true,
        runtimeSessionChanged: true,
        cleanStopObserved: true,
      },
      removal: {
        passed: true,
        stagedPluginRemoved: true,
        noLiveRuntime: true,
        swaOwnedResidueCount: 0,
      },
    },
    windowsStaging:
      platform === "win32-x64"
        ? { mode: "powershell-acl", passed: true }
        : { mode: "not-applicable", passed: true },
    errors: [],
  };
}

async function paths(): Promise<{
  directory: string;
  fixtureRoot: string;
  reportPath: string;
  args: [string, string, string];
}> {
  const directory = await mkdtemp(join(tmpdir(), "swa-keyless-cli-"));
  temporaryDirectories.push(directory);
  const fixtureRoot = join(directory, "fixture");
  const reportPath = join(directory, "reports", "report.json");
  return {
    directory,
    fixtureRoot,
    reportPath,
    args: [fixtureRoot, reportPath, sourceCommit],
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

it("does not require or forward provider credentials", async () => {
  const { args, reportPath } = await paths();
  const environment = {
    OPENAI_API_KEY: "must-not-be-read",
    ANTHROPIC_API_KEY: "must-not-be-read",
    PATH: process.env.PATH,
  };
  const execute = vi.fn<RunKeylessLifecycleExecute>().mockResolvedValue(
    successfulReport(),
  );

  const exitCode = await runKeylessLifecycleCli(args, environment, execute);

  expect(exitCode).toBe(0);
  expect(execute).toHaveBeenCalledWith(
    expect.not.objectContaining({
      environment,
    }),
  );
  expect(await readFile(reportPath, "utf8")).not.toContain("must-not-be-read");
});

it.each([
  {
    name: "relative fixture root",
    args: ["relative-fixture", "/absolute/report.json", sourceCommit],
  },
  {
    name: "relative report path",
    args: ["/absolute/fixture", "relative-report.json", sourceCommit],
  },
  {
    name: "malformed commit SHA",
    args: ["/absolute/fixture", "/absolute/report.json", "ABC"],
  },
  {
    name: "extra argument",
    args: [
      "/absolute/fixture",
      "/absolute/report.json",
      sourceCommit,
      "extra",
    ],
  },
])("rejects $name with only the closed usage contract", async ({ args }) => {
  const execute = vi.fn<RunKeylessLifecycleExecute>();
  await expect(
    runKeylessLifecycleCli(args, {}, execute),
  ).rejects.toThrow(
    "usage: run-keyless-lifecycle FIXTURE_ROOT REPORT_JSON SOURCE_COMMIT",
  );
  expect(execute).not.toHaveBeenCalled();
});

it("rejects an existing report symlink before execution", async () => {
  const { args, directory, reportPath } = await paths();
  const target = join(directory, "target.json");
  await writeFile(target, "{}\n", { mode: 0o600 });
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(join(directory, "reports"), { recursive: true, mode: 0o700 }),
  );
  await symlink(target, reportPath);
  const execute = vi.fn<RunKeylessLifecycleExecute>();

  await expect(runKeylessLifecycleCli(args, {}, execute)).rejects.toThrow(
    "unsafe report path",
  );
  expect(execute).not.toHaveBeenCalled();
  expect((await lstat(reportPath)).isSymbolicLink()).toBe(true);
});

it("rejects a user-owned report-directory ancestor symlink", async () => {
  const { directory, fixtureRoot } = await paths();
  const targetDirectory = join(directory, "target");
  const linkedDirectory = join(directory, "linked-reports");
  const reportPath = join(linkedDirectory, "report.json");
  await mkdir(targetDirectory, { mode: 0o700 });
  await symlink(targetDirectory, linkedDirectory);
  const execute = vi.fn<RunKeylessLifecycleExecute>();

  await expect(
    runKeylessLifecycleCli(
      [fixtureRoot, reportPath, sourceCommit],
      {},
      execute,
    ),
  ).rejects.toThrow("unsafe report directory");
  expect(execute).not.toHaveBeenCalled();
});

it("rejects an unsafe existing POSIX report directory", async () => {
  if (process.platform === "win32") return;
  const { args, directory } = await paths();
  const reportDirectory = join(directory, "reports");
  await mkdir(reportDirectory, { mode: 0o755 });
  await chmod(reportDirectory, 0o755);
  const execute = vi.fn<RunKeylessLifecycleExecute>();

  await expect(runKeylessLifecycleCli(args, {}, execute)).rejects.toThrow(
    "report directory must be protected",
  );
  expect(execute).not.toHaveBeenCalled();
});

it("rejects a report directory swapped to a symlink during execution", async () => {
  const { args, directory, reportPath } = await paths();
  const reportDirectory = join(directory, "reports");
  const originalDirectory = join(directory, "reports-original");
  const replacementDirectory = join(directory, "replacement");
  await Promise.all([
    mkdir(reportDirectory, { mode: 0o700 }),
    mkdir(replacementDirectory, { mode: 0o700 }),
  ]);
  const execute = vi.fn<RunKeylessLifecycleExecute>().mockImplementation(
    async () => {
      await rename(reportDirectory, originalDirectory);
      await symlink(replacementDirectory, reportDirectory);
      return successfulReport();
    },
  );

  await expect(runKeylessLifecycleCli(args, {}, execute)).rejects.toThrow(
    "unsafe report directory",
  );
  expect(execute).toHaveBeenCalledOnce();
  await expect(lstat(reportPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    lstat(join(replacementDirectory, "report.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects an existing non-private POSIX report before execution", async () => {
  if (process.platform === "win32") return;
  const { args, directory, reportPath } = await paths();
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(join(directory, "reports"), { recursive: true, mode: 0o700 }),
  );
  await writeFile(reportPath, "{}\n", { mode: 0o644 });
  await chmod(reportPath, 0o644);
  const execute = vi.fn<RunKeylessLifecycleExecute>();

  await expect(runKeylessLifecycleCli(args, {}, execute)).rejects.toThrow(
    "report permissions must be 0600",
  );
  expect(execute).not.toHaveBeenCalled();
});

it("atomically writes a private POSIX report and returns the platform gate", async () => {
  const { args, reportPath } = await paths();
  const rejected = successfulReport();
  rejected.phases.initial.passed = false;
  rejected.errors = [{ code: "mcp-call-invalid", phase: "initial" }];
  const execute = vi.fn<RunKeylessLifecycleExecute>().mockResolvedValue(rejected);

  await expect(runKeylessLifecycleCli(args, {}, execute)).resolves.toBe(1);
  expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(rejected);
  if (process.platform !== "win32") {
    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(reportPath, ".."))).mode & 0o777).toBe(0o700);
  }
  const entries = await import("node:fs/promises").then(({ readdir }) =>
    readdir(join(reportPath, "..")),
  );
  expect(entries).toEqual(["report.json"]);
});
