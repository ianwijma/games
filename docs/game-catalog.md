# Game catalog: what the core must support

The core is only as good as the games it makes easy. This file lists games we
expect to host (two real, the rest imagined on purpose to cover different
shapes) and what each one demands from the shared libraries. Add a row before
adding a core feature: if no game needs it, we do not build it.

Status key: **v1** = built now. **designed** = the protocol and package
boundaries already allow it, nothing is built. **later** = needs new design.

## The games

| #   | Game                                                          | Shape                                                     | What it stresses                                                                                                           |
| --- | ------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Ohno!** (`games/ohno`, built)                               | Turn-based cards, 2-12 players                            | Hidden hands, turn timer, house-rule settings, lobby with colours and ready flags, rejoin after reload                     |
| 2   | **Soap Tank arena**                                           | Real-time, 2-8 friends, canvas                            | 20-60 Hz simulation, input streaming, snapshots, host migration mid-fight, sprite and audio assets                         |
| 3   | **Soap Tank battle royale**                                   | Real-time, 30-100 strangers                               | No invite code (matchmaking), no player can be trusted as host, interest management                                        |
| 4   | Sketch and guess (party drawing game)                         | Rounds with timers, 3-12 players                          | High-rate stroke stream that is not game state, a secret word only the drawer sees, late joiners, spectators, chat         |
| 5   | Big-screen quiz (TV shows the board, phones are buzzers)      | Simultaneous hidden answers, 2-30 players                 | Unequal roles (a display that is not a player), devices that must never host, phones that sleep and reconnect, fair timing |
| 6   | Long board game (tile-and-trade strategy, 3-6 players)        | Turn-based, sessions of hours, sometimes resumed next day | Everyone leaves and comes back, large state, save and resume, trades between two players                                   |
| 7   | Social deduction (hidden roles, day and night phases)         | Phase-based, 5-15 players                                 | Per-player and per-team secrets, votes, a host who must not peek                                                           |
| 8   | Co-op arcade or racing (2-4 players)                          | Real-time                                                 | Low latency, client prediction, clock sync                                                                                 |
| 9   | Space trading sim                                             | Single-player first, long-running simulation              | Runs with no server at all, save games, a simulation tick that outlives the page                                           |
| 10  | Classic two-player abstract (tic-tac-toe, connect-four style) | Turn-based, 2 players                                     | The smallest possible game. It is the template agents copy.                                                                |

## What that demands from the core

| Requirement                                                                          | Needed by       | Status                         | Where it lives                                                              |
| ------------------------------------------------------------------------------------ | --------------- | ------------------------------ | --------------------------------------------------------------------------- |
| Room by invite code, join, leave, kick, lock                                         | all multiplayer | v1                             | `relay-core`, `net`                                                         |
| One authoritative host, picked and replaced by the relay                             | 1, 2, 4-8, 10   | v1                             | `relay-core`                                                                |
| Lossless host migration for turn-based (atomic commit = checkpoint + fan-out)        | 1, 4-7, 10      | v1                             | `relay-core`, `game`                                                        |
| Seat survives a reload or dropped connection (resume token)                          | all multiplayer | v1                             | `relay-core`, `net`                                                         |
| Per-player views of state (hidden information)                                       | 1, 4, 5, 7      | v1                             | `game` (`view(state, viewer)`)                                              |
| Lobby as a platform feature: players, ready, settings, owner, start, rematch         | 1, 4-7, 10      | v1                             | `game`                                                                      |
| Owner (who may start or change settings) is separate from network host               | 1, 5, 6         | v1                             | `game`                                                                      |
| Seeded randomness and injected time, so logic is deterministic and testable          | all             | v1                             | `game`                                                                      |
| Deadlines that fire even if the host tab is asleep, and survive migration            | 1, 4, 5, 7      | v1                             | relay alarms                                                                |
| Same game code runs with no server (single-player, tests, local dev)                 | 9, all tests    | v1                             | `net` local transport runs the relay in-process                             |
| Test harness: N simulated players, kill the host at any step                         | all             | v1                             | `@games/game/testing`                                                       |
| React bindings and a default lobby UI                                                | all             | v1                             | `react`                                                                     |
| Devices that never host (`canHost: false`)                                           | 5               | v1 (relay)                     | `relay-core`                                                                |
| Spectators and late joiners                                                          | 4, 5, 7         | designed                       | a peer that is in the room but not seated in the game                       |
| Bots that fill seats                                                                 | 1, 6            | designed                       | run on the host, state is in the checkpoint, so they migrate for free       |
| Ephemeral streams that bypass state (strokes, cursors, emotes)                       | 4               | designed                       | host `send` without commit; a direct peer broadcast needs a new room option |
| Volatile channel, dropped when a socket is backed up                                 | 2, 8            | v1 (relay), designed (runtime) | `relay-core`                                                                |
| Real-time runtime: fixed tick, inputs, snapshots, interpolation, periodic checkpoint | 2, 8            | designed                       | future `@games/realtime`                                                    |
| Voluntary host handoff when the host tab is hidden                                   | 2, 8            | v1 (relay), designed (runtime) | `handoff` message                                                           |
| Clock sync (relay time, round-trip estimate)                                         | 5, 8            | v1 (ping/pong)                 | `net`                                                                       |
| Save and resume beyond the life of a room                                            | 6, 9            | designed                       | host exports the checkpoint to IndexedDB, new room is created from it       |
| Simultaneous secret submissions                                                      | 5, 7            | works today                    | plain actions plus `view` hiding until reveal                               |
| Private messages between two players                                                 | 6, 7            | works today                    | state plus `view`                                                           |
| Authority that runs on the server instead of a player                                | 3, 7            | later                          | run the same game definition inside the relay as a virtual host             |
| Matchmaking without a code                                                           | 3               | later                          | a queue in front of rooms. A code is one way into a room, not the only one  |
| Binary snapshots, interest management, WebTransport                                  | 3               | later                          | behind `encode`/`decode` and the transport interface                        |
| Voice or video                                                                       | maybe 7         | out of scope                   | would need WebRTC or an SFU                                                 |
| Accounts, friends, persistent stats                                                  | none yet        | out of scope                   |                                                                             |

## What the imagined games changed in the design

1. **The lobby moved out of game state.** In `uno-web` joining, ready flags and
   the owner are inside the rules reducer. Games 4, 5, 6 and 7 all need the same
   lobby, so the runtime owns it and a game only receives `setup({ players, config })`.
2. **Owner is not host.** The network host is an implementation detail that can
   move at any moment. The owner is the person who may press Start. Game 5 makes
   this obvious: the TV is the display, a phone is the owner, and either could
   be the host.
3. **Timers belong to the relay.** Games 1, 4, 5 and 7 have deadlines. Browser
   timers in a hidden tab are throttled, and a migrating host would lose them.
   The host asks the relay for an alarm and the relay delivers it to whoever is
   host at that time.
4. **The relay stores the checkpoint, not the players.** `uno-web` gives every
   player the full state so anyone can take over, which also lets anyone read
   every hand. Games 1, 4, 5 and 7 need secrets, so only the host and the relay
   hold full state and each player gets a view.
5. **Authority is a role, not a place.** Games 3 and 7 cannot trust a player's
   browser. A game definition is pure (`setup`, `apply`, `view`), so the same
   code can later run inside the relay. Nothing in a game may assume it runs in
   a browser.
6. **A room is not tied to a code.** Game 3 enters rooms through matchmaking.
   The relay keeps "how you got in" separate from "what a room is".
7. **Local play is the same code path.** Game 9 and every test run the relay
   logic in-process. There is no separate single-player API to keep in sync.
