import { closeSync, openSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { RUNTIME_BUILD_ID } from "./runtime-build-id.js";

export type LifecycleHost = "claude-code" | "codex";
export type LifecycleEventName = "started" | "health" | "crash-requested" | "exiting";

export interface LifecycleEvent {
  schemaVersion: 1;
  runtimeVersion: "0.0.0-spike";
  runtimeBuildId: string;
  host: LifecycleHost;
  runId: string;
  pluginVersion: "0.0.1" | "0.0.2";
  platform: string;
  executablePath: string;
  pid: number;
  parentPid: number;
  sequence: number;
  observedAtMs: number;
  event: LifecycleEventName;
  nonce?: string;
  exitCode?: number;
}

export interface LifecycleEventRecorder {
  record(
    event: LifecycleEventName,
    detail?: { nonce?: string; exitCode?: number },
  ): void;
}

const runIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseLifecycleEventLine(line: string): LifecycleEvent {
  const value = JSON.parse(line) as Partial<LifecycleEvent>;
  if (
    value.schemaVersion !== 1 ||
    value.runtimeVersion !== "0.0.0-spike" ||
    typeof value.runtimeBuildId !== "string" ||
    value.runtimeBuildId.length === 0 ||
    (value.host !== "claude-code" && value.host !== "codex") ||
    typeof value.runId !== "string" ||
    !runIdPattern.test(value.runId) ||
    (value.pluginVersion !== "0.0.1" && value.pluginVersion !== "0.0.2") ||
    typeof value.platform !== "string" ||
    typeof value.executablePath !== "string" ||
    !isAbsolute(value.executablePath) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid ?? 0) <= 0 ||
    !Number.isSafeInteger(value.parentPid) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence ?? 0) <= 0 ||
    !Number.isSafeInteger(value.observedAtMs) ||
    !["started", "health", "crash-requested", "exiting"].includes(value.event ?? "")
  ) {
    throw new Error("invalid lifecycle event");
  }
  if (value.event === "health" && (typeof value.nonce !== "string" || value.nonce.length === 0)) {
    throw new Error("invalid lifecycle event");
  }
  if (value.event === "exiting" && !Number.isSafeInteger(value.exitCode)) {
    throw new Error("invalid lifecycle event");
  }
  return value as LifecycleEvent;
}

export function createLifecycleEventRecorder(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): LifecycleEventRecorder | undefined {
  const evidencePath = env.NAVACT_SPIKE_EVIDENCE_PATH;
  const host = env.NAVACT_SPIKE_HOST;
  const runId = env.NAVACT_SPIKE_RUN_ID;
  const pluginVersion = env.NAVACT_SPIKE_PLUGIN_VERSION;
  const values = [evidencePath, host, runId, pluginVersion];
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => value === undefined)) {
    throw new Error("incomplete lifecycle evidence environment");
  }
  if (!isAbsolute(evidencePath!)) throw new Error("lifecycle evidence path must be absolute");
  if (host !== "claude-code" && host !== "codex") throw new Error("invalid lifecycle host");
  if (!runIdPattern.test(runId!)) throw new Error("invalid lifecycle run id");
  if (pluginVersion !== "0.0.1" && pluginVersion !== "0.0.2") {
    throw new Error("invalid lifecycle plugin version");
  }

  let sequence = 0;
  return {
    record(event, detail = {}) {
      sequence += 1;
      const value: LifecycleEvent = {
        schemaVersion: 1,
        runtimeVersion: "0.0.0-spike",
        runtimeBuildId: RUNTIME_BUILD_ID,
        host,
        runId: runId!,
        pluginVersion,
        platform: `${process.platform}-${process.arch}`,
        executablePath: process.execPath,
        pid: process.pid,
        parentPid: process.ppid,
        sequence,
        observedAtMs: Date.now(),
        event,
        ...(detail.nonce === undefined ? {} : { nonce: detail.nonce }),
        ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }),
      };
      const descriptor = openSync(evidencePath!, "a", 0o600);
      try {
        writeSync(descriptor, `${JSON.stringify(value)}\n`, undefined, "utf8");
      } finally {
        closeSync(descriptor);
      }
    },
  };
}
