import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildSelfContainedRuntime } from "../src/runtime-artifact-builder.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function absoluteFixture() {
  const directory = await mkdtemp(join(tmpdir(), "navact-runtime-builder-"));
  directories.push(directory);
  return {
    entryPoint: join(directory, "entry.ts"),
    hostBundlePath: join(directory, "host", "runtime.cjs"),
    outputPath: join(directory, "output", "navact-runtime"),
    workingDirectory: join(directory, "work"),
  };
}

it.each([
  ["entryPoint", "entry.ts"],
  ["hostBundlePath", "host/runtime.cjs"],
  ["outputPath", "output/navact-runtime"],
  ["workingDirectory", "work"],
] as const)("rejects a relative %s before launching a process", async (field, relativePath) => {
  const input = await absoluteFixture();
  await expect(buildSelfContainedRuntime({
    ...input,
    [field]: relativePath,
    runtimeBuildId: "0.0.1",
  })).rejects.toThrow(`${field} must be an absolute path`);
});

it.each(["0.0", "v0.0.1", "0.0.1-beta", "baseline", "packaging-baseline-1"])(
  "rejects the unsupported build ID %s before launching a process",
  async (runtimeBuildId) => {
    const input = await absoluteFixture();
    await expect(buildSelfContainedRuntime({ ...input, runtimeBuildId })).rejects.toThrow("invalid runtime build ID");
  },
);

it("embeds each requested build ID in a running self-contained Runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "navact-runtime-build-id-"));
  directories.push(directory);
  const entryPoint = join(directory, "entry.ts");
  await writeFile(
    entryPoint,
    `import { RUNTIME_BUILD_ID } from ${JSON.stringify(resolve(process.cwd(), "src", "runtime-build-id.ts"))}; process.stdout.write(RUNTIME_BUILD_ID);`,
  );
  const originalPnpmEntry = process.env.npm_execpath;
  process.env.npm_execpath ??= join(dirname(process.execPath), "..", "node_modules", "pnpm", "bin", "pnpm.cjs");
  try {
    for (const runtimeBuildId of ["0.0.1", "0.0.2"] as const) {
      const outputPath = join(directory, runtimeBuildId, process.platform === "win32" ? "navact-runtime.exe" : "navact-runtime");
      await buildSelfContainedRuntime({
        entryPoint,
        hostBundlePath: join(directory, runtimeBuildId, "host", "runtime.cjs"),
        outputPath,
        workingDirectory: join(directory, runtimeBuildId, "work"),
        runtimeBuildId,
      });
      const result = spawnSync(outputPath, [], { encoding: "utf8", windowsHide: true });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(runtimeBuildId);
    }
  } finally {
    if (originalPnpmEntry === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = originalPnpmEntry;
  }
}, 30_000);
