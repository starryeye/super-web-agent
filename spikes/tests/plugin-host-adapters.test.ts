import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createPluginHostAdapter,
  healthPrompt,
  resolveNpmPackageBin,
  type RunCommand,
} from "../src/plugin-host-adapters.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(async (directory) => { await (await import("node:fs/promises")).rm(directory, { recursive: true, force: true }); })); });

function recorder(records: string[]): RunCommand {
  return async ({ displayName, args, env }) => {
    records.push([displayName, ...args].join(" "));
    if (env !== undefined) {
      expect(Object.keys(env).sort()).toEqual(["NAVACT_SPIKE_EVIDENCE_PATH", "NAVACT_SPIKE_HOST", "NAVACT_SPIKE_PLUGIN_VERSION", "NAVACT_SPIKE_RUN_ID", "PARENT"].sort());
    }
    return { command: [displayName, ...args].join(" "), exitCode: 0, stdout: "model output", stderr: "diagnostic", startedAtMs: 100, durationMs: 20 };
  };
}

it.each([
  ["claude-code", "claude", "/private/tmp/navact-lifecycle-fixture/active/claude-code", [
    "claude --version",
    "claude plugin marketplace add /private/tmp/navact-lifecycle-fixture/active/claude-code",
    "claude plugin install navact-lifecycle-spike@navact-lifecycle-spike-claude --scope user",
    `claude -p ${healthPrompt("adapter-test")} --output-format json --permission-mode dontAsk`,
    "claude plugin marketplace update navact-lifecycle-spike-claude",
    "claude plugin update navact-lifecycle-spike@navact-lifecycle-spike-claude --scope user",
    "claude plugin uninstall navact-lifecycle-spike@navact-lifecycle-spike-claude --scope user",
    "claude plugin marketplace remove navact-lifecycle-spike-claude",
  ]],
  ["codex", "codex", "/private/tmp/navact-lifecycle-fixture/active/codex", [
    "codex --version",
    "codex plugin marketplace add /private/tmp/navact-lifecycle-fixture/active/codex --json",
    "codex plugin add navact-lifecycle-spike@navact-lifecycle-spike-codex --json",
    `codex exec --ephemeral --sandbox read-only -c approval_policy="never" --json ${healthPrompt("adapter-test")}`,
    "codex plugin add navact-lifecycle-spike@navact-lifecycle-spike-codex --json",
    "codex plugin remove navact-lifecycle-spike@navact-lifecycle-spike-codex --json",
    "codex plugin marketplace remove navact-lifecycle-spike-codex --json",
  ]],
] as const)("issues the exact %s command contract", async (host, executable, root, expected) => {
  const records: string[] = [];
  const adapter = createPluginHostAdapter(host, { displayName: executable, executable, prefixArgs: [] }, recorder(records));
  await adapter.version("/project");
  await adapter.addMarketplace(root, "/project");
  await adapter.install("/project");
  await adapter.runPrompt(healthPrompt("adapter-test"), "/project", { PARENT: "allowed", NAVACT_SPIKE_EVIDENCE_PATH: "/evidence", NAVACT_SPIKE_HOST: host, NAVACT_SPIKE_RUN_ID: "run", NAVACT_SPIKE_PLUGIN_VERSION: "0.0.1" });
  await adapter.update("/project");
  await adapter.uninstall("/project");
  await adapter.removeMarketplace("/project");
  expect(records).toEqual(expected);
});

it("resolves package bin strings and keyed bins inside its package root", async () => {
  const prefix = await mkdtemp(join(tmpdir(), "navact-bin-")); directories.push(prefix);
  const packageRoot = join(prefix, "node_modules", "@openai", "codex");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ bin: { codex: "bin/codex.js" } }));
  await writeFile(join(packageRoot, "bin", "codex.js"), "#!/usr/bin/env node\n");
  await chmod(join(packageRoot, "bin", "codex.js"), 0o500);
  await expect(resolveNpmPackageBin({ prefix, packageName: "@openai/codex", binName: "codex" })).resolves.toBe(await realpath(join(packageRoot, "bin", "codex.js")));
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ bin: "bin/codex.js" }));
  await expect(resolveNpmPackageBin({ prefix, packageName: "@openai/codex", binName: "codex" })).resolves.toBe(await realpath(join(packageRoot, "bin", "codex.js")));
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ bin: { nope: "bin/codex.js" } }));
  await expect(resolveNpmPackageBin({ prefix, packageName: "@openai/codex", binName: "codex" })).rejects.toThrow("missing package bin");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ bin: "../../escape.js" }));
  await expect(resolveNpmPackageBin({ prefix, packageName: "@openai/codex", binName: "codex" })).rejects.toThrow("escapes package root");
});

it("keeps JS launch prefix arguments internal and passes allowFailure to the runner", async () => {
  const inputs: Parameters<RunCommand>[0][] = [];
  const adapter = createPluginHostAdapter("codex", { displayName: "codex", executable: process.execPath, prefixArgs: ["/absolute/codex.mjs"] }, async (input) => { inputs.push(input); return { command: "codex exec", exitCode: 9, stdout: "private", stderr: "private", startedAtMs: 1, durationMs: 1 }; });
  await adapter.runPrompt("prompt", "/project", { PARENT: "value" }, true);
  expect(inputs[0]).toMatchObject({ executable: process.execPath, prefixArgs: ["/absolute/codex.mjs"], allowFailure: true });
  expect(inputs[0]?.args.slice(0, 2)).toEqual(["exec", "--ephemeral"]);
});

it("rejects a bin symlink escaping the real package root and a directory target", async () => {
  const prefix = await mkdtemp(join(tmpdir(), "navact-bin-")); directories.push(prefix);
  const root = join(prefix, "node_modules", "@openai", "codex"); await mkdir(join(root, "bin"), { recursive: true });
  const outside = join(prefix, "outside.js"); await writeFile(outside, "x");
  await symlink(outside, join(root, "bin", "codex.js")); await writeFile(join(root, "package.json"), JSON.stringify({ bin: "bin/codex.js" }));
  await expect(resolveNpmPackageBin({ prefix, packageName: "@openai/codex", binName: "codex" })).rejects.toThrow("escapes package root");
  await writeFile(join(root, "package.json"), JSON.stringify({ bin: "bin" }));
  await expect(resolveNpmPackageBin({ prefix, packageName: "@openai/codex", binName: "codex" })).rejects.toThrow("not a regular file");
});

it("preserves Claude's successful marketplace update when the plugin update runner rejects", async () => {
  let call = 0;
  const adapter = createPluginHostAdapter("claude-code", { displayName: "claude", executable: "/host/claude", prefixArgs: [] }, async (input) => {
    call += 1; const value = { command: [input.displayName, ...input.args].join(" "), exitCode: 0, stdout: "", stderr: "", startedAtMs: 1, durationMs: 1 };
    if (call === 2) throw Object.assign(new Error("failed"), { observation: { ...value, exitCode: 7 } });
    return value;
  });
  await expect(adapter.update("/project")).rejects.toMatchObject({ partialObservations: [{ command: "claude plugin marketplace update navact-lifecycle-spike-claude" }] });
});
