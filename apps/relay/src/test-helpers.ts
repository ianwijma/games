/** Shared by the persistence and restart tests: a tiny game and real-socket players. Not bundled. */
import { createSession, defineGame, GameError, type Session } from "@games/game";
import { webSocketTransport } from "@games/net";

// -- a small turn-based game with an optional turn timer --------------------------

export interface CountState {
  order: [string, string];
  turn: 0 | 1;
  moves: { by: string; n: number }[];
  deadline: number | null;
  timerMs: number;
  timeouts: number;
}
export interface CountView {
  moves: CountState["moves"];
  turn: string;
  deadline: number | null;
  timeouts: number;
}
export type CountAction = { type: "add"; n: number };
export interface CountConfig {
  timerMs: number;
}

export const MOVES_TO_WIN = 6;

export const countGame = defineGame<CountState, CountAction, CountView, CountConfig>({
  id: "count",
  version: 1,
  minPlayers: 2,
  maxPlayers: 2,
  defaultConfig: { timerMs: 0 },
  validateConfig(config) {
    const timerMs = (config as { timerMs?: unknown } | null)?.timerMs;
    if (typeof timerMs !== "number" || !Number.isInteger(timerMs) || timerMs < 0) {
      throw new GameError("bad timer");
    }
    return { timerMs };
  },
  setup({ players, config, now }) {
    return {
      order: [players[0] as string, players[1] as string],
      turn: 0,
      moves: [],
      deadline: config.timerMs > 0 ? now + config.timerMs : null,
      timerMs: config.timerMs,
      timeouts: 0,
    };
  },
  apply(state, action, { actor, now }) {
    if (state.order[state.turn] !== actor) throw new GameError("not your turn");
    state.moves.push({ by: actor, n: action.n });
    state.turn = state.turn === 0 ? 1 : 0;
    state.deadline = state.timerMs > 0 ? now + state.timerMs : null;
  },
  view: (state) => ({
    moves: state.moves,
    turn: state.order[state.turn],
    deadline: state.deadline,
    timeouts: state.timeouts,
  }),
  isOver: (state) => state.moves.length >= MOVES_TO_WIN,
  deadline: (state) => state.deadline,
  onDeadline(state, { now }) {
    state.turn = state.turn === 0 ? 1 : 0;
    state.timeouts++;
    state.deadline = now + state.timerMs;
  },
});

// -- real players ------------------------------------------------------------------

export interface Player {
  session: Session<CountAction, CountView, CountConfig>;
  /** Every distinct connection status the session went through, in order. */
  statuses: string[];
  id(): string;
  view(): CountView | null;
}

export function makePlayer(url: string): Player {
  const session = createSession(countGame, {
    transport: webSocketTransport(url),
    reconnect: { minMs: 20, maxMs: 100 },
  });
  const statuses: string[] = [];
  const note = () => {
    const status = session.getSnapshot().status;
    if (statuses.at(-1) !== status) statuses.push(status);
  };
  session.subscribe(note);
  return {
    session,
    statuses,
    id: () => session.getSnapshot().me as string,
    view: () => session.getSnapshot().view,
  };
}

/** Polls until `condition` holds; throws with `what` after `timeoutMs`. */
export async function waitFor(
  what: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Two players in a started game (player 0 is the owner). */
export async function startGame(
  url: string,
  config?: CountConfig,
): Promise<{ code: string; players: [Player, Player] }> {
  const a = makePlayer(url);
  const b = makePlayer(url);
  const code = await a.session.create({ name: "A" });
  await b.session.join(code, { name: "B" });
  if (config) await a.session.configure(config);
  await Promise.all([a.session.setReady(true), b.session.setReady(true)]);
  await a.session.start();
  await waitFor("both views", () => a.view() !== null && b.view() !== null);
  return { code, players: [a, b] };
}

/** Waits for every view to agree, then the player whose turn it is plays `n`, and everyone sees it. */
export async function move(players: Player[], n: number): Promise<void> {
  const counts = () => players.map((p) => p.view()?.moves.length ?? -1);
  await waitFor("views to agree", () => new Set(counts()).size === 1 && counts()[0] !== -1);
  const before = counts()[0] as number;
  const turn = players[0]?.view()?.turn;
  const mover = players.find((p) => p.id() === turn);
  if (!mover) throw new Error("nobody to move");
  await mover.session.act({ type: "add", n });
  await waitFor("everyone to see the move", () => counts().every((c) => c === before + 1));
}

export const movesOf = (p: Player) => p.view()?.moves.map((m) => m.n) ?? [];

export async function healthz(port: number): Promise<{
  rooms: number;
  peers: number;
  connected: number;
  snapshot?: {
    savedAt: number;
    bytes: number;
    serializeMs: number;
    writeMs: number;
    rooms: number;
  } | null;
}> {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  return (await response.json()) as never;
}

/** Waits until nothing in the hub changes for `quietMs`. */
export async function quiesce(hub: { revision: number }, quietMs = 120): Promise<void> {
  let last = -1;
  let since = Date.now();
  await waitFor("hub to go quiet", () => {
    if (hub.revision !== last) {
      last = hub.revision;
      since = Date.now();
    }
    return Date.now() - since >= quietMs;
  });
}
