import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { verifyRuntimeArtifact, type RuntimeManifest } from "./runtime-manifest.js";
import {
  RuntimeStdioTransport,
  RuntimeTerminationUnobservedError,
} from "./runtime-stdio-transport.js";

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

function runTextCommand(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        windowsHide: true,
        ...(env === undefined ? {} : { env }),
      },
      (error, stdout) => {
        if (error !== null) rejectCommand(error);
        else resolveCommand(stdout);
      },
    );
  });
}

function system32Executable(name: "whoami.exe" | "icacls.exe"): string {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (systemRoot === undefined || !isAbsolute(systemRoot)) {
    throw new Error("Windows SystemRoot must be absolute");
  }
  return join(systemRoot, "System32", name);
}

function windowsPowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (systemRoot === undefined || !isAbsolute(systemRoot)) {
    throw new Error("Windows SystemRoot must be absolute");
  }
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function sidEquals(left: string, right: string): boolean {
  return left.toUpperCase() === right.toUpperCase();
}

export function validateWindowsAclSnapshot(snapshot: unknown, currentSid: string): void {
  const record = snapshot as Record<string, unknown> | undefined;
  const accessRules = record?.accessRules;
  if (
    record?.areAccessRulesProtected !== true ||
    typeof record.ownerSid !== "string" ||
    !sidEquals(record.ownerSid, currentSid) ||
    !Array.isArray(accessRules) ||
    accessRules.length !== 1
  ) {
    throw new Error("invalid Windows staging ACL");
  }
  const rule = accessRules[0] as Record<string, unknown> | undefined;
  if (
    typeof rule?.identitySid !== "string" ||
    !sidEquals(rule.identitySid, currentSid) ||
    rule.accessControlType !== 0 ||
    rule.fileSystemRights !== 2_032_127 ||
    rule.inheritanceFlags !== 3 ||
    rule.propagationFlags !== 0 ||
    rule.isInherited !== false
  ) {
    throw new Error("invalid Windows staging ACL");
  }
}

const createPrivateWindowsDirectoryScript = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:NAVACT_STAGE_PATH
$sid = [System.Security.Principal.SecurityIdentifier]::new($env:NAVACT_STAGE_SID)
if ([System.IO.Directory]::Exists($path) -or [System.IO.File]::Exists($path)) {
  throw 'Runtime staging path already exists'
}
$security = [System.Security.AccessControl.DirectorySecurity]::new()
$security.SetAccessRuleProtection($true, $false)
$security.SetOwner($sid)
$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$security.AddAccessRule($rule)
try {
  [void][System.IO.Directory]::CreateDirectory($path, $security)
} catch {
  if ([System.IO.Directory]::Exists($path)) {
    Remove-Item -LiteralPath $path -Recurse -Force
  }
  throw
}
`;

const inspectWindowsDirectoryAclScript = String.raw`
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:NAVACT_STAGE_PATH
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  [pscustomobject]@{
    identitySid = $_.IdentityReference.Value
    accessControlType = [int]$_.AccessControlType
    fileSystemRights = [int]$_.FileSystemRights
    inheritanceFlags = [int]$_.InheritanceFlags
    propagationFlags = [int]$_.PropagationFlags
    isInherited = $_.IsInherited
  }
})
[pscustomobject]@{
  areAccessRulesProtected = $acl.AreAccessRulesProtected
  ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  accessRules = @($rules)
} | ConvertTo-Json -Depth 5 -Compress
`;

async function runWindowsPowerShell(script: string, env: NodeJS.ProcessEnv): Promise<string> {
  return runTextCommand(
    windowsPowerShellExecutable(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    env,
  );
}

async function discoverWindowsSid(): Promise<string> {
  const sidOutput = await runTextCommand(system32Executable("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  const sidMatches = sidOutput.match(/\bS-\d+(?:-\d+)+\b/gi) ?? [];
  if (sidMatches.length !== 1 || sidMatches[0] === undefined) {
    throw new Error("failed to discover current Windows user SID");
  }
  return sidMatches[0];
}

async function createPosixStagingDirectory(): Promise<string> {
  const stagingDirectory = await mkdtemp(join(tmpdir(), "navact-runtime-"));
  try {
    await chmod(stagingDirectory, 0o700);
    if (((await stat(stagingDirectory)).mode & 0o777) !== 0o700) {
      throw new Error("Runtime staging directory must have mode 0700");
    }
    return stagingDirectory;
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function createWindowsStagingDirectory(): Promise<string> {
  const sid = await discoverWindowsSid();
  const stagingDirectory = join(tmpdir(), `navact-runtime-${randomBytes(32).toString("hex")}`);
  const icacls = system32Executable("icacls.exe");
  const powershellEnvironment = {
    ...process.env,
    NAVACT_STAGE_PATH: stagingDirectory,
    NAVACT_STAGE_SID: sid,
  };
  try {
    await runWindowsPowerShell(createPrivateWindowsDirectoryScript, powershellEnvironment);
    await runTextCommand(icacls, [
      stagingDirectory,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:(OI)(CI)F`,
    ]);
    await runTextCommand(icacls, [stagingDirectory, "/verify"]);
    const snapshotText = await runWindowsPowerShell(inspectWindowsDirectoryAclScript, powershellEnvironment);
    validateWindowsAclSnapshot(JSON.parse(snapshotText) as unknown, sid);
    return stagingDirectory;
  } catch (error) {
    try {
      await rm(stagingDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "failed to secure and clean Runtime staging directory");
    }
    throw error;
  }
}

async function createPrivateStagingDirectory(): Promise<string> {
  return process.platform === "win32" ? createWindowsStagingDirectory() : createPosixStagingDirectory();
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

  const stagingDirectory = await createPrivateStagingDirectory();
  let cleanupComplete = false;
  const cleanup = async (): Promise<void> => {
    if (cleanupComplete) return;
    await rm(stagingDirectory, { recursive: true, force: true });
    cleanupComplete = true;
  };

  try {
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
      const cleanupFailure = await this.cleanupOwnedRuntime();
      if (cleanupFailure !== undefined) this.pendingCleanupFailure ??= cleanupFailure;
      throw error;
    }
  }

  private async stopRuntime(): Promise<void> {
    if (this.state === "idle" && this.pendingCleanupFailure === undefined) return;
    this.state = "stopping";
    const previousFailure = this.pendingCleanupFailure;
    const cleanupFailure = await this.cleanupOwnedRuntime();
    if (this.ownsRuntimeResources()) {
      const retainedFailure =
        previousFailure ??
        cleanupFailure ??
        new RuntimeTerminationUnobservedError();
      this.pendingCleanupFailure = retainedFailure;
      throw retainedFailure;
    }
    this.state = "idle";
    this.pendingCleanupFailure = undefined;
    if (previousFailure !== undefined) throw previousFailure;
    if (cleanupFailure !== undefined) throw cleanupFailure;
  }

  private async cleanupOwnedRuntime(): Promise<unknown> {
    let failure: unknown;
    const client = this.client;
    const transport = this.transport;
    try {
      await client?.close();
    } catch (error) {
      failure = error;
    }
    if (transport !== undefined && (client === undefined || transport.processOwnershipResolved)) {
      try {
        await transport.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (transport !== undefined && !transport.processOwnershipResolved) {
      return failure instanceof RuntimeTerminationUnobservedError
        ? failure
        : new RuntimeTerminationUnobservedError(
            failure === undefined ? undefined : { cause: failure },
          );
    }
    this.client = undefined;
    this.transport = undefined;
    if (this.stageCleanup !== undefined) {
      try {
        await this.stageCleanup();
        this.stageCleanup = undefined;
      } catch (error) {
        failure ??= error;
      }
    }
    return failure;
  }

  private ownsRuntimeResources(): boolean {
    return this.client !== undefined || this.transport !== undefined || this.stageCleanup !== undefined;
  }
}
