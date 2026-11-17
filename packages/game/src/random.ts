export interface Random {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  /** Shuffles in place and returns the same array. */
  shuffle<T>(items: T[]): T[];
}

/**
 * A small seeded generator (mulberry32). Its whole state is one 32-bit integer, so it can live
 * in the session state and survive host migration. Read `state` after use to store it back.
 */
export function createRandom(seedState: number): Random & { readonly state: number } {
  let s = seedState >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (maxExclusive: number) => Math.floor(next() * maxExclusive);
  return {
    get state() {
      return s;
    },
    next,
    int,
    pick(items) {
      if (items.length === 0) throw new Error("pick from an empty list");
      return items[int(items.length)] as never;
    },
    shuffle(items) {
      for (let i = items.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [items[i], items[j]] = [items[j] as never, items[i] as never];
      }
      return items;
    },
  };
}
