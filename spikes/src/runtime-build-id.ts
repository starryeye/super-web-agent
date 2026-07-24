declare const __SWA_SPIKE_RUNTIME_BUILD_ID__: string | undefined;

export const RUNTIME_BUILD_ID =
  typeof __SWA_SPIKE_RUNTIME_BUILD_ID__ === "string"
    ? __SWA_SPIKE_RUNTIME_BUILD_ID__
    : "direct-test";
