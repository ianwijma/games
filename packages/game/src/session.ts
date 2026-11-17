import { RoomClient, type RoomStatus, type TokenStorage, type Transport } from "@games/net";
import type { Checkpoint, Json } from "@games/protocol";
import { LIMITS } from "@games/protocol";
import type { Clock } from "@games/relay-core";
import {
  initialState,
  MAX_REJECTS,
  reconcile,
  runDeadline,
  type SessionState,
  step,
  type ViewMessage,
  viewMessage,
} from "./engine";
import {
  type GameDefinition,
  GameError,
  type LobbyPlayer,
  type Phase,
  type PlayerId,
  SessionClosedError,
} from "./types";

export interface SessionOptions {
  transport: Transport;
  /** Where the seat token is kept so a reload can `resume`. Default: memory. */
  storage?: TokenStorage;
  /** Time source. Default: system clock. */
  clock?: Clock;
  /** Seed for the game's random numbers (only used by whoever creates the room). Default: random. */
  seed?: number;
  /** Reconnect backoff. Default 500 / 8000 ms. */
  reconnect?: { minMs: number; maxMs: number };
}

export interface SessionPlayer extends LobbyPlayer {
  /** Whether the player's connection is up right now. */
  connected: boolean;
  isOwner: boolean;
  isYou: boolean;
}

export interface SessionSnapshot<V, C> {
  status: RoomStatus;
  /** The invite code, once joined. */
  code: string | null;
  me: PlayerId | null;
  /** Network role; UIs should not normally show it. */
  isHost: boolean;
  isOwner: boolean;
  /** False for spectators. */
  isPlayer: boolean;
  /** Null until the first view arrives. */
  phase: Phase | null;
  players: SessionPlayer[];
  config: C | null;
  /** This player's view of the game; null in the lobby. */
  view: V | null;
  /** Set when the session ended for good (kicked, room closed, seat lost...). */
  closed: { reason: string; message?: string } | null;
}

export interface Session<A, V, C> {
  /** Opens a room and returns its invite code. */
  create(options: { name: string }): Promise<string>;
  join(code: string, options: { name: string }): Promise<void>;
  /** Reclaims the seat stored for `code` (after a reload). */
  resume(code: string): Promise<void>;
  hasSeat(code: string): boolean;
  /** Gives up the seat for good. */
  leave(): void;
  /** Closes the connection but keeps the seat; stops all listeners and timers. */
  destroy(): void;
  /** Referentially stable between changes (suits React's useSyncExternalStore). */
  getSnapshot(): SessionSnapshot<V, C>;
  subscribe(listener: () => void): () => void;
  /** Resolves when the host applied the action; rejects with GameError if it was refused. */
  act(action: A): Promise<void>;
  setReady(ready: boolean): Promise<void>;
  /** Owner only, lobby only. */
  configure(config: C): Promise<void>;
  /** Owner only. */
  start(): Promise<void>;
  /** Owner only. */
  backToLobby(): Promise<void>;
  /** Relay clock estimate, ms. */
  serverNow(): number;
}

interface Pending {
  action: { type: string };
  /** Assigned on first send, never changed, so retries are recognised as duplicates. */
  n?: number;
  resolve(): void;
  reject(error: Error): void;
}

interface HostState<S, C, V> {
  state: SessionState<S, C>;
  seq: number;
  /** Deadline last armed by this host instance; undefined = never (a new host always arms once). */
  alarm: number | null | undefined;
  /** Our own views by seq. Applied only once the relay confirms the commit, so we never act on a state it did not store. */
  unconfirmed: [number, ViewMessage<V, C>][];
}

const asJson = (value: unknown) => value as Json;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function createSession<S, A extends { type: string }, V, C>(
  game: GameDefinition<S, A, V, C>,
  options: SessionOptions,
): Session<A, V, C> {
  type State = SessionState<S, C>;
  type View = ViewMessage<V, C>;
  const anyGame = game as unknown as GameDefinition<S, { type: string }, V, C>;

  const client = new RoomClient({
    transport: options.transport,
    game: game.id,
    gameVersion: game.version,
    mode: "turn",
    ...(options.storage && { storage: options.storage }),
    ...(options.clock && { clock: options.clock }),
    ...(options.reconnect && { reconnect: options.reconnect }),
  });

  const listeners = new Set<() => void>();
  let closedInfo: SessionSnapshot<V, C>["closed"] = null;
  let destroyed = false;

  // -- replica -------------------------------------------------------------

  let view: View | null = null;
  /** Last action number used. Raised to the host's ack so a reloaded page does not reuse old numbers. */
  let counter = 0;
  let pending: Pending[] = [];
  let wasReconnecting = false;

  const rejectAll = (message: string) => {
    const all = pending;
    pending = [];
    for (const p of all) p.reject(new SessionClosedError(message));
  };

  const submit = (action: { type: string }): Promise<void> => {
    if (client.status === "closed") return Promise.reject(new SessionClosedError("Not connected"));
    return new Promise<void>((resolve, reject) => {
      const entry: Pending = { action, resolve, reject };
      pending.push(entry);
      transmit(entry);
    });
  };

  /** Sends one pending action if we can. Numbers are assigned here, after the first view. */
  const transmit = (entry: Pending) => {
    if (view === null || client.status !== "connected") return;
    if (host === null && client.isHost) return; // host event not processed yet; it flushes afterwards
    entry.n ??= ++counter;
    if (host) handleAct(client.me as PlayerId, entry.n, entry.action);
    else client.send("host", { k: "act", n: entry.n, a: entry.action as unknown as Json });
  };

  /** `all`: also re-send actions already sent (after a host change or reconnect). */
  const flush = (all: boolean) => {
    for (const entry of [...pending]) if (all || entry.n === undefined) transmit(entry);
  };

  const onView = (message: View) => {
    if (view && message.seq < view.seq) return;
    view = message;
    counter = Math.max(counter, message.ack);
    const done = pending.filter((p) => p.n !== undefined && p.n <= message.ack);
    if (done.length > 0) {
      pending = pending.filter((p) => !done.includes(p));
      for (const p of done) {
        const refused = message.rej?.find((r) => r.n === p.n);
        if (refused) p.reject(new GameError(refused.error));
        else p.resolve();
      }
    }
    flush(false);
    refresh();
  };

  const onReject = (n: number, error: string) => {
    const entry = pending.find((p) => p.n === n);
    if (!entry) return;
    pending = pending.filter((p) => p !== entry);
    entry.reject(new GameError(error));
  };

  // -- host ----------------------------------------------------------------

  let host: HostState<S, C, V> | null = null;

  const randomSeed = () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0] as number;

  const initHost = (checkpoint: Checkpoint | null) => {
    host = {
      state: checkpoint
        ? structuredClone(checkpoint.state as unknown as State)
        : initialState(anyGame, options.seed ?? randomSeed()),
      seq: checkpoint?.seq ?? 0,
      alarm: undefined,
      unconfirmed: [],
    };
    host.state.acks ??= {};
    host.state.rejects ??= {};
    reconcileAndCommit();
  };

  const reconcileAndCommit = () => {
    if (!host || !client.room) return;
    const next = structuredClone(host.state);
    reconcile(anyGame, next, client.room.peers);
    commit(next);
  };

  /** Stores `next` as the checkpoint, sends every peer its view, and applies our own locally. */
  const commit = (next: State): boolean => {
    const h = host;
    const room = client.room;
    const me = client.me;
    if (!h || !room || me === null) return false;
    const seq = h.seq + 1;
    const out = room.peers
      .filter((p) => p.id !== me)
      .map((p) => ({ to: p.id, d: asJson(viewMessage(anyGame, next, seq, p.id)) }));
    if (!client.commit(seq, asJson(next), out)) return false;
    h.state = next;
    h.seq = seq;
    const locked = next.phase !== "lobby";
    if (room.locked !== locked) client.setRoom({ locked });
    syncAlarm(h, next);
    // Deep copy: the UI must never hold a reference into the authoritative state.
    h.unconfirmed.push([seq, structuredClone(viewMessage(anyGame, next, seq, me))]);
    return true;
  };

  /** The relay stored every commit up to `seq`: only now may the host see (and resolve) its own view. */
  const onCommitted = (seq: number) => {
    const h = host;
    if (!h) return;
    const ready = h.unconfirmed.filter(([s]) => s <= seq);
    if (ready.length === 0) return;
    h.unconfirmed = h.unconfirmed.filter(([s]) => s > seq);
    onView((ready[ready.length - 1] as [number, ViewMessage<V, C>])[1]);
  };

  /** One alarm per deadline, named by it, so a stale or queued alarm can be recognised and ignored. */
  const syncAlarm = (h: HostState<S, C, V>, state: State) => {
    const due = state.phase === "playing" && game.deadline ? game.deadline(state.game as S) : null;
    if (h.alarm !== undefined && h.alarm === due) return;
    if (typeof h.alarm === "number") client.setAlarm(`deadline:${h.alarm}`, null);
    const ok = due === null ? true : client.setAlarm(`deadline:${due}`, due);
    if (ok) h.alarm = due;
  };

  const handleAct = (from: PlayerId, n: number, action: unknown) => {
    const h = host;
    if (!h) return;
    if (n <= (h.state.acks[from] ?? 0)) return void sendView(from);
    try {
      if (!isRecord(action) || typeof action.type !== "string")
        throw new GameError("Invalid action");
      const next = step(
        anyGame,
        h.state,
        from,
        action as { type: string },
        Math.floor(client.serverNow()),
      );
      next.acks[from] = n;
      commit(next); // if not connected the sender simply retries after the next host event
    } catch (error) {
      let message = "Something went wrong";
      if (error instanceof GameError) message = error.message;
      else console.error(error);
      // Remembered in memory and checkpointed with the next commit. If this host dies first, the
      // action is simply evaluated again by the next one.
      h.state.acks[from] = n;
      const list = [...(h.state.rejects[from] ?? []), { n, error: message }];
      h.state.rejects[from] = list.slice(-MAX_REJECTS);
      if (from === client.me) onReject(n, message);
      else sendView(from);
    }
  };

  /** Tells a peer where its actions stand, using the normal view message. */
  const sendView = (to: PlayerId) => {
    if (!host) return;
    if (to === client.me) {
      // Our own view waits for the relay's confirmation, which resolves our actions on its own.
      if (host.unconfirmed.length === 0) {
        onView(structuredClone(viewMessage(anyGame, host.state, host.seq, to)));
      }
      return;
    }
    client.send(to, asJson(viewMessage(anyGame, host.state, host.seq, to)));
  };

  const onDeadlineAlarm = (at: number) => {
    const h = host;
    if (!h) return;
    if (h.state.phase !== "playing" || !game.deadline) return;
    if (game.deadline(h.state.game as S) !== at) return; // stale alarm for an older deadline
    try {
      const next = runDeadline(anyGame, h.state, Math.floor(client.serverNow()));
      if (next) commit(next);
    } catch (error) {
      console.error(error);
    }
  };

  // -- wiring --------------------------------------------------------------

  const unsubscribe = [
    client.on("status", (status) => {
      if (status === "reconnecting") wasReconnecting = true;
      if (status === "connected" && wasReconnecting) {
        wasReconnecting = false;
        flush(true);
      }
      // Without a link we cannot be sure we are still host; only a `host` event grants the role.
      if (status !== "connected") host = null;
      refresh();
    }),
    client.on("room", () => refresh()),
    client.on("closed", ({ reason, message }) => {
      if (reason === "local") return;
      closedInfo = { reason, ...(message !== undefined && { message }) };
      host = null;
      rejectAll(message ?? "Disconnected");
      refresh();
    }),
    client.on("host", (event) => {
      if (event.isHost) {
        initHost(event.checkpoint);
      } else {
        host = null;
      }
      flush(true);
    }),
    client.on("peer", () => reconcileAndCommit()),
    client.on("alarm", (id) => {
      if (id.startsWith("deadline:")) onDeadlineAlarm(Number(id.slice("deadline:".length)));
    }),
    client.on("committed", onCommitted),
    client.on("message", ({ from, d }) => {
      if (!isRecord(d)) return;
      if (d.k === "act") {
        if (!Number.isInteger(d.n) || (d.n as number) < 1) return;
        handleAct(from, d.n as number, d.a);
      } else if (d.k === "view" && isRecord(d.v)) {
        onView(d as unknown as View);
      }
    }),
  ];

  // -- snapshot ------------------------------------------------------------

  const build = (): SessionSnapshot<V, C> => {
    const room = client.room;
    const me = client.me;
    const v = view?.v;
    const players: SessionPlayer[] = (v?.players ?? []).map((p) => ({
      ...p,
      connected: room?.peers.find((peer) => peer.id === p.id)?.connected ?? false,
      isOwner: p.id === v?.ownerId,
      isYou: p.id === me,
    }));
    return {
      status: client.status,
      code: room?.code ?? null,
      me,
      isHost: client.isHost && client.status === "connected",
      isOwner: me !== null && v?.ownerId === me,
      isPlayer: players.some((p) => p.isYou),
      phase: v?.phase ?? null,
      players,
      config: v?.config ?? null,
      view: v?.game ?? null,
      closed: closedInfo,
    };
  };

  let snapshot = build();
  function refresh() {
    if (destroyed) return;
    snapshot = build();
    for (const listener of [...listeners]) listener();
  }

  const stop = () => {
    destroyed = true;
    for (const off of unsubscribe) off();
    host = null;
  };

  return {
    async create({ name }) {
      const room = await client.create({
        name,
        maxPeers: Math.min(game.maxPlayers + 8, LIMITS.maxPeersPerRoom),
      });
      return room.code;
    },
    async join(code, { name }) {
      await client.join(code, { name });
    },
    async resume(code) {
      await client.resume(code);
    },
    hasSeat: (code) => client.hasSeat(code),
    leave() {
      rejectAll("You left");
      client.leave();
      stop();
    },
    destroy() {
      rejectAll("Session closed");
      client.close();
      stop();
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    act: (action) => submit(action),
    setReady: (ready) => submit({ type: "@ready", ready } as { type: string }),
    configure: (config) => submit({ type: "@config", config } as { type: string }),
    start: () => submit({ type: "@start" }),
    backToLobby: () => submit({ type: "@lobby" }),
    serverNow: () => client.serverNow(),
  };
}
