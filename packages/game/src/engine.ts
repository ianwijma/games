import type { PeerId, PeerInfo } from "@games/protocol";
import { createRandom } from "./random";
import {
  type GameDefinition,
  GameError,
  type LobbyPlayer,
  type Phase,
  type PlayerId,
} from "./types";

/** What the host checkpoints. */
export interface SessionState<S, C> {
  phase: Phase;
  players: LobbyPlayer[];
  ownerId: PlayerId | null;
  config: C;
  game: S | null;
  /** State of the seeded generator (see createRandom). */
  rng: number;
  /** Highest action number applied per peer; makes retries idempotent. */
  acks: Record<PlayerId, number>;
  /** The last few refused actions per peer, so a retry after a lost reply still learns the verdict. */
  rejects: Record<PlayerId, RejectedAction[]>;
}

export interface RejectedAction {
  n: number;
  error: string;
}

export const MAX_REJECTS = 8;

export type BuiltInAction =
  | { type: "@ready"; ready: boolean }
  | { type: "@config"; config: unknown }
  | { type: "@start" }
  | { type: "@lobby" };

export interface ViewPayload<V, C> {
  phase: Phase;
  players: LobbyPlayer[];
  ownerId: PlayerId | null;
  config: C;
  game: V | null;
}

/** Host -> peer, inside a commit. */
export interface ViewMessage<V, C> {
  k: "view";
  seq: number;
  ack: number;
  /** Actions of this peer with number <= ack that were refused (the rest were applied). */
  rej: RejectedAction[];
  v: ViewPayload<V, C>;
}

type AnyGame<S, C> = GameDefinition<S, { type: string }, unknown, C>;

export function initialState<S, C>(game: AnyGame<S, C>, rng: number): SessionState<S, C> {
  return {
    phase: "lobby",
    players: [],
    ownerId: null,
    config: structuredClone(game.defaultConfig),
    game: null,
    rng,
    acks: {},
    rejects: {},
  };
}

/** Brings the player list and owner in line with who is in the room. Mutates `state`. */
export function reconcile<S, C>(game: AnyGame<S, C>, state: SessionState<S, C>, peers: PeerInfo[]) {
  const byId = new Map(peers.map((p) => [p.id, p]));
  if (state.phase === "lobby") {
    const before = new Map(state.players.map((p) => [p.id, p]));
    state.players = [...peers]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .slice(0, game.maxPlayers)
      .map((p) => ({ id: p.id, name: p.name, ready: before.get(p.id)?.ready ?? false }));
  }
  const connected = (id: PeerId) => byId.get(id)?.connected === true;
  const owner = state.players.find((p) => p.id === state.ownerId);
  const orphaned =
    !owner ||
    (!connected(owner.id) && state.players.some((p) => p.id !== owner.id && connected(p.id)));
  if (orphaned) {
    state.ownerId = (state.players.find((p) => connected(p.id)) ?? state.players[0])?.id ?? null;
  }
}

/**
 * Applies one action and returns the new state; `state` itself is never modified, so any throw
 * leaves everything (including the rng) untouched. Throws GameError for rejections.
 */
export function step<S, C>(
  game: AnyGame<S, C>,
  state: SessionState<S, C>,
  actor: PlayerId,
  action: { type: string },
  now: number,
): SessionState<S, C> {
  const next = structuredClone(state);
  const player = next.players.find((p) => p.id === actor);
  if (!player) throw new GameError("You are not a player in this game");
  const requireOwner = () => {
    if (next.ownerId !== actor) throw new GameError("Only the room owner can do that");
  };
  const requirePhase = (phase: Phase) => {
    if (next.phase !== phase) throw new GameError("Not possible right now");
  };

  switch (action.type) {
    case "@ready":
      requirePhase("lobby");
      player.ready = (action as { ready?: unknown }).ready === true;
      return next;
    case "@config":
      requireOwner();
      requirePhase("lobby");
      next.config = game.validateConfig
        ? game.validateConfig((action as { config?: unknown }).config)
        : ((action as { config?: unknown }).config as C);
      return next;
    case "@start": {
      requireOwner();
      requirePhase("lobby");
      if (next.players.length < game.minPlayers) {
        throw new GameError(`At least ${game.minPlayers} players are needed`);
      }
      const random = createRandom(next.rng);
      next.game = game.setup({
        now,
        random,
        players: next.players.map((p) => p.id),
        config: next.config,
      });
      next.rng = random.state;
      next.phase = game.isOver?.(next.game) ? "ended" : "playing";
      return next;
    }
    case "@lobby":
      requireOwner();
      if (next.phase === "lobby") throw new GameError("Not possible right now");
      next.phase = "lobby";
      next.game = null;
      for (const p of next.players) p.ready = false;
      return next;
  }
  if (action.type.startsWith("@")) throw new GameError("Unknown action");
  requirePhase("playing");
  const random = createRandom(next.rng);
  const draft = next.game as S;
  next.game = game.apply(draft, action, { now, random, actor }) ?? draft;
  next.rng = random.state;
  if (game.isOver?.(next.game)) next.phase = "ended";
  return next;
}

/** Runs the game's deadline handler. Returns null when there is nothing due. */
export function runDeadline<S, C>(
  game: AnyGame<S, C>,
  state: SessionState<S, C>,
  now: number,
): SessionState<S, C> | null {
  if (state.phase !== "playing" || !game.deadline || !game.onDeadline) return null;
  const due = game.deadline(state.game as S);
  if (due === null) return null;
  const next = structuredClone(state);
  const random = createRandom(next.rng);
  const draft = next.game as S;
  next.game = game.onDeadline(draft, { now: Math.max(now, due), random }) ?? draft;
  next.rng = random.state;
  if (game.isOver?.(next.game)) next.phase = "ended";
  return next;
}

export function viewMessage<S, C, V>(
  game: GameDefinition<S, { type: string }, V, C>,
  state: SessionState<S, C>,
  seq: number,
  peer: PeerId,
): ViewMessage<V, C> {
  const isPlayer = state.players.some((p) => p.id === peer);
  return {
    k: "view",
    seq,
    ack: state.acks[peer] ?? 0,
    rej: state.rejects?.[peer] ?? [],
    v: {
      phase: state.phase,
      players: state.players,
      ownerId: state.ownerId,
      config: state.config,
      game: state.game === null ? null : game.view(state.game, isPlayer ? peer : null),
    },
  };
}
