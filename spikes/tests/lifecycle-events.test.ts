import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createLifecycleEventRecorder,
  parseLifecycleEventLine,
} from "../src/lifecycle-events.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "navact-lifecycle-events-"));
  directories.push(directory);
  return {
    directory,
    evidencePath: join(directory, "events.jsonl"),
    env: {
      NAVACT_SPIKE_EVIDENCE_PATH: join(directory, "events.jsonl"),
      NAVACT_SPIKE_HOST: "claude-code",
      NAVACT_SPIKE_RUN_ID: "health-v1",
      NAVACT_SPIKE_PLUGIN_VERSION: "0.0.1",
    },
  };
}

it("appends strict ordered lifecycle events to a private file", async () => {
  const value = await fixture();
  const recorder = createLifecycleEventRecorder(value.env);
  recorder!.record("started");
  recorder!.record("health", { nonce: "nonce-1" });
  const lines = (await readFile(value.evidencePath, "utf8")).trim().split("\n");
  expect(lines.map(parseLifecycleEventLine)).toMatchObject([
    { sequence: 1, event: "started", host: "claude-code", runId: "health-v1", pluginVersion: "0.0.1" },
    { sequence: 2, event: "health", nonce: "nonce-1" },
  ]);
  if (process.platform !== "win32") {
    expect((await stat(value.evidencePath)).mode & 0o777).toBe(0o600);
  } else {
    expect((await stat(value.evidencePath)).isFile()).toBe(true);
  }
});

it("returns undefined only when all lifecycle variables are absent", () => {
  expect(createLifecycleEventRecorder({})).toBeUndefined();
  expect(() =>
    createLifecycleEventRecorder({ NAVACT_SPIKE_HOST: "codex" }),
  ).toThrow("incomplete lifecycle evidence environment");
});

it("rejects relative evidence paths and malformed report values", async () => {
  const value = await fixture();
  expect(() =>
    createLifecycleEventRecorder({ ...value.env, NAVACT_SPIKE_EVIDENCE_PATH: "events.jsonl" }),
  ).toThrow("lifecycle evidence path must be absolute");
  expect(() => parseLifecycleEventLine('{"schemaVersion":1,"event":"health"}')).toThrow(
    "invalid lifecycle event",
  );
});
