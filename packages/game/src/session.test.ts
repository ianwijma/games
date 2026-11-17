import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { initialState, reconcile, step } from "./engine";
import { createRandom } from "./random";
import { createTable, type Table } from "./testing";
import { defineGame, GameError } from "./types";

// -- toy game 1: hidden hands ------------------------------------------------

interface CardState {
  order: string[];
  turn: number;
  hands: Record<string, number[]>;
  played: { by: string; card: number; bonus: number }[];
}
interface CardView {
  hand: number[];
  counts: Record<string, number>;
  turn: string;
  played: CardState["played"];
}
type CardAction = { type: "play"; card: number };

const cards = defineGame<CardState, CardAction, CardView, { cards: number }>({
  id: "cards",
  version: 1,
  minPlayers: 2,
  maxPlayers: 3,
  defaultConfig: { cards: 2 },
  validateConfig(config) {
    const n = (config as { cards?: unknown } | null)?.cards;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 5) {
      throw new GameError("cards must be 1 to 5");
    }
    return { cards: n };
  },
  setup({ players, config, random }) {
    const deck = random.shuffle(
      Array.from({ length: players.length * config.cards * 2 }, (_, i) => i + 1),
    );
    const hands: Record<string, number[]> = {};
    for (const p of players) hands[p] = deck.splice(0, config.cards);
    return { order: players, turn: 0, hands, played: [] };
  },
  apply(state, action, { actor, random }) {
    if (state.order[state.turn] !== actor) throw new GameError("Not your turn");
    const hand = state.hands[actor] ?? [];
    const at = hand.indexOf(action.card);
    if (at < 0) throw new GameError("You do not hold that card");
    hand.splice(at, 1);
    state.played.push({ by: actor, card: action.card, bonus: random.int(100) });
    state.turn = (state.turn + 1) % state.order.length;
  },
  view(state, viewer) {
    return {
      hand: viewer ? [...(state.hands[viewer] ?? [])] : [],
      counts: Object.fromEntries(Object.entries(state.hands).map(([id, h]) => [id, h.length])),
      turn: state.order[state.turn] as string,
      played: state.played,
    };
  },
  isOver: (state) => Object.values(state.hands).every((h) => h.length === 0),
});

type CardTable = Table<CardAction, CardView, { cards: number }>;

const idOf = (table: CardTable, i: number) => table.sessions[i]?.getSnapshot().me as string;
const phaseOf = (table: CardTable) => table.sessions[0]?.getSnapshot().phase;

/** Plays the lowest card of whoever's turn it is. */
async function playNext(table: CardTable) {
  const turn = table.view(0).turn;
  const i = table.sessions.findIndex((_, k) => idOf(table, k) === turn);
  const card = table.view(i).hand[0] as number;
  await table.act(i, { type: "play", card });
  return { player: i, card };
}

async function newCardTable(seed: number, players = 3) {
  const table = await createTable(cards, { players, seed });
  await table.start();
  return table;
}

/** Plays to the end, calling `hook` before every move and once at the end. */
async function playOut(table: CardTable, hook?: (step: number) => Promise<void>) {
  let step = 0;
  while (phaseOf(table) !== "ended") {
    await hook?.(step);
    await playNext(table);
    step++;
  }
  await hook?.(step);
}

describe("lobby and hidden information", () => {
  it("runs the lobby: ready, owner-only config, minPlayers, start", async () => {
    const table = await createTable(cards, { players: 3, seed: 1 });
    const [owner, other] = table.sessions;
    expect(owner?.getSnapshot()).toMatchObject({ phase: "lobby", isOwner: true, isPlayer: true });
    expect(other?.getSnapshot().isOwner).toBe(false);
    expect(other?.getSnapshot().players.map((p) => p.name)).toEqual([
      "Player 1",
      "Player 2",
      "Player 3",
    ]);
    expect(owner?.getSnapshot().config).toEqual({ cards: 2 });

    const rejected = (p: Promise<void>, message: string) => {
      const check = expect(p).rejects.toThrow(message);
      return table.settle().then(() => check);
    };
    await rejected(
      (other as NonNullable<typeof other>).configure({ cards: 3 }),
      "Only the room owner",
    );
    await rejected(
      (owner as NonNullable<typeof owner>).configure({ cards: 9 }),
      "cards must be 1 to 5",
    );
    await rejected((other as NonNullable<typeof other>).start(), "Only the room owner");
    const configured = (owner as NonNullable<typeof owner>).configure({ cards: 3 });
    await table.settle();
    await configured;
    expect(other?.getSnapshot().config).toEqual({ cards: 3 });

    const ready = (other as NonNullable<typeof other>).setReady(true);
    await table.settle();
    await ready;
    expect(owner?.getSnapshot().players.map((p) => p.ready)).toEqual([false, true, false]);

    await table.start();
    expect(owner?.getSnapshot().phase).toBe("playing");
    expect(table.view(0).hand).toHaveLength(3);
    // Lobby actions no longer apply, and the room is locked.
    await rejected((owner as NonNullable<typeof owner>).setReady(false), "Not possible right now");
    expect(table.hub.stats().rooms).toBe(1);

    const solo = await createTable(cards, { players: 1 });
    await rejected(
      (solo.sessions[0] as NonNullable<(typeof solo.sessions)[0]>).start(),
      "At least 2 players",
    );
  });

  it("never sends other players' hands", async () => {
    const table = await newCardTable(5);
    const ids = table.sessions.map((_, i) => idOf(table, i));
    let shadow = initialState(cards, 5);
    shadow.players = ids.map((id) => ({ id, name: id, ready: true }));
    shadow.ownerId = ids[0] as string;
    shadow = step(cards, shadow, ids[0] as string, { type: "@start" }, 0);
    const game = shadow.game as CardState;
    ids.forEach((id, i) => {
      const view = table.view(i);
      expect(view.hand).toEqual(game.hands[id]);
      expect(Object.keys(view).sort()).toEqual(["counts", "hand", "played", "turn"]);
      for (const other of ids.filter((o) => o !== id)) {
        const secret = game.hands[other] as number[];
        expect(view.hand.some((c) => secret.includes(c))).toBe(false);
      }
    });
  });

  it("enforces turns, ends the game and goes back to the lobby", async () => {
    const table = await newCardTable(3);
    const turn = table.view(0).turn;
    const waiting = table.sessions.findIndex((_, i) => idOf(table, i) !== turn);
    await expect(
      table.act(waiting, { type: "play", card: table.view(waiting).hand[0] as number }),
    ).rejects.toThrow("Not your turn");
    const mover = table.sessions.findIndex((_, i) => idOf(table, i) === turn);
    await expect(table.act(mover, { type: "play", card: 999 })).rejects.toThrow("do not hold");

    await playOut(table);
    expect(phaseOf(table)).toBe("ended");
    expect(table.view(1).played).toHaveLength(6);

    await expect(table.act(0, { type: "play", card: 1 })).rejects.toThrow("Not possible");
    const back = table.sessions[0]?.backToLobby();
    await table.settle();
    await back;
    expect(table.sessions[2]?.getSnapshot()).toMatchObject({ phase: "lobby", view: null });
    expect(table.sessions[2]?.getSnapshot().players.every((p) => !p.ready)).toBe(true);
    await table.start();
    expect(table.view(1).played).toEqual([]);
  });
});

describe("host migration", () => {
  it("completes the same game wherever the host is killed", async () => {
    const baseline = await newCardTable(11);
    let steps = 0;
    await playOut(baseline, async (k) => {
      steps = k;
    });
    // Player ids are random per table, so compare by seat.
    const bySeat = (table: CardTable, i: number) =>
      table.view(i).played.map((p) => ({
        ...p,
        by: table.sessions.findIndex((_, k) => idOf(table, k) === p.by),
      }));
    const expected = bySeat(baseline, 0);
    expect(expected).toHaveLength(6);

    for (let killAt = 0; killAt <= steps; killAt++) {
      const table = await newCardTable(11);
      const ids = table.sessions.map((_, i) => idOf(table, i));
      let shadow = initialState(cards, 11);
      shadow.players = ids.map((id) => ({ id, name: id, ready: true }));
      shadow.ownerId = ids[0] as string;
      shadow = step(cards, shadow, ids[0] as string, { type: "@start" }, 0);

      const check = () => {
        ids.forEach((id, i) => {
          expect(table.view(i)).toEqual(cards.view(shadow.game as CardState, id));
        });
      };
      check();
      let k = 0;
      while (phaseOf(table) !== "ended") {
        if (k === killAt) {
          const old = table.hostIndex();
          const next = await table.killHost();
          expect(next).not.toBe(old);
          expect(next).toBeGreaterThanOrEqual(0);
          await table.reconnect(old);
          check();
        }
        const { player, card } = await playNext(table);
        shadow = step(
          cards,
          shadow,
          ids[player] as string,
          { type: "play", card } as { type: string },
          0,
        );
        check();
        k++;
      }
      if (killAt === k) {
        await table.killHost();
        await table.reconnect(0);
      }
      for (let i = 0; i < 3; i++) expect(bySeat(table, i)).toEqual(expected);
    }
  });
});

// -- toy game 2: a ledger (conserves a total, records each action's uid) ------

interface Ledger {
  balances: Record<string, number>;
  seen: Record<string, number>;
  order: string[];
}
type Move = { type: "move"; uid: string; to: number };
const ledger = defineGame<Ledger, Move, Ledger, Record<string, never>>({
  id: "ledger",
  version: 1,
  minPlayers: 2,
  maxPlayers: 3,
  defaultConfig: {},
  setup: ({ players }) => ({
    balances: Object.fromEntries(players.map((p) => [p, 10])),
    seen: {},
    order: players,
  }),
  apply(state, { uid, to }, { actor }) {
    state.seen[uid] = (state.seen[uid] ?? 0) + 1;
    const target = state.order[to % state.order.length] as string;
    state.balances[actor] = (state.balances[actor] ?? 0) - 1;
    state.balances[target] = (state.balances[target] ?? 0) + 1;
  },
  view: (state) => state,
});

const total = (l: Ledger) => Object.values(l.balances).reduce((a, b) => a + b, 0);

describe("exactly-once actions", () => {
  it("applies an action sent while the host is being killed exactly once", async () => {
    for (const players of [2, 3]) {
      const table = await createTable(ledger, { players, seed: 2 });
      await table.start();
      const sender = players - 1;
      const killing = table.disconnect(0); // the link is closed, but nothing is delivered yet
      const sent = table.sessions[sender]?.act({ type: "move", uid: "a", to: 0 }) as Promise<void>;
      await killing;
      await table.settle();
      await sent;
      expect(table.hostIndex()).toBe(1);
      for (const i of [1, sender]) {
        expect(table.view(i).seen).toEqual({ a: 1 });
        expect(total(table.view(i))).toBe(10 * players);
      }
      await table.reconnect(0);
      expect(table.view(0).seen).toEqual({ a: 1 });
    }
  });

  it("applies an action issued while the player itself is offline once it is back", async () => {
    const table = await createTable(ledger, { players: 3, seed: 2 });
    await table.start();
    await table.disconnect(2);
    const sent = table.sessions[2]?.act({ type: "move", uid: "x", to: 1 }) as Promise<void>;
    await table.settle();
    expect(table.view(0).seen).toEqual({});
    await table.reconnect(2);
    await sent;
    expect(table.view(0).seen).toEqual({ x: 1 });
  });

  it("keeps numbering after a reload (ack counter rule)", async () => {
    const table = await createTable(ledger, { players: 3, seed: 2 });
    await table.start();
    for (const uid of ["a", "b", "c"]) await table.act(2, { type: "move", uid, to: 0 });
    const before = table.sessions[2]?.getSnapshot().me;
    await table.reload(2);
    expect(table.sessions[2]?.getSnapshot().me).toBe(before);
    // A fresh session starts counting at 1, but the host already acked 3.
    await table.act(2, { type: "move", uid: "d", to: 1 });
    expect(table.view(0).seen).toEqual({ a: 1, b: 1, c: 1, d: 1 });
    expect(table.view(2).seen).toEqual({ a: 1, b: 1, c: 1, d: 1 });
    // Reloading the host works too.
    await table.reload(table.hostIndex());
    await table.act(1, { type: "move", uid: "e", to: 1 });
    expect(table.view(2).seen.e).toBe(1);
  });

  it("holds up under random drops, reconnects and host kills", async () => {
    const command = fc.oneof(
      fc.record({ kind: fc.constant("act" as const), who: fc.nat(2), to: fc.nat(2) }),
      fc.record({ kind: fc.constant("drop" as const), who: fc.nat(2) }),
      fc.record({ kind: fc.constant("back" as const), who: fc.nat(2) }),
      fc.record({ kind: fc.constant("kill" as const) }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(command, { maxLength: 25 }), async (commands) => {
        const table = await createTable(ledger, { players: 3, seed: 9 });
        await table.start();
        const issued: string[] = [];
        const resolved = new Set<string>();
        const online = [true, true, true];
        const consistent = () => {
          const views = [0, 1, 2].filter((i) => online[i]).map((i) => table.view(i));
          for (const v of views) expect(v).toEqual(views[0]);
          for (const v of views) {
            expect(total(v)).toBe(30);
            for (const n of Object.values(v.seen)) expect(n).toBeLessThanOrEqual(1);
          }
        };
        for (const c of commands) {
          if (c.kind === "act") {
            const uid = `u${issued.length}`;
            issued.push(uid);
            table.sessions[c.who]?.act({ type: "move", uid, to: c.to }).then(
              () => resolved.add(uid),
              () => {},
            );
          } else if (c.kind === "drop" && online[c.who]) {
            online[c.who] = false;
            await table.disconnect(c.who);
          } else if (c.kind === "back" && !online[c.who]) {
            online[c.who] = true;
            await table.reconnect(c.who);
          } else if (c.kind === "kill") {
            const host = table.hostIndex();
            if (host >= 0) {
              online[host] = false;
              await table.disconnect(host);
            }
          }
          await table.settle();
          consistent();
        }
        for (const i of [0, 1, 2]) {
          if (!online[i]) await table.reconnect(i);
          online[i] = true;
        }
        await table.settle();
        consistent();
        const seen = table.view(0).seen;
        for (const uid of issued) expect(seen[uid]).toBe(1);
        for (const uid of resolved) expect(seen[uid]).toBe(1);
      }),
      { numRuns: 50 },
    );
  });
});

// -- toy game 3: a turn timer --------------------------------------------------

interface Timer {
  due: number;
  fired: number;
  last: number;
}
const timer = defineGame<Timer, { type: "noop" }, Timer, Record<string, never>>({
  id: "timer",
  version: 1,
  minPlayers: 2,
  maxPlayers: 2,
  defaultConfig: {},
  setup: ({ now }) => ({ due: now + 10_000, fired: 0, last: 0 }),
  apply() {},
  view: (state) => state,
  deadline: (state) => (state.fired >= 3 ? null : state.due),
  onDeadline(state, { now }) {
    state.fired += 1;
    state.last = now;
    state.due += 10_000;
  },
});

describe("deadlines", () => {
  it("fires onDeadline when the clock passes it", async () => {
    const table = await createTable(timer, { seed: 1 });
    await table.start();
    const due = table.view(0).due;
    await table.advance(9_999);
    expect(table.view(1).fired).toBe(0);
    await table.advance(1);
    expect(table.view(1)).toMatchObject({ fired: 1, last: due });
    for (let i = 0; i < 5; i++) await table.advance(10_000);
    expect(table.view(0).fired).toBe(3);
  });

  it("still fires, once, after the host is killed before the deadline", async () => {
    const table = await createTable(timer, { players: 3, seed: 1 });
    await table.start();
    await table.advance(5_000);
    const old = table.hostIndex();
    await table.killHost();
    await table.reconnect(old);
    await table.advance(5_000);
    for (let i = 0; i < 3; i++) expect(table.view(i).fired).toBe(1);
    await table.killHost();
    await table.advance(10_000);
    const survivor = table.hostIndex();
    expect(table.view(survivor).fired).toBe(2);
  });
});

// -- owner and spectators --------------------------------------------------------

describe("owner and spectators", () => {
  it("passes ownership on when the owner drops", async () => {
    const table = await createTable(cards, { players: 3, seed: 1 });
    expect(table.sessions[0]?.getSnapshot().isOwner).toBe(true);
    await table.disconnect(0);
    expect(table.sessions[1]?.getSnapshot().isOwner).toBe(true);
    expect(table.sessions[2]?.getSnapshot().players.map((p) => [p.isOwner, p.connected])).toEqual([
      [false, false],
      [true, true],
      [false, true],
    ]);
    await table.reconnect(0);
    expect(table.sessions[1]?.getSnapshot().isOwner).toBe(true);
    expect(table.sessions[0]?.getSnapshot().players[0]?.connected).toBe(true);
  });

  it("makes a peer beyond maxPlayers a spectator", async () => {
    const table = await createTable(cards, { players: 4, seed: 4 });
    const spectator = table.sessions[3]?.getSnapshot();
    expect(spectator).toMatchObject({ isPlayer: false, phase: "lobby" });
    expect(spectator?.players).toHaveLength(3);
    await table.start();
    expect(table.view(3)).toMatchObject({ hand: [] });
    expect(Object.keys(table.view(3).counts)).toHaveLength(3);
    await expect(table.act(3, { type: "play", card: 1 })).rejects.toThrow("not a player");
    // Moves still reach the spectator, and the game ends without it.
    await playOut(table);
    expect(table.view(3).played).toHaveLength(6);
    expect(table.sessions[3]?.getSnapshot().phase).toBe("ended");
  });
});

describe("createRandom", () => {
  it("is reproducible from its state", () => {
    const a = createRandom(42);
    a.next();
    const b = createRandom(a.state);
    expect([a.next(), a.int(10)]).toEqual([b.next(), b.int(10)]);
    expect(createRandom(1).shuffle([1, 2, 3, 4, 5]).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(reconcile).toBeTypeOf("function");
  });
});
