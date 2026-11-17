# Deployment and sizing

Status: a plan. Nothing is deployed yet. The sizing numbers are measured, on
one development machine, and need repeating on the real server (see
"Validating").

## What gets deployed

| Piece     | What it is                                                | Where                  | State it holds        |
| --------- | --------------------------------------------------------- | ---------------------- | --------------------- |
| **Site**  | Static files from `apps/web/out`                          | Any static host or CDN | None                  |
| **Relay** | One Node process, one container (`apps/relay/Dockerfile`) | Homelab, later a VPS   | Rooms, in memory only |

There is no database. The site can be served from anywhere. Everything below
that concerns capacity is about the relay.

## Recommended setup

```
players ── HTTPS ──> games.wij.ma          static site on a CDN (Cloudflare Pages or similar)
players ── WSS ───> relay.games.wij.ma ──> tunnel or reverse proxy ──> relay container :8787
```

- **Site on a CDN, not at home.** It is free at this size, it is fast
  everywhere, and it keeps page loads off the home uplink, which the numbers
  below show is the scarce resource.
- **Relay in the homelab** as a container with a memory limit and
  `restart: unless-stopped`, reached through a tunnel (no open ports, works
  behind CG-NAT) or a reverse proxy. Either must forward WebSocket upgrades on
  `/ws` and must not buffer.
- **Separate hostname for the relay**, so it can move to a VPS later by
  changing one DNS record and nothing in the site.

### Relay configuration

| Variable          | Production value       | Why                                                                            |
| ----------------- | ---------------------- | ------------------------------------------------------------------------------ |
| `PORT`            | `8787`                 |                                                                                |
| `ALLOWED_ORIGINS` | `https://games.wij.ma` | Stops other sites using the relay from browsers                                |
| `ALLOWED_GAMES`   | the game ids we ship   | Stops the relay being used for anything else                                   |
| `TRUST_PROXY`     | `1`                    | Only behind exactly one proxy; needed for the per-IP cap to see real addresses |
| `MAX_CONN_PER_IP` | `32`                   | Raise if many players share one address (a school, an office)                  |

Also: open-file limit at least twice the expected socket count (one file per
connection), a health check on `GET /healthz`, and a container memory limit of
about twice the expected peak from the table below.

### Site configuration

`NEXT_PUBLIC_RELAY_URL=wss://relay.games.wij.ma/ws` at build time. It is baked
into the build, so changing the relay address means rebuilding the site.

## Rolling out a change

1. **Site only** (UI, a new game): build and upload. Players in a game keep
   playing on the old code until they reload.
2. **A game's state or action shape changed**: bump that game's `version`.
   Rooms refuse to mix versions, so old tabs get "refresh to update" on their
   next join instead of corrupting a game.
3. **Relay**: restarting it **ends every room**, because rooms live in memory.
   Clients reconnect on their own, but their rooms are gone. Until checkpoints
   are persisted (not built), deploy the relay when `/healthz` shows few rooms,
   and keep relay deploys rare.
4. **Protocol change** (`PROTOCOL_VERSION`): deploy the relay and the site
   together. Old tabs are refused with a clear error and must reload.
5. **Rollback**: redeploy the previous site build or the previous relay image
   tag. Nothing to migrate.

Continuous deployment is not set up. The intended shape: CI builds the relay
image and pushes it to a registry on merge; the homelab pulls a tagged image on
demand, not automatically, because of point 3.

## How much server does it need?

### Measured

Run with `pnpm --filter @games/relay loadtest` on 2026-11-18. One relay
process, real WebSocket clients, all on one machine (Ryzen 9 7945HX), over
loopback, no TLS and no proxy. Latency is from a player's move leaving the
client to the resulting view arriving back.

**Turn-based** (4 players per room, 8 KB of game state, each room makes a move
every 5 seconds on average, which is brisk):

| Rooms | Players | Relay memory | Relay CPU (one core) | Outbound traffic | Latency p50 / p99 |
| ----: | ------: | -----------: | -------------------: | ---------------: | ----------------: |
|   100 |     400 |        89 MB |                   3% |         2 Mbit/s |      1.1 / 5.8 ms |
| 1,000 |   4,000 |       151 MB |                  10% |        20 Mbit/s |      0.6 / 1.3 ms |
| 5,000 |  20,000 |       409 MB |                  41% |       101 Mbit/s |       0.6 / 88 ms |

A 10,000-room run did not finish connecting within the time limit on this
machine, so there is no figure for it.

**Real-time** (8 players per room, 20 snapshots a second of 1 KB each, inputs
at 20 a second). The real-time runtime is not built; this is the relay carrying
that traffic shape:

| Rooms | Players | Relay memory | Relay CPU (one core) | Outbound traffic | Latency p50 / p99 |
| ----: | ------: | -----------: | -------------------: | ---------------: | ----------------: |
|    50 |     400 |       115 MB |                  22% |        68 Mbit/s |      0.3 / 1.1 ms |
|   200 |   1,600 |       129 MB |                  82% |       270 Mbit/s |      1.9 / 5.5 ms |

### What the numbers say

- **Memory is not the constraint.** About 65 MB for the empty process plus
  roughly 70 KB per turn-based room. A thousand rooms fit in a quarter of a
  gigabyte.
- **CPU is not the constraint for turn-based games.** About 8% of one core per
  thousand rooms. The relay is single-threaded, so one process tops out
  somewhere near ten thousand turn-based rooms.
- **Upload bandwidth is the constraint.** Every move sends each player their
  full view. At the test's sizes that is about 20 kbit/s per room, so a home
  connection with 40 Mbit/s of upload carries about 2,000 turn-based rooms and
  nothing else.
- **Real-time is a different scale.** About 1.35 Mbit/s and 0.4% of a core per
  8-player room. One process handles about 200 rooms; a 40 Mbit/s home uplink
  handles about 30.

### Specifications

Sized with about twice the measured need. "Rooms" means rooms being played at
the same moment, not rooms created per day.

**Turn-based games**

| Concurrent rooms | Players | CPU                        | Memory limit | Upload needed | Where                                                     |
| ---------------: | ------: | -------------------------- | -----------: | ------------: | --------------------------------------------------------- |
|         up to 50 |     200 | 1 shared vCPU              |       256 MB |      2 Mbit/s | Homelab                                                   |
|        up to 500 |   2,000 | 1 vCPU                     |       512 MB |     20 Mbit/s | Homelab with a good uplink                                |
|      up to 2,000 |   8,000 | 1 dedicated vCPU           |         1 GB |     80 Mbit/s | VPS                                                       |
|      up to 5,000 |  20,000 | 2 vCPU (relay + TLS proxy) |         2 GB |    200 Mbit/s | VPS                                                       |
|             more |         |                            |              |               | Several relay processes, rooms routed by code (not built) |

**Real-time games** (in addition to the above)

| Concurrent rooms | Players | CPU              | Memory limit | Upload needed | Where                                          |
| ---------------: | ------: | ---------------- | -----------: | ------------: | ---------------------------------------------- |
|         up to 10 |      80 | 1 shared vCPU    |       256 MB |     30 Mbit/s | Homelab, friends only                          |
|         up to 50 |     400 | 1 dedicated vCPU |       512 MB |    150 Mbit/s | VPS                                            |
|        up to 100 |     800 | 2 vCPU           |       512 MB |    300 Mbit/s | VPS                                            |
|             more |         |                  |              |               | Several processes, and smaller snapshots first |

For a site played by friends and their friends, the first row of each table is
the realistic one: the smallest container the homelab can give.

### What would move these numbers

- **Real games will differ from the test.** State size and move rate are
  per-game. ONO's state (108 cards, 12 players) should be near the 8 KB tested;
  a long board game could be several times larger.
- **TLS and the proxy add CPU** that was not measured here.
- **Compression would cut bandwidth several times** for JSON this repetitive,
  at a cost in relay CPU and memory per connection. It is off. It is the first
  thing to try if upload becomes the limit.
- **Sending changes instead of full views** is the larger fix for turn-based
  bandwidth, and binary snapshots for real-time. Neither is built.

## Validating

Sizing is only trusted once it is repeated where the relay will run. All of
these use the same script.

| Check                             | How                                                                                                                               | Pass when                                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Capacity on the real server**   | Run the load test on the server itself at the planned room count and at twice that                                                | CPU under 60% of a core, memory under half the limit, p99 under 100 ms, zero errors                                      |
| **Through the real network path** | From outside the home network: `loadtest -- --url wss://relay.games.wij.ma/ws --rooms 200`                                        | p99 under 250 ms, zero errors. This is the test that includes the proxy, TLS and the uplink.                             |
| **Upload limit**                  | Raise `--rooms` over the internet until p99 climbs sharply                                                                        | Note the room count; it is the real ceiling. Plan for half of it.                                                        |
| **Memory leak**                   | `--seconds 3600` at a moderate room count                                                                                         | Relay memory is flat after the first minutes                                                                             |
| **Idle connections survive**      | Open a room, do nothing for 10 minutes, then move                                                                                 | The move goes through with no reconnect. Proxies drop idle sockets at 60-100 s; the relay's 25 s ping should prevent it. |
| **Proxy reload**                  | Reload the proxy config with a game open                                                                                          | The game continues after an automatic reconnect                                                                          |
| **Relay restart**                 | Restart the container with a game open                                                                                            | Clients show "disconnected" and a clear message; no hung tabs. (The room is lost; that is the known limit.)              |
| **Real phones**                   | Play one full game on mobile data, lock the phone for a minute mid-game                                                           | You are back in your seat when it unlocks                                                                                |
| **A real game's cost**            | Once ONO is ported, record its actual state size and moves per minute and rerun with `--state-bytes` and `--move-ms` set to match | The specification table is updated with those figures                                                                    |

When running the load test over the internet, the `MAX_CONN_PER_IP` cap applies
to the machine running it. Raise the cap for the test and put it back after.

### Watching it in production

`GET /healthz` returns the number of rooms, seats and live connections. Record
it once a minute together with the container's memory and CPU, and the uplink's
usage. Alert on: the health check failing, memory over 70% of the limit, upload
over 60% of the line. Process-level metrics from the relay itself are not built.

## Not built yet

- A deploy workflow and published relay image
- Checkpoint persistence, so a relay restart does not end rooms
- More than one relay process
- Compression, patches or binary frames
- Per-IP limits on creating rooms and guessing codes
