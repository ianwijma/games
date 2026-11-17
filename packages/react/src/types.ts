import type { GameDefinition, PlayerId, SessionPlayer } from "@games/game";
import type { ComponentType } from "react";

/** The props every game's main component receives. */
export interface GameProps<A, V, C> {
  view: V;
  me: PlayerId | null;
  players: SessionPlayer[];
  config: C;
  phase: "playing" | "ended";
  isOwner: boolean;
  /** Rejects with GameError; the shell shows the message, so callers may ignore the rejection. */
  act(action: A): Promise<void>;
  backToLobby(): Promise<void>;
  serverNow(): number;
}

/** Everything the site needs to list and mount a game. */
export interface GameModule<S, A extends { type: string }, V, C> {
  definition: GameDefinition<S, A, V, C>;
  title: string;
  description: string;
  Board: ComponentType<GameProps<A, V, C>>;
  /** Optional settings editor shown in the lobby; `disabled` for everyone but the owner. */
  Settings?: ComponentType<{ config: C; onChange(config: C): void; disabled: boolean }>;
}
