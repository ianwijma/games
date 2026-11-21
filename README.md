# games

Monorepo for the games on games.wijma.cloud, plus the shared libraries that make
multiplayer (and single-player) games quick to build.

Players join a room with an invite code. One player's browser hosts the game;
a small relay server passes messages and picks a new host if that player
disconnects, so the game continues.

```sh
npm install
npm run dev        # relay on ws://localhost:6767/ws, site on http://localhost:3000
npm test
```

- [Architecture](docs/architecture.md)
- [Adding a game](games/README.md)
- [Design: the table look](docs/design.md)
- [Deployment and sizing](docs/deployment.md)
- [Releasing](docs/releasing.md)
- [Limitations and risks](docs/limitations.md)
- [Game catalog: what the core is designed for](docs/game-catalog.md)
- [Rules for contributors and agents](AGENTS.md)

## Deploying

Both the site and the relay run in a homelab k3s cluster behind a Cloudflare
Tunnel, as `https://games.wijma.cloud` and `wss://games-relay.wijma.cloud/ws`.
The [Release workflow](docs/releasing.md) (Actions → Release) bumps the
version, publishes `ghcr.io/ianwijma/games-web` and
`ghcr.io/ianwijma/games-relay` as `X.Y.Z` and, for a stable release, pins that
version in the homelab repo, which deploys it. Each push to `develop` that
passes CI also publishes both images as `sha-<short sha>`. See [Deployment and sizing](docs/deployment.md) for the
images, the relay's environment variables (`ALLOWED_ORIGINS`,
`CLIENT_IP_HEADER`, `TRUST_PROXY`, `STATE_FILE`, ...) and what a relay restart
does to open rooms.
