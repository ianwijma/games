# Working in this repo

Monorepo for the games on games.wijma.cloud and the shared libraries that make a
multiplayer game quick to build. npm workspaces, Turborepo, TypeScript.

## Read before you change anything

- `docs/architecture.md`: how rooms, the host and the relay work, and why.
- `games/README.md`: how to add a game. Most tasks here are this.
- `docs/design.md`: how every screen should look and behave on a phone. Read
  it before writing any UI.
- `docs/releasing.md`: how a version is released and deployed. Never start a
  release or push a `v*` tag yourself.
- `docs/limitations.md`: asset budget, known limits, what is not built yet.
- `docs/game-catalog.md`: the games the core is designed for. Add a row there
  before adding a core feature.

## Layout

| Path                  | What                                           | Depends on           |
| --------------------- | ---------------------------------------------- | -------------------- |
| `packages/protocol`   | Wire types, limits, validation                 | nothing              |
| `packages/relay-core` | Rooms, host election, checkpoints. Pure logic. | protocol             |
| `packages/net`        | Client connection, reconnect, transports       | protocol, relay-core |
| `packages/game`       | `defineGame`, turn-based runtime, test harness | net                  |
| `packages/react`      | `GameShell` (entry, lobby), hooks              | game                 |
| `games/*`             | One package per game                           | game, react          |
| `apps/relay`          | Node WebSocket server around relay-core        | relay-core           |
| `apps/web`            | The site. Next.js static export.               | react, games         |

Imports go down this table only. A game imports `@games/game` and
`@games/react`, nothing else from the workspace, and never another game.

## Commands

```sh
npm install
npm run dev                              # relay on :6767 and the site on :3000
npm test -w @games/<name>      # one package (preferred while working)
npm run typecheck -w @games/<name>
npm run lint                             # biome; `npm run format` fixes
npm run loadtest -w @games/relay   # relay capacity; see docs/deployment.md
npm run ramp -w @games/relay       # add rooms until the relay fails
npm test && npm run typecheck && npm run build   # everything; slow, run once before finishing
```

## Rules

- Packages are consumed as TypeScript source (`exports` point at `src/`). Do not
  add build steps to packages. Use extensionless relative imports and
  `import type` for types.
- Dependencies: every package that uses a dependency must name the same exact
  version of it. `node scripts/check-versions.mjs` enforces it in CI. Declare
  what you import; npm lets undeclared imports work by accident. `protocol`, `relay-core`,
  `net` and `game` take no runtime dependencies.
- Game rules are pure and deterministic. No `Math.random()`, `Date.now()`,
  timers or I/O in `setup`, `apply`, `view` or `onDeadline`.
- Changing `packages/protocol` changes the contract between a deployed relay and
  cached clients. Bump `PROTOCOL_VERSION` for anything not backwards compatible.
- Every behaviour change in `relay-core`, `net` or `game` needs a test. Host
  migration bugs are subtle: reproduce with `createTable` first, then fix.
- Next.js 16 and Tailwind 4 differ from older versions. Check the installed
  package's docs instead of relying on memory.
- Binary assets: SVG, WebP, Opus, WOFF2 only, 500 KB per file, 20 MB per game.
  `node scripts/check-assets.mjs` enforces it in CI.
- Do not recreate an existing commercial game's name, artwork or exact content.
  Games in the same genre with their own identity are fine.
