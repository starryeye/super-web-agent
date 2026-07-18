import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildPluginLifecycleFixtures } from "../src/plugin-lifecycle-fixture.js";
import { buildSelfContainedRuntime } from "../src/runtime-artifact-builder.js";

function requirePlatform(value: string): "darwin-arm64" | "win32-x64" {
  if (value !== "darwin-arm64" && value !== "win32-x64") throw new Error(`unsupported fixture platform: ${value}`);
  return value;
}

async function main(): Promise<void> {
  const [outputArgument, ...extraArguments] = process.argv.slice(2);
  if (outputArgument === undefined || extraArguments.length !== 0) {
    throw new Error("usage: build-plugin-lifecycle-fixtures OUTPUT_ROOT");
  }
  const outputRoot = resolve(process.cwd(), outputArgument);
  const platform = requirePlatform(`${process.platform}-${process.arch}`);
  const runtimesRoot = join(outputRoot, "runtimes");
  await rm(runtimesRoot, { recursive: true, force: true });
  await mkdir(runtimesRoot, { recursive: true });
  const executable = process.platform === "win32" ? "navact-runtime.exe" : "navact-runtime";
  const artifacts = {} as Record<"0.0.1" | "0.0.2", string>;
  for (const version of ["0.0.1", "0.0.2"] as const) {
    const versionRoot = join(runtimesRoot, version);
    const outputPath = join(versionRoot, executable);
    await buildSelfContainedRuntime({
      entryPoint: join(process.cwd(), "src", "mcp-health-entry.ts"),
      hostBundlePath: join(versionRoot, "host-node", "navact-runtime.cjs"),
      outputPath,
      workingDirectory: join(versionRoot, "sea-work"),
      runtimeBuildId: version,
    });
    artifacts[version] = outputPath;
  }
  await buildPluginLifecycleFixtures({ artifacts, outputRoot, platform });
  console.log(join(outputRoot, "fixture-index.json"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
