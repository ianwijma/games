import type { Random } from "./random";

/** Same value as the relay's peer id. */
export type PlayerId = string;

export interface GameContext {
  /** Relay clock, ms. Use this instead of Date.now(). */
  now: number;
  /** Seeded and part of the saved state. Use this instead of Math.random(). */
  random: Random;
}

/** Throw from `apply` (or `validateConfig`) to reject an action; the message is shown to the player. */
export class GameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameError";
  }
}

/**
 * Everything the runtime needs to know about a game. State, Action, View and Config must be
 * JSON-serialisable. Action types starting with "@" are reserved for the runtime.
 */
export interface GameDefinition<
  State,
  Action extends { type: string },
  View,
  Config = Record<string, never>,
> {
  /** Lowercase letters, digits and dashes: /^[a-z0-9-]+$/ */
  id: string;
  /** Bump when the State or Action shape changes; everyone in a room must match. */
  version: number;
  minPlayers: number;
  maxPlayers: number;
  defaultConfig: Config;
  /** Normalise/validate untrusted config from the owner; throw GameError if invalid. Default: accept as-is. */
  validateConfig?(config: unknown): Config;
  /** Build the initial state when the owner starts the game. `players` is in seat order. */
  setup(ctx: GameContext & { players: PlayerId[]; config: Config }): State;
  /** Mutate `state` (it is a private draft) or return a new state. Throw GameError to reject. */
  // biome-ignore lint/suspicious/noConfusingVoidType: lets `apply` mutate and return nothing
  apply(state: State, action: Action, ctx: GameContext & { actor: PlayerId }): State | void;
  /** What `viewer` may see. `null` = a spectator. Must not leak other players' secrets. */
  view(state: State, viewer: PlayerId | null): View;
  /** True once the game is finished; the session moves to phase "ended". */
  isOver?(state: State): boolean;
  /** Relay-clock time at which `onDeadline` must run, or null. */
  deadline?(state: State): number | null;
  /**
   * Runs when the deadline passes (also after host migration). Mutate the draft or return a new state.
   * It MUST move or clear the deadline: the same deadline is never re-armed, so a handler that
   * leaves it unchanged will not run again.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: lets `apply` mutate and return nothing
  onDeadline?(state: State, ctx: GameContext): State | void;
}

/** Identity helper that gives a game definition full type inference. */
export function defineGame<S, A extends { type: string }, V, C = Record<string, never>>(
  def: GameDefinition<S, A, V, C>,
): GameDefinition<S, A, V, C> {
  return def;
}

/** Why a pending action was abandoned without an answer: the session was left, destroyed or closed. */
export class SessionClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionClosedError";
  }
}

export type Phase = "lobby" | "playing" | "ended";

export interface LobbyPlayer {
  id: PlayerId;
  name: string;
  ready: boolean;
}
