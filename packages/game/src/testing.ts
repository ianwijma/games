import {
  localTransport,
  memoryStorage,
  type TokenStorage,
  type Transport,
  type TransportLink,
} from "@games/net";
import { createFakeClock, type FakeClock, Hub } from "@games/relay-core";
import { createSession, type Session } from "./session";
import type { GameDefinition } from "./types";

export interface Table<A, V, C> {
  /** Index = seat order. All are already joined in one room, phase "lobby". */
  sessions: Session<A, V, C>[];
  hub: Hub;
  clock: FakeClock;
  /** Delivers everything queued (and microtasks) until nothing is left to do. */
  settle(): Promise<void>;
  /** Everyone ready, the owner starts, settle. */
  start(): Promise<void>;
  /**
   * Settles while waiting for a session call, e.g. `table.run(table.sessions[0].configure(c))`.
   * A bare `await session.configure(c)` never finishes: nothing is delivered until `settle`.
   */
  run<T>(pending: Promise<T>): Promise<T>;
  /** `act` + settle. Rejects if the action is rejected. */
  act(player: number, action: A): Promise<void>;
  view(player: number): V;
  /** Seat index of a player id, -1 if unknown. */
  indexOf(playerId: string): number;
  /** Index of the session the relay currently treats as host. */
  hostIndex(): number;
  /** Hard-drops the host's connection without `leave`, settles, returns the new host index. */
  killHost(): Promise<number>;
  /** Hard drop, no auto-reconnect until `reconnect`. */
  disconnect(player: number): Promise<void>;
  /** Lets a disconnected player resume its seat. */
  reconnect(player: number): Promise<void>;
  /** Simulates a page reload: destroys the player's session and replaces `sessions[player]` with one that resumes the seat. */
  reload(player: number): Promise<void>;
  /** Moves the fake clock forward and settles. */
  advance(ms: number): Promise<void>;
}

/** Builds simulated players in one room on a fake clock, all in memory. Deterministic for a given seed. */
export async function createTable<S, A extends { type: string }, V, C>(
  game: GameDefinition<S, A, V, C>,
  options: { players?: number | string[]; seed?: number } = {},
): Promise<Table<A, V, C>> {
  const count = options.players ?? game.minPlayers;
  const names =
    typeof count === "number" ? Array.from({ length: count }, (_, i) => `Player ${i + 1}`) : count;
  const clock = createFakeClock();
  const hub = new Hub({ clock });
  const queue: (() => void)[] = [];
  const base = localTransport(hub, { defer: (deliver) => void queue.push(deliver) });

  const settle = async () => {
    for (let idle = 0; idle < 3; ) {
      if (queue.length > 0) {
        idle = 0;
        while (queue.length > 0) queue.shift()?.();
      } else idle++;
      await Promise.resolve();
    }
  };

  /** While blocked, new connections fail at once, so a dropped player stays dropped. */
  const gates = names.map(() => ({ blocked: false, link: null as TransportLink | null }));
  const transports: Transport[] = gates.map((gate) => ({
    open(handlers) {
      if (gate.blocked) {
        queue.push(() => handlers.onClose());
        return { send() {}, close() {} };
      }
      gate.link = base.open(handlers);
      return gate.link;
    },
  }));

  const storages = names.map(() => memoryStorage());
  const makeSession = (i: number) =>
    createSession(game, {
      transport: transports[i] as Transport,
      storage: storages[i] as TokenStorage,
      clock,
      seed: options.seed ?? 1,
      reconnect: { minMs: 1, maxMs: 1 },
    });
  const sessions = names.map((_, i) => makeSession(i));

  /** Runs a promise-returning call, settles, and throws if it was rejected. */
  const run = async <T>(call: Promise<T>): Promise<T> => {
    let failure: { error: unknown } | null = null;
    call.catch((error) => {
      failure = { error };
    });
    await settle();
    if (failure) throw (failure as { error: unknown }).error;
    return call;
  };

  const code = sessions[0]?.create({ name: names[0] as string }) as Promise<string>;
  await settle();
  const roomCode = await code;
  for (let i = 1; i < sessions.length; i++) {
    await run((sessions[i] as Session<A, V, C>).join(roomCode, { name: names[i] as string }));
  }

  const hostIndex = () =>
    sessions.findIndex((s) => {
      const snap = s.getSnapshot();
      return snap.isHost && snap.status === "connected";
    });

  const disconnect = async (player: number) => {
    const gate = gates[player];
    if (!gate) throw new Error(`no player ${player}`);
    gate.blocked = true;
    gate.link?.close();
    await settle();
  };

  return {
    sessions,
    hub,
    clock,
    settle,
    async start() {
      const players = sessions.filter((s) => s.getSnapshot().isPlayer);
      await run(Promise.all(players.map((s) => s.setReady(true))));
      const owner = sessions.find((s) => s.getSnapshot().isOwner);
      if (!owner) throw new Error("no owner");
      await run(owner.start());
    },
    run,
    act: (player, action) => run((sessions[player] as Session<A, V, C>).act(action)),
    view: (player) => (sessions[player] as Session<A, V, C>).getSnapshot().view as V,
    hostIndex,
    indexOf: (playerId) => sessions.findIndex((s) => s.getSnapshot().me === playerId),
    async killHost() {
      await disconnect(hostIndex());
      return hostIndex();
    },
    disconnect,
    async reload(player) {
      const old = sessions[player];
      if (!old) throw new Error(`no player ${player}`);
      const code = old.getSnapshot().code as string;
      old.destroy();
      await settle();
      const fresh = makeSession(player);
      sessions[player] = fresh;
      await run(fresh.resume(code));
    },
    async reconnect(player) {
      const gate = gates[player];
      if (!gate) throw new Error(`no player ${player}`);
      gate.blocked = false;
      clock.advance(1); // fires the client's pending retry timer
      await settle();
    },
    async advance(ms) {
      clock.advance(ms);
      await settle();
    },
  };
}
