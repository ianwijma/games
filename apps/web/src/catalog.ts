/**
 * What the static pages need to know about each game. Plain data, so server components can import
 * it without pulling any game code (not even a dynamic import: Turbopack would then preload the
 * game's client chunks on pages that import the registry). Add new games here and in games.ts.
 */
export const catalog = [
  {
    slug: "tic-tac-toe",
    title: "Tic-tac-toe",
    description: "Three in a row wins. Two players, optional turn timer.",
  },
] as const;

export type Slug = (typeof catalog)[number]["slug"];

export const findCatalogEntry = (slug: string) => catalog.find((g) => g.slug === slug);
