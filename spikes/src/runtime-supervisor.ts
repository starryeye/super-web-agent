import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isAbsolute, resolve } from "node:path";
import { verifyRuntimeArtifact, type RuntimeManifest } from "./runtime-manifest.js";

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

function resolveRuntimeLaunch(verifiedArtifactPath: string, launch: RuntimeLaunchSpec): {
  command: string;
  args: string[];
} {
  if (!isAbsolute(verifiedArtifactPath)) throw new Error("Runtime artifact path must be absolute");
  const declaredArtifact = launch.kind === "host-node" ? launch.artifactPath : launch.executable;
  if (resolve(declaredArtifact) !== resolve(verifiedArtifactPath)) {
    throw new Error("Runtime launch artifact mismatch");
  }
  return launch.kind === "host-node"
    ? { command: process.execPath, args: [verifiedArtifactPath] }
    : { command: verifiedArtifactPath, args: [] };
}

export class RuntimeSupervisor {
  state: SupervisorState = "idle";
  private client: Client | undefined;

  constructor(private readonly options: {
    artifactPath: string;
    manifest: RuntimeManifest;
    publicKeyPem: string;
    launch: RuntimeLaunchSpec;
  }) {}

  async start(nonce: string): Promise<HealthResult> {
    if (this.state !== "idle") throw new Error(`cannot start Runtime from ${this.state}`);
    this.state = "starting";
    try {
      await verifyRuntimeArtifact(this.options);
      const resolvedLaunch = resolveRuntimeLaunch(this.options.artifactPath, this.options.launch);
      const transport = new StdioClientTransport({
        command: resolvedLaunch.command,
        args: resolvedLaunch.args,
        stderr: "pipe",
        ...(this.options.launch.cwd === undefined ? {} : { cwd: this.options.launch.cwd }),
        ...(this.options.launch.env === undefined ? {} : { env: this.options.launch.env }),
      });
      this.client = new Client({ name: "navact-runtime-supervisor-spike", version: "0.0.0" });
      await this.client.connect(transport);
      const result = await this.client.callTool({ name: "navact_spike_health", arguments: { nonce } });
      const value = validateHealthResult(result.structuredContent, nonce);
      this.state = "running";
      return value;
    } catch (error) {
      this.state = "failed";
      await this.client?.close().catch(() => undefined);
      this.client = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === "idle") return;
    this.state = "stopping";
    await this.client?.close();
    this.client = undefined;
    this.state = "idle";
  }
}
