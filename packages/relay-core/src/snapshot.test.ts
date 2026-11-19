import type { PeerInfo, RoomInfo, ServerMessage } from "@games/protocol";
import { PROTOCOL_VERSION } from "@games/protocol";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock";
import { type Connection, Hub, type HubOptions, RESTORE_SEQ_GAP, type Session } from "./hub";
import type { HubSnapshot } from "./snapshot";

class FakeConn implements Connection {
  sent: ServerMessage[] = [];
  closed = false;
  bufferedAmount = 0;
  send(m: ServerMessage) {
    this.sent.push(structuredClone(m));
  }
  close() {
    this.closed = true;
  }
  of<T extends ServerMessage["t"]>(t: T) {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
}

interface Client {
  conn: FakeConn;
  session: Session;
  id: string;
  token: string;
  code: string;
  joinedAt: number;
  name: string;
  canHost: boolean;
  send(m: unknown): void;
  /** The connection dropped. */
  drop(): void;
}

function client(hub: Hub): Client {
  const conn = new FakeConn();
  const session = hub.connect(conn);
  return {
    conn,
    session,
    id: "",
    token: "",
    code: "",
    joinedAt: 0,
    name: "",
    canHost: true,
    send: (m) => session.receive(m),
    drop: () => session.disconnected(),
  };
}

const base = { v: PROTOCOL_VERSION, game: "ono", gameVersion: 1 };

function learn(c: Client, now: number, name: string, canHost: unknown) {
  const w = c.conn.of("welcome").at(-1);
  if (w) {
    c.id = w.you;
    c.token = w.token;
    c.code = w.room.code;
    c.joinedAt = now;
    c.name = name;
    c.canHost = canHost !== false;
  }
}

function create(hub: Hub, now: number, extra: Record<string, unknown> = {}, name = "host") {
  const c = client(hub);
  c.send({ t: "create", ...base, mode: "turn", name, ...extra });
  learn(c, now, name, extra.canHost);
  return c;
}

function join(
  hub: Hub,
  now: number,
  code: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  const c = client(hub);
  c.send({ t: "join", ...base, code, name, ...extra });
  learn(c, now, name, extra.canHost);
  return c;
}

function resume(hub: Hub, c: { code: string; token: string }) {
  const r = client(hub);
  r.send({ t: "resume", v: PROTOCOL_VERSION, code: c.code, token: c.token });
  return r;
}

const errCode = (c: Client) => c.conn.of("error").at(-1)?.code;
const lastHost = (c: Client) => c.conn.of("host").at(-1);
const copy = (s: HubSnapshot): HubSnapshot => JSON.parse(JSON.stringify(s));

const MIN = 60_000;
const START = 1_000_000;

/** A new relay process: new hub, new clock starting at `at`, the snapshot restored through JSON. */
function reboot(snapshot: HubSnapshot, at: number, options: HubOptions = {}) {
  const clock = createFakeClock(at);
  const hub = new Hub({ clock, ...options });
  const result = hub.restore(copy(snapshot));
  return { clock, hub, result };
}

/** A hub with a host `h` and a peer `p` in one room. */
function duo(options: HubOptions = {}) {
  const clock = createFakeClock(START);
  const hub = new Hub({ clock, ...options });
  const h = create(hub, clock.now());
  const p = join(hub, clock.now(), h.code, "peer");
  return { clock, hub, h, p };
}

describe("round trip", () => {
  function world() {
    const clock = createFakeClock(START);
    const hub = new Hub({ clock });
    const tick = (ms: number) => clock.advance(ms);
    const rooms: {
      name: string;
      clients: Client[];
      checkpoint: { seq: number; state: unknown } | null;
    }[] = [];

    // 1: lobby, no checkpoint, one seat with meta.
    const a1 = create(hub, clock.now(), {}, "a1");
    tick(10);
    const a2 = join(hub, clock.now(), a1.code, "a2", { meta: { color: "red" } });
    rooms.push({ name: "lobby", clients: [a1, a2], checkpoint: null });

    // 2: committed and locked.
    tick(10);
    const b1 = create(hub, clock.now(), {}, "b1");
    tick(10);
    const b2 = join(hub, clock.now(), b1.code, "b2");
    b1.send({
      t: "commit",
      epoch: b1.conn.of("host").at(-1)?.epoch,
      seq: 5,
      state: { n: [1, { deep: true }] },
      out: [],
    });
    b1.send({ t: "room", epoch: b1.conn.of("host").at(-1)?.epoch, locked: true });
    b1.send({
      t: "alarm",
      epoch: b1.conn.of("host").at(-1)?.epoch,
      id: "tick",
      at: clock.now() + 60 * MIN,
    });
    rooms.push({
      name: "locked",
      clients: [b1, b2],
      checkpoint: { seq: 5, state: { n: [1, { deep: true }] } },
    });

    // 3: changed maxPeers, a seat that cannot host.
    tick(10);
    const c1 = create(hub, clock.now(), {}, "c1");
    tick(10);
    const c2 = join(hub, clock.now(), c1.code, "c2", { canHost: false });
    c1.send({ t: "room", epoch: c1.conn.of("host").at(-1)?.epoch, maxPeers: 4 });
    c1.send({ t: "commit", epoch: c1.conn.of("host").at(-1)?.epoch, seq: 2, state: "s", out: [] });
    rooms.push({ name: "maxpeers", clients: [c1, c2], checkpoint: { seq: 2, state: "s" } });

    // 4: one disconnected seat.
    tick(10);
    const d1 = create(hub, clock.now(), {}, "d1");
    tick(10);
    const d2 = join(hub, clock.now(), d1.code, "d2");
    d2.drop();
    rooms.push({ name: "dropped", clients: [d1, d2], checkpoint: null });

    // 5: empty and waiting for expiry.
    tick(10);
    const e1 = create(hub, clock.now(), {}, "e1");
    e1.drop();
    tick(10 * MIN);
    rooms.push({ name: "empty", clients: [e1], checkpoint: null });

    return { clock, hub, rooms };
  }

  it("snapshot survives JSON unchanged and holds only plain data", () => {
    const { hub } = world();
    const s = hub.snapshot();
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    const plain = (v: unknown): boolean => {
      if (v === null || typeof v !== "object")
        return typeof v !== "function" && typeof v !== "undefined";
      const proto = Object.getPrototypeOf(v);
      if (Array.isArray(v)) return v.every(plain);
      return proto === Object.prototype && Object.values(v).every(plain);
    };
    expect(plain(s)).toBe(true);
    expect(s.rooms).toHaveLength(5);
    expect(s.protocol).toBe(PROTOCOL_VERSION);
  });

  it("every seat resumes with its old token and the room is as it was", () => {
    const { clock, hub, rooms } = world();
    const snap = hub.snapshot();
    const oldEpochs = new Map(snap.rooms.map((r) => [r.code, r.epoch]));
    const saved = clock.now();
    const next = reboot(snap, saved + 5_000);
    expect(next.result).toEqual({ ok: true, rooms: 5, expired: 0, skipped: [], savedAt: saved });
    expect(next.hub.stats()).toEqual({ rooms: 5, peers: 9, connected: 0 });

    for (const room of rooms) {
      const code = (room.clients[0] as Client).code;
      const first = snap.rooms.find((r) => r.code === code);
      const resumed: Client[] = [];
      const resumedIds: string[] = [];
      let hostId: string | null = null;
      for (const old of room.clients) {
        const r = resume(next.hub, old);
        resumed.push(r);
        resumedIds.push(old.id);
        const w = r.conn.of("welcome").at(-1) as Extract<ServerMessage, { t: "welcome" }>;
        expect(w, room.name).toBeDefined();
        expect(w.you).toBe(old.id);
        const info: RoomInfo = w.room;
        expect(info).toMatchObject({
          code,
          game: "ono",
          gameVersion: 1,
          mode: "turn",
          locked: first?.locked,
          maxPeers: first?.maxPeers,
          hostId,
        });
        expect(
          info.peers.map(({ id, name, canHost, joinedAt }) => ({ id, name, canHost, joinedAt })),
        ).toEqual(
          room.clients.map(({ id, name, canHost, joinedAt }) => ({ id, name, canHost, joinedAt })),
        );
        expect(info.peers.filter((p) => p.connected).map((p) => p.id)).toEqual(resumedIds);
        expect(info.epoch).toBeGreaterThan(oldEpochs.get(code) as number);
        // The first host-capable seat to come back becomes host (the welcome predates the election).
        if (hostId === null && old.canHost) hostId = old.id;
      }
      const hostClient = resumed.find((r) => r.conn.of("welcome")[0]?.you === hostId);
      expect(hostClient, room.name).toBeDefined();
      const hostMsg = lastHost(hostClient as Client);
      expect(hostMsg?.hostId).toBe(hostId);
      if (room.checkpoint) {
        expect(hostMsg?.checkpoint).toEqual({
          seq: room.checkpoint.seq + RESTORE_SEQ_GAP,
          state: room.checkpoint.state,
        });
      } else {
        expect(hostMsg?.checkpoint ?? null).toBeNull();
      }
    }
  });

  it("keeps meta, canHost and locked; lets new peers in only where unlocked", () => {
    const { clock, hub, rooms } = world();
    const next = reboot(hub.snapshot(), clock.now() + 1_000);
    const [lobby, locked, maxpeers] = rooms as [
      (typeof rooms)[number],
      (typeof rooms)[number],
      (typeof rooms)[number],
    ];
    const r = resume(next.hub, lobby?.clients[1] as Client);
    const peers = r.conn.of("welcome")[0]?.room.peers as PeerInfo[];
    expect(peers[1]?.meta).toEqual({ color: "red" });
    const m = resume(next.hub, maxpeers?.clients[1] as Client);
    expect(m.conn.of("welcome")[0]?.room.peers[1]?.canHost).toBe(false);
    expect(m.conn.of("welcome")[0]?.room.maxPeers).toBe(4);
    expect(m.conn.of("welcome")[0]?.room.hostId).toBeNull();

    const fresh = join(next.hub, next.clock.now(), (lobby.clients[0] as Client).code, "newbie");
    expect(fresh.conn.of("welcome")).toHaveLength(1);
    const late = join(next.hub, next.clock.now(), (locked.clients[0] as Client).code, "late");
    expect(errCode(late)).toBe("room-locked");

    const bad = client(next.hub);
    bad.send({
      t: "resume",
      v: PROTOCOL_VERSION,
      code: (lobby.clients[0] as Client).code,
      token: "nope",
    });
    expect(errCode(bad)).toBe("bad-token");
  });
});

describe("epoch fencing across a restart", () => {
  it("rejects stale epochs and old seqs, accepts the new epoch", () => {
    const { clock, hub, h } = duo();
    const epoch = lastHost(h)?.epoch as number;
    h.send({ t: "commit", epoch, seq: 9, state: { v: 1 }, out: [] });
    const next = reboot(hub.snapshot(), clock.now() + 1_000);
    const h2 = resume(next.hub, h);
    const hostMsg = lastHost(h2);
    expect(hostMsg?.epoch).toBeGreaterThan(epoch);
    expect(hostMsg?.checkpoint?.seq).toBe(9 + RESTORE_SEQ_GAP);

    h2.send({ t: "commit", epoch, seq: 9 + RESTORE_SEQ_GAP + 5, state: 1, out: [] });
    expect(errCode(h2)).toBe("stale-epoch");
    expect(h2.conn.of("committed")).toHaveLength(0);
    h2.send({ t: "alarm", epoch, id: "x", at: next.clock.now() + 10 });
    expect(h2.conn.of("error").filter((e) => e.code === "stale-epoch")).toHaveLength(2);

    const now = hostMsg?.epoch as number;
    h2.send({ t: "commit", epoch: now, seq: 9, state: 1, out: [] });
    expect(h2.conn.of("error").at(-1)?.code).toBe("bad-message");
    h2.send({ t: "commit", epoch: now, seq: 9 + RESTORE_SEQ_GAP, state: 1, out: [] });
    expect(h2.conn.of("committed")).toHaveLength(0);
    h2.send({ t: "commit", epoch: now, seq: 10 + RESTORE_SEQ_GAP, state: { v: 2 }, out: [] });
    expect(h2.conn.of("committed")).toEqual([{ t: "committed", seq: 10 + RESTORE_SEQ_GAP }]);
  });
});

describe("alarms across a restart", () => {
  it("delivers an alarm that fell due during downtime once, to the first host only", () => {
    const { clock, hub, h, p } = duo();
    const epoch = lastHost(h)?.epoch as number;
    h.send({ t: "alarm", epoch, id: "x", at: clock.now() + 60_000 });
    const next = reboot(hub.snapshot(), clock.now() + 10 * MIN);
    const h2 = resume(next.hub, h);
    const types = h2.conn.sent.map((m) => m.t);
    expect(types.slice(-2)).toEqual(["host", "alarm"]);
    expect(h2.conn.of("alarm")).toEqual([{ t: "alarm", id: "x" }]);
    const p2 = resume(next.hub, p);
    next.clock.advance(MIN * 20);
    expect(h2.conn.of("alarm")).toHaveLength(1);
    h2.drop();
    expect(lastHost(p2)?.hostId).toBe(p.id);
    expect(p2.conn.of("alarm")).toHaveLength(0);
    next.clock.advance(MIN * 20);
    expect(p2.conn.of("alarm")).toHaveLength(0);
  });

  it("fires a future alarm at its absolute time, once", () => {
    const { clock, hub, h } = duo();
    const epoch = lastHost(h)?.epoch as number;
    h.send({ t: "alarm", epoch, id: "x", at: clock.now() + 60_000 });
    clock.advance(20_000); // 40 s left
    const next = reboot(hub.snapshot(), clock.now() + 10_000); // 30 s left
    const h2 = resume(next.hub, h);
    next.clock.advance(29_999);
    expect(h2.conn.of("alarm")).toHaveLength(0);
    next.clock.advance(1);
    expect(h2.conn.of("alarm")).toEqual([{ t: "alarm", id: "x" }]);
    next.clock.advance(5 * MIN);
    expect(h2.conn.of("alarm")).toHaveLength(1);
  });

  it("keeps an alarm that was already waiting for a host at snapshot time", () => {
    const { clock, hub, h, p } = duo();
    const epoch = lastHost(h)?.epoch as number;
    h.send({ t: "alarm", epoch, id: "x", at: clock.now() + 1_000 });
    h.drop();
    p.drop();
    clock.advance(2_000); // fires with nobody to receive it
    const snap = hub.snapshot();
    expect(snap.rooms[0]).toMatchObject({ alarms: [], dueAlarms: ["x"] });
    const next = reboot(snap, clock.now() + 1_000);
    const h2 = resume(next.hub, h);
    expect(h2.conn.of("alarm")).toEqual([{ t: "alarm", id: "x" }]);
    h2.drop();
    const h3 = resume(next.hub, h);
    next.clock.advance(MIN);
    expect(h3.conn.of("alarm")).toHaveLength(0);
  });

  it("does not bring back a cancelled alarm", () => {
    const { clock, hub, h } = duo();
    const epoch = lastHost(h)?.epoch as number;
    h.send({ t: "alarm", epoch, id: "x", at: clock.now() + 60_000 });
    h.send({ t: "alarm", epoch, id: "x", at: null });
    const snap = hub.snapshot();
    expect(snap.rooms[0]?.alarms).toEqual([]);
    const next = reboot(snap, clock.now() + 10);
    const h2 = resume(next.hub, h);
    next.clock.advance(10 * MIN);
    expect(h2.conn.of("alarm")).toHaveLength(0);
  });
});

describe("expiry across a restart", () => {
  const emptyFor = (ms: number, options: HubOptions = {}) => {
    const { clock, hub, h, p } = duo(options);
    h.drop();
    p.drop();
    clock.advance(ms);
    return { clock, hub, h, p };
  };

  it("counts from when the room became empty (default 30 min)", () => {
    const { clock, hub } = emptyFor(10 * MIN);
    const next = reboot(hub.snapshot(), clock.now() + 5 * MIN);
    expect(next.hub.stats().rooms).toBe(1);
    next.clock.advance(15 * MIN - 1);
    expect(next.hub.stats().rooms).toBe(1);
    next.clock.advance(1);
    expect(next.hub.stats().rooms).toBe(0);
  });

  it("counts from savedAt when peers were connected at the snapshot", () => {
    const { clock, hub } = duo();
    clock.advance(7 * MIN);
    const snap = hub.snapshot();
    expect(snap.rooms[0]?.emptySince).toBeNull();
    const next = reboot(snap, clock.now() + 5 * MIN);
    next.clock.advance(25 * MIN - 1);
    expect(next.hub.stats().rooms).toBe(1);
    next.clock.advance(1);
    expect(next.hub.stats().rooms).toBe(0);
  });

  it("honours a configured ttl", () => {
    const { clock, hub } = emptyFor(MIN, { emptyRoomTtlMs: 10 * MIN });
    const next = reboot(hub.snapshot(), clock.now(), { emptyRoomTtlMs: 10 * MIN });
    next.clock.advance(9 * MIN - 1);
    expect(next.hub.stats().rooms).toBe(1);
    next.clock.advance(1);
    expect(next.hub.stats().rooms).toBe(0);
  });

  it("drops rooms that expired during downtime and counts them", () => {
    const { clock, hub, h } = emptyFor(10 * MIN);
    const keep = create(hub, clock.now(), {}, "keeper");
    const next = reboot(hub.snapshot(), clock.now() + 25 * MIN);
    expect(next.result).toMatchObject({ ok: true, rooms: 1, expired: 1 });
    const r = resume(next.hub, h);
    expect(errCode(r)).toBe("room-not-found");
    expect(r.conn.closed).toBe(true);
    expect(resume(next.hub, keep).conn.of("welcome")).toHaveLength(1);
  });

  it("is cancelled by a resume, and a full ttl applies after the next drop", () => {
    const { clock, hub, h } = emptyFor(10 * MIN);
    const next = reboot(hub.snapshot(), clock.now() + 5 * MIN);
    const r = resume(next.hub, h);
    next.clock.advance(MIN * 31);
    expect(next.hub.stats().rooms).toBe(1);
    r.drop();
    expect(next.hub.snapshot().rooms[0]?.emptySince).toBe(next.clock.now());
    next.clock.advance(30 * MIN - 1);
    expect(next.hub.stats().rooms).toBe(1);
    next.clock.advance(1);
    expect(next.hub.stats().rooms).toBe(0);
  });
});

describe("incompatible snapshots", () => {
  const valid = () => {
    const { hub } = duo();
    return hub.snapshot();
  };
  const refuse = (data: unknown) => {
    const clock = createFakeClock(START);
    const hub = new Hub({ clock });
    let result: ReturnType<Hub["restore"]> | undefined;
    expect(() => {
      result = hub.restore(data);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    expect(result && !result.ok && result.reason.length).toBeGreaterThan(0);
    expect(hub.stats().rooms).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
    const c = create(hub, clock.now());
    expect(c.conn.of("welcome")).toHaveLength(1);
  };
  const mutate = (
    fn: (s: { rooms: Record<string, unknown>[] } & Record<string, unknown>) => void,
  ) => {
    const s = copy(valid()) as unknown as { rooms: Record<string, unknown>[] } & Record<
      string,
      unknown
    >;
    fn(s);
    return s;
  };

  it("refuses a wrong format", () => refuse({ ...valid(), format: 999 }));
  it("refuses a wrong protocol version", () =>
    refuse({ ...valid(), protocol: PROTOCOL_VERSION + 1 }));
  it("refuses things that are not snapshots", () => {
    for (const junk of [null, undefined, "snapshot", 42, [], {}, [valid()]]) refuse(junk);
  });
  it("refuses a snapshot whose room list is not a list", () => {
    refuse(
      mutate((s) => {
        s.rooms = "x" as never;
      }),
    );
  });

  /** Two rooms; `damage` spoils the first. The second must come back, the first must not. */
  const skipsOnlyTheBadRoom = (damage: (room: Record<string, unknown>) => void) => {
    const clock = createFakeClock(START);
    const hub = new Hub({ clock });
    const bad = create(hub, clock.now());
    const good = create(hub, clock.now());
    const snapshot = copy(hub.snapshot()) as unknown as { rooms: Record<string, unknown>[] };
    damage(snapshot.rooms.find((r) => r.code === bad.code) as Record<string, unknown>);
    const next = new Hub({ clock: createFakeClock(START + 1000) });
    const result = next.restore(snapshot);
    expect(result).toMatchObject({ ok: true, rooms: 1 });
    expect(result.ok && result.skipped).toHaveLength(1);
    expect(result.ok && result.skipped[0]).toContain(":");
    expect(errCode(resume(next, bad))).toBe("room-not-found");
    expect(resume(next, good).conn.of("welcome")).toHaveLength(1);
  };

  it("leaves out a corrupted room and keeps the others", () => {
    const damages: Record<string, unknown>[] = [
      { seats: "nope" },
      { seats: [] },
      { code: "abc" },
      { epoch: "1" },
      { epoch: Number.MAX_SAFE_INTEGER },
      { gameVersion: 2 ** 60 },
      { checkpoint: { seq: 2 ** 60, state: null } },
      { checkpoint: { seq: 1 } },
      { alarms: [{ id: 1 }] },
      {
        alarms: [
          { id: "t", at: START + 5 },
          { id: "t", at: START + 9 },
        ],
      },
      { alarms: [{ id: "t", at: START + 5 }], dueAlarms: ["t"] },
      { dueAlarms: Array.from({ length: 17 }, (_, i) => `a${i}`) },
      {
        seats: Array.from({ length: 65 }, (_, i) => ({
          token: `t${i}`,
          info: { id: `p${i}`, name: "x", connected: false, canHost: true, joinedAt: 1 },
        })),
      },
      { maxPeers: 0 },
      { mode: "other" },
    ];
    for (const damage of damages) skipsOnlyTheBadRoom((room) => void Object.assign(room, damage));
  });

  it("keeps the first of two rooms with the same code", () => {
    const { hub, h } = duo();
    const snapshot = copy(hub.snapshot());
    snapshot.rooms.push(structuredClone(snapshot.rooms[0] as HubSnapshot["rooms"][number]));
    const next = new Hub({ clock: createFakeClock(START) });
    const result = next.restore(snapshot);
    expect(result).toMatchObject({ ok: true, rooms: 1 });
    expect(result.ok && result.skipped).toHaveLength(1);
    expect(resume(next, h).conn.of("welcome")).toHaveLength(1);
  });

  it("a client cannot plant a value that spoils the snapshot for everyone", () => {
    const clock = createFakeClock(START);
    const hub = new Hub({ clock });
    const good = create(hub, clock.now());
    // Unsafe integers never get past the wire validation, so they never reach a snapshot.
    const hostile = client(hub);
    hostile.send({ t: "create", ...base, gameVersion: 2 ** 60, mode: "turn", name: "x" });
    expect(hostile.conn.of("welcome")).toHaveLength(0);
    good.send({ t: "commit", epoch: lastHost(good)?.epoch, seq: 2 ** 60, state: 1, out: [] });
    expect(good.conn.of("committed")).toHaveLength(0);
    good.send({ t: "commit", epoch: lastHost(good)?.epoch, seq: 1, state: 1, out: [] });
    const next = new Hub({ clock: createFakeClock(START) });
    expect(next.restore(copy(hub.snapshot()))).toMatchObject({ ok: true, rooms: 1, skipped: [] });
  });

  it("leaves out rooms of a game this relay no longer allows", () => {
    const { hub, h } = duo();
    const next = new Hub({ clock: createFakeClock(START), allowedGames: ["other"] });
    const result = next.restore(copy(hub.snapshot()));
    expect(result).toMatchObject({ ok: true, rooms: 0 });
    expect(result.ok && result.skipped).toHaveLength(1);
    expect(errCode(resume(next, h))).toBe("room-not-found");
  });

  it("refuses a non-empty hub and leaves it alone", () => {
    const { hub } = duo();
    const before = hub.stats();
    const result = hub.restore(hub.snapshot());
    expect(result.ok).toBe(false);
    expect(hub.stats()).toEqual(before);
  });
});

describe("revision", () => {
  it("is stable on an untouched hub and ignores ping and send", () => {
    const { hub, h, p } = duo();
    const r = hub.revision;
    expect(hub.snapshot()).toEqual(hub.snapshot());
    expect(hub.revision).toBe(r);
    h.send({ t: "ping", n: 1 });
    p.send({ t: "send", to: "host", d: "hello" });
    h.send({ t: "send", to: "all", d: "hi" });
    expect(hub.revision).toBe(r);
  });

  it("increases on every state change", () => {
    const clock = createFakeClock(START);
    const hub = new Hub({ clock, emptyRoomTtlMs: MIN });
    let last = hub.revision;
    const bumped = (what: string) => {
      expect(hub.revision, what).toBeGreaterThan(last);
      last = hub.revision;
    };
    const h = create(hub, clock.now());
    bumped("create");
    const p = join(hub, clock.now(), h.code, "p");
    bumped("join");
    const q = join(hub, clock.now(), h.code, "q");
    bumped("join 2");
    p.drop();
    bumped("disconnect");
    resume(hub, p);
    bumped("resume");
    const epoch = () => lastHost(h)?.epoch as number;
    h.send({ t: "commit", epoch: epoch(), seq: 1, state: 1, out: [] });
    bumped("commit");
    h.send({ t: "alarm", epoch: epoch(), id: "a", at: clock.now() + 1_000 });
    bumped("alarm set");
    clock.advance(1_000);
    bumped("alarm fired");
    h.send({ t: "room", epoch: epoch(), maxPeers: 5 });
    bumped("room settings");
    h.send({ t: "kick", epoch: epoch(), peer: q.id });
    bumped("kick");
    const r = resume(hub, p);
    bumped("resume 2");
    r.send({ t: "leave" });
    bumped("leave");
    h.drop();
    bumped("last disconnect");
    clock.advance(MIN);
    expect(hub.stats().rooms).toBe(0);
    bumped("expiry");
  });
});
