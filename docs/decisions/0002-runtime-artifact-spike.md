# Runtime Artifact Spike Decision

Status: Accepted

## Decision boundary

This ADR evaluates only whether one minimal MCP Runtime can run as a self-contained artifact on darwin-arm64 and win32-x64 without Host Node on PATH. It does not approve production signing, host plugin lifecycle, localhost pairing, browser automation, or performance claims.

## Evidence

| Platform | Gate | SEA bytes | Start samples (ms) | OS signing |
| --- | --- | ---: | --- | --- |
| darwin-arm64 | pass | 120060448 | 458.05, 434.10, 370.03 | ad-hoc |
| win32-x64 | pass | 92643328 | 1572.81, 1549.06, 1518.16 | unsigned-test |

## Reasons

- both target platforms passed the self-contained Runtime artifact gate

## Follow-ups

- darwin-arm64 uses ad-hoc code signing; production signing and notarization remain unresolved
- win32-x64 uses an unsigned test binary; production Authenticode signing remains unresolved

## Consequence

Proceed to the separate Claude Code and Codex plugin lifecycle spike using this artifact format.

Ephemeral Ed25519 keys, ad-hoc macOS signatures, and unsigned Windows test binaries are not production release artifacts.
