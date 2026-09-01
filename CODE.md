# Code

## Role

Pi package skeleton for `@xl0/pi-lovely-agents`. Runtime behavior has not
been designed or implemented yet.

## Layout

- `extensions/lovely-agents/index.ts`: no-op extension entrypoint
- `package.json`: package metadata, Pi discovery, and Bun tooling
- `scripts/release.ts`: interactive release driver
- `.github/workflows/publish.yml`: tag-triggered npm/GitHub release pipeline

The package is ESM. Pi discovers `./extensions` through the package manifest.
`@earendil-works/pi-coding-agent` is a peer dependency.

## Tooling and release

TypeScript is strict and checks `extensions/`; Biome handles formatting and
linting. `bun run check` runs both.

The unreleased package starts at `0.0.0`; the first minor release becomes
`0.1.0`. `bun run release` verifies and bumps locally, then pushes a `v*` tag.
CI verifies the tag, stages the package on npm with OIDC provenance, and creates
a GitHub Release. The local release driver asks for 2FA to approve the staged
npm version.
