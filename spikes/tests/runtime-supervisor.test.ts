import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { canonicalManifestPayload, type RuntimeManifest } from "../src/runtime-manifest.js";
import { RuntimeSupervisor } from "../src/runtime-supervisor.js";

const temporaryDirectories: string[] = [];

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

it("verifies, starts, calls, and stops the compiled Runtime", async () => {
  const serverPath = resolve("dist/src/mcp-health-entry.js");
  const fixture = await signedArtifact(serverPath);
  const supervisor = new RuntimeSupervisor({
    ...fixture,
    launch: { command: process.execPath, args: [serverPath] },
  });
  await expect(supervisor.start("nonce-1")).resolves.toMatchObject({
    status: "ok",
    nonce: "nonce-1",
    platform: `${process.platform}-${process.arch}`,
  });
  await supervisor.stop();
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
    launch: { command: process.execPath, args: [artifactPath] },
  });
  await expect(supervisor.start("nonce-2")).rejects.toThrow("artifact sha256 mismatch");
  expect(supervisor.state).toBe("failed");
  await supervisor.stop();
  expect(supervisor.state).toBe("idle");
});
