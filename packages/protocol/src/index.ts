/**
 * Wire protocol between a game client and the relay.
 *
 * The relay is game-agnostic. It knows rooms, peers, who the host is, and the
 * host's last checkpoint. It never interprets game payloads (`Json` fields).
 *
 * Topology: a star through the relay. Exactly one peer per room is the host
 * (the authority). Other peers talk only to the host; the host talks to anyone.
 * The relay alone decides who the host is, so there is no split brain.
 */

export const PROTOCOL_VERSION = 1;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Relay-assigned. Stable for a peer's whole life in a room, across reconnects. */
export type PeerId = string;
export type RoomCode = string;

/**
 * `turn`: every state change is a `commit` (checkpoint + fan-out, atomic), so
 * host migration loses nothing.
 * `realtime`: the host streams over the volatile channel and checkpoints
 * periodically; migration resumes from the last checkpoint.
 */
export type RoomMode = "turn" | "realtime";

/**
 * `reliable`: ordered, never dropped.
 * `volatile`: latest-wins. The relay may drop a volatile message when the
 * recipient's socket is backed up. Use for inputs and snapshots.
 */
export type Channel = "reliable" | "volatile";

export interface PeerInfo {
  id: PeerId;
  name: string;
  connected: boolean;
  /** False for devices that must never be picked as host (e.g. a phone used as a controller). */
  canHost: boolean;
  /** Relay clock, ms since epoch. Defines seat order and host election order. */
  joinedAt: number;
  meta?: Json;
}

export interface RoomInfo {
  code: RoomCode;
  game: string;
  gameVersion: number;
  mode: RoomMode;
  /** Null while no host-capable peer is connected. */
  hostId: PeerId | null;
  /** Increments on every host change. Host-only messages carry it. */
  epoch: number;
  /** When locked, new peers cannot join (resuming peers still can). */
  locked: boolean;
  maxPeers: number;
  peers: PeerInfo[];
}

export interface Checkpoint {
  seq: number;
  state: Json;
}

export type Recipient = "host" | "all" | PeerId | PeerId[];

export interface Outgoing {
  to: "all" | PeerId | PeerId[];
  d: Json;
}

// ---------------------------------------------------------------------------
// Client -> relay
// ---------------------------------------------------------------------------

export interface JoinOptions {
  name: string;
  canHost?: boolean;
  meta?: Json;
}

export type ClientMessage =
  /** First message on a connection: open a new room. The creator becomes host. */
  | ({
      t: "create";
      v: number;
      game: string;
      gameVersion: number;
      mode: RoomMode;
      maxPeers?: number;
    } & JoinOptions)
  /** First message on a connection: join a room by invite code. */
  | ({ t: "join"; v: number; code: RoomCode; game: string; gameVersion: number } & JoinOptions)
  /** First message on a connection: reclaim a seat after a disconnect or reload. */
  | { t: "resume"; v: number; code: RoomCode; token: string }
  /** Non-hosts may only send to "host". */
  | { t: "send"; to: Recipient; ch?: Channel; d: Json }
  /**
   * Host only. Atomically stores `state` as the room checkpoint and delivers
   * `out`. Because both happen in one step, no peer ever sees a state newer
   * than the checkpoint a future host will resume from.
   */
  | { t: "commit"; epoch: number; seq: number; state: Json; out: Outgoing[] }
  /**
   * Host only. Ask the relay to send `alarm` to whoever is host at time `at`
   * (relay clock). Survives host migration. `at: null` cancels. Setting an
   * existing id replaces it.
   */
  | { t: "alarm"; epoch: number; id: string; at: number | null }
  /** Host only. */
  | { t: "room"; epoch: number; locked?: boolean; maxPeers?: number }
  /** Host only. Removes the peer's seat and invalidates its token. */
  | { t: "kick"; epoch: number; peer: PeerId; reason?: string }
  /** Host only. Give up the host role (e.g. tab going to the background). */
  | { t: "handoff"; epoch: number; to?: PeerId }
  /** Give up the seat for good. A plain disconnect keeps the seat. */
  | { t: "leave" }
  | { t: "ping"; n: number };

// ---------------------------------------------------------------------------
// Relay -> client
// ---------------------------------------------------------------------------

export type PeerEvent = "join" | "resume" | "drop" | "leave" | "kick";

export type ErrorCode =
  | "bad-message"
  | "unsupported-version"
  | "room-not-found"
  | "room-full"
  | "room-locked"
  | "game-mismatch"
  | "bad-token"
  | "not-host"
  | "stale-epoch"
  | "rate-limited"
  | "too-large"
  | "server-full";

export type ByeReason = "kicked" | "left" | "replaced" | "room-closed" | "error";

export type ServerMessage =
  /** Reply to create/join/resume. `token` is the secret used to `resume`. */
  | { t: "welcome"; you: PeerId; token: string; room: RoomInfo; now: number }
  | { t: "peer"; ev: PeerEvent; peer: PeerInfo }
  /**
   * Sent to everyone on every host change. The peer that became host also gets
   * `checkpoint` (null if nothing was ever committed) and must take over from
   * it. Also sent to the creator right after `welcome`.
   */
  | { t: "host"; hostId: PeerId | null; epoch: number; checkpoint?: Checkpoint | null }
  | { t: "room"; locked: boolean; maxPeers: number }
  | { t: "msg"; from: PeerId; ch: Channel; d: Json }
  /**
   * To the host, after its `commit` was stored. Until this arrives the host
   * must not treat that state as final (a host that was replaced without
   * knowing it never receives it).
   */
  | { t: "committed"; seq: number }
  | { t: "alarm"; id: string }
  | { t: "pong"; n: number; now: number }
  | { t: "error"; code: ErrorCode; message: string }
  /** The relay closes the connection right after this. Do not auto-reconnect. */
  | { t: "bye"; reason: ByeReason; message?: string };

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

/** No 0/O, 1/I/L, or U (avoids look-alikes and most accidental words). */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const CODE_LENGTH = 6;

export const LIMITS = {
  /** Encoded size of one message. */
  maxMessageBytes: 256 * 1024,
  maxNameLength: 32,
  maxGameIdLength: 48,
  maxPeersPerRoom: 64,
  maxAlarmsPerRoom: 16,
  /** Encoded size of a peer's `meta`. It is repeated in every RoomInfo. */
  maxMetaBytes: 1024,
  /** Nesting depth of a message. Deeper JSON can overflow the stack when re-encoded. */
  maxDepth: 64,
} as const;

/** Relay pings each socket this often; proxies drop idle sockets after ~60s. */
export const HEARTBEAT_INTERVAL_MS = 25_000;

/** Uppercases, strips separators and whitespace. Returns null if not a valid code. */
export function normalizeCode(input: string): RoomCode | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** v1 uses JSON text frames. Keep all encoding behind these two functions. */
export function encode(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

/** Returns undefined for anything that is not a JSON object with a string `t`. */
export function decode(raw: string): { t: string; [key: string]: unknown } | undefined {
  if (raw.length > LIMITS.maxMessageBytes || tooDeep(raw)) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { t?: unknown }).t === "string"
    ) {
      return value as { t: string };
    }
  } catch {
    // fall through
  }
  return undefined;
}
export * from "./validate";

function tooDeep(raw: string): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charCodeAt(i);
    if (inString) {
      if (ch === 92)
        i++; // backslash: skip the escaped character
      else if (ch === 34) inString = false;
    } else if (ch === 34) inString = true;
    else if (ch === 123 || ch === 91) {
      if (++depth > LIMITS.maxDepth) return true;
    } else if (ch === 125 || ch === 93) depth--;
  }
  return false;
}
