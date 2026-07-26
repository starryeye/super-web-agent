import { RUNTIME_BUILD_ID } from "./runtime-build-id.js";
import { startHealthServer } from "./mcp-health-server.js";
import { createRuntimeSessionId } from "./runtime-session.js";

const identity = {
  runtimeSessionId: createRuntimeSessionId(),
  runtimeBuildId: RUNTIME_BUILD_ID,
};

startHealthServer(identity).catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
