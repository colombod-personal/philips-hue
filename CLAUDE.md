# philips-hue — working notes for coding agents

Device-centric Philips Hue SDK (CLIP v2) for agents and applications. MIT licensed; only MIT-compatible dependencies are allowed (see `docs/research.md` for the licensing table).

## Layout

- `packages/core` — `@hue-sdk/core`, zero runtime dependencies. Discovery (mDNS + cloud), pairing (link button), TLS pinning, CLIP v2 client, SSE event stream, and the device model (`HueBridge` → `HueDevice` → lights/sensors).
- `packages/cli` — `@hue-sdk/cli`, the `hue` command. Every command has `--json`.
- `packages/mcp` — `@hue-sdk/mcp`, a stdio MCP server exposing the same model as tools.
- `skills/hue` — an agent skill (OpenClaw / Claude Code style `SKILL.md`) that teaches an agent to use the CLI.
- `docs/` — architecture, research notes, security model.

## Commands

```sh
pnpm install
pnpm build        # core must be built before cli/mcp tests (they import dist via workspace links)
pnpm test         # node:test, runs against an in-process fake bridge (needs `openssl` on PATH)
pnpm typecheck
```

## Conventions

- TypeScript, ESM, `strict` + `exactOptionalPropertyTypes`. Keep `packages/core` dependency-free.
- CLIP v2 resource types live in `packages/core/src/types.ts`; keep them permissive (index signatures) because the bridge adds fields over firmware releases.
- Anything agents consume must be plain JSON: add to `packages/core/src/model/snapshot.ts`, not to class shapes.
- Errors are `HueError` with a stable `code`; never throw bare strings.
- Never log or print application keys; the CLI redacts them.
- Tests must not need real hardware: extend `packages/core/src/test-support/fake-bridge.ts` and `fixtures.ts` instead.
- No `rejectUnauthorized: false` outside `identify` (which exists to learn the certificate to pin) and the explicit `insecure` option.
