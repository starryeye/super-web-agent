import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
