# Adding a game

A game is a pure rules definition (`game.ts`) plus a React board (`Board.tsx`). The platform
supplies rooms, lobby, ready/start, host migration, reconnects and timers. Read
`docs/architecture.md` first, then `games/tic-tac-toe` (the template).

## Steps

1. Copy `games/tic-tac-toe` to `games/<name>`. In `package.json` rename the package to
   `@games/<name>`; in `src/game.ts` set `id: "<name>"` (`/^[a-z0-9-]+$/`).
2. Write `src/game.ts` first: `defineGame<State, Action, View, Config>({ id, version, minPlayers,
   maxPlayers, defaultConfig, setup, apply, view, ... })`. Optional: `validateConfig`, `isOver`,
   `deadline` + `onDeadline` (turn timers).
3. Write `src/game.test.ts` with `createTable` from `@games/game/testing` (see below). Run
   `pnpm --filter @games/<name> test` until green. Do not start on the UI before this passes.
4. Write `src/Board.tsx` (`"use client"`, props `GameProps<Action, View, Config>` from
   `@games/react`) and, if the game has settings, `src/Settings.tsx`.
5. `src/index.ts` exports a `GameModule` (definition, title, description, Board, Settings). Keep the
   `exports["./game"]` entry in `package.json`: it lets logic be imported without React.
6. Register it in the web app, in two places: `apps/web/src/catalog.ts` (slug, title,
   description; plain strings) and `apps/web/src/games.ts` (a dynamic `import()`). Add
   `@games/<name>` to `apps/web/package.json` dependencies and to `transpilePackages` in
   `apps/web/next.config.ts`, then `pnpm install`.

## Rules

- State, Action, View and Config are plain JSON (no Map, Set, Date, class instances, undefined).
- `apply(state, action, ctx)` mutates the draft or returns a new state, and must be deterministic:
  use `ctx.random` and `ctx.now`, never `Math.random()` or `Date.now()`. It must not do I/O.
- Reject bad input by throwing `GameError("message")`; the player sees the message. Validate
  everything in an action: it comes from an untrusted client.
- Hide secrets in `view(state, viewer)` (`viewer` is `null` for spectators). Never hide them in the
  UI: every player receives whatever `view` returns.
- Bump `version` whenever the State or Action shape changes (rooms refuse mixed versions).
- Action types starting with `@` are reserved for the runtime (`@ready`, `@start`, ...).
- Import only `@games/game` and `@games/react`. Never `@games/protocol`, `@games/relay-core`,
  `@games/net` or another game.
- `Board` gets `view`, never `state`. `act()` rejects with `GameError` and the shell already shows
  it, so use `act(...).catch(() => {})` unless you need to react.
- Time in the UI comes from `serverNow()`, not `Date.now()`.
- Assets: SVG, WebP, Opus or WOFF2 only, at most 500 KB per file (see `docs/limitations.md`).
- Tailwind classes work in games; the web app scans everything under `games/`.

## Required tests

All through `createTable(game, { players: n })`: `await table.start()`, `await table.act(i, action)`,
`table.view(i)`, `await table.killHost()`, `await table.advance(ms)`. Wrap any other session call
in `table.run(...)`, e.g. `await table.run(table.sessions[0].configure(c))`; a bare `await` on a
session call hangs because nothing is delivered until the table settles.

1. A full round to the end (`sessions[0].getSnapshot().phase === "ended"`, correct winner).
2. Rejected actions: wrong player, illegal move, action after the end (`rejects.toThrow`).
3. Hidden information, if any: other players' views contain none of the secret values.
4. Kill the host after every move (`table.killHost()` then `table.reconnect(oldHost)`) and assert
   the game still finishes with the same result.
5. Deadlines, if any: `table.advance(ms)` fires `onDeadline`.
