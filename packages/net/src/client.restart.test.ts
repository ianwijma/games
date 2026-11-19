import { createFakeClock, Hub } from "@games/relay-core";
import { describe, expect, it } from "vitest";
import { RoomClient, type RoomEvents } from "./client";
import { memoryStorage } from "./storage";
import { localTransport, type Transport } from "./transport";

/** A relay that can be taken down (opens fail) and replaced by a new hub, on one fake clock. */
function setup() {
  const clock = createFakeClock();
  const queue: (() => void)[] = [];
  const defer = (f: () => void) => void queue.push(f);
  let hub = new Hub({ clock });
  let base = localTransport(hub, { defer });
  const relay = { failOpens: 0, opens: 0 };
  const transport: Transport = {
    open(handlers) {
      relay.opens++;
      if (relay.failOpens > 0) {
        relay.failOpens--;
        queue.push(() => handlers.onClose());
        return { send() {}, close() {} };
      }
      return base.open(handlers);
    },
  };
  const flush = async () => {
    do {
      while (queue.length) queue.shift()?.();
      await Promise.resolve();
    } while (queue.length);
  };
  const client = () => {
    const storage = memoryStorage();
    const c = new RoomClient({
      transport,
      game: "toy",
      gameVersion: 1,
      clock,
      storage,
      reconnect: { minMs: 100, maxMs: 100 },
    });
    return { c, storage };
  };
  /** The process dies: every link closes, the hub is gone. */
  const kill = async (c: RoomClient) => {
    queue.length = 0;
    hub.close();
    // The client sees its socket drop; nothing can be sent back.
    (c as unknown as { link: { close(): void } }).link.close();
    await flush();
  };
  return {
    clock,
    flush,
    client,
    kill,
    relay,
    get hub() {
      return hub;
    },
    boot(snapshot: unknown) {
      hub = new Hub({ clock });
      base = localTransport(hub, { defer });
      if (snapshot !== undefined) return hub.restore(snapshot);
      return null;
    },
  };
}

const record = <K extends keyof RoomEvents>(c: RoomClient, event: K) => {
  const seen: RoomEvents[K][] = [];
  c.on(event, (p) => seen.push(p));
  return seen;
};

describe("RoomClient across a relay restart", () => {
  it("keeps retrying while the relay is down, then resumes against the restored hub", async () => {
    const t = setup();
    const { c, storage } = t.client();
    const created = c.create({ name: "Ann" });
    await t.flush();
    const room = await created;
    const peer = t.client();
    await Promise.all([peer.c.join(room.code, { name: "Bob" }), t.flush()]);
    c.commit(4, { n: 1 }, []);
    await t.flush();
    const me = c.me;
    const statuses: string[] = [];
    c.on("status", (s) => statuses.push(s));
    const hosts = record(c, "host");
    const snapshot = JSON.parse(JSON.stringify(t.hub.snapshot()));

    await t.kill(c);
    expect(c.status).toBe("reconnecting");
    // Relay is down for several attempts.
    t.relay.failOpens = 4;
    const opensBefore = t.relay.opens;
    for (let i = 0; i < 4; i++) {
      t.clock.advance(100);
      await t.flush();
      expect(c.status).toBe("reconnecting");
    }
    expect(t.relay.opens - opensBefore).toBe(4);

    t.boot(snapshot);
    t.clock.advance(100);
    await t.flush();
    expect(c.status).toBe("connected");
    expect(statuses).toEqual(["reconnecting", "connected"]);
    expect(c.me).toBe(me);
    expect(c.room?.code).toBe(room.code);
    expect(c.room?.peers.map((p) => p.name)).toEqual(["Ann", "Bob"]);
    expect(c.isHost).toBe(true);
    expect(hosts.at(-1)).toMatchObject({ isHost: true, checkpoint: { state: { n: 1 } } });
    expect(hosts.at(-1)?.checkpoint?.seq).toBeGreaterThan(4);
    expect(hosts.at(-1)?.epoch).toBeGreaterThan(1);
    expect(storage.get(`games:seat:toy:${room.code}`)).toBeTypeOf("string");

    // The restored room works: the host can commit under the new epoch.
    const seq = (hosts.at(-1)?.checkpoint?.seq as number) + 1;
    const committed = record(c, "committed");
    expect(c.commit(seq, { n: 2 }, [])).toBe(true);
    await t.flush();
    expect(committed).toEqual([seq]);
  });

  it("closes with resume-failed and forgets the token when the new relay knows nothing", async () => {
    const t = setup();
    const { c, storage } = t.client();
    const created = c.create({ name: "Ann" });
    await t.flush();
    const room = await created;
    const closed = record(c, "closed");
    await t.kill(c);
    t.relay.failOpens = 2;
    for (let i = 0; i < 2; i++) {
      t.clock.advance(100);
      await t.flush();
    }
    expect(c.status).toBe("reconnecting");
    t.boot(undefined);
    t.clock.advance(100);
    await t.flush();
    expect(c.status).toBe("closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.reason).toBe("resume-failed");
    expect(c.hasSeat(room.code)).toBe(false);
    expect(storage.get(`games:seat:toy:${room.code}`)).toBeNull();
  });
});
