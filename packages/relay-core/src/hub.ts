import type {
  Checkpoint,
  ClientMessage,
  ErrorCode,
  PeerId,
  PeerInfo,
  RoomInfo,
  RoomMode,
  ServerMessage,
} from "@games/protocol";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  LIMITS,
  normalizeCode,
  PROTOCOL_VERSION,
  parseClientMessage,
} from "@games/protocol";
import { type Clock, systemClock } from "./clock";
import {
  type HubSnapshot,
  parseSnapshot,
  type RestoreResult,
  type RoomSnapshot,
  SNAPSHOT_FORMAT,
} from "./snapshot";

export interface Connection {
  send(message: ServerMessage): void;
  /** The hub calls this after sending `bye`, and on pre-join failures. */
  close(): void;
  /** Bytes queued on the socket, if known. */
  readonly bufferedAmount?: number;
}

export interface Session {
  receive(message: unknown): void;
  disconnected(): void;
}

export interface HubOptions {
  clock?: Clock;
  randomBytes?: (n: number) => Uint8Array;
  emptyRoomTtlMs?: number;
  defaultMaxPeers?: number;
  maxRooms?: number;
  allowedGames?: readonly string[];
  volatileDropBytes?: number;
  rateLimit?: { burst: number; perSecond: number };
}

/** One live connection. `seat` stays set after a disconnect so a zombie socket can be recognised. */
interface Ctx {
  conn: Connection;
  seat: Seat | null;
  room: Room | null;
  /** Connection was closed by the hub (pre-join failure, leave, kick); ignore everything after. */
  done: boolean;
  tokens: number;
  lastRefill: number;
}

interface Seat {
  info: PeerInfo;
  token: string;
  /** The currently attached connection, null while disconnected. */
  ctx: Ctx | null;
}

interface Room {
  code: string;
  game: string;
  gameVersion: number;
  mode: RoomMode;
  hostId: PeerId | null;
  epoch: number;
  locked: boolean;
  maxPeers: number;
  /** Insertion order is the tie-break for host election. */
  seats: Map<PeerId, Seat>;
  checkpoint: Checkpoint | null;
  /** `at` is absolute relay-clock time, kept so a snapshot can re-arm the alarm in a new process. */
  alarms: Map<string, { at: number; handle: unknown }>;
  /** Alarms that fired while there was no host. */
  dueAlarms: Set<string>;
  emptyTimer: unknown;
  /** Relay-clock time the last peer disconnected; null while anyone is connected. */
  emptySince: number | null;
}

/**
 * Added to the checkpoint `seq` of every restored room. After a crash the snapshot can be a few
 * commits older than what clients last saw, and a client ignores views with a lower `seq` than
 * its current one. The gap makes the first commit after a restore newer than anything seen before.
 * A room restored with no checkpoint restarts at seq 1, so clients must also accept any view after
 * a reconnect or a host change (the turn-based runtime does).
 */
export const RESTORE_SEQ_GAP = 1_000_000;

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

const hostOnlyTypes = new Set(["commit", "alarm", "room", "kick", "handoff"]);

export class Hub {
  private readonly rooms = new Map<string, Room>();
  private readonly clock: Clock;
  private readonly random: (n: number) => Uint8Array;
  private readonly emptyRoomTtlMs: number;
  private readonly defaultMaxPeers: number;
  private readonly maxRooms: number;
  private readonly allowedGames: readonly string[] | undefined;
  private readonly volatileDropBytes: number;
  private readonly rate: { burst: number; perSecond: number };
  private changes = 0;

  constructor(options: HubOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.random =
      options.randomBytes ?? ((n) => globalThis.crypto.getRandomValues(new Uint8Array(n)));
    this.emptyRoomTtlMs = options.emptyRoomTtlMs ?? 30 * 60_000;
    this.defaultMaxPeers = options.defaultMaxPeers ?? 16;
    this.maxRooms = options.maxRooms ?? 10_000;
    this.allowedGames = options.allowedGames;
    this.volatileDropBytes = options.volatileDropBytes ?? 64 * 1024;
    this.rate = options.rateLimit ?? { burst: 120, perSecond: 60 };
  }

  /** Cancels every timer and forgets all rooms. Call when shutting the relay down. */
  close() {
    for (const room of [...this.rooms.values()]) this.deleteRoom(room);
  }

  /**
   * Increases whenever something a snapshot would contain may have changed. Compare with the value
   * at the last snapshot to skip writing an identical one.
   */
  get revision(): number {
    return this.changes;
  }

  /**
   * Everything needed to carry on in another process: plain JSON-safe data. Checkpoint states are
   * shared by reference, not copied (the hub never mutates them), so serialise without modifying.
   * Connections are not part of it: after `restore` every seat is disconnected.
   */
  snapshot(): HubSnapshot {
    const rooms: RoomSnapshot[] = [];
    for (const room of this.rooms.values()) {
      rooms.push({
        code: room.code,
        game: room.game,
        gameVersion: room.gameVersion,
        mode: room.mode,
        hostId: room.hostId,
        epoch: room.epoch,
        locked: room.locked,
        maxPeers: room.maxPeers,
        seats: [...room.seats.values()].map((s) => ({ info: { ...s.info }, token: s.token })),
        checkpoint: room.checkpoint,
        alarms: [...room.alarms].map(([id, { at }]) => ({ id, at })),
        dueAlarms: [...room.dueAlarms],
        emptySince: room.emptySince,
      });
    }
    return {
      format: SNAPSHOT_FORMAT,
      protocol: PROTOCOL_VERSION,
      savedAt: this.clock.now(),
      rooms,
    };
  }

  /**
   * Loads a snapshot into an empty hub. Never throws: anything that is not a snapshot of this
   * format and protocol version is refused with a reason and the hub stays empty.
   *
   * Every seat comes back disconnected and every room without a host, under a new epoch, exactly
   * as if all sockets had dropped. Alarms keep their absolute time; one that fell due while no
   * process was running is delivered once to the first host. A room that was empty counts its
   * expiry from when it became empty; a room with connected peers counts from `savedAt`.
   */
  restore(data: unknown): RestoreResult {
    if (this.rooms.size > 0) return { ok: false, reason: "hub is not empty" };
    const parsed = parseSnapshot(data);
    if (!parsed.ok) return parsed;
    const now = this.clock.now();
    const savedAt = Math.min(parsed.snapshot.savedAt, now);
    let expired = 0;
    const skipped = parsed.skipped;
    for (const snap of parsed.snapshot.rooms) {
      if (this.allowedGames && !this.allowedGames.includes(snap.game)) {
        skipped.push(`${snap.code}: game not allowed on this relay`);
        continue;
      }
      const emptySince = Math.min(snap.emptySince ?? savedAt, now);
      if (emptySince + this.emptyRoomTtlMs <= now) {
        expired++;
        continue;
      }
      const room: Room = {
        code: snap.code,
        game: snap.game,
        gameVersion: snap.gameVersion,
        mode: snap.mode,
        hostId: null,
        epoch: snap.epoch + 1,
        locked: snap.locked,
        maxPeers: snap.maxPeers,
        seats: new Map(
          snap.seats.map((s) => [
            s.info.id,
            { info: { ...s.info, connected: false }, token: s.token, ctx: null },
          ]),
        ),
        checkpoint: snap.checkpoint && {
          seq: snap.checkpoint.seq + RESTORE_SEQ_GAP,
          state: snap.checkpoint.state,
        },
        alarms: new Map(),
        dueAlarms: new Set(snap.dueAlarms),
        emptyTimer: undefined,
        emptySince,
      };
      this.rooms.set(room.code, room);
      for (const { id, at } of snap.alarms) {
        if (at <= now) room.dueAlarms.add(id);
        else this.armAlarm(room, id, at);
      }
      room.emptyTimer = this.clock.setTimer(
        () => this.expire(room),
        emptySince + this.emptyRoomTtlMs - now,
      );
    }
    this.changes++;
    return {
      ok: true,
      rooms: this.rooms.size,
      expired,
      skipped,
      savedAt: parsed.snapshot.savedAt,
    };
  }

  stats(): { rooms: number; peers: number; connected: number } {
    let peers = 0;
    let connected = 0;
    for (const room of this.rooms.values()) {
      peers += room.seats.size;
      connected += this.connectedSeats(room).length;
    }
    return { rooms: this.rooms.size, peers, connected };
  }

  connect(connection: Connection): Session {
    const ctx: Ctx = {
      conn: connection,
      seat: null,
      room: null,
      done: false,
      tokens: this.rate.burst,
      lastRefill: this.clock.now(),
    };
    return {
      receive: (message) => this.receive(ctx, message),
      disconnected: () => this.disconnected(ctx),
    };
  }

  // -- message intake ------------------------------------------------------

  private receive(ctx: Ctx, raw: unknown) {
    if (ctx.done) return;
    if (!this.takeToken(ctx)) return this.fail(ctx, "rate-limited", "too many messages");
    const msg = parseClientMessage(raw);
    if (!msg) return this.fail(ctx, "bad-message", "invalid message");
    if (msg.t !== "ping" && msg.t !== "send") this.changes++;

    const joined = ctx.seat !== null;
    if (!joined) {
      switch (msg.t) {
        case "create":
          return this.create(ctx, msg);
        case "join":
          return this.join(ctx, msg);
        case "resume":
          return this.resume(ctx, msg);
        default:
          return this.fail(ctx, "bad-message", "expected create, join or resume");
      }
    }
    const seat = ctx.seat as Seat;
    const room = ctx.room as Room;
    // A socket that was replaced or already reported as disconnected must not act on its old seat.
    if (seat.ctx !== ctx)
      return this.fail(ctx, "not-host", "connection is no longer attached to its seat");

    if (msg.t === "create" || msg.t === "join" || msg.t === "resume") {
      return this.fail(ctx, "bad-message", "already in a room");
    }
    if (hostOnlyTypes.has(msg.t)) {
      if (room.hostId !== seat.info.id)
        return this.fail(ctx, "not-host", "only the host may do that");
      if ((msg as { epoch: number }).epoch !== room.epoch)
        return this.fail(ctx, "stale-epoch", "stale epoch");
    }
    switch (msg.t) {
      case "send":
        return this.relay(ctx, room, seat, msg);
      case "commit":
        return this.commit(ctx, room, seat, msg);
      case "alarm":
        return this.alarm(ctx, room, msg);
      case "room":
        return this.roomSettings(room, msg);
      case "kick":
        return this.kick(ctx, room, msg);
      case "handoff":
        return this.handoff(ctx, room, seat, msg);
      case "leave":
        return this.leave(ctx, room, seat);
      case "ping":
        return ctx.conn.send({ t: "pong", n: msg.n, now: this.clock.now() });
    }
  }

  private takeToken(ctx: Ctx): boolean {
    const now = this.clock.now();
    const { burst, perSecond } = this.rate;
    ctx.tokens = Math.min(burst, ctx.tokens + ((now - ctx.lastRefill) / 1000) * perSecond);
    ctx.lastRefill = now;
    if (ctx.tokens < 1) return false;
    ctx.tokens -= 1;
    return true;
  }

  /** Reports an error. Before the connection has joined, that is fatal. */
  private fail(ctx: Ctx, code: ErrorCode, message: string): undefined {
    ctx.conn.send({ t: "error", code, message });
    if (!ctx.seat) {
      ctx.done = true;
      ctx.conn.close();
    }
    return undefined;
  }

  // -- lifecycle -----------------------------------------------------------

  private create(ctx: Ctx, msg: Extract<ClientMessage, { t: "create" }>) {
    if (msg.v !== PROTOCOL_VERSION)
      return this.fail(ctx, "unsupported-version", "unsupported protocol version");
    if (this.allowedGames && !this.allowedGames.includes(msg.game)) {
      return this.fail(ctx, "game-mismatch", "game not allowed on this relay");
    }
    if (this.rooms.size >= this.maxRooms) return this.fail(ctx, "server-full", "too many rooms");
    const requested = msg.maxPeers ?? this.defaultMaxPeers;
    const room: Room = {
      code: this.newCode(),
      game: msg.game,
      gameVersion: msg.gameVersion,
      mode: msg.mode,
      hostId: null,
      epoch: 0,
      locked: false,
      maxPeers: Math.min(Math.max(requested, 1), LIMITS.maxPeersPerRoom),
      seats: new Map(),
      checkpoint: null,
      alarms: new Map(),
      dueAlarms: new Set(),
      emptyTimer: undefined,
      emptySince: null,
    };
    this.rooms.set(room.code, room);
    this.addSeat(room, ctx, msg);
    this.sendWelcome(room, ctx.seat as Seat);
    this.elect(room);
  }

  private join(ctx: Ctx, msg: Extract<ClientMessage, { t: "join" }>) {
    if (msg.v !== PROTOCOL_VERSION)
      return this.fail(ctx, "unsupported-version", "unsupported protocol version");
    const code = normalizeCode(msg.code);
    const room = code ? this.rooms.get(code) : undefined;
    if (!room) return this.fail(ctx, "room-not-found", "no such room");
    if (room.game !== msg.game || room.gameVersion !== msg.gameVersion) {
      return this.fail(ctx, "game-mismatch", "room runs a different game or version");
    }
    if (room.locked) return this.fail(ctx, "room-locked", "room is locked");
    if (room.seats.size >= room.maxPeers) return this.fail(ctx, "room-full", "room is full");
    this.cancelEmptyTimer(room);
    const seat = this.addSeat(room, ctx, msg);
    this.sendWelcome(room, seat);
    this.broadcast(room, { t: "peer", ev: "join", peer: { ...seat.info } }, seat.info.id);
    this.elect(room);
  }

  private resume(ctx: Ctx, msg: Extract<ClientMessage, { t: "resume" }>) {
    if (msg.v !== PROTOCOL_VERSION)
      return this.fail(ctx, "unsupported-version", "unsupported protocol version");
    const code = normalizeCode(msg.code);
    const room = code ? this.rooms.get(code) : undefined;
    if (!room) return this.fail(ctx, "room-not-found", "no such room");
    let seat: Seat | undefined;
    for (const s of room.seats.values()) if (s.token === msg.token) seat = s;
    if (!seat) return this.fail(ctx, "bad-token", "unknown token");

    const old = seat.ctx;
    if (old) {
      old.conn.send({ t: "bye", reason: "replaced" });
      old.conn.close();
    }
    this.cancelEmptyTimer(room);
    seat.ctx = ctx;
    seat.info.connected = true;
    ctx.seat = seat;
    ctx.room = room;
    this.sendWelcome(room, seat);
    this.broadcast(room, { t: "peer", ev: "resume", peer: { ...seat.info } }, seat.info.id);
    // A host that reloads can resume before its old socket is seen to die. The new page has no
    // state, so re-announce it as host under a new epoch, which hands it the checkpoint.
    if (old && room.hostId === seat.info.id) this.setHost(room, seat.info.id);
    else this.elect(room);
  }

  private disconnected(ctx: Ctx) {
    const seat = ctx.seat;
    const room = ctx.room;
    if (!seat || !room || seat.ctx !== ctx) return;
    this.changes++;
    seat.ctx = null;
    seat.info.connected = false;
    this.broadcast(room, { t: "peer", ev: "drop", peer: { ...seat.info } }, seat.info.id);
    if (room.hostId === seat.info.id) this.elect(room);
    this.checkEmpty(room);
  }

  private leave(ctx: Ctx, room: Room, seat: Seat) {
    this.removeSeat(room, seat);
    ctx.conn.send({ t: "bye", reason: "left" });
    this.detach(ctx);
    this.broadcast(room, { t: "peer", ev: "leave", peer: { ...seat.info, connected: false } });
    this.afterRemoval(room, seat);
  }

  private kick(ctx: Ctx, room: Room, msg: Extract<ClientMessage, { t: "kick" }>) {
    const target = room.seats.get(msg.peer);
    if (!target || target.ctx === ctx)
      return this.fail(ctx, "bad-message", "cannot kick that peer");
    const targetCtx = target.ctx;
    this.removeSeat(room, target);
    if (targetCtx) {
      targetCtx.conn.send({
        t: "bye",
        reason: "kicked",
        ...(msg.reason !== undefined && { message: msg.reason }),
      });
      this.detach(targetCtx);
    }
    this.broadcast(room, { t: "peer", ev: "kick", peer: { ...target.info, connected: false } });
    this.checkEmpty(room);
  }

  private handoff(ctx: Ctx, room: Room, seat: Seat, msg: Extract<ClientMessage, { t: "handoff" }>) {
    let next: Seat | undefined;
    if (msg.to !== undefined) {
      next = room.seats.get(msg.to);
      if (!next?.ctx || !next.info.canHost || next === seat) {
        return this.fail(ctx, "bad-message", "invalid handoff target");
      }
    } else {
      next = this.candidates(room).find((s) => s !== seat);
      if (!next) return;
    }
    this.setHost(room, next.info.id);
  }

  /** Detaches a connection the hub has closed so later calls on it are no-ops. */
  private detach(ctx: Ctx) {
    ctx.done = true;
    ctx.seat = null;
    ctx.room = null;
    ctx.conn.close();
  }

  private removeSeat(room: Room, seat: Seat) {
    room.seats.delete(seat.info.id);
    seat.info.connected = false;
    seat.ctx = null;
  }

  private afterRemoval(room: Room, seat: Seat) {
    if (room.seats.size === 0) return this.deleteRoom(room);
    if (room.hostId === seat.info.id) this.elect(room);
    this.checkEmpty(room);
  }

  // -- host election -------------------------------------------------------

  private candidates(room: Room): Seat[] {
    // Array.prototype.sort is stable, so equal joinedAt keeps insertion order.
    return this.connectedSeats(room)
      .filter((s) => s.info.canHost)
      .sort((a, b) => a.info.joinedAt - b.info.joinedAt);
  }

  /** Runs only when there is no usable host; a connected host is never displaced. */
  private elect(room: Room) {
    const current = room.hostId === null ? undefined : room.seats.get(room.hostId);
    if (current?.ctx && current.info.canHost) return;
    const next = this.candidates(room)[0]?.info.id ?? null;
    if (next === room.hostId) return;
    this.setHost(room, next);
  }

  private setHost(room: Room, hostId: PeerId | null) {
    room.epoch += 1;
    room.hostId = hostId;
    for (const seat of this.connectedSeats(room)) {
      if (seat.info.id === hostId) {
        seat.ctx?.conn.send({ t: "host", hostId, epoch: room.epoch, checkpoint: room.checkpoint });
      } else {
        seat.ctx?.conn.send({ t: "host", hostId, epoch: room.epoch });
      }
    }
    const host = hostId === null ? undefined : room.seats.get(hostId);
    if (host?.ctx) {
      for (const id of room.dueAlarms) host.ctx.conn.send({ t: "alarm", id });
      room.dueAlarms.clear();
    }
  }

  // -- in-room traffic -----------------------------------------------------

  private relay(ctx: Ctx, room: Room, seat: Seat, msg: Extract<ClientMessage, { t: "send" }>) {
    const from = seat.info.id;
    const isHost = room.hostId === from;
    let targets: Seat[];
    if (!isHost) {
      if (msg.to !== "host")
        return this.fail(ctx, "not-host", "non-hosts may only send to the host");
      const host = room.hostId === null ? undefined : room.seats.get(room.hostId);
      if (!host) return;
      targets = [host];
    } else if (msg.to === "host") {
      targets = [seat];
    } else if (msg.to === "all") {
      targets = this.connectedSeats(room).filter((s) => s !== seat);
    } else {
      const ids = new Set(typeof msg.to === "string" ? [msg.to] : msg.to);
      targets = [...ids].flatMap((id) => room.seats.get(id) ?? []);
    }
    const ch = msg.ch ?? "reliable";
    for (const target of targets) {
      const conn = target.ctx?.conn;
      if (!conn) continue;
      if (ch === "volatile" && (conn.bufferedAmount ?? 0) > this.volatileDropBytes) continue;
      conn.send({ t: "msg", from, ch, d: msg.d });
    }
  }

  private commit(ctx: Ctx, room: Room, seat: Seat, msg: Extract<ClientMessage, { t: "commit" }>) {
    const min = room.checkpoint ? room.checkpoint.seq + 1 : 0;
    if (msg.seq < min) return this.fail(ctx, "bad-message", "seq must increase");
    room.checkpoint = { seq: msg.seq, state: msg.state };
    ctx.conn.send({ t: "committed", seq: msg.seq });
    for (const out of msg.out) {
      const targets =
        out.to === "all"
          ? this.connectedSeats(room).filter((s) => s !== seat)
          : [...new Set(typeof out.to === "string" ? [out.to] : out.to)].flatMap(
              (id) => room.seats.get(id) ?? [],
            );
      for (const target of targets) {
        target.ctx?.conn.send({ t: "msg", from: seat.info.id, ch: "reliable", d: out.d });
      }
    }
  }

  private alarm(ctx: Ctx, room: Room, msg: Extract<ClientMessage, { t: "alarm" }>) {
    const existing = room.alarms.get(msg.id);
    if (msg.at === null) {
      if (existing !== undefined) this.clock.clearTimer(existing.handle);
      room.alarms.delete(msg.id);
      room.dueAlarms.delete(msg.id);
      return;
    }
    if (existing === undefined && room.alarms.size >= LIMITS.maxAlarmsPerRoom) {
      return this.fail(ctx, "bad-message", "too many alarms");
    }
    if (existing !== undefined) this.clock.clearTimer(existing.handle);
    room.dueAlarms.delete(msg.id);
    this.armAlarm(room, msg.id, msg.at);
  }

  private armAlarm(room: Room, id: string, at: number) {
    const handle = this.clock.setTimer(
      () => {
        this.changes++;
        room.alarms.delete(id);
        const host = room.hostId === null ? undefined : room.seats.get(room.hostId);
        if (host?.ctx) host.ctx.conn.send({ t: "alarm", id });
        else room.dueAlarms.add(id);
      },
      Math.max(0, at - this.clock.now()),
    );
    room.alarms.set(id, { at, handle });
  }

  private roomSettings(room: Room, msg: Extract<ClientMessage, { t: "room" }>) {
    if (msg.locked !== undefined) room.locked = msg.locked;
    if (msg.maxPeers !== undefined) {
      room.maxPeers = Math.min(Math.max(msg.maxPeers, room.seats.size, 1), LIMITS.maxPeersPerRoom);
    }
    this.broadcast(room, { t: "room", locked: room.locked, maxPeers: room.maxPeers });
  }

  // -- room bookkeeping ----------------------------------------------------

  private checkEmpty(room: Room) {
    // A socket can report its close after the room is gone (hub shutdown); arm nothing then.
    if (this.rooms.get(room.code) !== room) return;
    if (this.connectedSeats(room).length > 0 || room.emptyTimer !== undefined) return;
    room.emptySince = this.clock.now();
    room.emptyTimer = this.clock.setTimer(() => this.expire(room), this.emptyRoomTtlMs);
  }

  private expire(room: Room) {
    room.emptyTimer = undefined;
    if (this.connectedSeats(room).length > 0) return;
    this.changes++;
    this.deleteRoom(room);
  }

  private cancelEmptyTimer(room: Room) {
    room.emptySince = null;
    if (room.emptyTimer === undefined) return;
    this.clock.clearTimer(room.emptyTimer);
    room.emptyTimer = undefined;
  }

  private deleteRoom(room: Room) {
    this.cancelEmptyTimer(room);
    for (const { handle } of room.alarms.values()) this.clock.clearTimer(handle);
    room.alarms.clear();
    room.dueAlarms.clear();
    this.rooms.delete(room.code);
  }

  private addSeat(
    room: Room,
    ctx: Ctx,
    opts: { name: string; canHost?: boolean; meta?: PeerInfo["meta"] },
  ): Seat {
    const info: PeerInfo = {
      id: this.newPeerId(room),
      name: opts.name,
      connected: true,
      canHost: opts.canHost ?? true,
      joinedAt: this.clock.now(),
    };
    if (opts.meta !== undefined) info.meta = opts.meta;
    const seat: Seat = { info, token: hex(this.random(32)), ctx };
    room.seats.set(info.id, seat);
    ctx.seat = seat;
    ctx.room = room;
    return seat;
  }

  private sendWelcome(room: Room, seat: Seat) {
    const info: RoomInfo = {
      code: room.code,
      game: room.game,
      gameVersion: room.gameVersion,
      mode: room.mode,
      hostId: room.hostId,
      epoch: room.epoch,
      locked: room.locked,
      maxPeers: room.maxPeers,
      peers: [...room.seats.values()].map((s) => ({ ...s.info })),
    };
    seat.ctx?.conn.send({
      t: "welcome",
      you: seat.info.id,
      token: seat.token,
      room: info,
      now: this.clock.now(),
    });
  }

  private connectedSeats(room: Room): Seat[] {
    return [...room.seats.values()].filter((s) => s.ctx !== null);
  }

  private broadcast(room: Room, message: ServerMessage, except?: PeerId) {
    for (const seat of this.connectedSeats(room)) {
      if (seat.info.id !== except) seat.ctx?.conn.send(message);
    }
  }

  // -- randomness ----------------------------------------------------------

  /** Rejection sampling keeps every symbol equally likely. */
  private randomSymbols(alphabet: string, length: number): string {
    const limit = 256 - (256 % alphabet.length);
    let out = "";
    while (out.length < length) {
      for (const byte of this.random(length * 2)) {
        if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
      }
    }
    return out;
  }

  private newCode(): string {
    for (;;) {
      const code = this.randomSymbols(CODE_ALPHABET, CODE_LENGTH);
      if (!this.rooms.has(code)) return code;
    }
  }

  private newPeerId(room: Room): PeerId {
    for (;;) {
      const id = `p${this.randomSymbols(ID_ALPHABET, 10)}`;
      if (!room.seats.has(id)) return id;
    }
  }
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
