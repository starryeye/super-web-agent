import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { build } from "esbuild";
import { canonicalManifestPayload, type RuntimeManifest } from "../src/runtime-manifest.js";
import {
  evaluatePackagingPlatform,
  type PackagingPlatformReport,
  type PackagingVariantReport,
  type TargetPlatform,
} from "../src/packaging-report.js";
import { RuntimeSupervisor, type RuntimeLaunchSpec } from "../src/runtime-supervisor.js";

const runtimeVersion = "0.0.0-spike" as const;
const seaFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const spikeRoot = process.cwd();
const platform = `${process.platform}-${process.arch}`;

function requireTargetPlatform(value: string): TargetPlatform {
  if (value !== "darwin-arm64" && value !== "win32-x64") {
    throw new Error(`unsupported evidence platform: ${value}`);
  }
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runChecked(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${basename(command)} exited ${String(result.status)}${detail.length === 0 ? "" : `: ${detail}`}`);
  }
}

function environmentWithoutPath(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && key.toLowerCase() !== "path" && key !== "NODE_OPTIONS") result[key] = value;
  }
  result.PATH = "";
  return result;
}

async function signedArtifact(artifactPath: string): Promise<{
  artifactPath: string;
  manifest: RuntimeManifest;
  publicKeyPem: string;
}> {
  const bytes = await readFile(artifactPath);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const unsigned = {
    runtimeVersion,
    coreProtocolRange: "1.0",
    bridgeProtocolRange: "1.0",
    platform,
    artifact: basename(artifactPath),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return {
    artifactPath,
    manifest: {
      ...unsigned,
      signature: sign(null, Buffer.from(canonicalManifestPayload(unsigned)), privateKey).toString("base64url"),
    },
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

async function exerciseVariant(input: {
  kind: PackagingVariantReport["kind"];
  artifactPath: string;
  requiresHostNode: boolean;
  launch: RuntimeLaunchSpec;
}): Promise<PackagingVariantReport> {
  const errors: string[] = [];
  const startsMs: number[] = [];
  let healthPassed = true;
  let cleanupPassed = true;
  const fixture = await signedArtifact(input.artifactPath);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const supervisor = new RuntimeSupervisor({ ...fixture, launch: input.launch });
    const startedAt = performance.now();
    try {
      const health = await supervisor.start(`probe-${attempt}`);
      if (health.platform !== platform) throw new Error(`health platform mismatch: ${health.platform}`);
      startsMs.push(Math.round((performance.now() - startedAt) * 100) / 100);
    } catch (error) {
      healthPassed = false;
      errors.push(`probe ${attempt}: ${errorText(error)}`);
    } finally {
      try {
        await supervisor.stop();
      } catch (error) {
        cleanupPassed = false;
        errors.push(`cleanup ${attempt}: ${errorText(error)}`);
      }
    }
  }
  return {
    kind: input.kind,
    artifact: relative(spikeRoot, input.artifactPath).replaceAll("\\", "/"),
    bytes: (await stat(input.artifactPath)).size,
    requiresHostNode: input.requiresHostNode,
    healthPassed,
    cleanupPassed,
    startsMs,
    errors,
  };
}

async function createSeaExecutable(hostBundle: string, executablePath: string, workingDirectory: string): Promise<void> {
  const preparationBlob = join(workingDirectory, "sea-prep.blob");
  const seaConfig = join(workingDirectory, "sea-config.json");
  await writeFile(
    seaConfig,
    `${JSON.stringify({ main: hostBundle, output: preparationBlob, useSnapshot: false, useCodeCache: false }, null, 2)}\n`,
  );
  runChecked(process.execPath, ["--experimental-sea-config", seaConfig]);
  await mkdir(dirname(executablePath), { recursive: true });
  await copyFile(process.execPath, executablePath);
  if (process.platform === "darwin") runChecked("/usr/bin/codesign", ["--remove-signature", executablePath]);
  const pnpmEntry = process.env.npm_execpath;
  if (pnpmEntry === undefined) throw new Error("pnpm did not provide npm_execpath");
  const postjectArgs = [pnpmEntry, "exec", "postject", executablePath, "NODE_SEA_BLOB", preparationBlob, "--sentinel-fuse", seaFuse];
  if (process.platform === "darwin") postjectArgs.push("--macho-segment-name", "NODE_SEA");
  runChecked(process.execPath, postjectArgs);
  if (process.platform === "darwin") runChecked("/usr/bin/codesign", ["--sign", "-", executablePath]);
  await chmod(executablePath, 0o755);
}

async function main(): Promise<void> {
  const target = requireTargetPlatform(platform);
  const artifactRoot = join(spikeRoot, ".artifacts", "packaging", target);
  await rm(artifactRoot, { recursive: true, force: true });
  await mkdir(artifactRoot, { recursive: true });

  const hostBundle = join(artifactRoot, "host-node", "navact-runtime.cjs");
  await mkdir(dirname(hostBundle), { recursive: true });
  await build({
    entryPoints: [join(spikeRoot, "src", "mcp-health-entry.ts")],
    outfile: hostBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    sourcemap: false,
    logLevel: "warning",
  });

  const cleanEnvironment = environmentWithoutPath();
  const control = await exerciseVariant({
    kind: "host-node",
    artifactPath: hostBundle,
    requiresHostNode: true,
    launch: {
      kind: "host-node",
      artifactPath: hostBundle,
      env: cleanEnvironment,
    },
  });

  const executableName = process.platform === "win32" ? "navact-runtime.exe" : "navact-runtime";
  const seaExecutable = join(artifactRoot, "self-contained", executableName);
  let candidate: PackagingVariantReport;
  try {
    await createSeaExecutable(hostBundle, seaExecutable, artifactRoot);
    candidate = await exerciseVariant({
      kind: "self-contained",
      artifactPath: seaExecutable,
      requiresHostNode: false,
      launch: { kind: "self-contained", executable: seaExecutable, env: cleanEnvironment },
    });
  } catch (error) {
    candidate = {
      kind: "self-contained",
      artifact: relative(spikeRoot, seaExecutable).replaceAll("\\", "/"),
      bytes: await stat(seaExecutable).then((value) => value.size).catch(() => 0),
      requiresHostNode: false,
      healthPassed: false,
      cleanupPassed: false,
      startsMs: [],
      errors: [errorText(error)],
    };
  }

  const report: PackagingPlatformReport = {
    schemaVersion: 1,
    runtimeVersion,
    platform: target,
    nodeVersion: process.version,
    artifactSignatureMode: "ephemeral-test-key",
    osCodeSigning: process.platform === "darwin" ? "ad-hoc" : "unsigned-test",
    variants: [control, candidate],
  };
  const reportPath = join(artifactRoot, "packaging-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(reportPath);
  if (evaluatePackagingPlatform(report).gate !== "pass") process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
