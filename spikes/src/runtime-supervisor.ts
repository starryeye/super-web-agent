import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { verifyRuntimeArtifact, type RuntimeManifest } from "./runtime-manifest.js";

export type SupervisorState = "idle" | "starting" | "running" | "stopping" | "failed";

export interface RuntimeLaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface HealthResult {
  status: "ok";
  nonce: string;
  pid: number;
  platform: string;
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
      const transport = new StdioClientTransport({
        command: this.options.launch.command,
        args: this.options.launch.args,
        stderr: "pipe",
        ...(this.options.launch.cwd === undefined ? {} : { cwd: this.options.launch.cwd }),
        ...(this.options.launch.env === undefined ? {} : { env: this.options.launch.env }),
      });
      this.client = new Client({ name: "navact-runtime-supervisor-spike", version: "0.0.0" });
      await this.client.connect(transport);
      const result = await this.client.callTool({ name: "navact_spike_health", arguments: { nonce } });
      const value = result.structuredContent as Partial<HealthResult> | undefined;
      if (
        value?.status !== "ok" ||
        value.nonce !== nonce ||
        typeof value.pid !== "number" ||
        typeof value.platform !== "string"
      ) {
        throw new Error("invalid Runtime health response");
      }
      this.state = "running";
      return value as HealthResult;
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
