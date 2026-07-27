# Codex Desktop keyless lifecycle acceptance procedure

## Claim boundary

This document defines the manual record required for a future signed-in Codex
Desktop acceptance run. It is not evidence that the run has happened, and it
does not make a Codex Desktop compatibility claim. That claim requires the
next vertical slice to perform and preserve a valid record.

## Prerequisites

- Use a current, signed-in Codex Desktop installation.
- Have the exact local plugin artifact intended for the run, including its
  plugin version and SHA-256 digest.
- Use the packaged plugin contract: `super-web-agent-lifecycle-evidence` and
  its bundled MCP entrypoint.

## Manual procedure

1. Create or select a fresh local marketplace in Codex Desktop using the
   application’s current marketplace workflow, then make the exact local
   plugin artifact available from that marketplace.
2. Install `super-web-agent-lifecycle-evidence` from that local marketplace.
   Confirm the installed version and artifact SHA-256 are the intended values.
3. Start a new Codex task. Do not reuse a task containing prior trial output.
4. Supply a newly generated nonce and ask the task to call `swa_spike_health`
   exactly once with that nonce.
5. Verify the returned structured content preserves the supplied nonce and
   reports the expected platform and Runtime build ID. Confirm that the build
   ID equals the installed plugin version.
6. Remove `super-web-agent-lifecycle-evidence` through Codex Desktop’s current
   plugin-management workflow.
7. Confirm the bundled Runtime process has exited after removal.
8. Create a record accepted by
   `parseCodexDesktopAcceptanceRecord` in
   `spikes/src/codex-desktop-acceptance.ts`. Include only the schema fields;
   use the observed platform, plugin version, artifact digest, and Runtime
   build ID. Mark `status` as `passed` only when installation, bundled MCP
   startup, health-tool verification, structured-result preservation, removal,
   and Runtime exit all passed.
9. Keep `notes` short and sanitized: at most ten single-line notes, each no
   more than 200 characters. Do not record credentials, conversation content,
   absolute user paths, or raw logs.

## Result handling

If any phase did not pass, record `status: "failed"` and the corresponding
phase result. Do not convert a failed or incomplete run into a compatibility
claim. The strict parser rejects malformed records, unknown keys, mismatched
plugin and Runtime versions, and unsafe notes.

The live signed-in Desktop run and any resulting compatibility claim belong to
the next vertical slice. This procedure is intentionally artifact-bound and
application-level; it does not provide environment or transport setup steps.
