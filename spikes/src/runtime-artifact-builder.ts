import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { build } from "esbuild";

const seaFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

export interface SelfContainedRuntimeBuildInput {
  entryPoint: string;
  hostBundlePath: string;
  outputPath: string;
  workingDirectory: string;
  runtimeBuildId: string;
}

function requireAbsolutePath(name: string, value: string): void {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
}

function requireRuntimeBuildId(value: string): void {
  if (value !== "packaging-baseline" && !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`invalid runtime build ID: ${value}`);
  }
}

function runChecked(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${basename(command)} exited ${String(result.status)}${detail.length === 0 ? "" : `: ${detail}`}`);
  }
}

export async function buildSelfContainedRuntime(input: SelfContainedRuntimeBuildInput): Promise<void> {
  requireAbsolutePath("entryPoint", input.entryPoint);
  requireAbsolutePath("hostBundlePath", input.hostBundlePath);
  requireAbsolutePath("outputPath", input.outputPath);
  requireAbsolutePath("workingDirectory", input.workingDirectory);
  requireRuntimeBuildId(input.runtimeBuildId);

  await mkdir(dirname(input.hostBundlePath), { recursive: true });
  await build({
    entryPoints: [input.entryPoint],
    outfile: input.hostBundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    sourcemap: false,
    logLevel: "warning",
    define: {
      __NAVACT_SPIKE_RUNTIME_BUILD_ID__: JSON.stringify(input.runtimeBuildId),
    },
  });

  await mkdir(input.workingDirectory, { recursive: true });
  const preparationBlob = join(input.workingDirectory, "sea-prep.blob");
  const seaConfig = join(input.workingDirectory, "sea-config.json");
  await writeFile(
    seaConfig,
    `${JSON.stringify({ main: input.hostBundlePath, output: preparationBlob, useSnapshot: false, useCodeCache: false }, null, 2)}\n`,
  );
  runChecked(process.execPath, ["--experimental-sea-config", seaConfig]);
  await mkdir(dirname(input.outputPath), { recursive: true });
  await copyFile(process.execPath, input.outputPath);
  if (process.platform === "darwin") runChecked("/usr/bin/codesign", ["--remove-signature", input.outputPath]);
  const pnpmEntry = process.env.npm_execpath;
  if (pnpmEntry === undefined) throw new Error("pnpm did not provide npm_execpath");
  const postjectArgs = [pnpmEntry, "exec", "postject", input.outputPath, "NODE_SEA_BLOB", preparationBlob, "--sentinel-fuse", seaFuse];
  if (process.platform === "darwin") postjectArgs.push("--macho-segment-name", "NODE_SEA");
  runChecked(process.execPath, postjectArgs);
  if (process.platform === "darwin") runChecked("/usr/bin/codesign", ["--sign", "-", input.outputPath]);
  await chmod(input.outputPath, 0o755);
}
