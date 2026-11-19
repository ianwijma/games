# Deployment and sizing

Status as of 2026-11-20:

- **Built and checked locally:** both container images, the workflow that
  publishes them, and the relay's client IP settings (unit tests, and both
  images run with a read-only root filesystem under Docker).
- **Observed on the real path:** the headers the relay sees behind the tunnel
  (see "Client IP behind the tunnel").
- **Planned, in the homelab repo:** the Kubernetes manifests, DNS and the Argo
  CD app. Nothing is serving players yet.

The sizing numbers are measured, on one development machine, and need
repeating on the real server (see "Validating").

## What gets deployed

| Piece     | Image                          | Container                                  | State it holds        |
| --------- | ------------------------------ | ------------------------------------------ | --------------------- |
| **Site**  | `ghcr.io/ianwijma/games-web`   | nginx serving `apps/web/out` on port 8080  | None                  |
| **Relay** | `ghcr.io/ianwijma/games-relay` | One Node process (`apps/relay`), port 6767 | Rooms, in memory only |

There is no database. Everything below that concerns capacity is about the
relay.

## Setup

Both run in the homelab k3s cluster, reached through the existing Cloudflare
Tunnel. No ports are open at home.

```
players ── HTTPS ──> games.wijma.cloud ────────┐
                                               ├─> Cloudflare ─> tunnel ─> cloudflared pod ─> Traefik ─┬─> games-web pod :8080
players ── WSS ───> games-relay.wijma.cloud/ws ┘                                                       └─> games-relay pod :6767
```

- **Separate hostname for the relay**, so it can move to a VPS later by
  changing one DNS record and nothing in the site. It is
  `games-relay.wijma.cloud`, one level under `wijma.cloud`, because
  Cloudflare's free Universal SSL certificate covers only one level of
  subdomain; `relay.games.wijma.cloud` would need a paid certificate.
- **The site is in the cluster too, behind Cloudflare.** It is under a
  megabyte of static files: the `/_next/static/` files are cached for a year, so
  Cloudflare serves most requests from its cache. If page loads ever compete
  with the relay for the home uplink, move the site to a CDN; the image is
  just the static export.
- Traefik must forward WebSocket upgrades on `/ws` and must not buffer.

### Images

`.github/workflows/images.yml` builds both images after CI passes on a push to
`develop`, and pushes them to GHCR:

| Tag               | Meaning                                                 |
| ----------------- | ------------------------------------------------------- |
| `sha-<short sha>` | Immutable, one per commit. The homelab pins these.      |
| `develop`         | Moves to the newest build. For humans; never deploy it. |

There is no `latest`. Images are `linux/amd64` only, which is what the cluster
runs. The site image is built with
`NEXT_PUBLIC_RELAY_URL=wss://games-relay.wijma.cloud/ws`. It can also be run by
hand from the Actions tab (`workflow_dispatch`, `develop` only).

Build them locally from the repo root:

```sh
docker build -f apps/relay/Dockerfile -t games-relay .
docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_RELAY_URL=wss://games-relay.wijma.cloud/ws -t games-web .
```

Both run as a numeric non-root user (relay 1000, site 101), so
`runAsNonRoot: true` works, and both work with `readOnlyRootFilesystem: true`.
The site's nginx needs `/tmp` writable (mount an `emptyDir` there); the relay
writes nothing. Probes: `GET /healthz` on each container's port. The Docker
`HEALTHCHECK` in the relay image is ignored by Kubernetes.

### Relay configuration

| Variable           | Production value            | Why                                                                                         |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------------------- |
| `PORT`             | `6767` (the default)        |                                                                                             |
| `ALLOWED_ORIGINS`  | `https://games.wijma.cloud` | Stops other sites using the relay from browsers                                             |
| `ALLOWED_GAMES`    | the game ids we ship        | Stops the relay being used for anything else                                                |
| `CLIENT_IP_HEADER` | `cf-connecting-ip`          | Where the per-IP cap finds the player's address. See below.                                 |
| `TRUST_PROXY`      | unset                       | Number of proxies appending to `X-Forwarded-For`. Not needed when `CLIENT_IP_HEADER` is set |
| `MAX_CONN_PER_IP`  | `32` (the default)          | Raise if many players share one address (a school, an office)                               |
| `MAX_ROOMS`        | `10000` (the default)       | New rooms are refused with "server full" beyond this                                        |

Also: open-file limit at least twice the expected socket count (one file per
connection), and a container memory limit of about twice the expected peak
from the tables below.

### Client IP behind the tunnel

The relay caps connections per client IP (`MAX_CONN_PER_IP`), so it has to know
the player's real address. Without settings it uses the TCP peer, which behind
the tunnel is always Traefik.

Observed on 2026-11-20 on this exact path (Cloudflare, cloudflared, Traefik,
pod), the pod receives:

```
X-Forwarded-For:  <real client>, 10.42.0.40     # last entry: the cloudflared pod
Cf-Connecting-Ip: <real client>
```

So the last `X-Forwarded-For` entry, which is what `TRUST_PROXY=1` takes, is a
cloudflared pod. Every player would count as one of the two cloudflared pods,
and the cap of 32 would hold the whole site to about 64 connections.

The relay reads the client IP in this order:

1. `CLIENT_IP_HEADER=<name>`: that request header, verbatim. Production uses
   `cf-connecting-ip`, which Cloudflare sets on every request and overwrites if
   the client sent one.
2. `TRUST_PROXY=<n>`: the `n`-th `X-Forwarded-For` entry from the right, for
   `n` proxies you control. `TRUST_PROXY=2` also gives the real client on this
   path, but it breaks silently if a hop is added or removed. If the header has
   fewer than `n` entries, none are trusted. `TRUST_PROXY=1` keeps its old
   meaning: exactly one proxy, the last entry.
3. Otherwise, or when the chosen header is missing: the TCP peer address.

**`CLIENT_IP_HEADER` is only safe because the relay can be reached only through
Cloudflare.** Any client can send a `Cf-Connecting-Ip` header; only Cloudflare
replaces it. Anyone who reaches Traefik or the relay without passing through
Cloudflare picks their own IP for the cap, and so escapes it. With no ports
open at home, that should mean only clients inside the home network or the
cluster; the homelab repo should keep it that way. If the relay ever gets
another way in (a LAN route in Traefik, a NodePort, a VPS with port 443 open to
the internet), restrict that path to Cloudflare's addresses or switch to
`TRUST_PROXY` with the right hop count.

### Site configuration

`NEXT_PUBLIC_RELAY_URL=wss://games-relay.wijma.cloud/ws` at build time (the
image workflow sets it). It is baked into the build, so changing the relay
address means rebuilding the site.

The site image's nginx (`apps/web/nginx.conf`) serves directory URLs
(`/tic-tac-toe/`, and redirects `/tic-tac-toe` to it with a relative
`Location`), caches `/_next/static/*` for a year as immutable, sends
`Cache-Control: no-cache` for everything else so a deploy is seen on reload,
answers unknown paths with the export's `404.html`, and serves `/healthz`.

## Rolling out a change

Deploying means changing the pinned `sha-…` tag in the homelab repo; Argo CD
then rolls it out. Merging to `develop` only publishes images.

1. **Site only** (UI, a new game): bump the `games-web` tag. Players in a game
   keep playing on the old code until they reload.
2. **A game's state or action shape changed**: bump that game's `version`.
   Rooms refuse to mix versions, so old tabs get "refresh to update" on their
   next join instead of corrupting a game.
3. **Relay**: restarting it **ends every room**, because rooms live in memory.
   Clients reconnect on their own, but their rooms are gone. Until checkpoints
   are persisted (not built), deploy the relay when `/healthz` shows few rooms,
   and keep relay deploys rare. Do not let anything bump the relay tag
   automatically. A rolling update does not help: the new pod starts empty.
4. **Protocol change** (`PROTOCOL_VERSION`): deploy the relay and the site
   together. Old tabs are refused with a clear error and must reload.
5. **Rollback**: pin the previous `sha-…` tag. Nothing to migrate.

## How much server does it need?

### Measured

Run with `npm run loadtest -w @games/relay` on 2026-11-18. One relay
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

### Where it breaks

Run with `npm run ramp -w @games/relay` on 2026-11-18, same machine and
conditions. The ramp adds rooms in steps, each step from its own client
process, until connections fail or latency passes one second.

**Turn-based rooms being played** (4 players, 8 KB state, a move every 5 s,
1,000 rooms added per step):

|  Rooms | Players | Relay memory | Relay CPU | Outbound traffic | p99 latency | Result                                                                 |
| -----: | ------: | -----------: | --------: | ---------------: | ----------: | ---------------------------------------------------------------------- |
|  5,000 |  20,000 |       390 MB |       34% |       102 Mbit/s |        2 ms | Fine                                                                   |
| 10,000 |  40,000 |       577 MB |       78% |       204 Mbit/s |        5 ms | Fine                                                                   |
| 13,000 |  52,000 |       685 MB |      109% |       263 Mbit/s |       14 ms | Fine, but the main thread is nearly full                               |
| 16,000 |  64,000 |       801 MB |      131% |       327 Mbit/s |       36 ms | Last step that held. New players took 10 s to get in.                  |
| 17,000 |       — |       841 MB |      151% |                — |    1,760 ms | **Failed**: 229 players could not join within 20 s, median move 381 ms |

CPU above 100% is the relay's main thread at its limit plus garbage collection
and network threads. Before the failure, single steps at 3,000, 6,000, 11,000
and 15,000 rooms showed a p99 of 115 to 929 ms while the next step's clients
were connecting, so a burst of joins is felt by players already in a game.

**Idle connections** (rooms open, nobody moving, 2,500 rooms added per step):
260,000 connections in 65,000 rooms held with no failures at 1.4 GB of relay
memory, about 5 KB per connection. The step after that stalled and the test was
stopped by its time limit without reporting why, so the idle ceiling is "at
least 260,000", and the cause of the stall is not known.

What this means:

- **The limit is CPU on one thread, reached at about 16,000 active turn-based
  rooms**, long after a home uplink would have run out.
- **The default room cap of 10,000 sits below the breaking point**, at 78% CPU.
  That is a sensible place for it. Raise `MAX_ROOMS` only with these numbers
  repeated on the real server.
- **It fails softly**: joins slow down and time out; rooms already playing kept
  going and no connection was dropped.

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
  per-game. Ohno!'s state (112 cards, 12 players) should be near the 8 KB tested;
  a long board game could be several times larger.
- **TLS and the proxy add CPU** that was not measured here.
- **Compression would cut bandwidth several times** for JSON this repetitive,
  at a cost in relay CPU and memory per connection. It is off. It is the first
  thing to try if upload becomes the limit.
- **Sending changes instead of full views** is the larger fix for turn-based
  bandwidth, and binary snapshots for real-time. Neither is built.

## Validating

Sizing is only trusted once it is repeated where the relay will run. All of
these use the load test (a fixed load) or the ramp (add rooms until it fails).

| Check                             | How                                                                                                                                 | Pass when                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Capacity on the real server**   | Run the load test on the server itself at the planned room count and at twice that                                                  | CPU under 60% of a core, memory under half the limit, p99 under 100 ms, zero errors                                      |
| **Through the real network path** | From outside the home network: `loadtest -- --url wss://games-relay.wijma.cloud/ws --rooms 200`                                     | p99 under 250 ms, zero errors. This is the test that includes the proxy, TLS and the uplink.                             |
| **Upload limit**                  | `ramp -- --url wss://games-relay.wijma.cloud/ws --step 50` from outside                                                             | Note the room count; it is the real ceiling. Plan for half of it.                                                        |
| **Memory leak**                   | `--seconds 3600` at a moderate room count                                                                                           | Relay memory is flat after the first minutes                                                                             |
| **Idle connections survive**      | Open a room, do nothing for 10 minutes, then move                                                                                   | The move goes through with no reconnect. Proxies drop idle sockets at 60-100 s; the relay's 25 s ping should prevent it. |
| **Proxy reload**                  | Reload the proxy config with a game open                                                                                            | The game continues after an automatic reconnect                                                                          |
| **Relay restart**                 | Restart the container with a game open                                                                                              | Clients show "disconnected" and a clear message; no hung tabs. (The room is lost; that is the known limit.)              |
| **Real phones**                   | Play one full game on mobile data, lock the phone for a minute mid-game                                                             | You are back in your seat when it unlocks                                                                                |
| **A real game's cost**            | Once Ohno! is ported, record its actual state size and moves per minute and rerun with `--state-bytes` and `--move-ms` set to match | The specification table is updated with those figures                                                                    |

When running the load test over the internet, the `MAX_CONN_PER_IP` cap applies
to the machine running it. Raise the cap for the test and put it back after.

### Watching it in production

`GET /healthz` returns the number of rooms, seats and live connections. Record
it once a minute together with the container's memory and CPU, and the uplink's
usage. Alert on: the health check failing, memory over 70% of the limit, upload
over 60% of the line. Process-level metrics from the relay itself are not built.

## Not built yet

- Checkpoint persistence, so a relay restart does not end rooms
- More than one relay process
- Compression, patches or binary frames
- Per-IP limits on creating rooms and guessing codes
