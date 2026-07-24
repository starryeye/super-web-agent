import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  canonicalManifestPayload,
  verifyRuntimeArtifact,
  type RuntimeManifest,
} from "../src/runtime-manifest.js";
import {
  parseWindowsAclSnapshot,
  RuntimeSupervisor,
  stageRuntimeArtifact,
  validateWindowsAclSnapshot,
  validateHealthResult,
  type RuntimeLaunchSpec,
} from "../src/runtime-supervisor.js";
import {
  RuntimeStdioTransport,
  RuntimeTerminationUnobservedError,
  type RuntimeShutdownDeadlines,
} from "../src/runtime-stdio-transport.js";

const temporaryDirectories: string[] = [];

function isRuntimeStagingDirectory(name: string): boolean {
  return /^navact-runtime-(?:[A-Za-z0-9]{6}|[a-f0-9]{64})$/.test(name);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function signedArtifact(artifactPath: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const unsigned = {
    runtimeVersion: "0.0.0-spike",
    coreProtocolRange: "1.0",
    bridgeProtocolRange: "1.0",
    platform: `${process.platform}-${process.arch}`,
    artifact: basename(artifactPath),
    sha256: createHash("sha256").update(await readFile(artifactPath)).digest("hex"),
  };
  return {
    artifactPath,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    manifest: {
      ...unsigned,
      signature: sign(null, Buffer.from(canonicalManifestPayload(unsigned)), privateKey).toString("base64url"),
    } satisfies RuntimeManifest,
  };
}

async function healthArtifact(stubborn = false): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), stubborn ? "navact-stubborn-runtime-" : "navact-runtime-"));
  temporaryDirectories.push(directory);
  const artifactPath = join(directory, stubborn ? "stubborn-health.mjs" : "mcp-health-entry.mjs");
  const healthServerUrl = pathToFileURL(resolve("dist/src/mcp-health-server.js")).href;
  await writeFile(
    artifactPath,
    [
      `import { startHealthServer } from ${JSON.stringify(healthServerUrl)};`,
      ...(stubborn
        ? [
            'if (process.platform !== "win32") process.on("SIGTERM", () => undefined);',
            "setInterval(() => undefined, 1_000);",
          ]
        : []),
      "await startHealthServer();",
      "",
    ].join("\n"),
  );
  return artifactPath;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not observed before timeout");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

function transportWithDeadlines(
  server: ConstructorParameters<typeof RuntimeStdioTransport>[0],
  shutdownDeadlines: RuntimeShutdownDeadlines,
): RuntimeStdioTransport {
  return new RuntimeStdioTransport(server, { shutdownDeadlines });
}

async function delayedCleanExitArtifact(delayMs: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "navact-delayed-exit-"));
  temporaryDirectories.push(directory);
  const entryPath = join(directory, "delayed-clean-exit.mjs");
  await writeFile(entryPath, `process.stdin.resume(); setTimeout(() => process.exit(0), ${String(delayMs)});\n`);
  return entryPath;
}

const shortShutdownDeadlines = {
  gracefulExitTimeoutMs: 100,
  signalExitTimeoutMs: 100,
  forcedExitTimeoutMs: 200,
} satisfies RuntimeShutdownDeadlines;

const lateCleanExitDeadlines = {
  ...shortShutdownDeadlines,
  forcedExitTimeoutMs: 1_000,
} satisfies RuntimeShutdownDeadlines;

it("rejects a code-zero exit that misses the graceful deadline even when kill returns false", async () => {
  const entryPath = await delayedCleanExitArtifact(300);
  const killSpy = vi.spyOn(ChildProcess.prototype, "kill").mockReturnValue(false);
  const transport = transportWithDeadlines(
    { command: process.execPath, args: [entryPath], stderr: "pipe" },
    lateCleanExitDeadlines,
  );

  try {
    await transport.start();
    await expect(transport.close()).rejects.toThrow("Runtime did not exit cleanly");
    expect(killSpy).toHaveBeenCalled();
    expect(transport.exitObservation).toMatchObject({ code: 0, signal: null });
  } finally {
    killSpy.mockRestore();
  }
});

it("retries an unobserved close and reaps a later final close without accepting it as clean", async () => {
  const entryPath = await delayedCleanExitArtifact(600);
  const killSpy = vi.spyOn(ChildProcess.prototype, "kill").mockReturnValue(false);
  const transport = transportWithDeadlines(
    { command: process.execPath, args: [entryPath], stderr: "pipe" },
    shortShutdownDeadlines,
  );

  try {
    await transport.start();
    await expect(transport.close()).rejects.toBeInstanceOf(RuntimeTerminationUnobservedError);
    expect(transport.finalCloseObserved).toBe(false);
    await expect(transport.close()).rejects.toThrow("Runtime did not exit cleanly");
    expect(transport.finalCloseObserved).toBe(true);
    expect(transport.pid).toBeNull();
  } finally {
    killSpy.mockRestore();
  }
});

it("releases staging after a synchronous pre-child spawn failure", async () => {
  const serverPath = await healthArtifact();
  const fixture = await signedArtifact(serverPath);
  const baseline = new Set((await readdir(tmpdir())).filter(isRuntimeStagingDirectory));
  const foreignDirectory = await mkdtemp(join(tmpdir(), "navact-runtime-build-id-"));
  temporaryDirectories.push(foreignDirectory);
  const supervisor = new RuntimeSupervisor({
    ...fixture,
    launch: { kind: "host-node", artifactPath: serverPath, cwd: "invalid\0cwd" },
  });

  let startError: unknown;
  let stopError: unknown;
  try {
    await supervisor.start("nonce-spawn-failure");
  } catch (error) {
    startError = error;
  }
  try {
    await supervisor.stop();
  } catch (error) {
    stopError = error;
  }
  const afterStop = (await readdir(tmpdir())).filter(isRuntimeStagingDirectory);
  const leaked = afterStop.filter((name) => !baseline.has(name));
  temporaryDirectories.push(...leaked.map((name) => join(tmpdir(), name)));

  expect(startError).toBeInstanceOf(TypeError);
  expect(String(startError)).toMatch(/null bytes|NUL|invalid/i);
  expect(stopError).toBeUndefined();
  expect(supervisor.state).toBe("idle");
  expect(await readdir(tmpdir())).toContain(basename(foreignDirectory));
  expect(leaked).toEqual([]);
});

it("accepts only a protected current-SID Windows ACL snapshot", async () => {
  const sid = "S-1-5-21-1000-1001-1002-1003";
  const rule = {
    identitySid: sid,
    accessControlType: 0,
    fileSystemRights: 2_032_127,
    inheritanceFlags: 3,
    propagationFlags: 0,
    isInherited: false,
  };
  const validSnapshot = {
    areAccessRulesProtected: true,
    ownerSid: sid,
    accessRules: [rule],
  };

  expect(
    parseWindowsAclSnapshot(
      [
        "protected\t1",
        `owner\t${sid}`,
        `rule\t${sid}\t0\t2032127\t3\t0\t0`,
      ].join("\r\n"),
    ),
  ).toEqual(validSnapshot);

  expect(() => validateWindowsAclSnapshot(validSnapshot, sid)).not.toThrow();
  expect(() =>
    validateWindowsAclSnapshot(
      {
        ...validSnapshot,
        accessRules: [
          rule,
          { ...rule, identitySid: "S-1-5-32-544" },
        ],
      },
      sid,
    ),
  ).toThrow("invalid Windows staging ACL");
});

it("freezes premature exit before a later final close", async () => {
  const fakeChild = Object.assign(new EventEmitter(), {
    pid: 48_280,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
  const spawnProcess = vi.fn(() => fakeChild) as unknown as typeof import("node:child_process").spawn;
  const transport = new RuntimeStdioTransport(
    { command: process.execPath, stderr: "pipe" },
    { shutdownDeadlines: shortShutdownDeadlines, spawnProcess },
  );

  const startPromise = transport.start();
  fakeChild.emit("spawn");
  await startPromise;
  const pid = transport.pid;
  expect(pid).not.toBeNull();
  fakeChild.emit("exit", 0, null);
  expect(transport.pid).toBe(pid);
  expect(transport.finalCloseObserved).toBe(false);
  expect(transport.exitObservation).toEqual({ code: 0, signal: null, premature: true });
  expect(Object.isFrozen(transport.exitObservation)).toBe(true);
  const closePromise = transport.close();
  setTimeout(() => fakeChild.emit("close", 0, null), 20);
  await expect(closePromise).rejects.toThrow("Runtime did not exit cleanly");
  expect(transport.finalCloseObserved).toBe(true);
});

it("stages signed bytes independently from later source mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "navact-stage-source-"));
  temporaryDirectories.push(directory);
  const sourcePath = join(directory, "mcp-health-entry.js");
  await copyFile(resolve("dist/src/mcp-health-entry.js"), sourcePath);
  const fixture = await signedArtifact(sourcePath);
  const staged = await stageRuntimeArtifact({ ...fixture, kind: "host-node" });
  try {
    expect(staged.artifactPath).not.toBe(sourcePath);
    expect(basename(staged.artifactPath)).toBe(basename(sourcePath));
    await writeFile(sourcePath, "tampered after staging");
    await expect(
      verifyRuntimeArtifact({ ...fixture, artifactPath: staged.artifactPath }),
    ).resolves.toMatchObject({ platform: `${process.platform}-${process.arch}` });
  } finally {
    await staged.cleanup();
  }
});

it("verifies, starts, calls, and stops the compiled Runtime", async () => {
  const serverPath = await healthArtifact();
  const fixture = await signedArtifact(serverPath);
  const supervisor = new RuntimeSupervisor({
    ...fixture,
    launch: { kind: "host-node", artifactPath: serverPath },
  });
  await expect(supervisor.start("nonce-1")).resolves.toMatchObject({
    status: "ok",
    nonce: "nonce-1",
    platform: `${process.platform}-${process.arch}`,
  });
  await supervisor.stop();
  expect(supervisor.state).toBe("idle");
});

it("serializes an immediate stop behind an in-flight start", async () => {
  const serverPath = await healthArtifact();
  const fixture = await signedArtifact(serverPath);
  const supervisor = new RuntimeSupervisor({
    ...fixture,
    launch: { kind: "host-node", artifactPath: serverPath },
  });
  const startPromise = supervisor.start("nonce-race");
  const stopPromise = supervisor.stop();

  try {
    const [health] = await Promise.all([startPromise, stopPromise]);
    expect.soft(supervisor.state).toBe("idle");
    expect(() => process.kill(health.pid, 0)).toThrow();
  } finally {
    await supervisor.stop();
  }
});

it("rejects stop after forced termination of a stubborn healthy Runtime", async () => {
  const artifactPath = await healthArtifact(true);
  const fixture = await signedArtifact(artifactPath);
  const supervisor = new RuntimeSupervisor({
    ...fixture,
    launch: { kind: "host-node", artifactPath },
  });

  await expect(supervisor.start("nonce-stubborn")).resolves.toMatchObject({
    status: "ok",
    nonce: "nonce-stubborn",
  });
  await expect(supervisor.stop()).rejects.toThrow("Runtime did not exit cleanly");
  expect(supervisor.state).toBe("idle");
});

it("refuses bytes changed after signing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "navact-supervisor-"));
  temporaryDirectories.push(directory);
  const artifactPath = join(directory, "mcp-health-entry.js");
  await copyFile(resolve("dist/src/mcp-health-entry.js"), artifactPath);
  const fixture = await signedArtifact(artifactPath);
  await writeFile(artifactPath, "tampered");
  const supervisor = new RuntimeSupervisor({
    ...fixture,
    launch: { kind: "host-node", artifactPath },
  });
  await expect(supervisor.start("nonce-2")).rejects.toThrow("artifact sha256 mismatch");
  expect(supervisor.state).toBe("failed");
  await supervisor.stop();
  expect(supervisor.state).toBe("idle");
});

it("rejects a launch path different from the verified artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "navact-launch-binding-"));
  temporaryDirectories.push(directory);
  const artifactPath = join(directory, "verified-entry.js");
  const differentPath = join(directory, "different-entry.js");
  await copyFile(resolve("dist/src/mcp-health-entry.js"), artifactPath);
  await copyFile(resolve("dist/src/mcp-health-entry.js"), differentPath);
  const fixture = await signedArtifact(artifactPath);
  const supervisor = new RuntimeSupervisor({
    ...fixture,
    launch: { kind: "host-node", artifactPath: differentPath },
  });
  await expect(supervisor.start("nonce-3")).rejects.toThrow("Runtime launch artifact mismatch");
  expect(supervisor.state).toBe("failed");
});

it("derives the Host Node executable instead of honoring a caller override", async () => {
  const serverPath = await healthArtifact();
  const fixture = await signedArtifact(serverPath);
  const launch = {
    kind: "host-node",
    artifactPath: serverPath,
    hostExecutable: join(tmpdir(), "navact-missing-host-executable"),
  } as unknown as RuntimeLaunchSpec;
  const supervisor = new RuntimeSupervisor({ ...fixture, launch });
  await expect(supervisor.start("nonce-4")).resolves.toMatchObject({ status: "ok", nonce: "nonce-4" });
  await supervisor.stop();
});

const validHealth = {
  status: "ok" as const,
  nonce: "nonce-health",
  pid: 1,
  platform: `${process.platform}-${process.arch}`,
};

it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid Runtime pid %s",
  (pid) => {
    expect(() => validateHealthResult({ ...validHealth, pid }, validHealth.nonce)).toThrow(
      "invalid Runtime health response",
    );
  },
);

it("rejects health from another platform", () => {
  expect(() => validateHealthResult({ ...validHealth, platform: "other-platform" }, validHealth.nonce)).toThrow(
    "invalid Runtime health response",
  );
});
