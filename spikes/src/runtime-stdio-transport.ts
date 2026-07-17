import { getDefaultEnvironment, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough, type Stream } from "node:stream";

const gracefulExitTimeoutMs = 2_000;
const signalExitTimeoutMs = 2_000;
const forcedExitTimeoutMs = 2_000;
const uncleanExitMessage = "Runtime did not exit cleanly";

interface ExitObservation {
  code: number | null;
  signal: NodeJS.Signals | null;
  premature: boolean;
}

export class RuntimeStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly readBuffer = new ReadBuffer();
  private readonly stderrStream: PassThrough | null;
  private readonly finalClosePromise: Promise<ExitObservation>;
  private resolveFinalClose!: (observation: ExitObservation) => void;
  private child: ChildProcess | undefined;
  private exitObservation: ExitObservation | undefined;
  private closePromise: Promise<void> | undefined;
  private closeRequested = false;
  private closeNotified = false;
  private escalated = false;
  private started = false;

  constructor(private readonly server: StdioServerParameters) {
    this.stderrStream = server.stderr === "pipe" || server.stderr === "overlapped" ? new PassThrough() : null;
    this.finalClosePromise = new Promise((resolve) => {
      this.resolveFinalClose = resolve;
    });
  }

  get stderr(): Stream | null {
    return this.stderrStream ?? this.child?.stderr ?? null;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("RuntimeStdioTransport already started");
    this.started = true;

    await new Promise<void>((resolve, reject) => {
      let startSettled = false;
      const child = spawn(this.server.command, this.server.args ?? [], {
        env: { ...getDefaultEnvironment(), ...this.server.env },
        stdio: ["pipe", "pipe", this.server.stderr ?? "inherit"],
        shell: false,
        windowsHide: process.platform === "win32",
        cwd: this.server.cwd,
      });
      this.child = child;

      child.once("spawn", () => {
        startSettled = true;
        resolve();
      });
      child.once("error", (error) => {
        if (!startSettled) {
          startSettled = true;
          reject(error);
        }
        this.onerror?.(error);
      });
      child.once("close", (code, signal) => {
        const observation = { code, signal, premature: !this.closeRequested };
        this.exitObservation = observation;
        this.child = undefined;
        this.readBuffer.clear();
        this.resolveFinalClose(observation);
        this.notifyClose();
        if (!startSettled) {
          startSettled = true;
          reject(new Error(uncleanExitMessage));
        }
      });
      child.stdin?.on("error", (error) => this.onerror?.(error));
      child.stdout?.on("data", (chunk: Buffer) => {
        this.readBuffer.append(chunk);
        this.processReadBuffer();
      });
      child.stdout?.on("error", (error) => this.onerror?.(error));
      if (this.stderrStream !== null && child.stderr !== null) child.stderr.pipe(this.stderrStream);
    });
  }

  send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const stdin = this.child?.stdin;
    if (stdin == null || stdin.destroyed) return Promise.reject(new Error("Not connected"));
    return new Promise<void>((resolve, reject) => {
      stdin.write(serializeMessage(message), (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOwnedProcess();
    return this.closePromise;
  }

  private processReadBuffer(): void {
    while (true) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) return;
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private async closeOwnedProcess(): Promise<void> {
    this.closeRequested = true;
    try {
      const child = this.child;
      if (child !== undefined && this.exitObservation === undefined) {
        try {
          child.stdin?.end();
        } catch {
          // Final close observation determines whether shutdown was clean.
        }
        if (!(await this.waitForFinalClose(gracefulExitTimeoutMs))) {
          this.escalated = true;
          try {
            child.kill("SIGTERM");
          } catch {
            // Continue to the final close observation and forced fallback.
          }
        }
        if (this.exitObservation === undefined && !(await this.waitForFinalClose(signalExitTimeoutMs))) {
          this.escalated = true;
          try {
            child.kill("SIGKILL");
          } catch {
            // The bounded final wait below still proves whether close was observed.
          }
        }
        if (this.exitObservation === undefined) await this.waitForFinalClose(forcedExitTimeoutMs);
      }

      const observation = this.exitObservation;
      if (
        observation === undefined ||
        observation.premature ||
        this.escalated ||
        observation.code !== 0 ||
        observation.signal !== null
      ) {
        throw new Error(uncleanExitMessage);
      }
    } finally {
      this.readBuffer.clear();
      this.notifyClose();
    }
  }

  private waitForFinalClose(timeoutMs: number): Promise<boolean> {
    if (this.exitObservation !== undefined) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);
      timer.unref();
      void this.finalClosePromise.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private notifyClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.onclose?.();
  }
}
