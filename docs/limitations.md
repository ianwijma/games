# Limitations and risks

Researched 2026-11-17. Numbers marked **(checked)** were read from the linked
page that day. Numbers marked **(recalled)** are from memory; verify them before
a decision depends on one.

## Ranked: what will actually hurt

| #   | Risk                                              | When it bites                                     | What to do                                                                |
| --- | ------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Binary assets bloat git, permanently              | First game with real sprites or audio (Soap Tank) | Size budget now, object storage with a manifest for heavy games           |
| 2   | Proxies drop idle or long-lived WebSockets        | First deploy behind nginx or Cloudflare           | Heartbeat and resumable reconnect (built)                                 |
| 3   | The host model's built-in limits                  | Hidden-information games, mobile hosts, real-time | Know them (below). Server-side authority later.                           |
| 4   | One web app couples every game's build and deploy | Around 10+ games, or the first heavy one          | Games are plain packages. Split a game into its own app when it earns it. |
| 5   | Old cached clients meet a new relay               | Every relay or game deploy                        | Version checks (built). Bump `gameVersion` on state changes.              |
| 6   | Names and artwork of existing games               | Before anything is public                         | See "Names and artwork"                                                   |

## 1. GitHub limits

| Limit                             | Number                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Repository size                   | 10 GB recommended ceiling **(checked)**                                                                     |
| One file                          | Warning from 1 MB recommended, **blocked at 100 MB** **(checked)**                                          |
| One push                          | 2 GB **(checked)**                                                                                          |
| Pull request diff                 | 300 files, 20,000 lines; 25 images rendered **(checked)**                                                   |
| Git LFS, free plan                | 10 GiB storage and 10 GiB download per month. Every clone and CI checkout counts as download. **(checked)** |
| Actions, private repo, free plan  | About 2,000 minutes a month on 2-core Linux. Public repos and self-hosted runners are free. **(checked)**   |
| Actions cache                     | 10 GB per repo, entries unused for 7 days are evicted **(checked)**                                         |
| Artifacts and Packages, free plan | 500 MB shared **(checked)**                                                                                 |

Sources: [repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits),
[LFS billing](https://docs.github.com/en/billing/concepts/product-billing/git-lfs),
[Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[dependency caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).

**Code will never be the problem.** `uno-web` is 724 KB. `open-bubble-tank`, at
91,000 lines of TypeScript, is 20 MB, most of it test fixtures. Thirty games of
code stay far below 1 GB. Only binary files can break the repo.

## 2. Assets

What goes wrong:

- Every version of every binary stays in every clone forever. Removing one
  means rewriting history and force-pushing, which breaks every open worktree.
- Each agent worktree checks the files out again. Ten worktrees of a repo with
  1 GB of assets is 10 GB of disk.
- Two PNGs in `open-bubble-tank/assets/branding` are already 1.1 MB and 1.5 MB.
  Uncompressed exports like these are how it starts.

Policy:

1. **In git, with a budget.** SVG, WebP, Opus, WOFF2 only. No file over 500 KB.
   No game over 20 MB of assets. `scripts/check-assets.mjs` enforces this in CI.
2. **Outside git, with a manifest**, once a game outgrows the budget. Files go
   to object storage under a content hash; the repo commits a small manifest of
   path to hash. Cloudflare R2's free tier is 10 GB with free egress
   **(checked, [pricing](https://developers.cloudflare.com/r2/pricing/))**.
   Self-hosted storage in the homelab works but then your home uplink serves
   every download.
3. **Source art never goes in this repo** (PSD, Aseprite, WAV). Separate storage.
4. **Git LFS is the weakest option.** The download quota is spent by CI and by
   every fresh worktree.
5. **Test fixtures count too.** `open-bubble-tank` has 6.5 MB of JSON fixtures
   in five files. Generate large fixtures in the test, or compress them.

## 3. Build and bundle

- **One Next.js app, one route per game.** Next splits code per route, so a
  game's heavy library stays in that game's chunk, unless something shared
  imports it: a layout, the UI package, or an `index.ts` that re-exports
  everything. Rules: games are loaded with a dynamic import, shared packages
  set `"sideEffects": false`, and a shared package never imports from a game.
- **Coupling.** One type error in one game fails `next build` for the whole
  site, and build time grows with every game. CI on every PR catches the first.
  For the second, and for canvas games that gain nothing from Next, the way out
  is a separate app per game served under its own path. Games are plain React
  packages so that this move is cheap.
- **Static export** means no server features: no rewrites, redirects, headers,
  server actions or default image optimisation
  **(checked, [static exports](https://nextjs.org/docs/app/guides/static-exports))**.
  That is fine while games are client-only and the relay is separate.
- **Packages as source.** Type errors in a shared package surface in whatever
  consumes it, and type-checking is not cached per package the way a build
  would be **(checked, [internal packages](https://turborepo.dev/docs/core-concepts/internal-packages))**.
  Acceptable at this size.
- **npm workspaces.** Chosen because npm ships with Node. Two costs. Every
  dependency is hoisted to the root `node_modules`, so a package can import
  something it never declared and it works until that package is built alone
  (the relay's Docker image, a split-out game). And each worktree gets a full
  copy of `node_modules`, about 830 MB, where pnpm would share one store.
  Also: npm 9 and 10 crash when resolving this dependency tree from scratch
  ("Cannot read properties of null (reading 'edgesOut')", seen 2026-11-18).
  Installing from the committed `package-lock.json` works on all of them. If
  the lockfile ever has to be regenerated, use `npx npm@11 install`.
- **Shallow CI checkouts** make `turbo --affected` treat everything as changed.
  Use full history with `filter: blob:none`
  **(checked, [turbo run](https://turborepo.dev/docs/reference/run))**.

## 4. Size and speed for players

- A reasonable budget is 150-200 KB of gzipped JavaScript before assets
  **(recalled)**. React and the Next runtime take roughly 100 KB of that
  **(recalled; read the real figure from `next build` output)**.
- The netcode packages have no dependencies, so they add only their own code.
- Effect in a client bundle: its own published figures are about 7 KB minimal
  to about 20 KB with Stream and Schema, gzipped, for v4
  **(checked, vendor figures: [v4 beta post](https://effect.website/blog/releases/effect/40-beta))**.
  Affordable, but it is paid by every game page that imports it.
- Turn-based sync sends each player their full view on every change. Fine for
  card games (a few KB). A game with large state (game 6 in the catalog) will
  want patches instead; that is a runtime change, not a protocol change.
- One message is capped at 256 KB, checkpoint included.

## 5. Limits of the host model

These come with "one player's browser is the authority" and no library removes
them.

- **The host can cheat.** Full state, including other players' hidden cards, is
  in the host's memory. This is better than `uno-web` today, where every player
  has it, but it is a friends-only trust model. Public or competitive play needs
  the rules to run on the server (catalog games 3 and 7).
- **Two hops.** A player's action goes player → relay → host → relay → player.
  Fine for turn-based. For real-time, every non-host player sees roughly double
  the latency of a dedicated server, and the host has an advantage.
- **Hidden tabs and phones.** Browsers throttle timers in background tabs and
  phones suspend pages entirely. The turn-based host is driven only by incoming
  messages and relay alarms, so throttling does not stall it, and a suspended
  phone simply drops and the relay migrates. A real-time host must hand off
  when its tab is hidden. Verify browser behaviour on real devices before
  shipping a real-time game.
- **Migration is not free in real-time.** Up to one checkpoint interval of
  simulation is lost and everyone sees a short pause.
- **An action can be lost with its host.** If the host dies after receiving an
  action but before committing it, the player's client resends it to the new
  host. This is built and tested, but it is why actions carry sequence numbers.
- **The relay is a single point of failure** and holds rooms in memory. A relay
  restart ends every room. Persisting checkpoints to disk would fix that; not
  built.

## 6. Hosting the relay at home

- **Idle timeouts.** nginx closes a proxied WebSocket after 60 s without data
  **(checked, [nginx](https://nginx.org/en/docs/http/websocket.html))**.
  Cloudflare's proxy closes after about 100 s idle and also whenever it restarts
  its own servers **(checked for restarts, [Cloudflare](https://developers.cloudflare.com/network/websockets/))**.
  Caddy closes WebSockets on every config reload unless `stream_close_delay` is
  set **(checked, [Caddy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy))**.
  The relay pings every 25 s and clients reconnect and resume their seat.
- **Capacity.** One Node process holds tens of thousands of idle sockets
  **(recalled)**. Turn-based traffic is negligible. Raise the open-file limit
  before worrying about anything else.
- **Abuse.** The relay has an origin allowlist, a per-IP connection cap, a
  per-connection rate limit and a message size cap. It has no accounts. Anyone
  who can load the site can create rooms. Invite codes have about 730 million
  combinations; guessing one is impractical only as long as join attempts are
  rate-limited per IP, which the per-IP cap only partly does.
- **Home network.** CG-NAT or a changing IP blocks inbound connections; a
  tunnel or a small VPS in front solves it. A home outage takes every
  multiplayer game down. Do not serve assets from the home uplink.
- **Real-time and TCP.** WebSocket runs over TCP, so one lost packet stalls
  everything behind it. WebTransport avoids this and now ships in Safari too
  **(checked, [WebKit 26.4](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/))**,
  but Node server support is immature **(recalled)**. The transport interface
  leaves room for it. Not needed for turn-based games.

## 7. Working with many agents

- **Shared library changes ripple.** A change in `game` or `react` can break
  every game. Each game needs at least one test that plays a full round through
  the test harness, and CI must run tests for everything affected.
- **Dependency drift.** Every package must name the same exact version of a
  shared dependency. `scripts/check-versions.mjs` fails CI otherwise, so a game
  cannot quietly bring its own React.
- **Root config edits** (`tsconfig.base.json`, `turbo.json`, the lockfile)
  invalidate every cached task. Expect a full rebuild after them.
- **`uno-web` warns that Next 16.4 differs from what models remember.** Agents
  should read the installed Next docs, not rely on memory. The same goes for
  Effect 4 if it is adopted.

## 8. Names and artwork

- **Ohno!** (`games/ohno`, rebuilt from `uno-web`). A new name is necessary but
  not sufficient: the card faces, the colours-and-symbols look and the exact
  card set of the commercial game are also protected. So the card faces are our
  own (`design.md`, "Ohno! card faces": the genre's usual four colours and
  generic symbols, in our own layout, lettering and back), the deck is our own
  112-card list, not the original's 108, and the call on your last card is
  "Oh no!". The rules are the genre's and came across from `uno-web`. Still
  open: a wordmark for the box and title screen, which must look nothing like
  the original's.
- **Soap Tank.** `open-bubble-tank` describes itself as a reconstruction of a
  specific commercial game, with tooling that imports the original game file.
  A new name does not change what it is. To live on this platform it needs to
  become its own game: its own art, enemies, progression and tuning, keeping
  only the genre (a tank that grows by collecting pickups, arena to arena).
  The real-time netcode it would need is generic and unaffected by this.
- **Third-party assets** (fonts, sounds, icons) need their licence recorded
  next to the file or in the asset manifest.

## Not built yet (tracked here so it is not forgotten)

- Real-time runtime (`@games/realtime`)
- Server-side authority and matchmaking
- Checkpoint persistence across relay restarts
- Per-IP rate limit on join attempts
- Spectators, bots, save and resume
