import { createHash, timingSafeEqual, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export interface RuntimeManifest {
  runtimeVersion: string;
  coreProtocolRange: string;
  bridgeProtocolRange: string;
  platform: string;
  artifact: string;
  sha256: string;
  signature: string;
}

type UnsignedManifest = Omit<RuntimeManifest, "signature">;

const manifestKeys = [
  "artifact",
  "bridgeProtocolRange",
  "coreProtocolRange",
  "platform",
  "runtimeVersion",
  "sha256",
  "signature",
] as const;

export function canonicalManifestPayload(manifest: UnsignedManifest): string {
  return JSON.stringify({
    runtimeVersion: manifest.runtimeVersion,
    coreProtocolRange: manifest.coreProtocolRange,
    bridgeProtocolRange: manifest.bridgeProtocolRange,
    platform: manifest.platform,
    artifact: manifest.artifact,
    sha256: manifest.sha256,
  });
}

export function parseRuntimeManifest(value: unknown): RuntimeManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("runtime manifest must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\n") !== [...manifestKeys].sort().join("\n")) {
    throw new Error("invalid runtime manifest keys");
  }
  for (const key of manifestKeys) {
    if (typeof record[key] !== "string" || record[key].length === 0) {
      throw new Error(`invalid runtime manifest field: ${key}`);
    }
  }
  return record as unknown as RuntimeManifest;
}

export async function verifyRuntimeArtifact(input: {
  artifactPath: string;
  manifest: RuntimeManifest;
  publicKeyPem: string;
}): Promise<{ runtimeVersion: string; platform: string }> {
  const expectedPlatform = `${process.platform}-${process.arch}`;
  if (input.manifest.platform !== expectedPlatform) throw new Error("runtime platform mismatch");
  if (input.manifest.artifact !== basename(input.artifactPath)) throw new Error("runtime artifact name mismatch");
  const bytes = await readFile(input.artifactPath);
  const actualDigest = createHash("sha256").update(bytes).digest();
  const expectedDigest = Buffer.from(input.manifest.sha256, "hex");
  if (actualDigest.length !== expectedDigest.length || !timingSafeEqual(actualDigest, expectedDigest)) {
    throw new Error("artifact sha256 mismatch");
  }
  const { signature, ...unsigned } = input.manifest;
  const signatureValid = verify(
    null,
    Buffer.from(canonicalManifestPayload(unsigned)),
    input.publicKeyPem,
    Buffer.from(signature, "base64url"),
  );
  if (!signatureValid) throw new Error("artifact signature mismatch");
  return { runtimeVersion: input.manifest.runtimeVersion, platform: input.manifest.platform };
}
