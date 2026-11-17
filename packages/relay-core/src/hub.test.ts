import type { ClientMessage, ServerMessage } from "@games/protocol";
import { CODE_ALPHABET, CODE_LENGTH, LIMITS, PROTOCOL_VERSION } from "@games/protocol";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock";
import { type Connection, Hub, type HubOptions, type Session } from "./hub";

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
  last() {
    return this.sent[this.sent.length - 1];
  }
  clear() {
    this.sent = [];
  }
}

function setup(options: HubOptions = {}) {
  const clock = createFakeClock();
  // Deterministic but varied bytes.
  let counter = 1;
  const randomBytes = (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      counter = (counter * 1103515245 + 12345) >>> 0;
      out[i] = (counter >>> 16) & 0xff;
    }
    return out;
  };
  const hub = new Hub({ clock, randomBytes, ...options });
  return { clock, hub };
}

interface Client {
  conn: FakeConn;
  session: Session;
  id: string;
  token: string;
  code: string;
  send(m: unknown): void;
}

function client(hub: Hub): Client {
  const conn = new FakeConn();
  const session = hub.connect(conn);
  const c: Client = {
    conn,
    session,
    id: "",
    token: "",
    code: "",
    send: (m) => session.receive(m),
  };
  return c;
}

const base = { v: PROTOCOL_VERSION, game: "ono", gameVersion: 1 };

function learn(c: Client) {
  const w = c.conn.of("welcome").at(-1);
  if (w) {
    c.id = w.you;
    c.token = w.token;
    c.code = w.room.code;
  }
}

function create(hub: Hub, extra: Record<string, unknown> = {}, name = "host"): Client {
  const c = client(hub);
  c.send({ t: "create", ...base, mode: "turn", name, ...extra });
  learn(c);
  return c;
}

function join(hub: Hub, code: string, name = "p", extra: Record<string, unknown> = {}): Client {
  const c = client(hub);
  c.send({ t: "join", ...base, code, name, ...extra });
  learn(c);
  return c;
}

const err = (c: Client) => c.conn.of("error").at(-1)?.code;
const epochOf = (c: Client) => c.conn.of("host").at(-1)?.epoch ?? 0;

describe("1. intake and validation", () => {
  it("bad message before join errors and closes", () => {
    const { hub } = setup();
    const c = client(hub);
    c.send({ t: "ping", n: 1 });
    expect(err(c)).toBe("bad-message");
    expect(c.conn.closed).toBe(true);
  });

  it("garbage before join closes; failed create/join/resume also closes", () => {
    const { hub } = setup();
    const a = client(hub);
    a.send("nope");
    expect(a.conn.closed).toBe(true);
    const b = client(hub);
    b.send({ t: "join", ...base, code: "ABCDEF", name: "x" });
    expect(err(b)).toBe("room-not-found");
    expect(b.conn.closed).toBe(true);
    const c = client(hub);
    c.send({ t: "resume", v: 1, code: "ABCDEF", token: "x" });
    expect(err(c)).toBe("room-not-found");
    expect(c.conn.closed).toBe(true);
  });

  it("after join errors keep the connection open; second create/join/resume is bad-message", () => {
    const { hub } = setup();
    const h = create(hub);
    h.send({ t: "nonsense" });
    expect(err(h)).toBe("bad-message");
    h.send({ t: "create", ...base, mode: "turn", name: "x" });
    expect(err(h)).toBe("bad-message");
    h.send({ t: "join", ...base, code: h.code, name: "x" });
    h.send({ t: "resume", v: 1, code: h.code, token: h.token });
    expect(h.conn.of("error")).toHaveLength(4);
    expect(h.conn.closed).toBe(false);
    expect(hub.stats().peers).toBe(1);
  });
});

describe("2. version", () => {
  it("rejects a different protocol version on create, join and resume", () => {
    const { hub } = setup();
    const h = create(hub);
    const a = client(hub);
    a.send({ t: "create", ...base, v: 2, mode: "turn", name: "x" });
    expect(err(a)).toBe("unsupported-version");
    const b = client(hub);
    b.send({ t: "join", ...base, v: 2, code: h.code, name: "x" });
    expect(err(b)).toBe("unsupported-version");
    const c = client(hub);
    c.send({ t: "resume", v: 2, code: h.code, token: h.token });
    expect(err(c)).toBe("unsupported-version");
  });
});

describe("3. create", () => {
  it("welcomes then elects the creator with epoch 1 and null checkpoint", () => {
    const { hub, clock } = setup();
    const h = create(hub, { maxPeers: 4, meta: { a: 1 } });
    const [welcome, host] = h.conn.sent;
    expect(welcome).toMatchObject({ t: "welcome", you: h.id, now: clock.now() });
    if (welcome?.t !== "welcome") throw new Error();
    expect(welcome.room).toMatchObject({
      hostId: null,
      epoch: 0,
      maxPeers: 4,
      mode: "turn",
      locked: false,
    });
    expect(welcome.room.peers).toHaveLength(1);
    expect(welcome.room.peers[0]?.meta).toEqual({ a: 1 });
    expect(welcome.token).toMatch(/^[0-9a-f]{64}$/);
    expect(h.id).toMatch(/^p[0-9a-z]{10}$/);
    expect(h.code).toHaveLength(CODE_LENGTH);
    for (const ch of h.code) expect(CODE_ALPHABET).toContain(ch);
    expect(host).toEqual({ t: "host", hostId: h.id, epoch: 1, checkpoint: null });
  });

  it("enforces allowedGames and maxRooms", () => {
    const { hub } = setup({ allowedGames: ["chess"], maxRooms: 1 });
    const a = client(hub);
    a.send({ t: "create", ...base, mode: "turn", name: "x" });
    expect(err(a)).toBe("game-mismatch");
    expect(a.conn.closed).toBe(true);
    const b = client(hub);
    b.send({ t: "create", ...base, game: "chess", mode: "turn", name: "x" });
    expect(b.conn.of("welcome")).toHaveLength(1);
    const c = client(hub);
    c.send({ t: "create", ...base, game: "chess", mode: "turn", name: "x" });
    expect(err(c)).toBe("server-full");
  });

  it("clamps maxPeers and defaults it", () => {
    const { hub } = setup({ defaultMaxPeers: 5 });
    const a = create(hub, { maxPeers: 1000 });
    const b = create(hub, { maxPeers: 0 });
    const c = create(hub);
    expect(a.conn.of("welcome")[0]?.room.maxPeers).toBe(LIMITS.maxPeersPerRoom);
    expect(b.conn.of("welcome")[0]?.room.maxPeers).toBe(1);
    expect(c.conn.of("welcome")[0]?.room.maxPeers).toBe(5);
  });

  it("generates unique codes and skips colliding ones", () => {
    // randomBytes that first yields a code already in use, then different ones.
    const clock = createFakeClock();
    const seq: number[][] = [];
    let call = 0;
    const randomBytes = (n: number) => {
      call++;
      const out = new Uint8Array(n);
      // Calls: room1 code, room1 peer id, room1 token, room2 code (collides), ...
      out.fill(call <= 4 ? 0 : call);
      seq.push([call]);
      return out;
    };
    const hub = new Hub({ clock, randomBytes });
    const a = create(hub);
    const b = create(hub);
    expect(a.code).not.toBe(b.code);
    expect(hub.stats().rooms).toBe(2);
  });

  it("rejection-samples: bytes at or above the bias limit are skipped", () => {
    const clock = createFakeClock();
    let call = 0;
    const hub = new Hub({
      clock,
      randomBytes: (n) => {
        call++;
        const out = new Uint8Array(n);
        // First call is the code: 255 (rejected) except the final two bytes of each pair are 1.
        for (let i = 0; i < n; i++) out[i] = call === 1 ? (i % 2 === 0 ? 255 : 1) : 7;
        return out;
      },
    });
    const h = create(hub);
    expect(h.code).toBe(CODE_ALPHABET[1]?.repeat(CODE_LENGTH));
  });
});

describe("4. join", () => {
  it("welcomes the joiner and notifies others, no election change", () => {
    const { hub } = setup();
    const h = create(hub);
    h.conn.clear();
    const p = join(hub, `${h.code.slice(0, 3)}-${h.code.slice(3).toLowerCase()}`, "pat");
    const w = p.conn.of("welcome")[0];
    expect(w?.room.peers.map((x) => x.id)).toEqual([h.id, p.id]);
    expect(w?.room.hostId).toBe(h.id);
    expect(h.conn.sent).toHaveLength(1);
    expect(h.conn.sent[0]).toMatchObject({
      t: "peer",
      ev: "join",
      peer: { id: p.id, name: "pat", connected: true },
    });
    expect(p.conn.of("peer")).toHaveLength(0);
    expect(p.conn.of("host")).toHaveLength(0);
  });

  it("rejects unknown room, mismatches, locked and full", () => {
    const { hub } = setup();
    const h = create(hub, { maxPeers: 2 });
    const tryJoin = (m: Record<string, unknown>) => {
      const c = client(hub);
      c.send({ t: "join", ...base, code: h.code, name: "x", ...m });
      return c;
    };
    expect(err(tryJoin({ code: "zzzzzz" }))).toBe("room-not-found");
    expect(err(tryJoin({ code: "bad" }))).toBe("room-not-found");
    expect(err(tryJoin({ game: "other" }))).toBe("game-mismatch");
    expect(err(tryJoin({ gameVersion: 2 }))).toBe("game-mismatch");
    h.send({ t: "room", epoch: 1, locked: true });
    const locked = tryJoin({});
    expect(err(locked)).toBe("room-locked");
    expect(locked.conn.closed).toBe(true);
    h.send({ t: "room", epoch: 1, locked: false });
    expect(tryJoin({}).conn.of("welcome")).toHaveLength(1);
    expect(err(tryJoin({}))).toBe("room-full");
  });

  it("counts disconnected seats toward capacity", () => {
    const { hub } = setup();
    const h = create(hub, { maxPeers: 2 });
    const p = join(hub, h.code);
    p.session.disconnected();
    const c = client(hub);
    c.send({ t: "join", ...base, code: h.code, name: "x" });
    expect(err(c)).toBe("room-full");
  });

  it("elects a host if the room has none", () => {
    const { hub, clock } = setup();
    const h = create(hub);
    h.session.disconnected();
    expect(hub.stats().connected).toBe(0);
    clock.advance(10);
    const p = join(hub, h.code);
    expect(p.conn.of("host").at(-1)).toMatchObject({ hostId: p.id, epoch: 3, checkpoint: null });
  });
});

describe("5. resume", () => {
  it("unknown room and bad token", () => {
    const { hub } = setup();
    const h = create(hub);
    const a = client(hub);
    a.send({ t: "resume", v: 1, code: "ABCDEF", token: h.token });
    expect(err(a)).toBe("room-not-found");
    const b = client(hub);
    b.send({ t: "resume", v: 1, code: h.code, token: "nope" });
    expect(err(b)).toBe("bad-token");
    expect(b.conn.closed).toBe(true);
  });

  it("restores a dropped seat with the same id and token", () => {
    const { hub } = setup();
    const h = create(hub);
    const p = join(hub, h.code);
    p.session.disconnected();
    h.conn.clear();
    const p2 = client(hub);
    p2.send({ t: "resume", v: 1, code: h.code, token: p.token });
    const w = p2.conn.of("welcome")[0];
    expect(w).toMatchObject({ you: p.id, token: p.token });
    expect(w?.room.peers.find((x) => x.id === p.id)?.connected).toBe(true);
    expect(h.conn.sent[0]).toMatchObject({
      t: "peer",
      ev: "resume",
      peer: { id: p.id, connected: true },
    });
    // Resuming does not displace the connected host.
    expect(p2.conn.of("host")).toHaveLength(0);
  });

  it("replaces a live connection; the old one's disconnected() is a no-op", () => {
    const { hub } = setup();
    const h = create(hub);
    const p = join(hub, h.code);
    h.conn.clear();
    const p2 = client(hub);
    p2.send({ t: "resume", v: 1, code: h.code, token: p.token });
    expect(p.conn.of("bye")[0]).toEqual({ t: "bye", reason: "replaced" });
    expect(p.conn.closed).toBe(true);
    h.conn.clear();
    p.session.disconnected();
    expect(h.conn.sent).toHaveLength(0);
    expect(hub.stats().connected).toBe(2);
  });

  it("elects when the room has no host", () => {
    const { hub } = setup();
    const h = create(hub);
    h.session.disconnected();
    const h2 = client(hub);
    h2.send({ t: "resume", v: 1, code: h.code, token: h.token });
    expect(h2.conn.of("host").at(-1)).toMatchObject({ hostId: h.id, epoch: 3 });
  });
});

describe("6. disconnect and empty rooms", () => {
  it("marks dropped, notifies others, migrates the host, keeps seat", () => {
    const { hub } = setup();
    const h = create(hub);
    const p = join(hub, h.code);
    p.conn.clear();
    h.session.disconnected();
    expect(p.conn.sent[0]).toMatchObject({
      t: "peer",
      ev: "drop",
      peer: { id: h.id, connected: false },
    });
    expect(p.conn.sent[1]).toMatchObject({ t: "host", hostId: p.id, epoch: 2, checkpoint: null });
    expect(hub.stats()).toEqual({ rooms: 1, peers: 2, connected: 1 });
    h.session.disconnected();
    expect(p.conn.sent).toHaveLength(2);
  });

  it("deletes the room after the ttl, with alarms; cancelled on resume", () => {
    const { hub, clock } = setup({ emptyRoomTtlMs: 1000 });
    const h = create(hub);
    h.send({ t: "alarm", epoch: 1, id: "a", at: clock.now() + 10_000 });
    h.session.disconnected();
    clock.advance(999);
    expect(hub.stats().rooms).toBe(1);
    const h2 = client(hub);
    h2.send({ t: "resume", v: 1, code: h.code, token: h.token });
    clock.advance(5000);
    expect(hub.stats().rooms).toBe(1);
    h2.session.disconnected();
    clock.advance(1000);
    expect(hub.stats().rooms).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
    const c = client(hub);
    c.send({ t: "resume", v: 1, code: h.code, token: h.token });
    expect(err(c)).toBe("room-not-found");
  });
});

describe("7. leave", () => {
  it("removes the seat, says bye, notifies others, migrates", () => {
    const { hub } = setup();
    const h = create(hub);
    const p = join(hub, h.code);
    p.conn.clear();
    h.send({ t: "leave" });
    expect(h.conn.of("bye")[0]).toEqual({ t: "bye", reason: "left" });
    expect(h.conn.closed).toBe(true);
    expect(p.conn.sent[0]).toMatchObject({ t: "peer", ev: "leave", peer: { id: h.id } });
    expect(p.conn.sent[1]).toMatchObject({ t: "host", hostId: p.id });
    expect(hub.stats().peers).toBe(1);
    // Token is dead.
    const c = client(hub);
    c.send({ t: "resume", v: 1, code: h.code, token: h.token });
    expect(err(c)).toBe("bad-token");
    h.session.disconnected();
    expect(p.conn.sent).toHaveLength(2);
  });

  it("deletes a room with zero seats immediately", () => {
    const { hub, clock } = setup();
    const h = create(hub);
    h.send({ t: "alarm", epoch: 1, id: "a", at: clock.now() + 1000 });
    h.send({ t: "leave" });
    expect(hub.stats().rooms).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("starts the empty timer when only disconnected seats remain", () => {
    const { hub, clock } = setup({ emptyRoomTtlMs: 100 });
    const h = create(hub);
    const p = join(hub, h.code);
    p.session.disconnected();
    h.send({ t: "leave" });
    expect(hub.stats().rooms).toBe(1);
    clock.advance(100);
    expect(hub.stats().rooms).toBe(0);
  });
});

describe("8. host election", () => {
  it("orders by joinedAt then insertion, and skips canHost=false", () => {
    const { hub, clock } = setup();
    const h = create(hub);
    const phone = join(hub, h.code, "phone", { canHost: false });
    const a = join(hub, h.code, "a");
    clock.advance(5);
    const b = join(hub, h.code, "b");
    h.session.disconnected();
    expect(a.conn.of("host").at(-1)).toMatchObject({ hostId: a.id, epoch: 2 });
    expect(phone.conn.of("host").at(-1)).toEqual({ t: "host", hostId: a.id, epoch: 2 });
    expect(b.conn.of("host").at(-1)?.checkpoint).toBeUndefined();
  });

  it("insertion order breaks joinedAt ties", () => {
    const { hub } = setup();
    const h = create(hub);
    const a = join(hub, h.code);
    join(hub, h.code);
    h.session.disconnected();
    expect(a.conn.of("host").at(-1)?.hostId).toBe(a.id);
  });

  it("with no candidates the host becomes null and epoch still increments", () => {
    const { hub } = setup();
    const h = create(hub);
    const phone = join(hub, h.code, "phone", { canHost: false });
    h.session.disconnected();
    expect(phone.conn.of("host").at(-1)).toEqual({ t: "host", hostId: null, epoch: 2 });
  });

  it("a connected host is never displaced by an earlier-joined peer returning", () => {
    const { hub } = setup();
    const h = create(hub);
    const p = join(hub, h.code);
    h.session.disconnected();
    const h2 = client(hub);
    h2.send({ t: "resume", v: 1, code: h.code, token: h.token });
    expect(h2.conn.of("host")).toHaveLength(0);
    expect(epochOf(p)).toBe(2);
    expect(hub.stats().connected).toBe(2);
    // p is still host: its commit works at epoch 2.
    p.send({ t: "commit", epoch: 2, seq: 0, state: 1, out: [] });
    expect(p.conn.of("error")).toHaveLength(0);
  });
});

describe("9. send", () => {
  function trio() {
    const s = setup();
    const h = create(s.hub);
    const a = join(s.hub, h.code, "a");
    const b = join(s.hub, h.code, "b");
    for (const c of [h, a, b]) c.conn.clear();
    return { ...s, h, a, b };
  }

  it("non-host may only send to host", () => {
    const { a, h, b } = trio();
    a.send({ t: "send", to: "host", d: { x: 1 } });
    expect(h.conn.sent).toEqual([{ t: "msg", from: a.id, ch: "reliable", d: { x: 1 } }]);
    a.send({ t: "send", to: "all", d: 1 });
    a.send({ t: "send", to: b.id, d: 1 });
    a.send({ t: "send", to: [b.id], d: 1 });
    expect(a.conn.of("error").map((e) => e.code)).toEqual(["not-host", "not-host", "not-host"]);
    expect(b.conn.sent).toHaveLength(0);
  });

  it("drops silently when there is no host", () => {
    const { hub } = setup();
    const h = create(hub);
    const phone = join(hub, h.code, "phone", { canHost: false });
    h.session.disconnected();
    phone.conn.clear();
    phone.send({ t: "send", to: "host", d: 1 });
    expect(phone.conn.sent).toHaveLength(0);
  });

  it("host: all excludes self, ids, lists, host-to-self, unknown skipped", () => {
    const { h, a, b } = trio();
    h.send({ t: "send", to: "all", d: "x" });
    expect(a.conn.sent).toEqual([{ t: "msg", from: h.id, ch: "reliable", d: "x" }]);
    expect(b.conn.sent).toHaveLength(1);
    expect(h.conn.sent).toHaveLength(0);
    h.send({ t: "send", to: a.id, d: "y" });
    expect(a.conn.sent).toHaveLength(2);
    expect(b.conn.sent).toHaveLength(1);
    h.send({ t: "send", to: [a.id, b.id, "pnone", a.id], d: "z" });
    expect(a.conn.sent).toHaveLength(3);
    expect(b.conn.sent).toHaveLength(2);
    h.send({ t: "send", to: "host", d: "me" });
    expect(h.conn.sent).toEqual([{ t: "msg", from: h.id, ch: "reliable", d: "me" }]);
    expect(h.conn.of("error")).toHaveLength(0);
  });

  it("skips disconnected recipients", () => {
    const { h, a } = trio();
    a.session.disconnected();
    h.conn.clear();
    h.send({ t: "send", to: a.id, d: 1 });
    expect(a.conn.sent).toHaveLength(0);
    expect(h.conn.of("error")).toHaveLength(0);
  });

  it("volatile skips backed-up recipients; reliable does not", () => {
    const { h, a, b } = trio();
    a.conn.bufferedAmount = 64 * 1024 + 1;
    h.send({ t: "send", to: "all", ch: "volatile", d: 1 });
    expect(a.conn.sent).toHaveLength(0);
    expect(b.conn.sent).toEqual([{ t: "msg", from: h.id, ch: "volatile", d: 1 }]);
    h.send({ t: "send", to: "all", ch: "reliable", d: 2 });
    expect(a.conn.sent).toHaveLength(1);
    a.conn.bufferedAmount = 64 * 1024;
    h.send({ t: "send", to: "all", ch: "volatile", d: 3 });
    expect(a.conn.sent).toHaveLength(2);
  });
});

describe("10. host-only guards", () => {
  const msgs: ClientMessage[] = [
    { t: "commit", epoch: 1, seq: 0, state: 1, out: [] },
    { t: "alarm", epoch: 1, id: "a", at: null },
    { t: "room", epoch: 1, locked: true },
    { t: "kick", epoch: 1, peer: "x" },
    { t: "handoff", epoch: 1 },
  ];

  it("non-host gets not-host, wrong epoch gets stale-epoch", () => {
    const { hub } = setup();
    const h = create(hub);
    const a = join(hub, h.code);
    for (const m of msgs) {
      a.send(m);
      expect(err(a)).toBe("not-host");
      h.send({ ...m, epoch: 99 });
      expect(err(h)).toBe("stale-epoch");
    }
    expect(a.conn.of("error")).toHaveLength(msgs.length);
    expect(h.conn.of("error")).toHaveLength(msgs.length);
  });

  it("zombie ex-host cannot commit after migration, even after resuming elsewhere", () => {
    const { hub } = setup();
    const h = create(hub);
    const a = join(hub, h.code);
    h.send({ t: "commit", epoch: 1, seq: 1, state: "good", out: [] });
    h.session.disconnected();
    h.conn.clear();
    h.send({ t: "commit", epoch: 1, seq: 2, state: "evil", out: [{ to: "all", d: "evil" }] });
    expect(err(h)).toBe("not-host");
    a.conn.clear();
    // Checkpoint unchanged: hand over to a third peer and look at it.
    const c = join(hub, h.code, "c");
    a.send({ t: "handoff", epoch: 2, to: c.id });
    expect(c.conn.of("host").at(-1)?.checkpoint).toEqual({ seq: 1, state: "good" });
    expect(a.conn.of("msg")).toHaveLength(0);
    // Ex-host resumes on a new socket and becomes the host again; the zombie stays dead.
    const h2 = client(hub);
    h2.send({ t: "resume", v: 1, code: h.code, token: h.token });
    c.send({ t: "handoff", epoch: 3, to: h.id });
    expect(h2.conn.of("host").at(-1)?.hostId).toBe(h.id);
    h.conn.clear();
    h.send({ t: "commit", epoch: 4, seq: 5, state: "zombie", out: [] });
    expect(err(h)).toBe("not-host");
  });
});

describe("11. commit", () => {
  it("stores the checkpoint then delivers out; all excludes host", () => {
    const { hub } = setup();
    const h = create(hub);
    const a = join(hub, h.code);
    const b = join(hub, h.code);
    for (const c of [h, a, b]) c.conn.clear();
    h.send({
      t: "commit",
      epoch: 1,
      seq: 3,
      state: { s: 1 },
      out: [
        { to: "all", d: "A" },
        { to: [a.id, h.id], d: "B" },
        { to: b.id, d: "C" },
      ],
    });
    expect(a.conn.of("msg").map((m) => m.d)).toEqual(["A", "B"]);
    expect(b.conn.of("msg").map((m) => m.d)).toEqual(["A", "C"]);
    expect(h.conn.of("msg").map((m) => m.d)).toEqual(["B"]);
    expect(a.conn.of("msg")[0]).toMatchObject({ from: h.id, ch: "reliable" });
    h.session.disconnected();
    expect(a.conn.of("host").at(-1)?.checkpoint).toEqual({ seq: 3, state: { s: 1 } });
  });

  it("requires increasing seq (>= 0 for the first)", () => {
    const { hub } = setup();
    const h = create(hub);
    h.send({ t: "commit", epoch: 1, seq: -1, state: 1, out: [] });
    expect(err(h)).toBe("bad-message");
    h.send({ t: "commit", epoch: 1, seq: 0, state: 1, out: [] });
    h.send({ t: "commit", epoch: 1, seq: 0, state: 2, out: [{ to: "all", d: 1 }] });
    expect(h.conn.of("error").map((e) => e.code)).toEqual(["bad-message", "bad-message"]);
    h.send({ t: "commit", epoch: 1, seq: 1, state: 3, out: [] });
    expect(h.conn.of("error")).toHaveLength(2);
  });

  it("a rejected commit delivers nothing and leaves the checkpoint alone", () => {
    const { hub } = setup();
    const h = create(hub);
    const a = join(hub, h.code);
    h.send({ t: "commit", epoch: 1, seq: 5, state: "keep", out: [] });
    a.conn.clear();
    h.send({ t: "commit", epoch: 1, seq: 4, state: "bad", out: [{ to: "all", d: 1 }] });
    expect(a.conn.sent).toHaveLength(0);
    h.session.disconnected();
    expect(a.conn.of("host").at(-1)?.checkpoint).toEqual({ seq: 5, state: "keep" });
  });
});

describe("12. alarms", () => {
  it("fires to the host once, cancel and replace work", () => {
    const { hub, clock } = setup();
    const h = create(hub);
    const now = clock.now();
    h.conn.clear();
    h.send({ t: "alarm", epoch: 1, id: "a", at: now + 100 });
    h.send({ t: "alarm", epoch: 1, id: "b", at: now + 100 });
    h.send({ t: "alarm", epoch: 1, id: "c", at: now + 100 });
    h.send({ t: "alarm", epoch: 1, id: "b", at: null });
    h.send({ t: "alarm", epoch: 1, id: "c", at: now + 500 });
    clock.advance(100);
    expect(h.conn.of("alarm")).toEqual([{ t: "alarm", id: "a" }]);
    clock.advance(1000);
    expect(h.conn.of("alarm").map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("past times fire immediately on the next tick", () => {
    const { hub, clock } = setup();
    const h = create(hub);
    h.send({ t: "alarm", epoch: 1, id: "a", at: 0 });
    clock.advance(0);
    expect(h.conn.of("alarm")).toHaveLength(1);
  });

  it("limits distinct ids but allows replacing", () => {
    const { hub, clock } = setup();
    const h = create(hub);
    for (let i = 0; i < LIMITS.maxAlarmsPerRoom; i++) {
      h.send({ t: "alarm", epoch: 1, id: `a${i}`, at: clock.now() + 1000 });
    }
    expect(h.conn.of("error")).toHaveLength(0);
    h.send({ t: "alarm", epoch: 1, id: "a0", at: clock.now() + 2000 });
    expect(h.conn.of("error")).toHaveLength(0);
    h.send({ t: "alarm", epoch: 1, id: "extra", at: clock.now() + 1000 });
    expect(err(h)).toBe("bad-message");
  });

  it("goes to the new host after migration", () => {
    const { hub, clock } = setup();
    const h = create(hub);
    const a = join(hub, h.code);
    h.send({ t: "alarm", epoch: 1, id: "x", at: clock.now() + 100 });
    h.session.disconnected();
    a.conn.clear();
    clock.advance(100);
    expect(a.conn.sent).toEqual([{ t: "alarm", id: "x" }]);
  });

  it("is held while there is no host and delivered after the next host message", () => {
    const { hub, clock } = setup();
    const h = create(hub);
    h.send({ t: "alarm", epoch: 1, id: "x", at: clock.now() + 100 });
    h.session.disconnected();
    clock.advance(200);
    const p = join(hub, h.code);
    const kinds = p.conn.sent.map((m) => m.t);
    expect(kinds).toEqual(["welcome", "host", "alarm"]);
  });

  it("a cancelled due alarm is not delivered later", () => {
    const { hub, clock } = setup();
    const h = create(hub);
    h.send({ t: "alarm", epoch: 1, id: "x", at: clock.now() + 100 });
    h.session.disconnected();
    clock.advance(200);
    const h2 = client(hub);
    h2.send({ t: "resume", v: 1, code: h.code, token: h.token });
    expect(h2.conn.of("alarm")).toEqual([{ t: "alarm", id: "x" }]);
  });
});

describe("13. room settings", () => {
  it("updates and broadcasts to everyone including host; clamps maxPeers", () => {
    const { hub } = setup();
    const h = create(hub);
    const a = join(hub, h.code);
    join(hub, h.code);
    h.conn.clear();
    a.conn.clear();
    h.send({ t: "room", epoch: 1, locked: true, maxPeers: 1 });
    expect(h.conn.sent).toEqual([{ t: "room", locked: true, maxPeers: 3 }]);
    expect(a.conn.sent).toEqual([{ t: "room", locked: true, maxPeers: 3 }]);
    h.send({ t: "room", epoch: 1, maxPeers: 500 });
    expect(h.conn.last()).toEqual({ t: "room", locked: true, maxPeers: LIMITS.maxPeersPerRoom });
    h.send({ t: "room", epoch: 1, locked: false });
    expect(h.conn.last()).toEqual({ t: "room", locked: false, maxPeers: LIMITS.maxPeersPerRoom });
  });

  it("resuming peers can still enter a locked room", () => {
    const { hub } = setup();
    const h = create(hub);
    const a = join(hub, h.code);
    h.send({ t: "room", epoch: 1, locked: true });
    a.session.disconnected();
    const a2 = client(hub);
    a2.send({ t: "resume", v: 1, code: h.code, token: a.token });
    expect(a2.conn.of("welcome")).toHaveLength(1);
  });
});

describe("14. kick", () => {
  it("removes the seat, byes the target, tells others, invalidates token", () => {
    const { hub } = setup();
    const h = create(hub);
    const a = join(hub, h.code);
    const b = join(hub, h.code);
    for (const c of [h, a, b]) c.conn.clear();
    h.send({ t: "kick", epoch: 1, peer: a.id, reason: "afk" });
    expect(a.conn.of("bye")).toEqual([{ t: "bye", reason: "kicked", message: "afk" }]);
    expect(a.conn.closed).toBe(true);
    expect(b.conn.sent[0]).toMatchObject({ t: "peer", ev: "kick", peer: { id: a.id } });
    expect(h.conn.sent[0]).toMatchObject({ t: "peer", ev: "kick" });
    expect(hub.stats().peers).toBe(2);
    const c = client(hub);
    c.send({ t: "resume", v: 1, code: h.code, token: a.token });
    expect(err(c)).toBe("bad-token");
    a.session.disconnected();
    expect(b.conn.sent).toHaveLength(1);
  });

  it("kicks a disconnected peer without bye, and rejects unknown/self", () => {
    const { hub } = setup();
    const h = create(hub);
    const a = join(hub, h.code);
    a.session.disconnected();
    a.conn.clear();
    h.send({ t: "kick", epoch: 1, peer: a.id });
    expect(a.conn.sent).toHaveLength(0);
    h.send({ t: "kick", epoch: 1, peer: "pnone" });
    h.send({ t: "kick", epoch: 1, peer: h.id });
    expect(h.conn.of("error").map((e) => e.code)).toEqual(["bad-message", "bad-message"]);
  });
});

describe("15. handoff", () => {
  it("to a specific peer", () => {
    const { hub } = setup();
    const h = create(hub);
    const a = join(hub, h.code);
    const b = join(hub, h.code);
    h.send({ t: "commit", epoch: 1, seq: 7, state: "s", out: [] });
    for (const c of [h, a, b]) c.conn.clear();
    h.send({ t: "handoff", epoch: 1, to: b.id });
    expect(b.conn.sent).toEqual([
      { t: "host", hostId: b.id, epoch: 2, checkpoint: { seq: 7, state: "s" } },
    ]);
    expect(a.conn.sent).toEqual([{ t: "host", hostId: b.id, epoch: 2 }]);
    expect(h.conn.sent).toEqual([{ t: "host", hostId: b.id, epoch: 2 }]);
    // Old host is now a normal peer.
    h.send({ t: "commit", epoch: 2, seq: 8, state: 1, out: [] });
    expect(err(h)).toBe("not-host");
  });

  it("rejects self, unknown, disconnected, and non-canHost targets", () => {
    const { hub } = setup();
    const h = create(hub);
    const a = join(hub, h.code);
    const phone = join(hub, h.code, "phone", { canHost: false });
    a.session.disconnected();
    for (const to of [h.id, "pnone", a.id, phone.id]) h.send({ t: "handoff", epoch: 1, to });
    expect(h.conn.of("error").map((e) => e.code)).toEqual(Array(4).fill("bad-message"));
    expect(epochOf(h)).toBe(1);
  });

  it("without `to` picks the next candidate, or does nothing", () => {
    const { hub } = setup();
    const h = create(hub);
    h.send({ t: "handoff", epoch: 1 });
    expect(h.conn.of("host")).toHaveLength(1);
    expect(h.conn.of("error")).toHaveLength(0);
    const a = join(hub, h.code);
    h.send({ t: "handoff", epoch: 1 });
    expect(a.conn.of("host").at(-1)).toMatchObject({ hostId: a.id, epoch: 2 });
  });
});

describe("16. ping", () => {
  it("answers with pong and relay time", () => {
    const { hub, clock } = setup();
    const h = create(hub);
    h.send({ t: "ping", n: 42 });
    expect(h.conn.last()).toEqual({ t: "pong", n: 42, now: clock.now() });
  });
});

describe("17. rate limit", () => {
  it("drops over-budget messages with rate-limited and refills over time", () => {
    const { hub, clock } = setup({ rateLimit: { burst: 3, perSecond: 2 } });
    const h = create(hub); // 1 token used
    h.send({ t: "ping", n: 1 });
    h.send({ t: "ping", n: 2 });
    h.send({ t: "ping", n: 3 });
    expect(h.conn.of("pong")).toHaveLength(2);
    expect(err(h)).toBe("rate-limited");
    expect(h.conn.closed).toBe(false);
    clock.advance(500);
    h.send({ t: "ping", n: 4 });
    expect(h.conn.of("pong")).toHaveLength(3);
    h.send({ t: "ping", n: 5 });
    expect(h.conn.of("pong")).toHaveLength(3);
  });

  it("buckets are per connection", () => {
    const { hub } = setup({ rateLimit: { burst: 2, perSecond: 1 } });
    const h = create(hub);
    const a = join(hub, h.code);
    h.send({ t: "ping", n: 1 });
    h.send({ t: "ping", n: 2 });
    a.send({ t: "ping", n: 1 });
    expect(a.conn.of("pong")).toHaveLength(1);
  });
});

describe("18. snapshots and secrecy", () => {
  it("never leaks tokens to others and sends copies", () => {
    const { hub } = setup();
    const h = create(hub);
    const a = join(hub, h.code);
    const welcome = a.conn.of("welcome")[0];
    expect(JSON.stringify(welcome?.room)).not.toContain(h.token);
    expect(JSON.stringify(h.conn.sent.slice(1))).not.toContain(a.token);
    expect(JSON.stringify(h.conn.sent)).not.toContain(a.token);
    expect(JSON.stringify(a.conn.sent.filter((m) => m.t !== "welcome"))).not.toContain("token");
  });

  it("does not hand out live references", () => {
    const { hub } = setup();
    const objects: ServerMessage[] = [];
    const conn: Connection = {
      send: (m) => objects.push(m),
      close() {},
    };
    const s = hub.connect(conn);
    s.receive({ t: "create", ...base, mode: "turn", name: "x" });
    const welcome = objects[0];
    if (welcome?.t !== "welcome") throw new Error();
    const info = welcome.room.peers[0];
    if (!info) throw new Error();
    info.name = "mutated";
    info.connected = false;
    const b = client(hub);
    b.send({ t: "join", ...base, code: welcome.room.code, name: "b" });
    expect(b.conn.of("welcome")[0]?.room.peers[0]).toMatchObject({ name: "x", connected: true });
  });
});

describe("scenario: migration", () => {
  it("host commits twice, drops, second becomes host with latest checkpoint, zombie rejected, ex-host resumes, alarm reaches new host", () => {
    const { hub, clock } = setup();
    const p1 = create(hub, {}, "one");
    const p2 = join(hub, p1.code, "two");
    const p3 = join(hub, p1.code, "three");

    p1.send({ t: "commit", epoch: 1, seq: 1, state: { turn: 1 }, out: [{ to: "all", d: "t1" }] });
    p1.send({ t: "commit", epoch: 1, seq: 2, state: { turn: 2 }, out: [{ to: "all", d: "t2" }] });
    p1.send({ t: "alarm", epoch: 1, id: "timeout", at: clock.now() + 5000 });
    expect(p2.conn.of("msg").map((m) => m.d)).toEqual(["t1", "t2"]);

    for (const c of [p1, p2, p3]) c.conn.clear();
    p1.session.disconnected();

    expect(p2.conn.of("host")).toEqual([
      { t: "host", hostId: p2.id, epoch: 2, checkpoint: { seq: 2, state: { turn: 2 } } },
    ]);
    expect(p3.conn.of("host")).toEqual([{ t: "host", hostId: p2.id, epoch: 2 }]);

    // Zombie socket of the old host.
    p1.send({
      t: "commit",
      epoch: 1,
      seq: 3,
      state: { turn: "evil" },
      out: [{ to: "all", d: "evil" }],
    });
    expect(err(p1)).toBe("not-host");
    expect(p2.conn.of("msg")).toHaveLength(0);
    expect(p3.conn.of("msg")).toHaveLength(0);

    // Old host comes back on a fresh socket as a normal peer.
    const back = client(hub);
    back.send({ t: "resume", v: 1, code: p1.code, token: p1.token });
    expect(back.conn.of("welcome")[0]).toMatchObject({ you: p1.id });
    expect(back.conn.of("welcome")[0]?.room).toMatchObject({ hostId: p2.id, epoch: 2 });
    expect(back.conn.of("host")).toHaveLength(0);
    back.send({ t: "commit", epoch: 2, seq: 9, state: 1, out: [] });
    expect(err(back)).toBe("not-host");
    back.send({ t: "send", to: "host", d: "hello" });
    expect(p2.conn.of("msg").at(-1)).toMatchObject({ from: p1.id, d: "hello" });

    // The alarm set by the old host reaches the new one.
    p2.conn.clear();
    clock.advance(5000);
    expect(p2.conn.of("alarm")).toEqual([{ t: "alarm", id: "timeout" }]);
    expect(p3.conn.of("alarm")).toHaveLength(0);
    expect(back.conn.of("alarm")).toHaveLength(0);
  });
});

describe("host reload", () => {
  it("re-announces a host that resumes over its own live socket, with the checkpoint", () => {
    const { hub } = setup();
    const host = create(hub);
    const other = join(hub, host.code);
    host.send({ t: "commit", epoch: 1, seq: 1, state: { n: 1 }, out: [] });

    const reloaded = client(hub);
    reloaded.send({ t: "resume", v: PROTOCOL_VERSION, code: host.code, token: host.token });

    expect(reloaded.conn.of("host").at(-1)).toEqual({
      t: "host",
      hostId: host.id,
      epoch: 2,
      checkpoint: { seq: 1, state: { n: 1 } },
    });
    expect(other.conn.of("host").at(-1)).toEqual({ t: "host", hostId: host.id, epoch: 2 });
  });
});

describe("commit acknowledgement", () => {
  it("tells the host when a commit was stored, and not when it was refused", () => {
    const { hub } = setup();
    const host = create(hub);
    host.send({ t: "commit", epoch: 1, seq: 1, state: 1, out: [] });
    expect(host.conn.of("committed")).toEqual([{ t: "committed", seq: 1 }]);
    host.send({ t: "commit", epoch: 9, seq: 2, state: 2, out: [] });
    expect(host.conn.of("committed")).toHaveLength(1);
  });
});

describe("close", () => {
  it("leaves no timers behind, even when sockets report their close afterwards", () => {
    const { hub, clock } = setup();
    const host = create(hub);
    const other = join(hub, host.code);
    host.send({ t: "alarm", epoch: 1, id: "a", at: clock.now() + 1000 });
    hub.close();
    host.session.disconnected();
    other.session.disconnected();
    expect(clock.pendingTimers()).toBe(0);
    expect(hub.stats().rooms).toBe(0);
  });
});
