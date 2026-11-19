import { localTransport, memoryStorage, type Transport, type TransportHandlers } from "@games/net";
import type { ServerMessage } from "@games/protocol";
import { createFakeClock, Hub } from "@games/relay-core";
import { describe, expect, it } from "vitest";
import { createSession } from "./session";
import { createTable } from "./testing";
import { defineGame, GameError, SessionClosedError } from "./types";

interface Ledger {
  seen: Record<string, number>;
}
type LedgerAction = { type: "move"; uid: string } | { type: "fail" };
const ledger = defineGame<Ledger, LedgerAction, Ledger, Record<string, never>>({
  id: "ledger",
  version: 1,
  minPlayers: 2,
  maxPlayers: 3,
  defaultConfig: {},
  setup: () => ({ seen: {} }),
  apply(state, action) {
    if (action.type === "fail") throw new GameError("nope");
    state.seen[action.uid] = (state.seen[action.uid] ?? 0) + 1;
  },
  view: (state) => state,
});

interface Bump {
  due: number;
  fired: number;
}
const bumper = defineGame<Bump, { type: "bump" }, Bump, Record<string, never>>({
  id: "bumper",
  version: 1,
  minPlayers: 2,
  maxPlayers: 2,
  defaultConfig: {},
  setup: ({ now }) => ({ due: now + 10_000, fired: 0 }),
  apply(state, _action, { now }) {
    state.due = now + 10_000;
  },
  view: (state) => state,
  deadline: (state) => (state.fired >= 3 ? null : state.due),
  onDeadline(state, { now }) {
    state.fired += 1;
    state.due = now + 10_000;
  },
});

/** Hand-built harness: lets a test see a socket close without the relay noticing, or hold back messages. */
function harness() {
  const clock = createFakeClock();
  const hub = new Hub({ clock });
  const queue: (() => void)[] = [];
  const base = localTransport(hub, { defer: (f) => void queue.push(f) });
  const flush = async () => {
    for (let idle = 0; idle < 3; ) {
      if (queue.length) {
        idle = 0;
        while (queue.length) queue.shift()?.();
      } else idle++;
      await Promise.resolve();
    }
  };
  function player() {
    const state = {
      handlers: null as TransportHandlers | null,
      held: [] as ServerMessage[],
      holdCommitted: false,
    };
    const transport: Transport = {
      open(handlers) {
        state.handlers = handlers;
        return base.open({
          ...handlers,
          onMessage(m) {
            if (m.t === "committed" && state.holdCommitted) state.held.push(m);
            else handlers.onMessage(m);
          },
        });
      },
    };
    const session = createSession(game(), {
      transport,
      storage: memoryStorage(),
      clock,
      seed: 3,
      reconnect: { minMs: 1, maxMs: 1 },
    });
    return {
      session,
      /** The client sees its socket close; the relay does not. */
      blip: () => state.handlers?.onClose(),
      release() {
        state.holdCommitted = false;
        for (const m of state.held.splice(0)) state.handlers?.onMessage(m);
      },
      hold() {
        state.holdCommitted = true;
      },
    };
  }
  return { clock, flush, player };
}
const game = () => ledger;

async function room() {
  const h = harness();
  const a = h.player();
  const b = h.player();
  const code = a.session.create({ name: "A" });
  await h.flush();
  const joined = b.session.join(await code, { name: "B" });
  await h.flush();
  await joined;
  const ready = [a.session.setReady(true), b.session.setReady(true)];
  await h.flush();
  await Promise.all(ready);
  const started = a.session.start();
  await h.flush();
  await started;
  return { ...h, a, b };
}

describe("host recovery", () => {
  it("survives a blip: socket closed for the host only, then resumed", async () => {
    const { a, b, clock, flush } = await room();
    expect(a.session.getSnapshot().isHost).toBe(true);
    a.blip();
    await flush();
    expect(a.session.getSnapshot().status).toBe("reconnecting");
    const during = a.session.act({ type: "move", uid: "x" });
    await flush();
    clock.advance(1);
    await flush();
    await during;
    expect(a.session.getSnapshot()).toMatchObject({ status: "connected", isHost: true });
    expect(a.session.getSnapshot().view?.seen).toEqual({ x: 1 });
    expect(b.session.getSnapshot().view?.seen).toEqual({ x: 1 });
    // The role still works afterwards.
    const later = b.session.act({ type: "move", uid: "y" });
    await flush();
    await later;
    expect(a.session.getSnapshot().view?.seen).toEqual({ x: 1, y: 1 });
  });

  it("the host sees its own state only after the relay confirmed it, and never shares it", async () => {
    const { a, b, flush } = await room();
    a.hold();
    let settled = false;
    const done = a.session.act({ type: "move", uid: "x" }).then(() => {
      settled = true;
    });
    await flush();
    expect(b.session.getSnapshot().view?.seen).toEqual({ x: 1 });
    expect(settled).toBe(false);
    expect(a.session.getSnapshot().view?.seen).toEqual({});
    a.release();
    await flush();
    await done;
    expect(a.session.getSnapshot().view?.seen).toEqual({ x: 1 });

    (a.session.getSnapshot().view as Ledger).seen.tampered = 1;
    const next = a.session.act({ type: "move", uid: "y" });
    await flush();
    await next;
    expect(b.session.getSnapshot().view?.seen).toEqual({ x: 1, y: 1 });
  });
});

describe("rejections", () => {
  it("a refused action is still refused after its reply was lost", async () => {
    const table = await createTable(ledger, { players: 3, seed: 2 });
    await table.start();
    const outcomes: string[] = [];
    const bad = table.sessions[2]?.act({ type: "fail" }).then(
      () => outcomes.push("bad:ok"),
      (e) => outcomes.push(`bad:${e instanceof GameError ? e.message : "other"}`),
    );
    const good = table.sessions[2]?.act({ type: "move", uid: "m" }).then(
      () => outcomes.push("good:ok"),
      () => outcomes.push("good:err"),
    );
    const dropping = table.disconnect(2); // the replies are lost
    await dropping;
    expect(outcomes).toEqual([]);
    await table.reconnect(2);
    await Promise.all([bad, good]);
    expect(outcomes.sort()).toEqual(["bad:nope", "good:ok"]);
    expect(table.view(0).seen).toEqual({ m: 1 });
  });

  it("a rejection by the host about its own action also reaches the caller", async () => {
    const table = await createTable(ledger, { players: 2, seed: 2 });
    await table.start();
    await expect(table.act(table.hostIndex(), { type: "fail" })).rejects.toThrow("nope");
    await table.act(table.hostIndex(), { type: "move", uid: "ok" });
    expect(table.indexOf(table.sessions[1]?.getSnapshot().me as string)).toBe(1);
    expect(table.indexOf("nobody")).toBe(-1);
  });
});

describe("deadlines are tied to their time", () => {
  it("acting just before the deadline moves it, and the old alarm does nothing", async () => {
    const table = await createTable(bumper, { seed: 1 });
    await table.start();
    const start = table.clock.now();
    await table.advance(9_999);
    await table.act(0, { type: "bump" });
    await table.advance(1); // the original deadline
    expect(table.view(1).fired).toBe(0);
    await table.advance(9_998);
    expect(table.view(1).fired).toBe(0);
    await table.advance(1);
    expect(table.view(1).fired).toBe(1);
    expect(table.clock.now()).toBe(start + 9_999 + 1 + 9_998 + 1);
  });

  it("runs onDeadline exactly once when the deadline passes while there is no host", async () => {
    const table = await createTable(bumper, { seed: 1 });
    await table.start();
    await table.disconnect(0);
    await table.disconnect(1);
    expect(table.hostIndex()).toBe(-1);
    await table.advance(12_000);
    await table.reconnect(1);
    await table.reconnect(0);
    expect(table.view(0).fired).toBe(1);
    expect(table.view(1).fired).toBe(1);
    await table.advance(5_000);
    expect(table.view(1).fired).toBe(1);
  });
});

describe("abandoned actions", () => {
  it("rejects with SessionClosedError, not GameError, when the session goes away", async () => {
    const table = await createTable(ledger, { players: 2, seed: 2 });
    await table.start();
    await table.disconnect(1);
    const pending = table.sessions[1]?.act({ type: "move", uid: "z" }) as Promise<void>;
    const outcome = pending.catch((e) => e);
    table.sessions[1]?.destroy();
    const error = await outcome;
    expect(error).toBeInstanceOf(SessionClosedError);
    expect(error).not.toBeInstanceOf(GameError);
  });
});
