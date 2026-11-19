import type {
  Channel,
  ClientMessage,
  JoinOptions,
  Json,
  Outgoing,
  Recipient,
  RoomMode,
} from "./index";
import { LIMITS } from "./index";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
/** Safe integers only: a counter beyond 2^53 cannot be incremented, compared or stored exactly. */
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const has = (o: Obj, k: string) => Object.hasOwn(o, k) && o[k] !== undefined;

function peerIds(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.every(isStr) ? (v as string[]) : null;
}

function parseTo(v: unknown, allowHost: boolean): Recipient | null {
  if (isStr(v)) return v === "host" && !allowHost ? null : v;
  return peerIds(v);
}

function parseOutgoing(v: unknown): Outgoing | null {
  if (!isObj(v) || !has(v, "d")) return null;
  const to = parseTo(v.to, false);
  if (to === null) return null;
  return { to: to as Outgoing["to"], d: v.d as Outgoing["d"] };
}

/** Shared by create and join. Returns null when any common field is invalid. */
function parseJoinFields(o: Obj): JoinOptions | null {
  if (!isStr(o.name)) return null;
  const name = o.name.trim();
  if (name.length < 1 || name.length > LIMITS.maxNameLength) return null;
  const out: JoinOptions = { name };
  if (o.canHost !== undefined) {
    if (typeof o.canHost !== "boolean") return null;
    out.canHost = o.canHost;
  }
  if (has(o, "meta")) {
    if (JSON.stringify(o.meta).length > LIMITS.maxMetaBytes) return null;
    out.meta = o.meta as Json;
  }
  return out;
}

const isGame = (v: unknown): v is string =>
  isStr(v) && v.length > 0 && v.length <= LIMITS.maxGameIdLength && /^[a-z0-9-]+$/.test(v);

export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isObj(value) || !isStr(value.t)) return null;
  const o = value;
  switch (o.t) {
    case "create": {
      if (!isInt(o.v) || !isGame(o.game) || !isInt(o.gameVersion)) return null;
      if (o.mode !== "turn" && o.mode !== "realtime") return null;
      const j = parseJoinFields(o);
      if (!j) return null;
      const msg = {
        t: "create" as const,
        v: o.v,
        game: o.game,
        gameVersion: o.gameVersion,
        mode: o.mode as RoomMode,
        ...j,
      } as ClientMessage & { t: "create" };
      if (o.maxPeers !== undefined) {
        if (!isInt(o.maxPeers)) return null;
        msg.maxPeers = o.maxPeers;
      }
      return msg;
    }
    case "join": {
      if (!isInt(o.v) || !isStr(o.code) || !isGame(o.game) || !isInt(o.gameVersion)) return null;
      const j = parseJoinFields(o);
      if (!j) return null;
      return {
        t: "join",
        v: o.v,
        code: o.code,
        game: o.game,
        gameVersion: o.gameVersion,
        ...j,
      } as ClientMessage;
    }
    case "resume":
      if (!isInt(o.v) || !isStr(o.code) || !isStr(o.token)) return null;
      return { t: "resume", v: o.v, code: o.code, token: o.token };
    case "send": {
      if (!has(o, "d")) return null;
      const to = parseTo(o.to, true);
      if (to === null) return null;
      const msg: ClientMessage = { t: "send", to, d: o.d as never };
      if (o.ch !== undefined) {
        if (o.ch !== "reliable" && o.ch !== "volatile") return null;
        msg.ch = o.ch as Channel;
      }
      return msg;
    }
    case "commit": {
      if (!isInt(o.epoch) || !isInt(o.seq) || !has(o, "state") || !Array.isArray(o.out))
        return null;
      const out: Outgoing[] = [];
      for (const item of o.out) {
        const parsed = parseOutgoing(item);
        if (!parsed) return null;
        out.push(parsed);
      }
      return { t: "commit", epoch: o.epoch, seq: o.seq, state: o.state as never, out };
    }
    case "alarm": {
      if (!isInt(o.epoch) || !isStr(o.id)) return null;
      if (o.at !== null && !(typeof o.at === "number" && Number.isFinite(o.at))) return null;
      return { t: "alarm", epoch: o.epoch, id: o.id, at: o.at };
    }
    case "room": {
      if (!isInt(o.epoch)) return null;
      const msg: ClientMessage = { t: "room", epoch: o.epoch };
      if (o.locked !== undefined) {
        if (typeof o.locked !== "boolean") return null;
        msg.locked = o.locked;
      }
      if (o.maxPeers !== undefined) {
        if (!isInt(o.maxPeers)) return null;
        msg.maxPeers = o.maxPeers;
      }
      return msg;
    }
    case "kick": {
      if (!isInt(o.epoch) || !isStr(o.peer)) return null;
      const msg: ClientMessage = { t: "kick", epoch: o.epoch, peer: o.peer };
      if (o.reason !== undefined) {
        if (!isStr(o.reason)) return null;
        msg.reason = o.reason;
      }
      return msg;
    }
    case "handoff": {
      if (!isInt(o.epoch)) return null;
      const msg: ClientMessage = { t: "handoff", epoch: o.epoch };
      if (o.to !== undefined) {
        if (!isStr(o.to)) return null;
        msg.to = o.to;
      }
      return msg;
    }
    case "leave":
      return { t: "leave" };
    case "ping":
      return isInt(o.n) ? { t: "ping", n: o.n } : null;
    default:
      return null;
  }
}
