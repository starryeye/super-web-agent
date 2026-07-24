import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalManifestPayload,
  parseRuntimeManifest,
  verifyRuntimeArtifact,
  type RuntimeManifest,
} from "../src/runtime-manifest.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function signedFixture() {
  const directory = await mkdtemp(join(tmpdir(), "super-web-agent-manifest-"));
  temporaryDirectories.push(directory);
  const artifactPath = join(directory, "super-web-agent-runtime");
  await writeFile(artifactPath, "runtime-v1");
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

describe("runtime artifact verification", () => {
  it("accepts a matching digest, platform, artifact name, and signature", async () => {
    const fixture = await signedFixture();
    await expect(verifyRuntimeArtifact(fixture)).resolves.toEqual({
      runtimeVersion: "0.0.0-spike",
      platform: `${process.platform}-${process.arch}`,
    });
  });

  it("rejects bytes changed after signing", async () => {
    const fixture = await signedFixture();
    await writeFile(fixture.artifactPath, "tampered-runtime");
    await expect(verifyRuntimeArtifact(fixture)).rejects.toThrow("artifact sha256 mismatch");
  });

  it("rejects missing manifest fields", () => {
    expect(() => parseRuntimeManifest({ runtimeVersion: "0.0.0-spike" })).toThrow("invalid runtime manifest keys");
  });

  it("rejects unknown manifest fields", () => {
    expect(() => parseRuntimeManifest({ unexpected: true })).toThrow("invalid runtime manifest keys");
  });
});
