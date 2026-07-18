import { startHealthServer } from "./mcp-health-server.js";

startHealthServer().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
