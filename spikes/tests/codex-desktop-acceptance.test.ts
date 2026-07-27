import { expect, it } from "vitest";
import {
  evaluateCodexDesktopAcceptance,
  parseCodexDesktopAcceptanceRecord,
  type CodexDesktopAcceptanceRecord,
} from "../src/codex-desktop-acceptance.js";

function passingRecord(): CodexDesktopAcceptanceRecord {
  return {
    schemaVersion: 1,
    status: "passed",
    recordedAt: "2026-07-27T12:00:00.000Z",
    desktopVersion: "0.107.0",
    platform: "darwin-arm64",
    pluginName: "super-web-agent-lifecycle-evidence",
    pluginVersion: "0.0.2",
    pluginArtifactSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    installation: "passed",
    bundledMcpStartup: "passed",
    healthTool: "passed",
    structuredResultPreserved: true,
    observedRuntimeBuildId: "0.0.2",
    removal: "passed",
    noLiveRuntime: true,
    notes: ["Health response verified against the supplied nonce."],
  };
}

it("parses and passes a complete sanitized Desktop acceptance record", () => {
  const record = passingRecord();

  expect(parseCodexDesktopAcceptanceRecord(record)).toEqual(record);
  expect(evaluateCodexDesktopAcceptance(record)).toEqual({
    state: "passed",
    reasons: ["Codex Desktop acceptance record passed"],
  });
});

it("rejects a calendar-invalid timestamp instead of accepting its normalized date", () => {
  const record = passingRecord();
  record.recordedAt = "2026-02-30T12:00:00.000Z";

  expect(() => parseCodexDesktopAcceptanceRecord(record)).toThrow("invalid Codex Desktop acceptance timestamp");
});

it.each([
  ["unknown record key", (record: Record<string, unknown>) => { record.rawLog = "hidden"; }],
  ["raw log note", (record: Record<string, unknown>) => { record.notes = ["stdout: hidden"]; }],
  ["conversation note", (record: Record<string, unknown>) => { record.notes = ["User: call the health tool"]; }],
  ["provider credential note", (record: Record<string, unknown>) => { record.notes = ["OPENAI_API_KEY=hidden"]; }],
  ["bearer token note", (record: Record<string, unknown>) => { record.notes = ["Bearer hidden-token"]; }],
  ["POSIX user path note", (record: Record<string, unknown>) => { record.notes = ["/Users/example/runtime"]; }],
  ["Windows user path note", (record: Record<string, unknown>) => { record.notes = ["C:\\Users\\example\\runtime"]; }],
  ["more than ten notes", (record: Record<string, unknown>) => { record.notes = Array.from({ length: 11 }, () => "safe note"); }],
  ["overlong note", (record: Record<string, unknown>) => { record.notes = ["a".repeat(201)]; }],
  ["malformed timestamp", (record: Record<string, unknown>) => { record.recordedAt = "2026-07-27"; }],
  ["malformed digest", (record: Record<string, unknown>) => { record.pluginArtifactSha256 = "abc"; }],
  ["version mismatch", (record: Record<string, unknown>) => { record.observedRuntimeBuildId = "0.0.1"; }],
  ["passed status with failed phase", (record: Record<string, unknown>) => { record.healthTool = "failed"; }],
  ["failed status with every phase passed", (record: Record<string, unknown>) => { record.status = "failed"; }],
])("rejects a %s", (_name, mutate) => {
  const record = passingRecord() as unknown as Record<string, unknown>;
  mutate(record);

  expect(() => parseCodexDesktopAcceptanceRecord(record)).toThrow("invalid Codex Desktop acceptance");
  expect(evaluateCodexDesktopAcceptance(record)).toEqual({
    state: "rejected",
    reasons: ["invalid Codex Desktop acceptance record"],
  });
});

it.each([
  ["failed installation", (record: CodexDesktopAcceptanceRecord) => { record.status = "failed"; record.installation = "failed"; }],
  ["missing structured content", (record: CodexDesktopAcceptanceRecord) => { record.status = "failed"; record.structuredResultPreserved = false; }],
  ["a live Runtime after removal", (record: CodexDesktopAcceptanceRecord) => { record.status = "failed"; record.noLiveRuntime = false; }],
])("parses but does not pass a record with %s", (_name, mutate) => {
  const record = passingRecord();
  mutate(record);

  expect(parseCodexDesktopAcceptanceRecord(record)).toEqual(record);
  expect(evaluateCodexDesktopAcceptance(record)).toEqual({
    state: "rejected",
    reasons: ["record status is failed"],
  });
});
