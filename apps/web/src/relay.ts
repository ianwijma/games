/** Null means no relay: the game page offers only "Play on this device". */
export const relayUrl: string | null =
  process.env.NEXT_PUBLIC_RELAY_URL ||
  (process.env.NODE_ENV === "development" ? "ws://localhost:8787/ws" : null);
