import type { GameModule } from "@games/react";
import { catalog, type Slug } from "./catalog";

// biome-ignore lint/suspicious/noExplicitAny: the registry holds games of every shape
type AnyModule = GameModule<any, any, any, any>;

/**
 * The registry: how to load each game in `catalog.ts`. Import this only from client components.
 * Every game has its own dynamic import, so its code lives in its own chunk.
 */
const loaders: Record<Slug, () => Promise<AnyModule>> = {
  ohno: () => import("@games/ohno").then((m) => m.ohno),
  "tic-tac-toe": () => import("@games/tic-tac-toe").then((m) => m.ticTacToe),
};

export const games = catalog.map((entry) => ({ ...entry, load: loaders[entry.slug] }));

export const findGame = (slug: string) => games.find((g) => g.slug === slug);
