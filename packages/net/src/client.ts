import type {
  ByeReason,
  Channel,
  Checkpoint,
  ClientMessage,
  ErrorCode,
  JoinOptions,
  Json,
  Outgoing,
  PeerEvent,
  PeerId,
  PeerInfo,
  Recipient,
  RoomInfo,
  RoomMode,
  ServerMessage,
} from "@games/protocol";
import { normalizeCode, PROTOCOL_VERSION } from "@games/protocol";
import { type Clock, systemClock } from "@games/relay-core";
import { memoryStorage, type TokenStorage } from "./storage";
import type { Transport, TransportLink } from "./transport";

/** A refusal or failure from the relay. `closed`: the connection ended first. `no-seat`: nothing stored to resume. */
export class RelayError extends Error {
  code: ErrorCode | "closed" | "no-seat";
  constructor(code: ErrorCode | "closed" | "no-seat", message: string) {
    super(message);
    this.name = "RelayError";
    this.code = code;
  }
}

export interface RoomClientOptions {
  transport: Transport;
  game: string;
  gameVersion: number;
  /** Default "turn". */
  mode?: RoomMode;
  /** Where the seat token is kept. Default: memory only. */
  storage?: TokenStorage;
  /** Time source for every timer. Default: the system clock. */
  clock?: Clock;
  /** Reconnect backoff, exponential with jitter. Default 500 / 8000. */
  reconnect?: { minMs: number; maxMs: number };
  /** Default 10_000. */
  pingIntervalMs?: number;
}

export type RoomStatus = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

export interface RoomEvents {
  status: RoomStatus;
  /** Fired after ANY change to room info (peers, host, epoch, locked...). */
  room: RoomInfo;
  peer: { ev: PeerEvent; peer: PeerInfo };
  /** `checkpoint` is null unless `isHost`. */
  host: { hostId: PeerId | null; epoch: number; isHost: boolean; checkpoint: Checkpoint | null };
  message: { from: PeerId; ch: Channel; d: Json };
  alarm: string;
  /** The relay stored the host's commit with this `seq` (host only). */
  committed: number;
  error: { code: ErrorCode; message: string };
  closed: { reason: ByeReason | "resume-failed" | "local"; message?: string };
}

const HANDSHAKE_TIMEOUT_MS = 10_000;

type Listener = (payload: never) => void;

/** One connection to a room: create/join/resume, reconnect, clock sync, and typed events. */
export class RoomClient {
  status: RoomStatus = "idle";
  room: RoomInfo | null = null;
  me: PeerId | null = null;
  private readonly options: RoomClientOptions;
  private readonly clock: Clock;
  private readonly storage: TokenStorage;
  private readonly listeners = new Map<keyof RoomEvents, Set<Listener>>();
  private link: TransportLink | null = null;
  /** Bumped whenever the current link is abandoned, so late callbacks from it are ignored. */
  private generation = 0;
  private pending: { resolve(room: RoomInfo): void; reject(error: Error): void } | null = null;
  private code: string | null = null;
  private offset = 0;
  private bestRtt = Number.POSITIVE_INFINITY;
  private pingN = 0;
  /** Only the latest ping is tracked, so a silent relay cannot make this grow. */
  private lastPing: { n: number; sentAt: number } | null = null;
  private pingTimer: unknown;
  private handshakeTimer: unknown;
  private reconnectTimer: unknown;
  private attempts = 0;

  constructor(options: RoomClientOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.storage = options.storage ?? memoryStorage();
  }

  get isHost(): boolean {
    return this.room !== null && this.me !== null && this.room.hostId === this.me;
  }

  get epoch(): number {
    return this.room?.epoch ?? 0;
  }

  create(options: JoinOptions & { maxPeers?: number }): Promise<RoomInfo> {
    return this.begin({
      t: "create",
      v: PROTOCOL_VERSION,
      game: this.options.game,
      gameVersion: this.options.gameVersion,
      mode: this.options.mode ?? "turn",
      ...options,
    });
  }

  join(code: string, options: JoinOptions): Promise<RoomInfo> {
    return this.begin({
      t: "join",
      v: PROTOCOL_VERSION,
      code: normalizeCode(code) ?? code,
      game: this.options.game,
      gameVersion: this.options.gameVersion,
      ...options,
    });
  }

  /** Reclaims the seat stored for `code`. Rejects with `RelayError("no-seat")` if there is none. */
  resume(code: string): Promise<RoomInfo> {
    const normalized = normalizeCode(code) ?? code;
    const token = this.storage.get(this.key(normalized));
    if (token === null) return Promise.reject(new RelayError("no-seat", "no stored seat"));
    return this.begin({ t: "resume", v: PROTOCOL_VERSION, code: normalized, token }, normalized);
  }

  hasSeat(code: string): boolean {
    return this.storage.get(this.key(normalizeCode(code) ?? code)) !== null;
  }

  /** Returns false (message dropped) unless connected. */
  send(to: Recipient, d: Json, ch?: Channel): boolean {
    return this.transmit({ t: "send", to, d, ...(ch && { ch }) });
  }

  /** Host only. Stores `state` as the checkpoint and delivers `out`, atomically. */
  commit(seq: number, state: Json, out: Outgoing[]): boolean {
    return this.hostOnly((epoch) => ({ t: "commit", epoch, seq, state, out }));
  }

  /** Host only. Wake the current host at relay-clock time `at`; null cancels. */
  setAlarm(id: string, at: number | null): boolean {
    return this.hostOnly((epoch) => ({ t: "alarm", epoch, id, at }));
  }

  /** Host only. */
  setRoom(change: { locked?: boolean; maxPeers?: number }): boolean {
    return this.hostOnly((epoch) => ({ t: "room", epoch, ...change }));
  }

  /** Host only. Removes the peer's seat for good. */
  kick(peer: PeerId, reason?: string): boolean {
    return this.hostOnly((epoch) => ({
      t: "kick",
      epoch,
      peer,
      ...(reason !== undefined && { reason }),
    }));
  }

  /** Host only. Give up the host role, optionally to a specific peer. */
  handoff(to?: PeerId): boolean {
    return this.hostOnly((epoch) => ({ t: "handoff", epoch, ...(to !== undefined && { to }) }));
  }

  /**
   * Gives up the seat for good: tells the relay, forgets the token, closes.
   * While reconnecting there is no link to tell, so the seat lingers on the relay until the room expires.
   */
  leave(): void {
    if (this.status === "idle") return;
    if (this.status === "connected") this.link?.send({ t: "leave" });
    this.forgetToken();
    this.shutdown("closed", { reason: "local" });
  }

  /** Closes the socket but keeps the seat (the token) so `resume` still works. No reconnect. */
  close(): void {
    if (this.status === "idle" || this.status === "closed") return;
    this.shutdown("closed", { reason: "local" });
  }

  /** Estimate of the relay's clock, ms. */
  serverNow(): number {
    return this.clock.now() + this.offset;
  }

  on<K extends keyof RoomEvents>(event: K, listener: (payload: RoomEvents[K]) => void): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    this.listeners.set(event, set);
    set.add(listener);
    return () => void set.delete(listener);
  }

  // -- connecting ----------------------------------------------------------

  private begin(first: ClientMessage, code: string | null = null): Promise<RoomInfo> {
    // Nothing may change before this check passes, or a rejected call would corrupt a live client.
    if (this.status !== "idle" && this.status !== "closed") {
      return Promise.reject(new Error("RoomClient is already in use; make a new one"));
    }
    this.code = code;
    this.room = null;
    this.me = null;
    this.attempts = 0;
    this.setStatus("connecting");
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.openLink(first);
    });
  }

  private openLink(first: ClientMessage) {
    const generation = ++this.generation;
    const live = () => generation === this.generation;
    this.handshakeTimer = this.clock.setTimer(() => {
      this.handshakeTimer = undefined;
      if (!live()) return;
      this.abandonLink();
      this.linkLost("handshake timed out");
    }, HANDSHAKE_TIMEOUT_MS);
    try {
      this.link = this.transport.open({
        onOpen: () => live() && this.link?.send(first),
        onMessage: (message) => live() && this.handle(message),
        onClose: () => live() && this.linkLost("connection closed before welcome"),
      });
    } catch {
      this.abandonLink();
      this.linkLost("could not open a connection");
    }
  }

  private get transport(): Transport {
    return this.options.transport;
  }

  private abandonLink() {
    this.generation++;
    this.stopTimers();
    const link = this.link;
    this.link = null;
    link?.close();
  }

  private stopTimers() {
    if (this.pingTimer !== undefined) this.clock.clearTimer(this.pingTimer);
    if (this.handshakeTimer !== undefined) this.clock.clearTimer(this.handshakeTimer);
    this.handshakeTimer = undefined;
    if (this.reconnectTimer !== undefined) this.clock.clearTimer(this.reconnectTimer);
    this.pingTimer = undefined;
    this.reconnectTimer = undefined;
  }

  private shutdown(status: RoomStatus, closed: RoomEvents["closed"]) {
    this.abandonLink();
    const pending = this.pending;
    this.pending = null;
    pending?.reject(new RelayError("closed", closed.message ?? "connection closed"));
    this.setStatus(status);
    this.emit("closed", closed);
  }

  /** The link ended or never worked: fail the first call, or retry when we already have a seat. */
  private linkLost(message: string) {
    this.link = null;
    this.stopTimers();
    if (this.pending) {
      this.pending.reject(new RelayError("closed", message));
      this.pending = null;
      this.setStatus("idle");
      return;
    }
    if (this.status === "closed" || this.status === "idle") return;
    this.setStatus("reconnecting");
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    const { minMs, maxMs } = this.options.reconnect ?? { minMs: 500, maxMs: 8000 };
    const base = Math.min(maxMs, minMs * 2 ** Math.min(this.attempts, 20));
    const delay = base * (0.5 + Math.random() * 0.5);
    this.attempts++;
    this.reconnectTimer = this.clock.setTimer(() => {
      this.reconnectTimer = undefined;
      const token = this.code ? this.storage.get(this.key(this.code)) : null;
      if (this.code === null || token === null) return this.resumeFailed("seat token missing");
      this.openLink({ t: "resume", v: PROTOCOL_VERSION, code: this.code, token });
    }, delay);
  }

  private resumeFailed(message: string) {
    this.forgetToken();
    this.shutdown("closed", { reason: "resume-failed", message });
  }

  // -- incoming ------------------------------------------------------------

  private handle(message: ServerMessage) {
    switch (message.t) {
      case "welcome":
        return this.onWelcome(message);
      case "pong":
        return this.onPong(message);
      case "committed":
        return this.emit("committed", message.seq);
      case "error":
        return this.onError(message);
      case "bye":
        if (
          message.reason === "kicked" ||
          message.reason === "left" ||
          message.reason === "room-closed"
        ) {
          this.forgetToken();
        }
        return this.shutdown("closed", {
          reason: message.reason,
          ...(message.message !== undefined && { message: message.message }),
        });
    }
    const room = this.room;
    if (!room || this.status !== "connected") return;
    switch (message.t) {
      case "peer": {
        const { peer } = message;
        let peers: PeerInfo[];
        if (message.ev === "leave" || message.ev === "kick") {
          peers = room.peers.filter((p) => p.id !== peer.id);
        } else if (room.peers.some((p) => p.id === peer.id)) {
          peers = room.peers.map((p) => (p.id === peer.id ? peer : p));
        } else {
          peers = [...room.peers, peer];
        }
        this.updateRoom({ ...room, peers });
        this.emit("peer", { ev: message.ev, peer });
        return;
      }
      case "host": {
        this.updateRoom({ ...room, hostId: message.hostId, epoch: message.epoch });
        const isHost = message.hostId !== null && message.hostId === this.me;
        this.emit("host", {
          hostId: message.hostId,
          epoch: message.epoch,
          isHost,
          checkpoint: isHost ? (message.checkpoint ?? null) : null,
        });
        return;
      }
      case "room":
        this.updateRoom({ ...room, locked: message.locked, maxPeers: message.maxPeers });
        return;
      case "msg":
        this.emit("message", { from: message.from, ch: message.ch, d: message.d });
        return;
      case "alarm":
        this.emit("alarm", message.id);
    }
  }

  private onWelcome(message: Extract<ServerMessage, { t: "welcome" }>) {
    const previous = this.room;
    this.me = message.you;
    this.code = message.room.code;
    this.storage.set(this.key(message.room.code), message.token);
    this.room = message.room;
    this.offset = message.now - this.clock.now();
    this.bestRtt = Number.POSITIVE_INFINITY;
    this.lastPing = null;
    this.attempts = 0;
    if (this.handshakeTimer !== undefined) this.clock.clearTimer(this.handshakeTimer);
    this.handshakeTimer = undefined;
    this.setStatus("connected");
    this.emit("room", message.room);
    const { hostId, epoch } = message.room;
    // Host changes that happened while we were away. If we are host, the relay follows up with `host` + checkpoint.
    if (
      hostId !== null &&
      hostId !== message.you &&
      (previous?.hostId !== hostId || previous.epoch !== epoch)
    ) {
      this.emit("host", { hostId, epoch, isHost: false, checkpoint: null });
    }
    this.ping();
    const pending = this.pending;
    this.pending = null;
    pending?.resolve(message.room);
  }

  private ping() {
    const n = ++this.pingN;
    this.lastPing = { n, sentAt: this.clock.now() };
    this.link?.send({ t: "ping", n });
    this.pingTimer = this.clock.setTimer(() => this.ping(), this.options.pingIntervalMs ?? 10_000);
  }

  private onPong(message: Extract<ServerMessage, { t: "pong" }>) {
    if (this.lastPing?.n !== message.n) return;
    const { sentAt } = this.lastPing;
    this.lastPing = null;
    const rtt = this.clock.now() - sentAt;
    if (rtt < this.bestRtt) {
      this.bestRtt = rtt;
      this.offset = message.now - (sentAt + rtt / 2);
    }
  }

  private onError(message: Extract<ServerMessage, { t: "error" }>) {
    if (this.handshakeTimer !== undefined) this.clock.clearTimer(this.handshakeTimer);
    this.handshakeTimer = undefined;
    if (this.pending) {
      this.pending.reject(new RelayError(message.code, message.message));
      this.pending = null;
      this.abandonLink();
      this.setStatus("idle");
      return;
    }
    this.emit("error", { code: message.code, message: message.message });
    // An error while reconnecting means the resume was refused (the relay closes the socket after it).
    if (this.status === "reconnecting") {
      if (message.code === "bad-token" || message.code === "room-not-found") {
        this.resumeFailed(message.message);
      } else {
        this.abandonLink();
        this.scheduleReconnect();
      }
    }
  }

  // -- helpers -------------------------------------------------------------

  private key(code: string): string {
    return `games:seat:${this.options.game}:${code.toUpperCase()}`;
  }

  private forgetToken() {
    if (this.code !== null) this.storage.remove(this.key(this.code));
  }

  private transmit(message: ClientMessage): boolean {
    if (this.status !== "connected" || !this.link) return false;
    this.link.send(message);
    return true;
  }

  private hostOnly(build: (epoch: number) => ClientMessage): boolean {
    if (!this.isHost) return false;
    return this.transmit(build(this.epoch));
  }

  private setStatus(status: RoomStatus) {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", status);
  }

  private updateRoom(room: RoomInfo) {
    this.room = room;
    this.emit("room", room);
  }

  private emit<K extends keyof RoomEvents>(event: K, payload: RoomEvents[K]) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as (payload: RoomEvents[K]) => void)(payload);
      } catch (error) {
        // Surface it without breaking the other listeners or message handling.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }
}
