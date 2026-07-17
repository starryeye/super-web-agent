import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { verifyRuntimeArtifact, type RuntimeManifest } from "./runtime-manifest.js";
import { RuntimeStdioTransport } from "./runtime-stdio-transport.js";

export type SupervisorState = "idle" | "starting" | "running" | "stopping" | "failed";

interface RuntimeLaunchOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export type RuntimeLaunchSpec =
  | (RuntimeLaunchOptions & { kind: "host-node"; artifactPath: string })
  | (RuntimeLaunchOptions & { kind: "self-contained"; executable: string });

export interface HealthResult {
  status: "ok";
  nonce: string;
  pid: number;
  platform: string;
}

interface RuntimeArtifactInput {
  artifactPath: string;
  manifest: RuntimeManifest;
  publicKeyPem: string;
}

export interface StagedRuntimeArtifact {
  artifactPath: string;
  cleanup: () => Promise<void>;
}

export function validateHealthResult(value: unknown, nonce: string): HealthResult {
  const result = value as Partial<HealthResult> | undefined;
  if (
    result?.status !== "ok" ||
    result.nonce !== nonce ||
    !Number.isSafeInteger(result.pid) ||
    (result.pid ?? 0) <= 0 ||
    result.platform !== `${process.platform}-${process.arch}`
  ) {
    throw new Error("invalid Runtime health response");
  }
  return result as HealthResult;
}

export async function stageRuntimeArtifact(
  input: RuntimeArtifactInput & { kind: RuntimeLaunchSpec["kind"] },
): Promise<StagedRuntimeArtifact> {
  if (!isAbsolute(input.artifactPath)) throw new Error("Runtime artifact path must be absolute");
  await verifyRuntimeArtifact(input);

  const stagingDirectory = await mkdtemp(join(tmpdir(), "navact-runtime-"));
  let cleanupComplete = false;
  const cleanup = async (): Promise<void> => {
    if (cleanupComplete) return;
    await rm(stagingDirectory, { recursive: true, force: true });
    cleanupComplete = true;
  };

  try {
    await chmod(stagingDirectory, 0o700);
    const stagedPath = join(stagingDirectory, basename(input.artifactPath));
    await copyFile(input.artifactPath, stagedPath);
    await chmod(stagedPath, input.kind === "self-contained" ? 0o500 : 0o400);
    await verifyRuntimeArtifact({ ...input, artifactPath: stagedPath });
    return { artifactPath: stagedPath, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function declaredRuntimeSource(artifactPath: string, launch: RuntimeLaunchSpec): string {
  if (!isAbsolute(artifactPath)) throw new Error("Runtime artifact path must be absolute");
  const declaredArtifact = launch.kind === "host-node" ? launch.artifactPath : launch.executable;
  if (!isAbsolute(declaredArtifact) || resolve(declaredArtifact) !== resolve(artifactPath)) {
    throw new Error("Runtime launch artifact mismatch");
  }
  return artifactPath;
}

export class RuntimeSupervisor {
  state: SupervisorState = "idle";
  private client: Client | undefined;
  private transport: RuntimeStdioTransport | undefined;
  private stageCleanup: (() => Promise<void>) | undefined;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private pendingCleanupFailure: unknown;

  constructor(private readonly options: RuntimeArtifactInput & { launch: RuntimeLaunchSpec }) {}

  start(nonce: string): Promise<HealthResult> {
    return this.enqueueLifecycle(() => this.startRuntime(nonce));
  }

  stop(): Promise<void> {
    return this.enqueueLifecycle(() => this.stopRuntime());
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation);
    this.lifecycleQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async startRuntime(nonce: string): Promise<HealthResult> {
    if (this.state !== "idle") throw new Error(`cannot start Runtime from ${this.state}`);
    this.state = "starting";
    try {
      const sourcePath = declaredRuntimeSource(this.options.artifactPath, this.options.launch);
      const staged = await stageRuntimeArtifact({
        artifactPath: sourcePath,
        manifest: this.options.manifest,
        publicKeyPem: this.options.publicKeyPem,
        kind: this.options.launch.kind,
      });
      this.stageCleanup = staged.cleanup;
      const command = this.options.launch.kind === "host-node" ? process.execPath : staged.artifactPath;
      const args = this.options.launch.kind === "host-node" ? [staged.artifactPath] : [];
      this.transport = new RuntimeStdioTransport({
        command,
        args,
        stderr: "pipe",
        ...(this.options.launch.cwd === undefined ? {} : { cwd: this.options.launch.cwd }),
        ...(this.options.launch.env === undefined ? {} : { env: this.options.launch.env }),
      });
      this.client = new Client({ name: "navact-runtime-supervisor-spike", version: "0.0.0" });
      await this.client.connect(this.transport);
      const result = await this.client.callTool({ name: "navact_spike_health", arguments: { nonce } });
      const value = validateHealthResult(result.structuredContent, nonce);
      this.state = "running";
      return value;
    } catch (error) {
      this.state = "failed";
      this.pendingCleanupFailure ??= await this.cleanupOwnedRuntime();
      throw error;
    }
  }

  private async stopRuntime(): Promise<void> {
    if (this.state === "idle" && this.pendingCleanupFailure === undefined) return;
    this.state = "stopping";
    const previousFailure = this.pendingCleanupFailure;
    this.pendingCleanupFailure = undefined;
    const cleanupFailure = await this.cleanupOwnedRuntime();
    this.state = "idle";
    if (previousFailure !== undefined) throw previousFailure;
    if (cleanupFailure !== undefined) throw cleanupFailure;
  }

  private async cleanupOwnedRuntime(): Promise<unknown> {
    let failure: unknown;
    try {
      await this.client?.close();
    } catch (error) {
      failure = error;
    }
    try {
      await this.transport?.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      await this.stageCleanup?.();
    } catch (error) {
      failure ??= error;
    }
    this.client = undefined;
    this.transport = undefined;
    this.stageCleanup = undefined;
    return failure;
  }
}
