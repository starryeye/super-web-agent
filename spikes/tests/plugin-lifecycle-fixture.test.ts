import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  activatePluginFixtureVersion,
  buildPluginLifecycleFixtures,
  parsePluginLifecycleFixtureIndex,
} from "../src/plugin-lifecycle-fixture.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "navact-plugin-fixture-"));
  directories.push(directory);
  const executableName = process.platform === "win32" ? "navact-runtime.exe" : "navact-runtime";
  const v1 = join(directory, "runtime-v1", executableName);
  const v2 = join(directory, "runtime-v2", executableName);
  await mkdir(join(directory, "runtime-v1"));
  await mkdir(join(directory, "runtime-v2"));
  await writeFile(v1, "self-contained-runtime-v1");
  await writeFile(v2, "self-contained-runtime-v2");
  return { directory, executableName, v1, v2 };
}

it("uses identical Runtime bytes across hosts but distinct bytes across versions", async () => {
  const value = await fixture();
  const index = await buildPluginLifecycleFixtures({
    artifacts: { "0.0.1": value.v1, "0.0.2": value.v2 },
    outputRoot: join(value.directory, "output"),
    platform: `${process.platform}-${process.arch}` as "darwin-arm64" | "win32-x64",
  });
  expect(index.versions).toEqual(["0.0.1", "0.0.2"]);
  expect(parsePluginLifecycleFixtureIndex(JSON.parse(
    await readFile(join(value.directory, "output", "fixture-index.json"), "utf8"),
  ))).toEqual(index);
  expect(index.runtimeArtifacts["0.0.1"].sha256).not.toBe(index.runtimeArtifacts["0.0.2"].sha256);
  for (const version of ["0.0.1", "0.0.2"] as const) {
    const expectedDigest = createHash("sha256")
      .update(await readFile(version === "0.0.1" ? value.v1 : value.v2))
      .digest("hex");
    expect(index.runtimeArtifacts[version].sha256).toBe(expectedDigest);
    for (const host of ["claude-code", "codex"] as const) {
      const executable = join(
        value.directory,
        "output",
        "versions",
        version,
        host,
        "plugins",
        "navact-lifecycle-spike",
        "bin",
        value.executableName,
      );
      expect(createHash("sha256").update(await readFile(executable)).digest("hex")).toBe(expectedDigest);
      if (process.platform !== "win32") {
        expect((await stat(executable)).mode & 0o111).not.toBe(0);
      }
    }
  }
});

it("renders host-specific cache-safe MCP launch paths with an empty PATH", async () => {
  const value = await fixture();
  await buildPluginLifecycleFixtures({
    artifacts: { "0.0.1": value.v1, "0.0.2": value.v2 },
    outputRoot: join(value.directory, "output"),
    platform: `${process.platform}-${process.arch}` as "darwin-arm64" | "win32-x64",
  });
  const claude = JSON.parse(
    await readFile(join(value.directory, "output", "versions", "0.0.1", "claude-code", "plugins", "navact-lifecycle-spike", ".mcp.json"), "utf8"),
  );
  const codex = JSON.parse(
    await readFile(join(value.directory, "output", "versions", "0.0.1", "codex", "plugins", "navact-lifecycle-spike", ".mcp.json"), "utf8"),
  );
  expect(claude.mcpServers.navact_lifecycle.command).toBe(
    `\${CLAUDE_PLUGIN_ROOT}/bin/${value.executableName}`,
  );
  expect(claude.mcpServers.navact_lifecycle.env.PATH).toBe("");
  expect(codex.mcpServers.navact_lifecycle).toMatchObject({
    command: `./bin/${value.executableName}`,
    cwd: ".",
    env: { PATH: "", NAVACT_SPIKE_HOST: "codex" },
    env_vars: ["NAVACT_SPIKE_EVIDENCE_PATH", "NAVACT_SPIKE_RUN_ID"],
  });
  const marketplace = JSON.parse(
    await readFile(join(value.directory, "output", "versions", "0.0.1", "codex", ".agents", "plugins", "marketplace.json"), "utf8"),
  );
  expect(marketplace).toMatchObject({
    name: "navact-lifecycle-spike-codex",
    plugins: [{ name: "navact-lifecycle-spike", source: "./plugins/navact-lifecycle-spike" }],
  });
});

it("activates one complete version without linking to its source directory", async () => {
  const value = await fixture();
  await buildPluginLifecycleFixtures({
    artifacts: { "0.0.1": value.v1, "0.0.2": value.v2 },
    outputRoot: join(value.directory, "output"),
    platform: `${process.platform}-${process.arch}` as "darwin-arm64" | "win32-x64",
  });
  const active = await activatePluginFixtureVersion({
    outputRoot: join(value.directory, "output"),
    host: "codex",
    version: "0.0.2",
  });
  expect(JSON.parse(await readFile(join(active, "plugins", "navact-lifecycle-spike", ".codex-plugin", "plugin.json"), "utf8"))).toMatchObject({
    name: "navact-lifecycle-spike",
    version: "0.0.2",
    mcpServers: "./.mcp.json",
  });
});
