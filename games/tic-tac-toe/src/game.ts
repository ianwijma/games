import { defineGame, GameError, type PlayerId } from "@games/game";

export type Mark = "X" | "O";

export interface State {
  board: (PlayerId | null)[];
  /** order[0] plays X and moves first. */
  order: [PlayerId, PlayerId];
  turn: 0 | 1;
  winner: PlayerId | "draw" | null;
  /** Relay-clock ms at which the current turn times out; null = no timer. */
  deadline: number | null;
  /** Copied from the config at setup, because `onDeadline` does not receive the config. */
  turnSeconds: number;
}

export type Action = { type: "place"; cell: number };

export interface Config {
  /** 0 = no timer. */
  turnSeconds: 0 | 15 | 30 | 60;
}

export interface View {
  board: (PlayerId | null)[];
  order: [PlayerId, PlayerId];
  turn: 0 | 1;
  winner: PlayerId | "draw" | null;
  deadline: number | null;
  yourMark: Mark | null;
}

export const TURN_OPTIONS = [0, 15, 30, 60] as const;

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

const deadlineFor = (now: number, turnSeconds: number) =>
  turnSeconds > 0 ? now + turnSeconds * 1000 : null;

export const game = defineGame<State, Action, View, Config>({
  id: "tic-tac-toe",
  version: 1,
  minPlayers: 2,
  maxPlayers: 2,
  defaultConfig: { turnSeconds: 0 },

  validateConfig(config) {
    const turnSeconds = (config as { turnSeconds?: unknown } | null)?.turnSeconds;
    if (!TURN_OPTIONS.some((option) => option === turnSeconds)) {
      throw new GameError("Choose one of the available turn times");
    }
    return { turnSeconds: turnSeconds as Config["turnSeconds"] };
  },

  setup({ players, config, random, now }) {
    const [a, b] = players as [PlayerId, PlayerId];
    return {
      board: Array<PlayerId | null>(9).fill(null),
      order: random.int(2) === 0 ? [a, b] : [b, a],
      turn: 0,
      winner: null,
      deadline: deadlineFor(now, config.turnSeconds),
      turnSeconds: config.turnSeconds,
    };
  },

  apply(state, action, { actor, now }) {
    if (state.winner !== null) throw new GameError("The game is over");
    if (state.order[state.turn] !== actor) throw new GameError("It is not your turn");
    const { cell } = action;
    if (!Number.isInteger(cell) || cell < 0 || cell > 8) throw new GameError("Invalid cell");
    if (state.board[cell] !== null) throw new GameError("That cell is taken");

    state.board[cell] = actor;
    if (LINES.some((line) => line.every((i) => state.board[i] === actor))) {
      state.winner = actor;
    } else if (state.board.every((c) => c !== null)) {
      state.winner = "draw";
    }
    if (state.winner !== null) {
      state.deadline = null;
    } else {
      state.turn = state.turn === 0 ? 1 : 0;
      state.deadline = deadlineFor(now, state.turnSeconds);
    }
  },

  view(state, viewer) {
    const index = viewer === null ? -1 : state.order.indexOf(viewer);
    return {
      board: state.board,
      order: state.order,
      turn: state.turn,
      winner: state.winner,
      deadline: state.deadline,
      yourMark: index === 0 ? "X" : index === 1 ? "O" : null,
    };
  },

  isOver: (state) => state.winner !== null,
  deadline: (state) => state.deadline,

  // Running out of time forfeits the move, not the game.
  onDeadline(state, { now }) {
    state.turn = state.turn === 0 ? 1 : 0;
    state.deadline = deadlineFor(now, state.turnSeconds);
  },
});
