import { createFakeClock, Hub } from "@games/relay-core";
import { describe, expect, it } from "vitest";
import { RelayError, RoomClient, type RoomEvents } from "./client";
import { memoryStorage, type TokenStorage } from "./storage";
import { localTransport, type Transport, type TransportLink } from "./transport";

function setup() {
  const clock = createFakeClock();
  const hub = new Hub({ clock });
  const queue: (() => void)[] = [];
  const base = localTransport(hub, { defer: (f) => void queue.push(f) });
  const flush = async () => {
    do {
      while (queue.length) queue.shift()?.();
      await Promise.resolve();
    } while (queue.length);
  };
  /** A transport whose most recent link can be killed from the test, like a dropped socket. */
  function killable(): Transport & { kill(): void } {
    let link: TransportLink | null = null;
    return {
      open: (handlers) => {
        link = base.open(handlers);
        return link;
      },
      kill: () => link?.close(),
    };
  }
  function client(storage: TokenStorage = memoryStorage()) {
    const transport = killable();
    const c = new RoomClient({
      transport,
      game: "toy",
      gameVersion: 1,
      clock,
      storage,
      reconnect: { minMs: 100, maxMs: 100 },
    });
    return { c, transport, storage };
  }
  return { clock, hub, flush, client };
}

function record<K extends keyof RoomEvents>(c: RoomClient, event: K) {
  const seen: RoomEvents[K][] = [];
  c.on(event, (p) => seen.push(p));
  return seen;
}

describe("RoomClient", () => {
  it("creates, joins and tracks room info immutably", async () => {
    const { flush, client } = setup();
    const a = client();
    const b = client();
    const aRooms = record(a.c, "room");
    const created = a.c.create({ name: "Ann" });
    await flush();
    const room = await created;
    expect(room.code).toHaveLength(6);
    expect(a.c.status).toBe("connected");
    expect(a.c.isHost).toBe(true);
    expect(a.c.epoch).toBe(1);
    expect(a.storage.get(`games:seat:toy:${room.code}`)).toBeTypeOf("string");

    const before = a.c.room;
    const joined = b.c.join(room.code.toLowerCase(), { name: "Bob" });
    await flush();
    await joined;
    expect(a.c.room?.peers.map((p) => p.name)).toEqual(["Ann", "Bob"]);
    expect(a.c.room).not.toBe(before);
    expect(before?.peers).toHaveLength(1);
    expect(b.c.isHost).toBe(false);
    expect(b.c.room?.hostId).toBe(a.c.me);
    expect(aRooms.length).toBeGreaterThan(2);

    a.c.setRoom({ locked: true });
    await flush();
    expect(b.c.room?.locked).toBe(true);
    expect(b.c.hasSeat(room.code)).toBe(true);
  });

  it("routes messages and host-only commits", async () => {
    const { flush, client } = setup();
    const a = client();
    const b = client();
    const code = await Promise.all([a.c.create({ name: "A" }), flush()]).then(([r]) => r.code);
    await Promise.all([b.c.join(code, { name: "B" }), flush()]);
    const atA = record(a.c, "message");
    const atB = record(b.c, "message");
    expect(b.c.send("host", { hi: 1 })).toBe(true);
    expect(a.c.commit(1, { s: 1 }, [{ to: "all", d: "view" }])).toBe(true);
    expect(b.c.commit(1, null, [])).toBe(false);
    await flush();
    expect(atA).toEqual([{ from: b.c.me, ch: "reliable", d: { hi: 1 } }]);
    expect(atB).toEqual([{ from: a.c.me, ch: "reliable", d: "view" }]);
  });

  it("resumes with a stored token after a reload", async () => {
    const { flush, client } = setup();
    const a = client();
    const b = client();
    const code = await Promise.all([a.c.create({ name: "A" }), flush()]).then(([r]) => r.code);
    await Promise.all([b.c.join(code, { name: "B" }), flush()]);
    const bId = b.c.me;
    b.c.close();
    await flush();
    expect(b.c.status).toBe("closed");
    expect(a.c.room?.peers.find((p) => p.id === bId)?.connected).toBe(false);

    const b2 = client(b.storage);
    expect(b2.c.hasSeat(code)).toBe(true);
    await Promise.all([b2.c.resume(code), flush()]);
    expect(b2.c.me).toBe(bId);
    expect(a.c.room?.peers.find((p) => p.id === bId)?.connected).toBe(true);

    const none = client();
    await expect(none.c.resume(code)).rejects.toMatchObject({ code: "no-seat" });
  });

  it("gives the checkpoint to a new host after the old host's link is closed", async () => {
    const { flush, client } = setup();
    const a = client();
    const b = client();
    const code = await Promise.all([a.c.create({ name: "A" }), flush()]).then(([r]) => r.code);
    await Promise.all([b.c.join(code, { name: "B" }), flush()]);
    const hosts = record(b.c, "host");
    a.c.commit(7, { n: 42 }, []);
    await flush();
    a.transport.kill();
    await flush();
    expect(hosts.at(-1)).toMatchObject({ isHost: true, checkpoint: { seq: 7, state: { n: 42 } } });
    expect(b.c.isHost).toBe(true);
    expect(b.c.room?.peers.find((p) => p.id === a.c.me)?.connected).toBe(false);
  });

  it("reconnects and resumes after an unexpected close", async () => {
    const { clock, flush, client } = setup();
    const a = client();
    const b = client();
    const code = await Promise.all([a.c.create({ name: "A" }), flush()]).then(([r]) => r.code);
    await Promise.all([b.c.join(code, { name: "B" }), flush()]);
    const statuses = record(a.c, "status");
    const aId = a.c.me;
    a.transport.kill();
    await flush();
    expect(a.c.status).toBe("reconnecting");
    expect(a.c.send("host", 1)).toBe(false);
    clock.advance(100);
    await flush();
    expect(a.c.status).toBe("connected");
    expect(statuses).toEqual(["reconnecting", "connected"]);
    expect(a.c.me).toBe(aId);
    expect(a.c.room?.hostId).toBe(b.c.me);
    expect(a.c.isHost).toBe(false);
    expect(b.c.room?.peers.find((p) => p.id === aId)?.connected).toBe(true);
  });

  it("closes with resume-failed when the seat was removed meanwhile", async () => {
    const { clock, flush, client } = setup();
    const a = client();
    const b = client();
    const code = await Promise.all([a.c.create({ name: "A" }), flush()]).then(([r]) => r.code);
    await Promise.all([b.c.join(code, { name: "B" }), flush()]);
    const closed = record(b.c, "closed");
    b.transport.kill();
    await flush();
    a.c.kick(b.c.me as string);
    await flush();
    clock.advance(100);
    await flush();
    expect(b.c.status).toBe("closed");
    expect(closed).toMatchObject([{ reason: "resume-failed" }]);
    expect(b.c.hasSeat(code)).toBe(false);
  });

  it("handles bye: kicked forgets the token, replaced keeps it, no reconnect", async () => {
    const { clock, flush, client } = setup();
    const a = client();
    const b = client();
    const code = await Promise.all([a.c.create({ name: "A" }), flush()]).then(([r]) => r.code);
    await Promise.all([b.c.join(code, { name: "B" }), flush()]);
    const closed = record(b.c, "closed");
    a.c.kick(b.c.me as string, "bye now");
    await flush();
    clock.advance(10_000);
    await flush();
    expect(closed).toEqual([{ reason: "kicked", message: "bye now" }]);
    expect(b.c.status).toBe("closed");
    expect(b.c.hasSeat(code)).toBe(false);

    const c = client();
    await Promise.all([c.c.join(code, { name: "C" }), flush()]);
    const c2 = client(c.storage);
    await Promise.all([c2.c.resume(code), flush()]);
    expect(c.c.status).toBe("closed");
    expect(c.c.hasSeat(code)).toBe(true);
  });

  it("leave tells the relay and forgets the token", async () => {
    const { flush, client } = setup();
    const a = client();
    const b = client();
    const code = await Promise.all([a.c.create({ name: "A" }), flush()]).then(([r]) => r.code);
    await Promise.all([b.c.join(code, { name: "B" }), flush()]);
    b.c.leave();
    await flush();
    expect(b.c.status).toBe("closed");
    expect(b.c.hasSeat(code)).toBe(false);
    expect(a.c.room?.peers.map((p) => p.name)).toEqual(["A"]);
  });

  it("rejects with the relay's error code", async () => {
    const { flush, client } = setup();
    const a = client();
    const result = a.c.join("ABCDEF", { name: "A" });
    const assertion = expect(result).rejects.toMatchObject({ code: "room-not-found" });
    await flush();
    await assertion;
    expect(await result.catch((e) => e)).toBeInstanceOf(RelayError);
    expect(a.c.status).toBe("idle");
  });

  it("estimates the relay clock", async () => {
    const clock = createFakeClock(1_000);
    const hubClock = createFakeClock(50_000);
    const hub = new Hub({ clock: hubClock });
    const queue: (() => void)[] = [];
    const c = new RoomClient({
      transport: localTransport(hub, { defer: (f) => void queue.push(f) }),
      game: "toy",
      gameVersion: 1,
      clock,
    });
    const p = c.create({ name: "A" });
    while (queue.length) queue.shift()?.();
    await p;
    expect(c.serverNow()).toBe(50_000);
    while (queue.length) queue.shift()?.();
    clock.advance(500);
    expect(c.serverNow()).toBe(50_500);
    c.close();
  });

  it("does not touch its state when a call is refused as already in use", async () => {
    const { clock, flush, client } = setup();
    const a = client();
    const code = await Promise.all([a.c.create({ name: "A" }), flush()]).then(([r]) => r.code);
    a.storage.set("games:seat:toy:ABCDEF", "other-token");
    await expect(a.c.resume("ABCDEF")).rejects.toThrow("already in use");
    a.transport.kill();
    await flush();
    clock.advance(100);
    await flush();
    expect(a.c.status).toBe("connected");
    expect(a.c.room?.code).toBe(code);
  });

  it("gives up on a link that never answers, and retries when reconnecting", async () => {
    const { clock, hub } = setup();
    let silent = true;
    const queue: (() => void)[] = [];
    const inner = localTransport(hub, { defer: (f) => void queue.push(f) });
    const drain = async () => {
      while (queue.length) queue.shift()?.();
      await Promise.resolve();
    };
    const opened: { link: TransportLink | null } = { link: null };
    const transport: Transport = {
      open: (handlers) => {
        if (silent) return { send() {}, close() {} };
        opened.link = inner.open(handlers);
        return opened.link;
      },
    };
    const c = new RoomClient({
      transport,
      game: "toy",
      gameVersion: 1,
      clock,
      reconnect: { minMs: 100, maxMs: 100 },
    });
    const first = c.create({ name: "A" });
    const check = expect(first).rejects.toMatchObject({ code: "closed" });
    clock.advance(10_000);
    await check;
    expect(c.status).toBe("idle");

    silent = false;
    await Promise.all([c.create({ name: "A" }), drain()]);
    await drain();
    silent = true;
    opened.link?.close();
    await drain();
    expect(c.status).toBe("reconnecting");
    clock.advance(100); // retry opens a silent link
    clock.advance(10_000); // ...which times out and schedules another retry
    expect(c.status).toBe("reconnecting");
    silent = false;
    clock.advance(100);
    await drain();
    await drain();
    expect(c.status).toBe("connected");
    c.close();
  });

  it("treats a transport that throws on open as a failed open", async () => {
    const { clock } = setup();
    const c = new RoomClient({
      transport: {
        open() {
          throw new Error("no network");
        },
      },
      game: "toy",
      gameVersion: 1,
      clock,
    });
    await expect(c.join("ABCDEF", { name: "A" })).rejects.toMatchObject({ code: "closed" });
    expect(c.status).toBe("idle");
  });

  it("reports the relay's commit confirmation", async () => {
    const { flush, client } = setup();
    const a = client();
    await Promise.all([a.c.create({ name: "A" }), flush()]);
    const seen = record(a.c, "committed");
    a.c.commit(3, { s: 1 }, []);
    await flush();
    expect(seen).toEqual([3]);
  });
});
