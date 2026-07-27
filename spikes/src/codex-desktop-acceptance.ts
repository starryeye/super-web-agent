export interface CodexDesktopAcceptanceRecord {
  schemaVersion: 1;
  status: "passed" | "failed";
  recordedAt: string;
  desktopVersion: string;
  platform: "darwin-arm64" | "win32-x64";
  pluginName: "super-web-agent-lifecycle-evidence";
  pluginVersion: "0.0.1" | "0.0.2";
  pluginArtifactSha256: string;
  installation: "passed" | "failed";
  bundledMcpStartup: "passed" | "failed";
  healthTool: "passed" | "failed";
  structuredResultPreserved: boolean;
  observedRuntimeBuildId: "0.0.1" | "0.0.2";
  removal: "passed" | "failed";
  noLiveRuntime: boolean;
  notes: string[];
}

export interface CodexDesktopAcceptanceEvaluation {
  state: "passed" | "rejected";
  reasons: string[];
}

const recordKeys = [
  "schemaVersion", "status", "recordedAt", "desktopVersion", "platform", "pluginName",
  "pluginVersion", "pluginArtifactSha256", "installation", "bundledMcpStartup", "healthTool",
  "structuredResultPreserved", "observedRuntimeBuildId", "removal", "noLiveRuntime", "notes",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireExactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw new Error("invalid Codex Desktop acceptance record keys");
  return value;
}

function requirePhase(value: unknown, label: string): "passed" | "failed" {
  if (value !== "passed" && value !== "failed") throw new Error(`invalid Codex Desktop acceptance ${label}`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`invalid Codex Desktop acceptance ${label}`);
  return value;
}

function requireRecordedAt(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new Error("invalid Codex Desktop acceptance timestamp");
  }
  const timestamp = new Date(value);
  const canonical = value.includes(".") ? value : `${value.slice(0, -1)}.000Z`;
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== canonical) {
    throw new Error("invalid Codex Desktop acceptance timestamp");
  }
  return value;
}

function requireDesktopVersion(value: unknown): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("invalid Codex Desktop acceptance Desktop version");
  }
  return value;
}

function requireVersion(value: unknown, label: string): "0.0.1" | "0.0.2" {
  if (value !== "0.0.1" && value !== "0.0.2") throw new Error(`invalid Codex Desktop acceptance ${label}`);
  return value;
}

function requireDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("invalid Codex Desktop acceptance artifact digest");
  }
  return value;
}

function noteIsSanitized(value: string): boolean {
  return value.length > 0 && value.length <= 200 && value.trim() === value &&
    !/[\r\n\t]/.test(value) &&
    !/\/Users\//.test(value) && !/C:\\Users\\/i.test(value) &&
    !/\b(?:OPENAI|ANTHROPIC)_API_KEY\b/i.test(value) && !/\bbearer\s+/i.test(value) &&
    !/\b(?:stdout|stderr)\s*:/i.test(value) && !/\bstack(?:\s+trace)?\s*:/i.test(value) &&
    !/\b(?:user|assistant|system)\s*:/i.test(value);
}

function requireNotes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10 ||
    !value.every((note) => typeof note === "string" && noteIsSanitized(note))) {
    throw new Error("invalid Codex Desktop acceptance notes");
  }
  return [...value] as string[];
}

export function parseCodexDesktopAcceptanceRecord(value: unknown): CodexDesktopAcceptanceRecord {
  const record = requireExactRecord(value, recordKeys);
  if (record.schemaVersion !== 1 ||
    (record.platform !== "darwin-arm64" && record.platform !== "win32-x64") ||
    record.pluginName !== "super-web-agent-lifecycle-evidence") {
    throw new Error("invalid Codex Desktop acceptance identity");
  }

  const status = requirePhase(record.status, "status");
  const installation = requirePhase(record.installation, "installation");
  const bundledMcpStartup = requirePhase(record.bundledMcpStartup, "bundled MCP startup");
  const healthTool = requirePhase(record.healthTool, "health tool");
  const removal = requirePhase(record.removal, "removal");
  const structuredResultPreserved = requireBoolean(record.structuredResultPreserved, "structured result preservation");
  const noLiveRuntime = requireBoolean(record.noLiveRuntime, "Runtime exit");
  const pluginVersion = requireVersion(record.pluginVersion, "plugin version");
  const observedRuntimeBuildId = requireVersion(record.observedRuntimeBuildId, "observed Runtime build ID");
  if (pluginVersion !== observedRuntimeBuildId) throw new Error("invalid Codex Desktop acceptance build version mismatch");

  const allPassed = installation === "passed" && bundledMcpStartup === "passed" && healthTool === "passed" &&
    structuredResultPreserved && removal === "passed" && noLiveRuntime;
  if ((status === "passed") !== allPassed) throw new Error("invalid Codex Desktop acceptance status disagreement");

  return {
    schemaVersion: 1,
    status,
    recordedAt: requireRecordedAt(record.recordedAt),
    desktopVersion: requireDesktopVersion(record.desktopVersion),
    platform: record.platform,
    pluginName: "super-web-agent-lifecycle-evidence",
    pluginVersion,
    pluginArtifactSha256: requireDigest(record.pluginArtifactSha256),
    installation,
    bundledMcpStartup,
    healthTool,
    structuredResultPreserved,
    observedRuntimeBuildId,
    removal,
    noLiveRuntime,
    notes: requireNotes(record.notes),
  };
}

export function evaluateCodexDesktopAcceptance(record: unknown): CodexDesktopAcceptanceEvaluation {
  let parsed: CodexDesktopAcceptanceRecord;
  try {
    parsed = parseCodexDesktopAcceptanceRecord(record);
  } catch {
    return { state: "rejected", reasons: ["invalid Codex Desktop acceptance record"] };
  }
  if (parsed.status !== "passed") return { state: "rejected", reasons: ["record status is failed"] };
  return { state: "passed", reasons: ["Codex Desktop acceptance record passed"] };
}
