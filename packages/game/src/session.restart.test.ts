import { describe, expect, it } from "vitest";
import { createTable, type Table } from "./testing";
import { defineGame, GameError, SessionClosedError } from "./types";

// -- a game where every move is counted, so "applied exactly once" is visible in the view ----------

interface Ledger {
  seen: Record<string, number>;
  total: number;
  goal: number;
}
type Move = { type: "move"; uid: string };
const ledger = defineGame<Ledger, Move, Ledger, { goal: number }>({
  id: "ledger-restart",
  version: 1,
  minPlayers: 2,
  maxPlayers: 3,
  defaultConfig: { goal: 6 },
  validateConfig(config) {
    const goal = (config as { goal?: unknown } | null)?.goal;
    if (typeof goal !== "number" || !Number.isInteger(goal) || goal < 1) {
      throw new GameError("bad goal");
    }
    return { goal };
  },
  setup: ({ config }) => ({ seen: {}, total: 0, goal: config.goal }),
  apply(state, action) {
    state.seen[action.uid] = (state.seen[action.uid] ?? 0) + 1;
    state.total += 1;
  },
  view: (state) => state,
  isOver: (state) => state.total >= state.goal,
});

interface Timer {
  due: number;
  fired: number;
}
const timer = defineGame<Timer, { type: "noop" }, Timer, Record<string, never>>({
  id: "timer-restart",
  version: 1,
  minPlayers: 2,
  maxPlayers: 3,
  defaultConfig: {},
  setup: ({ now }) => ({ due: now + 10_000, fired: 0 }),
  apply() {},
  view: (state) => state,
  deadline: (state) => (state.fired >= 3 ? null : state.due),
  onDeadline(state) {
    state.fired += 1;
    state.due += 10_000;
  },
});

const move = (uid: string): Move => ({ type: "move", uid });

async function newTable(players = 3, goal = 100) {
  const table = await createTable(ledger, { players, seed: 1 });
  if (goal !== 6) await table.run(table.sessions[0]?.configure({ goal }) as Promise<void>);
  await table.start();
  return table;
}

/** Everyone connected, one host, and identical views. */
function expectConverged<A, V, C>(table: Table<A, V, C>) {
  const snaps = table.sessions.map((s) => s.getSnapshot());
  for (const s of snaps) expect(s.status).toBe("connected");
  expect(snaps.filter((s) => s.isHost)).toHaveLength(1);
  for (const s of snaps) expect(s.view).toEqual(snaps[0]?.view);
  for (const s of snaps) expect(s.phase).toBe(snaps[0]?.phase);
}

function watchStatus(table: Table<unknown, unknown, unknown>, player: number) {
  const session = table.sessions[player] as NonNullable<(typeof table.sessions)[number]>;
  const seen: string[] = [session.getSnapshot().status];
  session.subscribe(() => {
    const status = session.getSnapshot().status;
    if (seen[seen.length - 1] !== status) seen.push(status);
  });
  return seen;
}

/** Starts an action and records how it ended, so nothing is ever an unhandled rejection. */
function track(promise: Promise<void>) {
  const result: { value: string | null } = { value: null };
  void promise.then(
    () => {
      result.value = "ok";
    },
    (error: Error) => {
      result.value = `${error.name}:${error.message}`;
    },
  );
  return result;
}

describe("restart: games carry on", () => {
  it("everyone is back in the same seat, same view, and the game finishes", async () => {
    const table = await newTable(3, 6);
    await table.act(0, move("a"));
    await table.act(1, move("b"));
    await table.act(2, move("c"));
    const before = table.sessions.map((s) => ({
      me: s.getSnapshot().me,
      code: s.getSnapshot().code,
    }));
    const view = table.view(0);
    const oldHub = table.hub;
    const statuses = [0, 1, 2].map((i) => watchStatus(table, i));

    await table.restart();

    expect(table.hub).not.toBe(oldHub);
    expect(
      table.sessions.map((s) => ({ me: s.getSnapshot().me, code: s.getSnapshot().code })),
    ).toEqual(before);
    for (const seen of statuses) expect(seen).toContain("reconnecting");
    for (let i = 0; i < 3; i++) expect(table.view(i)).toEqual(view);
    expectConverged(table);
    expect(table.hub.stats()).toMatchObject({ rooms: 1, peers: 3, connected: 3 });

    await table.act(2, move("d"));
    await table.act(0, move("e"));
    await table.act(1, move("f"));
    for (let i = 0; i < 3; i++) {
      expect(table.sessions[i]?.getSnapshot().phase).toBe("ended");
      expect(table.view(i).total).toBe(6);
    }
  });

  it("survives several restarts in a row", async () => {
    const table = await newTable();
    for (let i = 0; i < 4; i++) {
      await table.act(i % 3, move(`m${i}`));
      await table.restart();
      expectConverged(table);
    }
    expect(table.view(0).total).toBe(4);
  });

  it("keeps ready flags, config and the owner in the lobby", async () => {
    const table = await createTable(ledger, { players: 3, seed: 1 });
    await table.run(table.sessions[0]?.configure({ goal: 9 }) as Promise<void>);
    await table.run(table.sessions[1]?.setReady(true) as Promise<void>);
    const code = table.sessions[0]?.getSnapshot().code;

    await table.restart({ downMs: 1_000 });

    for (const s of table.sessions) {
      const snap = s.getSnapshot();
      expect(snap).toMatchObject({
        status: "connected",
        phase: "lobby",
        config: { goal: 9 },
        code,
      });
      expect(snap.players.map((p) => p.ready)).toEqual([false, true, false]);
    }
    expect(table.sessions.map((s) => s.getSnapshot().isOwner)).toEqual([true, false, false]);
    await table.advance(20_000); // longer than the owner grace period
    expect(table.sessions.map((s) => s.getSnapshot().isOwner)).toEqual([true, false, false]);
    await table.start();
    expect(table.sessions[0]?.getSnapshot().phase).toBe("playing");
  });
});

describe("restart in the middle of a commit, at every step", () => {
  for (const who of ["host", "other"] as const) {
    it(`an action from the ${who} is applied exactly once`, async () => {
      let sawEnd = false;
      let k = 0;
      for (; k < 60 && !sawEnd; k++) {
        const table = await newTable();
        const host = table.hostIndex();
        const actor = who === "host" ? host : (host + 1) % 3;
        const outcome = track(table.sessions[actor]?.act(move("x")) as Promise<void>);
        for (let i = 0; i < k && !sawEnd; i++) sawEnd = !(await table.step());
        await table.restart();
        await table.settle();

        const where = `${who}, restarted after ${k} steps`;
        expect(outcome.value, where).toBe("ok");
        expect(table.view(0).seen, where).toEqual({ x: 1 });
        expectConverged(table);
        await table.act((actor + 1) % 3, move("y"));
        expect(table.view(actor).seen, where).toEqual({ x: 1, y: 1 });
        expectConverged(table);
      }
      expect(sawEnd).toBe(true);
      expect(k).toBeGreaterThan(3);
    });

    it(`a lost commit is replayed once when the ${who} acts while others race`, async () => {
      const table = await newTable();
      const host = table.hostIndex();
      const a = (host + 1) % 3;
      const b = (host + 2) % 3;
      const outcomes = [
        track(table.sessions[a]?.act(move("a1")) as Promise<void>),
        track(table.sessions[b]?.act(move("b1")) as Promise<void>),
        track(table.sessions[host]?.act(move("h1")) as Promise<void>),
      ];
      await table.step();
      await table.step();
      await table.restart();
      await table.settle();
      expect(outcomes.map((o) => o.value)).toEqual(["ok", "ok", "ok"]);
      expect(table.view(0).seen).toEqual({ a1: 1, b1: 1, h1: 1 });
      expectConverged(table);
    });
  }

  it("killing the host at every step, then restarting, loses and repeats nothing", async () => {
    let sawEnd = false;
    for (let k = 0; k < 60 && !sawEnd; k++) {
      const table = await newTable();
      const host = table.hostIndex();
      const actor = (host + 1) % 3;
      const outcome = track(table.sessions[actor]?.act(move("x")) as Promise<void>);
      for (let i = 0; i < k && !sawEnd; i++) sawEnd = !(await table.step());
      await table.disconnect(host);
      await table.restart();
      await table.reconnect(host);
      await table.settle();

      const where = `host killed then restart after ${k} steps`;
      expect(outcome.value, where).toBe("ok");
      expect(table.view(0).seen, where).toEqual({ x: 1 });
      expectConverged(table);
      await table.act(host, move("y"));
      expect(table.view(actor).seen, where).toEqual({ x: 1, y: 1 });
    }
    expect(sawEnd).toBe(true);
  });
});

describe("restart and deadlines", () => {
  it("runs onDeadline once when it fell due during the outage", async () => {
    const table = await createTable(timer, { players: 3, seed: 1 });
    await table.start();
    const due = table.view(0).due;
    const start = table.clock.now();
    await table.restart({ downMs: 15_000 });
    for (let i = 0; i < 3; i++) expect(table.view(i)).toEqual({ due: due + 10_000, fired: 1 });
    expectConverged(table);
    // The next one is at its original time, not shifted by the restart.
    await table.advance(due + 10_000 - table.clock.now() - 1);
    expect(table.view(1).fired).toBe(1);
    await table.advance(1);
    expect(table.view(1).fired).toBe(2);
    await table.advance(1_000);
    expect(table.view(2).fired).toBe(2);
    expect(table.clock.now()).toBeGreaterThan(start + 15_000);
  });

  it("fires a deadline that is still ahead at its original absolute time, once", async () => {
    const table = await createTable(timer, { players: 3, seed: 1 });
    await table.start();
    const due = table.view(0).due;
    await table.advance(3_000);
    await table.restart({ downMs: 1_000 });
    expect(table.view(0).fired).toBe(0);
    await table.advance(due - table.clock.now() - 1);
    expect(table.view(0).fired).toBe(0);
    await table.advance(1);
    for (let i = 0; i < 3; i++) expect(table.view(i).fired).toBe(1);
    await table.advance(9_000);
    expect(table.view(1).fired).toBe(1);
  });
});

describe("crash with a stale snapshot", () => {
  it("rolls everyone back to the snapshot and carries on", async () => {
    const table = await newTable();
    await table.act(0, move("a"));
    await table.act(1, move("b"));
    const stale = table.snapshot();
    // Far more commits than the restarted room will make before the clients look again.
    for (let i = 0; i < 12; i++) await table.act(i % 3, move(`late${i}`));
    expect(table.view(0).total).toBe(14);

    await table.restart({ snapshot: stale });

    for (let i = 0; i < 3; i++) expect(table.view(i).seen).toEqual({ a: 1, b: 1 });
    expectConverged(table);
    await table.act(1, move("e"));
    for (let i = 0; i < 3; i++) expect(table.view(i).seen).toEqual({ a: 1, b: 1, e: 1 });
    await table.act(2, move("f"));
    expect(table.view(0).seen).toEqual({ a: 1, b: 1, e: 1, f: 1 });
    expectConverged(table);
  });

  it("a snapshot taken before the room's first commit does not leave clients on newer views", async () => {
    const table = await newTable();
    const stale = table.snapshot();
    const room = stale.rooms[0];
    if (!room) throw new Error("no room");
    // What a snapshot taken right after `create` holds: one seat, nothing committed yet.
    room.checkpoint = null;
    room.seats = room.seats.slice(0, 1);
    await table.act(0, move("a"));

    await table.restart({ snapshot: stale });

    const first = table.sessions[0]?.getSnapshot();
    expect(first?.status).toBe("connected");
    expect(first?.players.map((p) => p.name)).toEqual(["Player 1"]);
    expect(first?.phase).toBe("lobby");
    expect(table.sessions[1]?.getSnapshot().closed?.reason).toBe("resume-failed");
    // And the room is usable: a call resolves instead of waiting for the old seq to be overtaken.
    await table.run((table.sessions[0] as (typeof table.sessions)[number]).setReady(true));
    expect(table.sessions[0]?.getSnapshot().players[0]?.ready).toBe(true);
  });

  it("at every step of a commit, a snapshot taken then still yields a consistent room", async () => {
    let sawEnd = false;
    for (let k = 0; k < 60 && !sawEnd; k++) {
      const table = await newTable();
      const host = table.hostIndex();
      const actor = (host + 1) % 3;
      const outcome = track(table.sessions[actor]?.act(move("x")) as Promise<void>);
      for (let i = 0; i < k && !sawEnd; i++) sawEnd = !(await table.step());
      const stale = table.snapshot();
      await table.settle();
      expect(outcome.value).toBe("ok");
      await table.restart({ snapshot: stale });
      const where = `snapshot after ${k} steps`;
      expectConverged(table);
      const x = table.view(0).seen.x ?? 0;
      expect(x, where).toBeLessThanOrEqual(1);
      await table.act((host + 2) % 3, move("y"));
      expect(table.view(0).seen.y, where).toBe(1);
      expectConverged(table);
    }
    expect(sawEnd).toBe(true);
  });
});

describe("persistence lost", () => {
  it("ends every session with resume-failed, and nothing hangs", async () => {
    const table = await newTable();
    await table.act(0, move("a"));
    const pending = track(table.sessions[1]?.act(move("lost")) as Promise<void>);
    await table.restart({ snapshot: null });
    for (const s of table.sessions) {
      expect(s.getSnapshot().status).toBe("closed");
      expect(s.getSnapshot().closed?.reason).toBe("resume-failed");
    }
    expect(table.hub.stats().rooms).toBe(0);
    expect(pending.value).toMatch(new RegExp(`^${SessionClosedError.name}:`));
    await table.advance(60_000);
    await expect(table.sessions[0]?.act(move("again")) as Promise<void>).rejects.toBeInstanceOf(
      SessionClosedError,
    );
  });

  it("a room that expired during a long outage is gone too", async () => {
    const table = await newTable();
    await table.restart({ downMs: 31 * 60_000 });
    for (const s of table.sessions) expect(s.getSnapshot().closed?.reason).toBe("resume-failed");
    expect(table.hub.stats().rooms).toBe(0);
  });
});
