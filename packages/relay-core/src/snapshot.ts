import type { Checkpoint, PeerInfo, RoomMode } from "@games/protocol";
import { LIMITS, normalizeCode, PROTOCOL_VERSION } from "@games/protocol";

/** Bump when the shape below changes in a way an older or newer relay cannot read. */
export const SNAPSHOT_FORMAT = 1;

export interface RoomSnapshot {
  code: string;
  game: string;
  gameVersion: number;
  mode: RoomMode;
  hostId: string | null;
  epoch: number;
  locked: boolean;
  maxPeers: number;
  /** In seat (insertion) order, the tie-break for host election. Tokens are secrets. */
  seats: { info: PeerInfo; token: string }[];
  checkpoint: Checkpoint | null;
  /** `at` is absolute relay-clock time. */
  alarms: { id: string; at: number }[];
  dueAlarms: string[];
  /** Relay-clock time the last peer disconnected; null if someone was connected. */
  emptySince: number | null;
}

export interface HubSnapshot {
  format: number;
  /** `PROTOCOL_VERSION` of the relay that wrote it. Rooms do not survive a protocol change. */
  protocol: number;
  /** Relay-clock time the snapshot was taken. */
  savedAt: number;
  rooms: RoomSnapshot[];
}

export type RestoreResult =
  | {
      ok: true;
      rooms: number;
      /** Rooms whose time without players ran out while no relay was running. */
      expired: number;
      /** Rooms left out because their data was unusable or their game is no longer allowed, with the reason. */
      skipped: string[];
      savedAt: number;
    }
  | { ok: false; reason: string };

type Parsed =
  | { ok: true; snapshot: HubSnapshot; skipped: string[] }
  | { ok: false; reason: string };

/** Far below 2^53, so adding to it (a new epoch, `RESTORE_SEQ_GAP`) stays exact. */
const MAX_COUNTER = 2 ** 50;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";

/**
 * Checks everything the hub relies on, so a damaged or foreign file cannot crash it later. A file
 * of the wrong kind is refused whole. One unusable room is left out and the rest are kept: a
 * single odd room must not cost every other room its game.
 */
export function parseSnapshot(data: unknown): Parsed {
  try {
    if (!isObj(data)) return { ok: false, reason: "not a snapshot object" };
    if (data.format !== SNAPSHOT_FORMAT) {
      return {
        ok: false,
        reason: `snapshot format ${String(data.format)}, this relay reads ${SNAPSHOT_FORMAT}`,
      };
    }
    if (data.protocol !== PROTOCOL_VERSION) {
      return {
        ok: false,
        reason: `snapshot protocol version ${String(data.protocol)}, this relay speaks ${PROTOCOL_VERSION}`,
      };
    }
    if (!isNum(data.savedAt) || !Array.isArray(data.rooms)) {
      return { ok: false, reason: "malformed snapshot" };
    }
    const codes = new Set<string>();
    const rooms: RoomSnapshot[] = [];
    const skipped: string[] = [];
    for (const room of data.rooms) {
      const code = isObj(room) && isStr(room.code) ? room.code.slice(0, 16) : "?";
      const problem = roomProblem(room) ?? (codes.has(code) ? "duplicate code" : null);
      if (problem) {
        skipped.push(`${code}: ${problem}`);
        continue;
      }
      codes.add(code);
      rooms.push(room as RoomSnapshot);
    }
    return { ok: true, snapshot: { ...(data as unknown as HubSnapshot), rooms }, skipped };
  } catch (error) {
    return { ok: false, reason: `unreadable snapshot: ${String(error)}` };
  }
}

function roomProblem(r: unknown): string | null {
  if (!isObj(r)) return "not an object";
  if (!isStr(r.code) || normalizeCode(r.code) !== r.code) return "code";
  if (!isStr(r.game) || !isInt(r.gameVersion)) return "game or gameVersion";
  if (r.mode !== "turn" && r.mode !== "realtime") return "mode";
  if (r.hostId !== null && !isStr(r.hostId)) return "hostId";
  if (!isInt(r.epoch) || r.epoch < 0 || r.epoch > MAX_COUNTER) return "epoch";
  if (typeof r.locked !== "boolean") return "locked";
  if (!isInt(r.maxPeers) || r.maxPeers < 1 || r.maxPeers > LIMITS.maxPeersPerRoom) {
    return "maxPeers";
  }
  if (!Array.isArray(r.seats) || r.seats.length === 0) return "seats";
  if (r.seats.length > LIMITS.maxPeersPerRoom) return "too many seats";
  const ids = new Set<string>();
  const tokens = new Set<string>();
  for (const seat of r.seats) {
    if (!isObj(seat) || !isStr(seat.token) || seat.token === "" || !isObj(seat.info)) return "seat";
    const info = seat.info;
    if (!isStr(info.id) || !isStr(info.name) || !isNum(info.joinedAt)) return "seat info";
    if (typeof info.canHost !== "boolean" || typeof info.connected !== "boolean") {
      return "seat info";
    }
    if (ids.has(info.id) || tokens.has(seat.token)) return "duplicate seat";
    ids.add(info.id);
    tokens.add(seat.token);
  }
  if (r.checkpoint !== null) {
    if (!isObj(r.checkpoint) || !isInt(r.checkpoint.seq) || !("state" in r.checkpoint)) {
      return "checkpoint";
    }
    if (Math.abs(r.checkpoint.seq) > MAX_COUNTER) return "checkpoint seq";
  }
  if (!Array.isArray(r.alarms) || !Array.isArray(r.dueAlarms)) return "alarms";
  if (r.alarms.length + r.dueAlarms.length > LIMITS.maxAlarmsPerRoom) return "too many alarms";
  const alarmIds = new Set<string>();
  for (const alarm of r.alarms) {
    if (!isObj(alarm) || !isStr(alarm.id) || !isNum(alarm.at)) return "alarm";
    if (alarmIds.has(alarm.id)) return "duplicate alarm";
    alarmIds.add(alarm.id);
  }
  for (const id of r.dueAlarms) {
    if (!isStr(id)) return "dueAlarms";
    if (alarmIds.has(id)) return "duplicate alarm";
    alarmIds.add(id);
  }
  if (r.emptySince !== null && !isNum(r.emptySince)) return "emptySince";
  return null;
}
