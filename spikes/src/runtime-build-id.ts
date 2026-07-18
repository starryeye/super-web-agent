declare const __NAVACT_SPIKE_RUNTIME_BUILD_ID__: string | undefined;

export const RUNTIME_BUILD_ID =
  typeof __NAVACT_SPIKE_RUNTIME_BUILD_ID__ === "string"
    ? __NAVACT_SPIKE_RUNTIME_BUILD_ID__
    : "direct-test";
