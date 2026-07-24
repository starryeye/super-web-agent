import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { canonicalManifestPayload, type RuntimeManifest } from "../src/runtime-manifest.js";
import {
  evaluatePackagingPlatform,
  type PackagingPlatformReport,
  type PackagingVariantReport,
  type TargetPlatform,
} from "../src/packaging-report.js";
import { RuntimeSupervisor, type RuntimeLaunchSpec } from "../src/runtime-supervisor.js";
import { buildSelfContainedRuntime } from "../src/runtime-artifact-builder.js";

const runtimeVersion = "0.0.0-spike" as const;
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

async function main(): Promise<void> {
  const target = requireTargetPlatform(platform);
  const artifactRoot = join(spikeRoot, ".artifacts", "packaging", target);
  await rm(artifactRoot, { recursive: true, force: true });
  await mkdir(artifactRoot, { recursive: true });

  const hostBundle = join(
    artifactRoot,
    "host-node",
    "super-web-agent-runtime.cjs",
  );
  const executableName =
    process.platform === "win32"
      ? "super-web-agent-runtime.exe"
      : "super-web-agent-runtime";
  const seaExecutable = join(artifactRoot, "self-contained", executableName);
  let constructionError: unknown;
  try {
    await buildSelfContainedRuntime({
      entryPoint: join(spikeRoot, "src", "mcp-health-entry.ts"),
      hostBundlePath: hostBundle,
      outputPath: seaExecutable,
      workingDirectory: artifactRoot,
      runtimeBuildId: "packaging-baseline",
    });
  } catch (error) {
    constructionError = error;
  }

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

  let candidate: PackagingVariantReport;
  try {
    if (constructionError !== undefined) throw constructionError;
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
