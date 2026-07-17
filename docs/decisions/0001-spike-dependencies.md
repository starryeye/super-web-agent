# Spike Dependency Decision

Status: Accepted for disposable architecture spikes only.

- `@modelcontextprotocol/sdk` and `zod`: exercise a real stdio MCP server rather than a partial protocol. Production adoption requires a separate API-stability review.
- `esbuild`: produce the one CommonJS bundle required by Node 24 SEA. It is build-only, and its required install script is the sole entry in pnpm's `allowBuilds` map.
- `postject`: inject the SEA preparation blob using Node 24's documented flow. It is spike-only.
- `vitest`, `typescript`, and `@types/node`: provide strict type checking and TDD. They are development-only.

No dependency in this record is approved for production merely because this spike uses it.
