import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildKeylessPluginFixtures,
  type KeylessPluginPlatform,
  type PluginFixtureVersion,
  type SignedRuntimeFixture,
} from "../src/keyless-plugin-bundle.js";
import { buildSelfContainedRuntime } from "../src/runtime-artifact-builder.js";
import {
  canonicalManifestPayload,
  type RuntimeManifest,
} from "../src/runtime-manifest.js";

const usage = "usage: build-keyless-plugin-fixtures OUTPUT_ROOT";

export function parseBuildKeylessPluginFixtureArgs(
  args: readonly string[],
): string {
  if (args.length !== 1 || args[0] === undefined || args[0].length === 0) {
    throw new Error(usage);
  }
  return resolve(args[0]);
}

function currentPlatform(): KeylessPluginPlatform {
  const platform = `${process.platform}-${process.arch}`;
  if (platform !== "darwin-arm64" && platform !== "win32-x64") {
    throw new Error(`unsupported evidence platform: ${platform}`);
  }
  return platform;
}

function executableName(
  platform: KeylessPluginPlatform,
): "super-web-agent-runtime" | "super-web-agent-runtime.exe" {
  return platform === "win32-x64"
    ? "super-web-agent-runtime.exe"
    : "super-web-agent-runtime";
}

async function signRuntime(
  artifactPath: string,
  version: PluginFixtureVersion,
  platform: KeylessPluginPlatform,
): Promise<SignedRuntimeFixture> {
  const bytes = await readFile(artifactPath);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const unsigned = {
    runtimeVersion: version,
    coreProtocolRange: "1.0",
    bridgeProtocolRange: "1.0",
    platform,
    artifact: basename(artifactPath),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const manifest: RuntimeManifest = {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(canonicalManifestPayload(unsigned)),
      privateKey,
    ).toString("base64url"),
  };
  return {
    artifactPath,
    manifest,
    publicKeyPem: publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
  };
}

async function main(args: readonly string[]): Promise<void> {
  const outputRoot = parseBuildKeylessPluginFixtureArgs(args);
  const platform = currentPlatform();
  const buildRoot = await mkdtemp(join(tmpdir(), "swa-keyless-fixture-build-"));
  try {
    const runtimes = {} as Record<
      PluginFixtureVersion,
      SignedRuntimeFixture
    >;
    for (const version of ["0.0.1", "0.0.2"] as const) {
      const versionRoot = join(buildRoot, version);
      const artifactPath = join(versionRoot, executableName(platform));
      await buildSelfContainedRuntime({
        entryPoint: resolve(process.cwd(), "src", "mcp-health-entry.ts"),
        hostBundlePath: join(versionRoot, "host", "runtime.cjs"),
        outputPath: artifactPath,
        workingDirectory: join(versionRoot, "work"),
        runtimeBuildId: version,
      });
      runtimes[version] = await signRuntime(artifactPath, version, platform);
    }
    await buildKeylessPluginFixtures({
      outputRoot,
      platform,
      runtimes,
    });
    process.stdout.write(`${join(outputRoot, "fixture-index.json")}\n`);
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
