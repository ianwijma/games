import { createRandom, type PlayerId } from "@games/game";
import { createTable, type Table } from "@games/game/testing";
import { describe, expect, it } from "vitest";
import {
  type Action,
  type Card,
  COLORS,
  type Config,
  cardPoints,
  DEFAULT_CONFIG,
  game,
  type HouseRules,
  makeDeck,
  type State,
  type View,
} from "./game";

type T = Table<Action, View, Config>;
type Session = T["sessions"][number];

const config = (patch: Partial<Config> = {}): Config => ({
  ...DEFAULT_CONFIG,
  turnSeconds: 0,
  ...patch,
});

// ---------------------------------------------------------------------------------------------
// Pure fixtures

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

/** Hand-built state: `specs[i]` is player i's hand as "color:value" ("null" for wilds). */
function fixture(
  specs: string[][],
  top = "red:5",
  rules: Partial<HouseRules> = {},
  patch: Partial<State> = {},
): State {
  const s = game.setup({
    players: ids(specs.length),
    config: config(),
    random: createRandom(7),
    now: 0,
  });
  const remaining = makeDeck();
  const pick = (spec: string) => {
    const [color, value] = spec.split(":");
    const index = remaining.findIndex((c) => (c.color ?? "null") === color && c.value === value);
    if (index < 0) throw new Error(`Missing fixture card ${spec}`);
    return remaining.splice(index, 1)[0] as Card;
  };
  s.hands = Object.fromEntries(specs.map((spec, i) => [`p${i}`, spec.map(pick)]));
  s.discard = [pick(top)];
  s.drawPile = remaining;
  s.activeColor = (s.discard[0] as Card).color ?? "red";
  s.turn = 0;
  s.direction = 1;
  s.phase = "playing";
  s.challenge = null;
  s.pendingWild = null;
  s.pendingDraw = 0;
  s.hasDrawn = false;
  s.drawnCardId = null;
  s.catchable = null;
  s.called = [];
  s.rules = { ...s.rules, callPenalty: false, ...rules };
  Object.assign(s, patch);
  return s;
}

/** Puts a card at the top of the draw pile so the next draw returns it. */
function stack(s: State, spec: string) {
  const [color, value] = spec.split(":");
  const i = s.drawPile.findIndex((c) => (c.color ?? "null") === color && c.value === value);
  if (i < 0) throw new Error(`Missing ${spec}`);
  s.drawPile.push(...s.drawPile.splice(i, 1));
}

function act(s: State, actor: string, action: Action): State {
  const next = structuredClone(s);
  const result = game.apply(next, action, { actor, now: 1000, random: createRandom(3) });
  return result ?? next;
}

const cardOf = (s: State, who: string, value: string, color?: string) => {
  const c = s.hands[who]?.find(
    (x) => x.value === value && (color === undefined || x.color === color),
  );
  if (!c) throw new Error(`${who} has no ${value}`);
  return c;
};

const play = (s: State, value: string, color: string | null = "blue") => {
  const who = s.players[s.turn] as string;
  const card = cardOf(s, who, value);
  return act(s, who, {
    type: "play",
    cardId: card.id,
    ...(color ? { color: color as (typeof COLORS)[number] } : {}),
  });
};

const total = (s: State) =>
  s.drawPile.length + s.discard.length + Object.values(s.hands).reduce((n, h) => n + h.length, 0);
const rejects = (fn: () => unknown, message?: RegExp) => {
  if (message) expect(fn).toThrow(message);
  else expect(fn).toThrow();
};

// ---------------------------------------------------------------------------------------------
// Table helpers

async function started(players: number, cfg: Config = config()): Promise<T> {
  const table = await createTable<State, Action, View, Config>(game, { players, seed: 5 });
  await table.run((table.sessions[0] as Session).configure(cfg));
  await table.start();
  return table;
}

const seatOf = (table: T, id: PlayerId) => table.indexOf(id);

/** One legal move for whoever must act, decided from that player's own view only. */
async function botStep(table: T, step: number): Promise<void> {
  const v0 = table.view(0);
  if (v0.phase === "round-over") return table.act(0, { type: "nextRound" });
  for (let j = 0; j < table.sessions.length; j++) {
    const target = table.view(j).seats.find((s) => s.catchable);
    if (target && step % 5 === 0) return table.act(j, { type: "catch", playerId: target.id });
  }
  const actorId = v0.pendingWild ?? v0.challenge?.targetId ?? v0.turn;
  const i = seatOf(table, actorId);
  const v = table.view(i);
  if (v.can.call && step % 7 !== 3) return table.act(i, { type: "call" });
  const counts = COLORS.map((c) => v.hand.filter((x) => x.color === c).length);
  const best = COLORS[counts.indexOf(Math.max(...counts))] as (typeof COLORS)[number];
  if (v.can.chooseColor) return table.act(i, { type: "color", color: best });
  if (v.can.answerChallenge) return table.act(i, { type: "challenge", challenge: step % 3 === 0 });
  // Prefer coloured cards of the colour held most, wilds last: games end in a sane number of moves.
  const weight = (c: Card) => (c.color === null ? -1 : (counts[COLORS.indexOf(c.color)] ?? 0));
  const first = v.hand
    .filter((c) => v.playable.includes(c.id))
    .sort((a, b) => weight(b) - weight(a))[0];
  if (first) {
    return table.act(i, {
      type: "play",
      cardId: first.id,
      ...(first.color ? {} : { color: best }),
    });
  }
  if (v.can.draw) return table.act(i, { type: "draw" });
  if (v.can.pass) return table.act(i, { type: "pass" });
  throw new Error(`bot is stuck: ${JSON.stringify(v.can)}`);
}

const conserved = (table: T) => {
  const v = table.view(0);
  return v.seats.reduce((n, s) => n + s.cards, 0) + v.drawCount + v.discardCount;
};

async function playOut(table: T, each?: (step: number) => Promise<void> | void) {
  const phase = () => table.sessions[0]?.getSnapshot().phase;
  for (let step = 0; phase() !== "ended"; step++) {
    if (step > 6000) throw new Error("game did not finish");
    await botStep(table, step);
    await table.advance(1000); // the relay rate-limits on the fake clock
    expect(conserved(table)).toBe(112);
    await each?.(step);
  }
}

// ---------------------------------------------------------------------------------------------

describe("deck and deal", () => {
  it("has 112 unique cards and the right scoring", () => {
    const deck = makeDeck();
    expect(deck).toHaveLength(112);
    expect(new Set(deck.map((c) => c.id)).size).toBe(112);
    expect(deck[0]?.id).toBe("c0");
    expect(deck[111]?.id).toBe("c111");
    expect(deck.filter((c) => c.value === "0")).toHaveLength(8);
    expect(deck.filter((c) => c.value === "wild4")).toHaveLength(4);
    expect(deck.filter((c) => c.value === "wild")).toHaveLength(4);
    expect(deck.filter((c) => c.color === "red" && c.value === "skip")).toHaveLength(2);
    expect(cardPoints(deck.find((c) => c.value === "7") as Card)).toBe(7);
    expect(cardPoints(deck.find((c) => c.value === "reverse") as Card)).toBe(20);
    expect(cardPoints(deck.find((c) => c.value === "wild4") as Card)).toBe(50);
  });

  it("deals every opening card type without losing cards", () => {
    for (const n of [2, 3, 5, 12]) {
      for (let seed = 0; seed < 60; seed++) {
        const s = game.setup({
          players: ids(n),
          config: config(),
          random: createRandom(seed),
          now: 0,
        });
        const opening = s.discard[0] as Card;
        expect(total(s)).toBe(112);
        expect(opening.value).not.toBe("wild4");
        expect(s.round).toBe(1);
        expect(Object.values(s.hands).every((h) => h.length === 7 || h.length === 9)).toBe(true);
        if (opening.value === "wild") expect(s.pendingWild).toBe(s.players[s.turn]);
        else expect(s.pendingWild).toBeNull();
        if (opening.value === "reverse") {
          expect(s.direction).toBe(-1);
          expect(s.turn).toBe(s.dealer);
        }
        if (opening.value === "skip") expect(s.turn).toBe((s.dealer + 2) % n);
        expect(s.phase).toBe("playing");
        expect(s.cue.id).toBe(0);
      }
    }
  });

  it("is reproducible for a seed and sets the first deadline", () => {
    const make = () =>
      game.setup({
        players: ids(4),
        config: config({ turnSeconds: 30 }),
        random: createRandom(9),
        now: 100,
      });
    expect(make()).toEqual(make());
    expect(make().deadline).toBe(30_100);
    expect(
      game.setup({ players: ids(2), config: config(), random: createRandom(1), now: 5 }).deadline,
    ).toBeNull();
  });
});

describe("rules", () => {
  it("matches colour or symbol and refuses the rest", () => {
    const s = fixture([["blue:skip", "blue:8", "red:1"], ["green:9"], ["yellow:1"]], "red:skip");
    const v = game.view(s, "p0");
    expect(v.playable).toEqual([cardOf(s, "p0", "skip").id, cardOf(s, "p0", "1").id]);
    rejects(() => play(s, "8"), /Match/);
    rejects(() => act(s, "p1", { type: "draw" }), /not your turn/);
    expect(play(s, "skip").turn).toBe(2);
  });

  it("draws one card; only that card can be played afterwards; pass ends the turn", () => {
    let s = fixture([["red:7", "yellow:8"], ["green:9"], ["blue:1"]]);
    stack(s, "red:2");
    s = act(s, "p0", { type: "draw" });
    expect(s.hands.p0).toHaveLength(3);
    expect(s.hasDrawn).toBe(true);
    const view = game.view(s, "p0");
    expect(view.drawnCardId).toBe(s.drawnCardId);
    expect(view.playable).toEqual([s.drawnCardId]);
    expect(game.view(s, "p1").drawnCardId).toBeNull();
    expect(view.can).toMatchObject({ draw: false, pass: true });
    rejects(() => play(s, "7"), /drawn card/);
    rejects(() => act(s, "p0", { type: "draw" }), /already/);
    s = act(s, "p0", { type: "pass" });
    expect(s.turn).toBe(1);
    expect(s.drawnCardId).toBeNull();
  });

  it("ends the turn at once when the drawn card cannot be played", () => {
    let s = fixture([["red:7"], ["green:9"]]);
    stack(s, "blue:2");
    s = act(s, "p0", { type: "draw" });
    expect(s.turn).toBe(1);
    expect(s.hasDrawn).toBe(false);
  });

  it("cannot pass before drawing or play another player's card", () => {
    const s = fixture([["red:7"], ["green:9"], ["blue:1"]]);
    rejects(() => act(s, "p0", { type: "pass" }), /Draw/);
    rejects(
      () => act(s, "p0", { type: "play", cardId: (s.hands.p1 as Card[])[0]?.id as string }),
      /hand/,
    );
  });

  it("drawUntilPlayable keeps drawing; mustPlayDrawn forbids passing", () => {
    let s = fixture([["red:7", "yellow:8"], ["green:9"]], "red:5", {
      drawUntilPlayable: true,
      mustPlayDrawn: true,
    });
    stack(s, "red:2");
    stack(s, "blue:3");
    stack(s, "green:4"); // drawn first
    s = act(s, "p0", { type: "draw" });
    expect(s.hands.p0).toHaveLength(5);
    expect(s.note).toEqual({ kind: "draw", playerId: "p0", count: 3 });
    expect(game.view(s, "p0").playable).toEqual([s.drawnCardId]);
    expect(game.view(s, "p0").can.pass).toBe(false);
    rejects(() => act(s, "p0", { type: "pass" }), /play the drawn card/);
  });

  it("Draw Two skips the next player, who takes two", () => {
    const s = play(fixture([["red:draw2", "green:1"], ["blue:draw2"], ["yellow:2"]]), "draw2");
    expect(s.turn).toBe(2);
    expect(s.hands.p1).toHaveLength(3);
    expect(s.pendingDraw).toBe(0);
    expect(s.cue.events.map((e) => e.kind)).toEqual(["play", "draw", "turn"]);
  });

  it.each(["skip", "reverse", "draw2"])("%s gives the move back with two players", (value) => {
    const s = play(fixture([[`red:${value}`, "blue:1"], ["yellow:8"]]), value);
    expect(s.turn).toBe(0);
    expect(s.hasDrawn).toBe(false);
  });

  it("reverses with three players", () => {
    const s = play(fixture([["red:reverse", "blue:1"], ["yellow:8"], ["green:8"]]), "reverse");
    expect(s.turn).toBe(2);
    expect(s.direction).toBe(-1);
  });

  it("requires a colour for a wild and records it", () => {
    const s = fixture([["null:wild", "blue:1"], ["yellow:8"]]);
    rejects(() => play(s, "wild", null), /colour/);
    const next = play(s, "wild", "green");
    expect(next.activeColor).toBe("green");
    expect(next.note).toMatchObject({ kind: "play", color: "green" });
    expect(next.turn).toBe(1);
  });

  it("stacks Draw Two when the rule is on; +4 does not stack", () => {
    let s = fixture(
      [
        ["red:draw2", "green:1"],
        ["blue:draw2", "green:3"],
        ["yellow:2", "null:wild4"],
      ],
      "red:5",
      { stackDrawTwo: true },
    );
    s = play(s, "draw2");
    expect(s.pendingDraw).toBe(2);
    expect(s.note).toEqual({ kind: "stack", playerId: "p0", targetId: "p1", total: 2 });
    expect(game.view(s, "p1").playable).toEqual([cardOf(s, "p1", "draw2").id]);
    expect(game.view(s, "p1").pendingDraw).toBe(2);
    s = play(s, "draw2");
    expect(s.pendingDraw).toBe(4);
    expect(game.view(s, "p2").playable).toEqual([]);
    rejects(() => play(s, "2"), /\+2/);
    rejects(() => play(s, "wild4"), /\+2/);
    s = act(s, "p2", { type: "draw" });
    expect(s.hands.p2).toHaveLength(6);
    expect(s.pendingDraw).toBe(0);
    expect(s.turn).toBe(0);
    expect(s.note).toEqual({ kind: "penalty", playerId: "p2", count: 4 });
  });

  it("a final Draw Two settles the stack and wins", () => {
    const s = play(
      fixture([["red:draw2"], ["blue:1"], ["yellow:2"]], "red:5", { stackDrawTwo: true }),
      "draw2",
    );
    expect(s.hands.p1).toHaveLength(3);
    expect(s.pendingDraw).toBe(0);
    expect(s.winnerId).toBe("p0");
    expect(s.phase).toBe("round-over");
  });

  it("restarts the turn timer after a won challenge and after choosing the opening colour", () => {
    let s = fixture(
      [["null:wild4", "red:9"], ["green:1"], ["blue:8"]],
      "red:5",
      {},
      {
        turnSeconds: 15,
        deadline: 500,
      },
    );
    s = play(s, "wild4");
    expect(s.deadline).toBe(16_000);
    const won = structuredClone(s);
    game.apply(
      won,
      { type: "challenge", challenge: true },
      {
        actor: "p1",
        now: 14_000,
        random: createRandom(3),
      },
    );
    expect(won.turn).toBe(1);
    expect(won.deadline).toBe(29_000);

    const opening = fixture(
      [["red:9"], ["green:1"]],
      "red:5",
      {},
      {
        turnSeconds: 15,
        deadline: 15_000,
        pendingWild: "p0",
      },
    );
    game.apply(
      opening,
      { type: "color", color: "green" },
      {
        actor: "p0",
        now: 14_000,
        random: createRandom(3),
      },
    );
    expect(opening.deadline).toBe(29_000);
  });

  it("an illegal +4 can be challenged: offender draws four, target keeps the turn", () => {
    let s = fixture([["null:wild4", "red:9"], ["green:1"], ["blue:8"]]);
    s = play(s, "wild4");
    expect(s.challenge).toMatchObject({ offenderId: "p0", targetId: "p1", illegal: true });
    const view = game.view(s, "p1");
    expect(view.challenge).toEqual({ offenderId: "p0", targetId: "p1" });
    expect(view.can).toMatchObject({ answerChallenge: true, draw: false, pass: false });
    expect(view.playable).toEqual([]);
    expect(game.view(s, "p2").can.answerChallenge).toBe(false);
    rejects(() => act(s, "p1", { type: "draw" }), /challenge/);
    rejects(() => act(s, "p2", { type: "challenge", challenge: true }), /turn/);
    s = act(s, "p1", { type: "challenge", challenge: true });
    expect(s.hands.p0).toHaveLength(5);
    expect(s.hands.p1).toHaveLength(1);
    expect(s.turn).toBe(1);
    expect(s.activeColor).toBe("blue");
    expect(s.challenge).toBeNull();
    expect(s.note).toMatchObject({
      kind: "challenge",
      success: true,
      playerId: "p1",
      offenderId: "p0",
    });
    expect(total(s)).toBe(112);
  });

  it("a legal +4 (number match only) fails the challenge: target draws six and loses the turn", () => {
    let s = fixture([["null:wild4", "green:5"], ["yellow:1"], ["blue:8"]]);
    s = play(s, "wild4");
    expect(s.challenge?.illegal).toBe(false);
    s = act(s, "p1", { type: "challenge", challenge: true });
    expect(s.hands.p1).toHaveLength(7);
    expect(s.turn).toBe(2);
    expect(s.note).toMatchObject({ kind: "challenge", success: false });
  });

  it("accepting a +4 draws four and loses the turn", () => {
    let s = fixture([["null:wild4", "red:9"], ["yellow:1"], ["blue:8"]]);
    s = play(s, "wild4");
    s = act(s, "p1", { type: "challenge", challenge: false });
    expect(s.hands.p1).toHaveLength(5);
    expect(s.turn).toBe(2);
    expect(s.note).toEqual({ kind: "penalty", playerId: "p1", count: 4 });
  });

  it("a final +4 only ends the round once it is settled", () => {
    let s = fixture(
      [["null:wild4"], ["yellow:1"], ["blue:8"]],
      "red:5",
      {},
      { scores: { p0: 499, p1: 0, p2: 0 } },
    );
    s = play(s, "wild4");
    expect(s.phase).toBe("playing");
    expect(s.winnerId).toBeNull();
    s = act(s, "p1", { type: "challenge", challenge: false });
    expect(s.hands.p1).toHaveLength(5);
    expect(s.phase).toBe("match-over"); // 499 + 5 + 8 +... crosses 500
    expect(s.winnerId).toBe("p0");
    expect(game.isOver?.(s)).toBe(true);
  });

  it("call and catch", () => {
    let s = fixture([["red:7", "red:8"], ["green:9"], ["blue:1"]], "red:5", { callPenalty: true });
    s = play(s, "7");
    expect(s.catchable).toBe("p0");
    expect(game.view(s, "p1").seats[0]?.catchable).toBe(true);
    expect(game.view(s, "p2").seats[0]?.catchable).toBe(true);
    expect(game.view(s, "p0").seats[0]?.catchable).toBe(false);
    expect(game.view(s, null).seats[0]?.catchable).toBe(false);
    rejects(() => act(s, "p0", { type: "catch", playerId: "p0" }), /cannot be caught/);
    rejects(() => act(s, "p1", { type: "catch", playerId: "p2" }), /cannot be caught/);
    const caught = act(s, "p2", { type: "catch", playerId: "p0" });
    expect(caught.hands.p0).toHaveLength(3);
    expect(caught.catchable).toBeNull();
    expect(caught.note).toEqual({ kind: "caught", playerId: "p0", by: "p2" });
    expect(caught.turn).toBe(s.turn);
    // Calling in time prevents the catch, and the next move closes the window.
    const called = act(s, "p0", { type: "call" });
    expect(called.called).toEqual(["p0"]);
    expect(game.view(called, "p1").seats[0]).toMatchObject({ called: true, catchable: false });
    rejects(() => act(called, "p1", { type: "catch", playerId: "p0" }), /cannot be caught/);
    rejects(() => act(called, "p0", { type: "call" }), /nothing to call/);
    rejects(
      () => act(fixture([["red:7", "red:8"], ["green:9"]]), "p0", { type: "call" }),
      /nothing to call/,
    );
    const moved = act(s, "p1", { type: "draw" });
    expect(moved.catchable).toBeNull();
    // Turned off: no catching.
    const off = play(fixture([["red:7", "red:8"], ["green:9"]]), "7");
    expect(off.catchable).toBeNull();
    rejects(() => act(off, "p1", { type: "catch", playerId: "p0" }), /turned off/);
  });

  it("forgets a call once the player is no longer on one card", () => {
    let s = fixture([["red:7"], ["green:9"], ["blue:1"]], "red:5", {}, { called: ["p0"] });
    s = act(s, "p2", { type: "call" });
    expect(s.called).toEqual(["p0", "p2"]);
    stack(s, "yellow:2");
    s = play(s, "7"); // p0 goes out
    expect(s.called).toEqual(["p2"]);
  });

  it("scores the winner, then ends the round or the match by the goal", () => {
    const base = () => fixture([["red:7"], ["green:9", "null:wild"], ["blue:skip"]]);
    const round = play(base(), "7");
    expect(round.phase).toBe("round-over");
    expect(round.roundPoints).toBe(79);
    expect(round.scores).toEqual({ p0: 79, p1: 0, p2: 0 });
    expect(round.wins.p0).toBe(1);
    expect(round.note).toEqual({ kind: "win", playerId: "p0", points: 79, match: false });
    expect(round.deadline).toBeNull();
    expect(game.isOver?.(round)).toBe(false);
    expect(game.view(round, "p1").can).toMatchObject({ nextRound: true, draw: false, call: false });
    expect(game.view(round, null).can.nextRound).toBe(false);
    expect(game.view(round, "p1").playable).toEqual([]);

    const byPoints = play({ ...base(), goal: { mode: "points", target: 50 } }, "7");
    expect(byPoints.phase).toBe("match-over");
    expect(byPoints.note).toMatchObject({ kind: "win", match: true });
    const byRounds = play({ ...base(), goal: { mode: "rounds", target: 1 } }, "7");
    expect(byRounds.phase).toBe("match-over");
    rejects(() => act(byRounds, "p1", { type: "nextRound" }), /not ended/);
    rejects(() => act(byRounds, "p1", { type: "draw" }), /No round/);
  });

  it("deals the next round with a rotated dealer and keeps scores", () => {
    let s = play(fixture([["red:7"], ["green:9", "null:wild"], ["blue:skip"]]), "7");
    const dealer = s.dealer;
    s = act(s, "p2", { type: "nextRound" });
    expect(s.phase).toBe("playing");
    expect(s.round).toBe(2);
    expect(s.dealer).toBe((dealer + 1) % 3);
    expect(s.scores.p0).toBe(79);
    expect(s.wins.p0).toBe(1);
    expect(s.winnerId).toBeNull();
    expect(total(s)).toBe(112);
    expect(s.cue.events.filter((e) => e.kind === "deal")).toHaveLength(3);
    expect(s.note).toMatchObject({ kind: "round", round: 2 });
  });

  it("reshuffles the discard when the draw pile runs out and never invents cards", () => {
    let s = fixture([["red:7"], ["green:9"], ["blue:1"]], "red:5", {}, { pendingDraw: 5 });
    const extra = s.drawPile.splice(0, s.drawPile.length - 1);
    s.discard.unshift(...extra.slice(0, 3));
    s.hands.p2?.push(...extra.slice(3));
    expect(s.drawPile).toHaveLength(1);
    const top = s.discard[s.discard.length - 1];
    s = act(s, "p0", { type: "draw" });
    expect(s.hands.p0).toHaveLength(5); // 1 in the pile + 3 reshuffled; the top stays
    expect(s.discard).toEqual([top]);
    expect(s.note).toEqual({ kind: "penalty", playerId: "p0", count: 4 });
    expect(total(s)).toBe(112);
    // With nothing left to draw the pile simply stays empty.
    const empty = fixture([["red:7"], ["green:9"]], "red:5", {}, { pendingDraw: 2 });
    empty.hands.p1?.push(...empty.drawPile.splice(0));
    const after = act(empty, "p0", { type: "draw" });
    expect(after.hands.p0).toHaveLength(1);
    expect(after.note).toEqual({ kind: "penalty", playerId: "p0", count: 0 });
    expect(total(after)).toBe(112);
  });

  it("opening wild lets the chosen player pick the colour", () => {
    let s = fixture(
      [["red:7"], ["green:9"]],
      "null:wild",
      {},
      { pendingWild: "p0", activeColor: "red" },
    );
    expect(game.view(s, "p0").can).toMatchObject({ chooseColor: true, draw: false });
    expect(game.view(s, "p0").playable).toEqual([]);
    rejects(() => play(s, "7", null), /colour first/);
    rejects(() => act(s, "p1", { type: "color", color: "blue" }), /not choosing/);
    s = act(s, "p0", { type: "color", color: "blue" });
    expect(s.activeColor).toBe("blue");
    expect(s.pendingWild).toBeNull();
    expect(s.turn).toBe(0);
    expect(s.note).toEqual({ kind: "color", playerId: "p0", color: "blue" });
    expect(s.cue.events).toEqual([]);
  });
});

describe("deadline handler", () => {
  const fire = (s: State, now = 5000) => {
    const next = structuredClone(s);
    const result = game.onDeadline?.(next, { now, random: createRandom(2) });
    return result ?? next;
  };
  const timed = { turnSeconds: 15 as const, deadline: 1000 };

  it("passes the turn and restarts the timer", () => {
    const s = fire(fixture([["red:7"], ["green:9"]], "red:5", {}, timed));
    expect(s.turn).toBe(1);
    expect(s.deadline).toBe(20_000);
    expect(s.note).toEqual({ kind: "timeout", playerId: "p0" });
    expect(s.cue.id).toBe(1);
    expect(s.cue.events).toEqual([{ kind: "turn", playerId: "p1" }]);
  });

  it("a timed-out challenge target accepts and draws four; a final +4 then finishes", () => {
    const s = fire(
      play(fixture([["null:wild4"], ["yellow:1"], ["blue:8"]], "red:5", {}, timed), "wild4"),
    );
    expect(s.hands.p1).toHaveLength(5);
    expect(s.challenge).toBeNull();
    expect(s.turn).toBe(2);
    expect(s.winnerId).toBe("p0");
    expect(s.deadline).toBeNull();
    const t = fire(
      play(
        fixture([["null:wild4", "red:9"], ["yellow:1"], ["blue:8"]], "red:5", {}, timed),
        "wild4",
      ),
    );
    expect(t.hands.p1).toHaveLength(5);
    expect(t.phase).toBe("playing");
  });

  it("a timed-out +2 stack is drawn; an unanswered opening wild gets a colour", () => {
    const stacked = fire(
      fixture(
        [["red:7"], ["green:9"], ["blue:1"]],
        "red:5",
        { stackDrawTwo: true },
        { ...timed, pendingDraw: 4 },
      ),
    );
    expect(stacked.hands.p0).toHaveLength(5);
    expect(stacked.pendingDraw).toBe(0);
    const wild = fire(
      fixture([["red:7"], ["green:9"]], "null:wild", {}, { ...timed, pendingWild: "p0" }),
    );
    expect(wild.pendingWild).toBeNull();
    expect(COLORS).toContain(wild.activeColor);
    expect(wild.turn).toBe(1);
  });

  it("clears the deadline when there is no timer", () => {
    const s = fire(
      fixture([["red:7"], ["green:9"]], "red:5", {}, { turnSeconds: 0, deadline: 1000 }),
    );
    expect(s.deadline).toBeNull();
  });

  it("only moves the deadline when the turn passes", () => {
    const s = fixture(
      [["red:7", "red:8"], ["green:9"]],
      "red:5",
      { callPenalty: true },
      { turnSeconds: 15, deadline: 7000 },
    );
    const played = play(s, "7");
    expect(played.deadline).toBe(16_000);
    const called = act(played, "p0", { type: "call" });
    expect(called.deadline).toBe(16_000);
  });
});

describe("validation", () => {
  const s = fixture([["red:7", "null:wild"], ["green:9"]]);
  const bad = (action: unknown, actor = "p0") =>
    expect(() =>
      game.apply(structuredClone(s), action as Action, { actor, now: 0, random: createRandom(1) }),
    ).toThrow();

  it("rejects malformed payloads and strangers", () => {
    for (const a of [
      null,
      "play",
      42,
      [],
      {},
      { type: "explode" },
      { type: "play" },
      { type: "play", cardId: 5 },
      { type: "play", cardId: "c0", color: "purple" },
      { type: "play", cardId: "c0", color: 3 },
      { type: "color", color: "pink" },
      { type: "catch", playerId: 4 },
      { type: "catch", playerId: "nobody" },
      { type: "challenge" },
      { type: "challenge", challenge: "yes" },
      { type: "@ready" },
    ]) {
      bad(a);
    }
    bad({ type: "draw" }, "stranger");
    bad({ type: "play", cardId: "c0" }, "stranger");
  });

  it("does not leave the state half changed after a rejection through the table", async () => {
    const table = await started(2);
    const before = JSON.stringify(table.view(0));
    await expect(table.act(0, { type: "play", cardId: "nope" })).rejects.toThrow();
    expect(JSON.stringify(table.view(0))).toBe(before);
  });

  it("validateConfig accepts the default and cleans extras", () => {
    expect(game.validateConfig?.(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
    const cleaned = game.validateConfig?.({
      ...DEFAULT_CONFIG,
      extra: 1,
      goal: { mode: "rounds", target: 3, junk: true },
      rules: { ...DEFAULT_CONFIG.rules, more: 1 },
    });
    expect(cleaned).toEqual({ ...DEFAULT_CONFIG, goal: { mode: "rounds", target: 3 } });
  });

  it("validateConfig rejects bad shapes", () => {
    const rules = DEFAULT_CONFIG.rules;
    const cases: unknown[] = [
      null,
      "x",
      {},
      { ...DEFAULT_CONFIG, turnSeconds: 7 },
      { ...DEFAULT_CONFIG, turnSeconds: "30" },
      { ...DEFAULT_CONFIG, goal: undefined },
      { ...DEFAULT_CONFIG, goal: { mode: "points", target: 49 } },
      { ...DEFAULT_CONFIG, goal: { mode: "points", target: 5001 } },
      { ...DEFAULT_CONFIG, goal: { mode: "points", target: 100.5 } },
      { ...DEFAULT_CONFIG, goal: { mode: "rounds", target: 0 } },
      { ...DEFAULT_CONFIG, goal: { mode: "rounds", target: 21 } },
      { ...DEFAULT_CONFIG, goal: { mode: "rounds", target: "3" } },
      { ...DEFAULT_CONFIG, goal: { mode: "laps", target: 3 } },
      { ...DEFAULT_CONFIG, rules: undefined },
      { ...DEFAULT_CONFIG, rules: { ...rules, callPenalty: 1 } },
      { ...DEFAULT_CONFIG, rules: { stackDrawTwo: true } },
    ];
    for (const c of cases) expect(() => game.validateConfig?.(c)).toThrow();
    expect(
      game.validateConfig?.({ ...DEFAULT_CONFIG, goal: { mode: "points", target: 5000 } }),
    ).toBeTruthy();
    expect(
      game.validateConfig?.({
        ...DEFAULT_CONFIG,
        goal: { mode: "rounds", target: 20 },
        turnSeconds: 0,
      }),
    ).toBeTruthy();
  });
});

describe("view", () => {
  it("shows a spectator nothing private", () => {
    const s = fixture([["red:7", "null:wild"], ["green:9"]]);
    const v = game.view(s, null);
    expect(v.hand).toEqual([]);
    expect(v.playable).toEqual([]);
    expect(Object.values(v.can).every((x) => x === false)).toBe(true);
    expect(v.drawnCardId).toBeNull();
    expect(v.seats.map((x) => x.cards)).toEqual([2, 1]);
    expect(game.view(s, "stranger").hand).toEqual([]);
  });

  it("only offers moves on your own turn", () => {
    const s = fixture([["red:7", "green:1"], ["red:9"]]);
    expect(game.view(s, "p0").playable).toEqual([cardOf(s, "p0", "7").id]);
    expect(game.view(s, "p1").playable).toEqual([]);
    expect(game.view(s, "p1").can.draw).toBe(false);
    expect(game.view(s, "p0").can.draw).toBe(true);
  });
});

describe("full games through the table", () => {
  for (const n of [2, 3, 12]) {
    it(`plays one round to the end with ${n} players`, async () => {
      const table = await started(n, config({ goal: { mode: "rounds", target: 1 } }));
      await playOut(table);
      const view = table.view(0);
      expect(table.sessions[0]?.getSnapshot().phase).toBe("ended");
      expect(view.phase).toBe("match-over");
      expect(view.winnerId).not.toBeNull();
      const winner = view.seats.find((s) => s.id === view.winnerId);
      expect(winner?.cards).toBe(0);
      expect(winner?.wins).toBe(1);
      expect(winner?.score).toBe(view.roundPoints);
      for (let i = 0; i < n; i++) expect(table.view(i).winnerId).toBe(view.winnerId);
    });
  }

  it("plays a two round match through round-over and nextRound", async () => {
    const table = await started(3, config({ goal: { mode: "rounds", target: 2 } }));
    let sawRoundOver = false;
    let rounds = 1;
    await playOut(table, () => {
      const v = table.view(1);
      if (v.phase === "round-over") {
        sawRoundOver = true;
        expect(v.can.nextRound).toBe(true);
        expect(v.deadline).toBeNull();
      }
      rounds = Math.max(rounds, v.round);
    });
    expect(sawRoundOver).toBe(true);
    expect(rounds).toBeGreaterThanOrEqual(2);
    const v = table.view(0);
    expect(v.phase).toBe("match-over");
    expect(Math.max(...v.seats.map((s) => s.wins))).toBe(2);
    expect(v.seats.reduce((n, s) => n + s.wins, 0)).toBe(v.round);
  });

  it("plays a points match to the goal", async () => {
    const table = await started(2, config({ goal: { mode: "points", target: 50 } }));
    await playOut(table);
    const v = table.view(0);
    expect(Math.max(...v.seats.map((s) => s.score))).toBeGreaterThanOrEqual(50);
  });

  it("honours the house rules in a full game", async () => {
    const rules = {
      stackDrawTwo: true,
      drawUntilPlayable: true,
      mustPlayDrawn: true,
      callPenalty: true,
    };
    const table = await started(4, config({ goal: { mode: "rounds", target: 1 }, rules }));
    await playOut(table);
    expect(table.view(0).phase).toBe("match-over");
  });

  it("rejects wrong player, missing card, unplayable card, bare wild, nextRound while playing", async () => {
    const table = await started(3);
    const v0 = table.view(0);
    const mover = seatOf(table, v0.pendingWild ?? v0.turn);
    const other = (mover + 1) % 3;
    const mv = table.view(mover);
    const ov = table.view(other);
    await expect(table.act(other, { type: "draw" })).rejects.toThrow();
    await expect(table.act(mover, { type: "play", cardId: "c999" })).rejects.toThrow(/hand/);
    await expect(
      table.act(mover, { type: "play", cardId: ov.hand[0]?.id as string }),
    ).rejects.toThrow();
    await expect(table.act(mover, { type: "nextRound" })).rejects.toThrow(/not ended/);
    await expect(table.act(mover, { type: "catch", playerId: "nobody" })).rejects.toThrow();
    await expect(
      table.act(mover, { type: "challenge", challenge: true } as Action),
    ).rejects.toThrow();
    const unplayable = mv.hand.find((c) => !mv.playable.includes(c.id));
    if (unplayable && !mv.can.chooseColor) {
      await expect(table.act(mover, { type: "play", cardId: unplayable.id })).rejects.toThrow();
    }
    await expect(
      table.act(mover, { type: "play", cardId: 5 } as unknown as Action),
    ).rejects.toThrow();
  });

  it("rejects actions after the match ends", async () => {
    const table = await started(2, config({ goal: { mode: "rounds", target: 1 } }));
    await playOut(table);
    await expect(table.act(0, { type: "draw" })).rejects.toThrow();
    await expect(table.act(1, { type: "nextRound" })).rejects.toThrow();
  });

  it("never leaks hidden information", async () => {
    const table = await started(4, config({ goal: { mode: "rounds", target: 1 } }));
    const check = () => {
      for (let a = 0; a < 4; a++) {
        const json = JSON.stringify(table.view(a));
        expect(json).not.toContain('"illegal"');
        expect(json).not.toContain("drawPile");
        expect(json).not.toContain('"hands"');
        for (let b = 0; b < 4; b++) {
          if (a === b) continue;
          for (const card of table.view(b).hand) {
            expect(json).not.toContain(`"${card.id}"`);
          }
        }
        const v = table.view(a);
        expect(v.hand).toHaveLength(v.seats[a]?.cards as number);
        if (v.turn !== v.seats[a]?.id) expect(v.drawnCardId).toBeNull();
      }
    };
    check();
    await playOut(table, check);
  });

  it("finishes consistently when the host is killed after every move", async () => {
    const table = await started(3, config({ goal: { mode: "rounds", target: 1 } }));
    await playOut(table, async () => {
      const host = table.hostIndex();
      await table.killHost();
      await table.reconnect(host);
      expect(conserved(table)).toBe(112);
    });
    const winner = table.view(0).winnerId;
    expect(winner).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      expect(table.view(i).winnerId).toBe(winner);
      expect(table.view(i).phase).toBe("match-over");
    }
  }, 60_000);

  it("fires the turn timer through the relay", async () => {
    const table = await started(2, config({ turnSeconds: 15 }));
    const before = table.view(0);
    expect(before.deadline).not.toBeNull();
    const first = before.turn;
    await table.advance(15_001);
    const after = table.view(0);
    expect(after.cue.id).toBe(before.cue.id + 1);
    expect(after.note).toEqual({ kind: "timeout", playerId: first });
    expect(after.turn).not.toBe(first);
    expect(after.deadline).toBeGreaterThan(before.deadline as number);
    expect(conserved(table)).toBe(112);
    await table.advance(15_001);
    expect(table.view(0).cue.id).toBe(before.cue.id + 2);
  });

  it("bumps the cue on every committed action", async () => {
    const table = await started(2);
    const before = table.view(0).cue.id;
    await botStep(table, 1);
    expect(table.view(0).cue.id).toBe(before + 1);
  });
});
