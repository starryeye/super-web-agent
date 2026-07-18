import { createLifecycleEventRecorder } from "./lifecycle-events.js";
import { startHealthServer } from "./mcp-health-server.js";

const recorder = createLifecycleEventRecorder();
recorder?.record("started");
process.once("exit", (exitCode) => recorder?.record("exiting", { exitCode }));

startHealthServer({
  onHealth: (nonce) => recorder?.record("health", { nonce }),
  onCrashRequested: () => recorder?.record("crash-requested"),
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
