import type { GameModule } from "@games/react";
import { Board } from "./Board";
import { type Action, type Config, game, type State, type View } from "./game";
import { Settings } from "./Settings";

export const ticTacToe: GameModule<State, Action, View, Config> = {
  definition: game,
  title: "Tic-tac-toe",
  description: "Three in a row wins. Two players, optional turn timer.",
  Board,
  Settings,
};
