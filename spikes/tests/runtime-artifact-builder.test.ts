import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildSelfContainedRuntime } from "../src/runtime-artifact-builder.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function absoluteFixture() {
  const directory = await mkdtemp(join(tmpdir(), "super-web-agent-runtime-builder-"));
  directories.push(directory);
  return {
    entryPoint: join(directory, "entry.ts"),
    hostBundlePath: join(directory, "host", "runtime.cjs"),
    outputPath: join(directory, "output", "super-web-agent-runtime"),
    workingDirectory: join(directory, "work"),
  };
}

it.each([
  ["entryPoint", "entry.ts"],
  ["hostBundlePath", "host/runtime.cjs"],
  ["outputPath", "relative-runtime"],
  ["workingDirectory", "work"],
] as const)("rejects a relative %s before invoking the toolchain", async (field, relativePath) => {
  const input = await absoluteFixture();
  await expect(buildSelfContainedRuntime({
    ...input,
    [field]: relativePath,
    runtimeBuildId: "0.0.1",
  })).rejects.toThrow(`${field} must be an absolute path`);
});

it.each(["", "latest", "0.0", "../0.0.1"])(
  "rejects invalid embedded build ID %j",
  async (runtimeBuildId) => {
    const input = await absoluteFixture();
    await expect(buildSelfContainedRuntime({
      ...input,
      runtimeBuildId,
    })).rejects.toThrow("invalid runtime build ID");
  },
);

it("embeds distinct requested build IDs in exact Runtime executable basenames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "super-web-agent-runtime-build-id-"));
  directories.push(directory);
  const entryPoint = join(directory, "entry.ts");
  await writeFile(
    entryPoint,
    `import { RUNTIME_BUILD_ID } from ${JSON.stringify(resolve(process.cwd(), "src", "runtime-build-id.ts"))}; process.stdout.write(RUNTIME_BUILD_ID);`,
  );
  const originalPnpmEntry = process.env.npm_execpath;
  process.env.npm_execpath = join(directory, "missing-pnpm.cjs");
  try {
    const outputs: string[] = [];
    for (const runtimeBuildId of ["0.0.1", "0.0.2"]) {
      const outputPath = join(directory, runtimeBuildId, "super-web-agent-runtime");
      await buildSelfContainedRuntime({
        entryPoint,
        hostBundlePath: join(directory, runtimeBuildId, "host", "runtime.cjs"),
        outputPath,
        workingDirectory: join(directory, runtimeBuildId, "work"),
        runtimeBuildId,
      });
      expect(basename(outputPath)).toBe("super-web-agent-runtime");
      const result = spawnSync(outputPath, [], { encoding: "utf8", windowsHide: true });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(runtimeBuildId);
      outputs.push(outputPath);
    }
    expect(await readFile(outputs[0]!)).not.toEqual(await readFile(outputs[1]!));
  } finally {
    if (originalPnpmEntry === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = originalPnpmEntry;
  }
}, 60_000);
