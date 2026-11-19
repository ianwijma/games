import type { PlayerId } from "@games/game";

/**
 * The shapes shared by the rules (`game.ts`) and the table (`Board.tsx`). Everything here is plain
 * JSON. Bump `version` in `game.ts` when State or Action changes.
 */

export const COLORS = ["red", "yellow", "green", "blue"] as const;
export type Color = (typeof COLORS)[number];

export type CardValue =
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "skip"
  | "reverse"
  | "draw2"
  | "wild"
  | "wild4";

export interface Card {
  /** Unique in the deck: "c0" to "c111". */
  id: string;
  /** null for the two wild kinds. */
  color: Color | null;
  value: CardValue;
}

/** Cards in the deck. Our own list: two of every number (0 included) and every action per colour, four of each wild. */
export const DECK_SIZE = 112;
export const HAND_SIZE = 7;

export const TURN_OPTIONS = [0, 15, 30, 60, 90, 120] as const;
export type TurnSeconds = (typeof TURN_OPTIONS)[number];

export interface HouseRules {
  /** Answer a +2 with another +2; the first player who cannot takes the whole stack. +4 never stacks. */
  stackDrawTwo: boolean;
  /** Drawing continues until a playable card turns up or the deck runs out. */
  drawUntilPlayable: boolean;
  /** A drawn card that can be played must be played (no passing). */
  mustPlayDrawn: boolean;
  /** A player on one card who has not called "Oh no!" can be caught and draws two. */
  callPenalty: boolean;
}

export type Goal =
  /** First to `target` points (50 to 5000). */
  | { mode: "points"; target: number }
  /** First to `target` round wins (1 to 20). */
  | { mode: "rounds"; target: number };

export interface Config {
  /** 0 = no turn timer. */
  turnSeconds: TurnSeconds;
  goal: Goal;
  rules: HouseRules;
}

export const DEFAULT_CONFIG: Config = {
  turnSeconds: 30,
  goal: { mode: "points", target: 500 },
  rules: { stackDrawTwo: false, drawUntilPlayable: false, mustPlayDrawn: false, callPenalty: true },
};

export type Action =
  /** `color` is required for a wild card and ignored otherwise. */
  | { type: "play"; cardId: string; color?: Color }
  | { type: "draw" }
  /** Keep the card you just drew and end the turn. */
  | { type: "pass" }
  /** Choose the colour when a wild card opened the round. */
  | { type: "color"; color: Color }
  /** Call "Oh no!" while holding exactly one card. */
  | { type: "call" }
  /** Catch a player who is on one card and has not called. */
  | { type: "catch"; playerId: PlayerId }
  /** Answer a +4 played on you: `true` challenges it, `false` accepts and draws four. */
  | { type: "challenge"; challenge: boolean }
  /** Deal the next round. Any seated player may do it while the phase is "round-over". */
  | { type: "nextRound" };

/**
 * What moved in the last committed step, for animation. Public: draws and deals carry counts only,
 * never the cards. `id` goes up by one with every committed step (actions and timeouts), so the
 * table animates a cue only when it sees the id change while mounted, and never on restore.
 */
export type TableEvent =
  | { kind: "play"; playerId: PlayerId; card: Card }
  | { kind: "draw"; playerId: PlayerId; count: number }
  | { kind: "deal"; playerId: PlayerId; count: number }
  | { kind: "turn"; playerId: PlayerId };

export interface Cue {
  id: number;
  events: TableEvent[];
}

/** The last thing that happened, as data. The table turns it into a sentence (it knows the names). */
export type Note =
  | { kind: "round"; round: number; dealer: PlayerId }
  | { kind: "play"; playerId: PlayerId; card: Card; color: Color }
  | { kind: "draw"; playerId: PlayerId; count: number }
  /** Took a +2 stack or an accepted +4 and missed the turn. */
  | { kind: "penalty"; playerId: PlayerId; count: number }
  | { kind: "stack"; playerId: PlayerId; targetId: PlayerId; total: number }
  | { kind: "pass"; playerId: PlayerId }
  | { kind: "color"; playerId: PlayerId; color: Color }
  | { kind: "call"; playerId: PlayerId }
  | { kind: "caught"; playerId: PlayerId; by: PlayerId }
  /** `success`: the +4 was illegal and the offender drew four. Otherwise the challenger drew six. */
  | { kind: "challenge"; playerId: PlayerId; offenderId: PlayerId; success: boolean }
  | { kind: "timeout"; playerId: PlayerId }
  | { kind: "win"; playerId: PlayerId; points: number; match: boolean };

export type RoundPhase = "playing" | "round-over" | "match-over";

export interface State {
  phase: RoundPhase;
  /** Seat order, fixed for the whole match. */
  players: PlayerId[];
  /** Copied from the config at setup: `apply` and `onDeadline` do not receive the config. */
  rules: HouseRules;
  goal: Goal;
  turnSeconds: TurnSeconds;
  scores: Record<PlayerId, number>;
  wins: Record<PlayerId, number>;
  round: number;
  /** Index into `players`. */
  dealer: number;
  hands: Record<PlayerId, Card[]>;
  /** The top of the pile is the last element. */
  drawPile: Card[];
  /** The top of the pile is the last element. */
  discard: Card[];
  activeColor: Color;
  /** Index into `players`. */
  turn: number;
  direction: 1 | -1;
  /** The current player has drawn this turn and may only play that card (or pass). */
  hasDrawn: boolean;
  drawnCardId: string | null;
  /** Cards waiting in a +2 stack for the current player (house rule). */
  pendingDraw: number;
  /** A wild opened the round and this player must choose the colour before anyone plays. */
  pendingWild: PlayerId | null;
  /** A +4 waits for its target (the current player) to accept or challenge. `illegal` is secret. */
  challenge: { offenderId: PlayerId; targetId: PlayerId; illegal: boolean } | null;
  /** The player who just went down to one card and can be caught until the next move (another player's call does not close the window). */
  catchable: PlayerId | null;
  /** Players holding one card who have called. */
  called: PlayerId[];
  /** Winner of the last finished round; null while playing. */
  winnerId: PlayerId | null;
  /** Points the winner took in the last finished round. */
  roundPoints: number;
  /** Relay-clock ms at which the current turn times out; null = no timer or not playing. */
  deadline: number | null;
  cue: Cue;
  note: Note;
}

export interface SeatView {
  id: PlayerId;
  cards: number;
  score: number;
  wins: number;
  /** Holds one card and has called. */
  called: boolean;
  /** The viewer may catch this player right now. */
  catchable: boolean;
}

export interface View {
  phase: RoundPhase;
  /** In seat order. */
  seats: SeatView[];
  /** Whose turn it is. */
  turn: PlayerId;
  direction: 1 | -1;
  dealer: PlayerId;
  round: number;
  rules: HouseRules;
  goal: Goal;
  /** The viewer's own cards; empty for a spectator. Never anyone else's. */
  hand: Card[];
  /** Ids of cards in `hand` the viewer may play right now. Empty when it is not their move. */
  playable: string[];
  top: Card;
  activeColor: Color;
  drawCount: number;
  discardCount: number;
  /** Size of the +2 stack waiting for the current player. */
  pendingDraw: number;
  /** Who must choose a colour for the opening wild, if anyone. */
  pendingWild: PlayerId | null;
  /** A +4 waiting for an answer. Whether it was legal is not revealed. */
  challenge: { offenderId: PlayerId; targetId: PlayerId } | null;
  /** What the viewer may do now. All false for a spectator or when the round is over. */
  can: {
    draw: boolean;
    pass: boolean;
    call: boolean;
    chooseColor: boolean;
    answerChallenge: boolean;
    nextRound: boolean;
  };
  /** The card the viewer drew this turn, if it is their turn; null for everyone else. */
  drawnCardId: string | null;
  winnerId: PlayerId | null;
  roundPoints: number;
  deadline: number | null;
  cue: Cue;
  note: Note;
}
