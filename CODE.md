# Code

## Role

Pi package for durable agent orchestration. The broader runtime is still in
design; `/continue` is available independently.

## Layout

- `extensions/lovely-agents/index.ts`: extension entrypoint and `/continue`
- `package.json`: package metadata, Pi discovery, and Bun tooling
- `scripts/release.ts`: interactive release driver
- `.github/workflows/publish.yml`: tag-triggered npm/GitHub release pipeline

The package is ESM. Pi discovers `./extensions` through the package manifest.
`@earendil-works/pi-coding-agent` is a peer dependency.

`/continue` sends a hidden empty custom message with Follow-up delivery and
`triggerTurn: true` when the parent is idle. This resumes Pi's normal prompt
path without adding visible prompt text. It refuses to queue duplicate work
while the parent is already running and does nothing unless the latest
assistant reply ended with `error` or `aborted`.

## Tooling and release

TypeScript is strict and checks `extensions/`; Biome handles formatting and
linting. `bun run check` runs both.

The unreleased package starts at `0.0.0`; the first minor release becomes
`0.1.0`. `bun run release` verifies and bumps locally, then pushes a `v*` tag.
CI verifies the tag, stages the package on npm with OIDC provenance, and creates
a GitHub Release. The local release driver asks for 2FA to approve the staged
npm version.
