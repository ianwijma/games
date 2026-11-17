export interface Clock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface FakeClock extends Clock {
  /** Moves time forward, firing due timers in time order (ties in creation order). */
  advance(ms: number): void;
  pendingTimers(): number;
}

export function createFakeClock(start = 1_000_000): FakeClock {
  let current = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => current,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: current + Math.max(0, ms), fn });
      return id;
    },
    clearTimer(handle) {
      timers.delete(handle as number);
    },
    pendingTimers: () => timers.size,
    advance(ms) {
      const target = current + ms;
      for (;;) {
        let best: [number, { at: number; fn: () => void }] | undefined;
        for (const entry of timers) {
          if (entry[1].at <= target && (!best || entry[1].at < best[1].at)) best = entry;
        }
        if (!best) break;
        timers.delete(best[0]);
        current = Math.max(current, best[1].at);
        best[1].fn();
      }
      current = target;
    },
  };
}
