import { getDefaultEnvironment, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough, type Stream } from "node:stream";

const productionShutdownDeadlines = {
  gracefulExitTimeoutMs: 2_000,
  signalExitTimeoutMs: 2_000,
  forcedExitTimeoutMs: 2_000,
} as const;
const uncleanExitMessage = "Runtime did not exit cleanly";

export interface RuntimeShutdownDeadlines {
  readonly gracefulExitTimeoutMs: number;
  readonly signalExitTimeoutMs: number;
  readonly forcedExitTimeoutMs: number;
}

export interface RuntimeStdioTransportOptions {
  readonly shutdownDeadlines?: RuntimeShutdownDeadlines;
}

export interface RuntimeExitObservation {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly premature: boolean;
}

export class RuntimeTerminationUnobservedError extends Error {
  constructor(options?: ErrorOptions) {
    super("Runtime termination was not observed", options);
    this.name = "RuntimeTerminationUnobservedError";
  }
}

export class RuntimeStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly readBuffer = new ReadBuffer();
  private readonly stderrStream: PassThrough | null;
  private readonly finalClosePromise: Promise<void>;
  private resolveFinalClose!: () => void;
  private child: ChildProcess | undefined;
  private observedExit: RuntimeExitObservation | undefined;
  private observedFinalClose = false;
  private closePromise: Promise<void> | undefined;
  private closeRequested = false;
  private closeNotified = false;
  private gracefulDeadlineMissed = false;
  private signalDelivered = false;
  private terminalWithoutChild = false;
  private started = false;
  private readonly shutdownDeadlines: RuntimeShutdownDeadlines;

  constructor(
    private readonly server: StdioServerParameters,
    options: RuntimeStdioTransportOptions = {},
  ) {
    this.shutdownDeadlines = Object.freeze({
      ...(options.shutdownDeadlines ?? productionShutdownDeadlines),
    });
    for (const timeoutMs of [
      this.shutdownDeadlines.gracefulExitTimeoutMs,
      this.shutdownDeadlines.signalExitTimeoutMs,
      this.shutdownDeadlines.forcedExitTimeoutMs,
    ]) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error("Runtime shutdown deadlines must be positive safe integers");
      }
    }
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

  get exitObserved(): boolean {
    return this.observedExit !== undefined;
  }

  get finalCloseObserved(): boolean {
    return this.observedFinalClose;
  }

  get exitObservation(): Readonly<RuntimeExitObservation> | undefined {
    return this.observedExit;
  }

  get processOwnershipResolved(): boolean {
    return this.terminalWithoutChild || this.observedFinalClose;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("RuntimeStdioTransport already started");
    this.started = true;

    await new Promise<void>((resolve, reject) => {
      let startSettled = false;
      let child: ChildProcess;
      try {
        child = spawn(this.server.command, this.server.args ?? [], {
          env: { ...getDefaultEnvironment(), ...this.server.env },
          stdio: ["pipe", "pipe", this.server.stderr ?? "inherit"],
          shell: false,
          windowsHide: process.platform === "win32",
          cwd: this.server.cwd,
        });
      } catch (error) {
        this.terminalWithoutChild = true;
        this.readBuffer.clear();
        this.notifyClose();
        reject(error);
        return;
      }
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
      child.once("exit", (code, signal) => {
        this.observedExit ??= Object.freeze({ code, signal, premature: !this.closeRequested });
      });
      child.once("close", () => {
        this.observedFinalClose = true;
        this.child = undefined;
        this.readBuffer.clear();
        this.resolveFinalClose();
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
    if (this.closePromise !== undefined) return this.closePromise;
    const attempt = this.closeOwnedProcess();
    this.closePromise = attempt;
    void attempt.catch((error: unknown) => {
      if (error instanceof RuntimeTerminationUnobservedError && this.closePromise === attempt) {
        this.closePromise = undefined;
      }
    });
    return attempt;
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
    if (this.terminalWithoutChild) return;
    const child = this.child;
    if (child !== undefined && !this.observedFinalClose) {
      try {
        child.stdin?.end();
      } catch {
        // Final close observation determines whether shutdown was clean.
      }
      if (!(await this.waitForFinalClose(this.shutdownDeadlines.gracefulExitTimeoutMs))) {
        this.gracefulDeadlineMissed = true;
        if (!this.exitObserved) {
          try {
            if (child.kill("SIGTERM")) this.signalDelivered = true;
          } catch {
            // Continue to the final close observation and forced fallback.
          }
        }
        if (
          !(await this.waitForFinalClose(this.shutdownDeadlines.signalExitTimeoutMs)) &&
          !this.exitObserved
        ) {
          try {
            if (child.kill("SIGKILL")) this.signalDelivered = true;
          } catch {
            // The bounded final wait below still proves whether close was observed.
          }
        }
        if (!this.observedFinalClose) {
          await this.waitForFinalClose(this.shutdownDeadlines.forcedExitTimeoutMs);
        }
      }
    }

    if (!this.observedFinalClose) throw new RuntimeTerminationUnobservedError();
    const observation = this.observedExit;
    if (
      observation === undefined ||
      observation.premature ||
      this.gracefulDeadlineMissed ||
      this.signalDelivered ||
      observation.code !== 0 ||
      observation.signal !== null
    ) {
      throw new Error(uncleanExitMessage);
    }
  }

  private waitForFinalClose(timeoutMs: number): Promise<boolean> {
    if (this.observedFinalClose) return Promise.resolve(true);
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
