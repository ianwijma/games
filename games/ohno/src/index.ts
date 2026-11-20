import type { GameModule } from "@games/react";
import { Board } from "./Board";
import { game } from "./game";
import { Preferences } from "./Preferences";
import { Settings } from "./Settings";
import type { Action, Config, State, View } from "./types";

export const ohno: GameModule<State, Action, View, Config> = {
  definition: game,
  title: "Ohno!",
  description: "Match the colour or the figure and empty your hand first. 2 to 12 players.",
  Board,
  Settings,
  Preferences,
};
