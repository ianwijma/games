# games

Monorepo for the games on games.wij.ma, plus the shared libraries that make
multiplayer (and single-player) games quick to build.

Players join a room with an invite code. One player's browser hosts the game;
a small relay server passes messages and picks a new host if that player
disconnects, so the game continues.

```sh
pnpm install
pnpm dev        # relay on ws://localhost:8787/ws, site on http://localhost:3000
pnpm test
```

- [Architecture](docs/architecture.md)
- [Adding a game](games/README.md)
- [Design: the table look](docs/design.md)
- [Deployment and sizing](docs/deployment.md)
- [Limitations and risks](docs/limitations.md)
- [Game catalog: what the core is designed for](docs/game-catalog.md)
- [Rules for contributors and agents](AGENTS.md)

## Deploying

- **Site:** `pnpm --filter @games/web build` writes static files to
  `apps/web/out`. Set `NEXT_PUBLIC_RELAY_URL` (for example
  `wss://relay.games.wij.ma/ws`) at build time.
- **Relay:** `docker build -f apps/relay/Dockerfile -t games-relay .` from the
  repo root. Environment: `PORT` (8787), `ALLOWED_ORIGINS` (comma-separated,
  set it in production), `ALLOWED_GAMES`, `MAX_CONN_PER_IP`, `TRUST_PROXY=1`
  when behind exactly one reverse proxy. The proxy must forward WebSocket
  upgrades on `/ws`. Health check: `GET /healthz`.
