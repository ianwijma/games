# Architecture

## The idea in one paragraph

Players meet in a **room** through a six-character **invite code**. One player's
browser is the **host**: it runs the game rules and is the only authority. All
traffic goes through a small **relay** server, which knows nothing about any
game. The relay decides who the host is. When the host disconnects, the relay
picks another player, hands over the last state the old host committed, and the
game continues. No WebRTC, no peer-to-peer connections, no consensus protocol.

```
 player A (host) ──┐
 player B ─────────┼── WebSocket ── relay ── rooms { code, peers, hostId, epoch, checkpoint, alarms }
 player C ─────────┘
```

## Why this replaces what `uno-web` does

`uno-web` uses a WebRTC full mesh (Trystero) and a Raft-style election among the
players. That costs a lot: 66 connections for 12 players, a majority of players
must stay online or the game pauses (a two-player game pauses when either
leaves), and every player holds the full state, including everyone's cards.

With a relay there is one arbiter, so the hard parts go away:

| Problem                                 | `uno-web` today                       | Here                                                                       |
| --------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| Who is the leader?                      | Election with terms and votes         | The relay says so                                                          |
| Two leaders at once                     | Prevented by majority quorum          | Impossible: the relay rejects anything not from the current host and epoch |
| State for the new leader                | Every player keeps a full copy        | The relay keeps the last checkpoint                                        |
| Hidden cards                            | Hidden in the UI only                 | Only the host and the relay hold full state                                |
| Game continues with 1 of 2 players left | No (no majority)                      | Yes                                                                        |
| Connection setup                        | NAT traversal, TURN, Nostr signalling | One WebSocket                                                              |

The cost: the relay must be running, and the host can still read all state in
its own browser memory. See [limitations.md](limitations.md).

## Layout

```
apps/
  relay/        Node process: WebSocket + health endpoint around relay-core
  web/          The site (games.wijma.cloud). Next.js, static export. Mounts games.
packages/
  protocol/     Wire types, limits, validation, encode/decode. No dependencies.
  relay-core/   Rooms, host election, checkpoints, alarms. Pure logic, no I/O.
  net/          Client: transports, RoomClient (connect, resume, reconnect, clock).
  game/         defineGame + the turn-based runtime (lobby, host, replica) + test harness.
  react/        Hooks and the default lobby/shell UI.
games/
  tic-tac-toe/  The template game. Copy it to start a new one.
docs/
```

Dependency direction is one way: `protocol` ← `relay-core` ← `net` ← `game` ←
`react` ← games ← `apps/web`. A game never imports `relay-core` or `protocol`.

Packages are consumed as TypeScript source (their `exports` point at `src/`).
There is no build step for packages, so there is nothing to rebuild or get stale
between an edit and a test run. Only the two apps build.

## The relay

`relay-core` is a state machine with no I/O: `hub.connect(connection)` returns a
session with `receive(message)` and `disconnected()`. Time comes from an
injected clock. That makes every behaviour testable in milliseconds with a fake
clock, and lets the browser run the same code in-process (see "Local play").

`apps/relay` is the thin Node shell: one HTTP server, WebSocket on `/ws`,
`/healthz`, origin allowlist, per-IP connection cap, heartbeat pings.

Rules the relay enforces (the full list is the doc comments in
`packages/protocol/src/index.ts`):

- **Star topology.** A non-host may only send to the host. The host may send to
  anyone. Players cannot message each other directly, so they cannot spoof.
- **Election.** The earliest-joined connected peer with `canHost` becomes host.
  A connected host is never displaced. Every change increments `epoch`.
- **Epoch fencing.** Host-only messages carry the epoch. A former host with a
  half-dead socket is rejected, so it can never overwrite newer state.
- **Atomic commit.** `commit { seq, state, out }` stores the checkpoint and then
  delivers the outgoing messages, in one step. No player ever sees a state newer
  than the checkpoint the next host would resume from. The relay answers the
  host with `committed`; the host shows its own move only then, so a host that
  was replaced without knowing it never believes a move went through.
- **Seats outlive sockets.** A dropped peer keeps its seat. It returns with its
  resume token, including after a page reload. `leave` and `kick` free the seat.
- **Alarms.** The host asks for a wake-up at a relay-clock time. The relay
  delivers it to whoever is host then. Turn timers survive migration and do not
  depend on browser timers.
- **Rooms expire** 30 minutes after the last peer disconnects.

## Two modes, one concept

The room model is the same for both. What differs is how state moves.

|                   | `turn`                                            | `realtime`                                  |
| ----------------- | ------------------------------------------------- | ------------------------------------------- |
| State change      | One `commit` per accepted action                  | Host simulates at a fixed tick              |
| Sent to players   | Their view, reliable                              | Snapshots on the volatile channel, 10-20 Hz |
| Sent to host      | Actions, reliable, retried until acknowledged     | Inputs on the volatile channel              |
| Checkpoint        | Every commit                                      | Periodic (for example once a second)        |
| Lost on migration | Nothing                                           | Up to one checkpoint interval               |
| Host tab hidden   | Fine: the host only reacts to messages and alarms | Host hands off voluntarily (`handoff`)      |

The relay already implements both channels: `reliable` is ordered and never
dropped, `volatile` is skipped for a recipient whose socket is backed up. The
turn-based runtime is built. The real-time runtime (`@games/realtime`: tick
loop in a worker, input buffer, snapshot interpolation) is designed but not
built; it needs no protocol change.

## Writing a game

A game is a pure definition. It never touches the network.

```ts
export const game = defineGame<State, Action, View, Config>({
  id: "tic-tac-toe",
  version: 1,
  minPlayers: 2,
  maxPlayers: 2,
  defaultConfig: {},
  setup({ players, config, random }) {
    /* return the initial State */
  },
  apply(state, action, { actor, random, now }) {
    /* mutate the draft, or throw GameError */
  },
  view(state, viewer) {
    /* what this player may see */
  },
});
```

The runtime does the rest:

- **Lobby.** Players, ready flags, settings, owner, start, back to lobby.
- **Host role.** Validates the actor, calls `apply` on a copy of the state,
  commits, and sends each player their `view`.
- **Replica role.** Holds the latest view. Sends actions with a sequence number
  and resends anything unacknowledged after a host change. The host ignores
  sequence numbers it has already applied, so nothing is applied twice.
- **Switching roles.** Every client can do both. When the relay promotes a
  client it loads the checkpoint and carries on. Game code does not notice.
- **Determinism.** `random` is a seeded generator whose state is part of the
  checkpoint. `now` is the relay clock. `apply` must not read `Math.random()`
  or `Date.now()`.

## Local play and tests

`net` has two transports behind one interface: a WebSocket to a real relay, and
a local one that runs `relay-core` in the same process. Single-player games,
unit tests and offline development use the local one. There is no second code
path to maintain.

`@games/game/testing` builds a table of simulated players on a fake clock. A
test can make moves, drop any player, kill the host mid-game, and assert the
game is still consistent. Every new game should have a "kill the host at every
step" test; it is a few lines.

## Behaviour players can rely on

These came out of fixing `uno-web` by hand. Here the platform provides them, so
a game gets them without writing anything. Each is covered by a test.

- **Reload returns you to where you were**: same seat, same lobby settings and
  ready flag, same game state. True for the host, for a guest, and when
  everyone reloads at once.
- **Closing the tab and coming back works**, through the invite link or just
  the game's page. The seat is kept per browser, not per tab.
- **Leave means leave.** After pressing Leave, a reload shows the entry screen.
- **The owner keeps the role through a reload.** Ownership passes on only after
  the owner has been gone for 15 seconds, or has left.
- **A turn timer keeps running** through reloads, disconnects and host changes,
  and fires exactly once.
- **A move is never applied twice and never silently lost**, including when it
  was sent while the host was changing.
- **Nobody can join a game in progress**; seated players can always come back.

Not provided yet, and `uno-web` has them: animation cues that play for live
moves but not when a state is restored, a "flaky" presence state between
connected and disconnected, and toasts for connection lost and restored. Opening
the same room in two tabs of one browser moves the seat to the newest tab, where
`uno-web` treated each tab as a separate player.

## Compatibility

A deployed relay will meet old cached clients. Three numbers guard this:

- `PROTOCOL_VERSION`: relay and client must match, else `unsupported-version`.
- `gameVersion` (from the game definition): everyone in a room must match, else
  `game-mismatch`. Bump it when the state or action shape changes.
- The web app serves hashed assets, so a reload always gets the current client.

## Decisions and their reasons

| Decision                                             | Reason                                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm workspaces + Turborepo                           | npm ships with Node, so there is nothing extra to install. A CI check keeps one version of each dependency across all games. Turbo caches and runs only what changed.     |
| TypeScript 5.9, not 7.0                              | 7.0 is weeks old. All three existing repos and Next 16.4 are on 5.x.                                                                                                      |
| Packages as source, no package builds                | Least configuration, nothing stale. Revisit if type-checking gets slow.                                                                                                   |
| One Next.js app with a route per game, static export | Simplest for 10-30 small games. A game is a plain React package, so moving a heavy one to its own app later is cheap.                                                     |
| No Effect in `protocol`, `relay-core`, `net`, `game` | Game rules are pure functions. Effect would add bundle size and a learning step to the layer agents write against. It remains an option for the relay shell and app code. |
| JSON text frames                                     | Fine for turn-based. All encoding sits behind `encode`/`decode` for a later binary format.                                                                                |
| Biome for lint and format                            | One fast tool, one config.                                                                                                                                                |
