import { isAbsolute, resolve } from "node:path";
import { resolveNpmPackageBin } from "../src/plugin-host-adapters.js";

async function main(): Promise<void> {
  const [prefixArgument, packageName, binName, ...extra] = process.argv.slice(2);
  if (prefixArgument === undefined || packageName === undefined || binName === undefined || extra.length !== 0) throw new Error("usage");
  const prefix = resolve(process.cwd(), prefixArgument);
  if (!isAbsolute(prefix) || (packageName !== "@anthropic-ai/claude-code" && packageName !== "@openai/codex") || (binName !== "claude" && binName !== "codex")) throw new Error("usage");
  process.stdout.write(`${await resolveNpmPackageBin({ prefix, packageName, binName })}\n`);
}
main().catch(() => { process.stderr.write("could not resolve host CLI\n"); process.exitCode = 1; });
