import { defineGame, GameError, type PlayerId, type Random } from "@games/game";
import {
  type Action,
  type Card,
  type CardValue,
  COLORS,
  type Color,
  type Config,
  DEFAULT_CONFIG,
  HAND_SIZE,
  type HouseRules,
  type Note,
  type State,
  type TableEvent,
  TURN_OPTIONS,
  type TurnSeconds,
  type View,
} from "./types";

export * from "./types";

const NUMBERS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const ACTIONS = ["skip", "reverse", "draw2"] as const;

/** The 112 cards: per colour two of each number 0-9 and two of each action, plus four wild and four wild4. */
export function makeDeck(): Card[] {
  const deck: Card[] = [];
  const add = (color: Color | null, value: CardValue) =>
    deck.push({ id: `c${deck.length}`, color, value });
  for (const color of COLORS) {
    for (const value of [...NUMBERS, ...ACTIONS]) {
      add(color, value);
      add(color, value);
    }
  }
  for (let i = 0; i < 4; i++) {
    add(null, "wild");
    add(null, "wild4");
  }
  return deck;
}

export function cardPoints(card: Card): number {
  if (card.color === null) return 50;
  if (card.value === "skip" || card.value === "reverse" || card.value === "draw2") return 20;
  return Number(card.value);
}

// ---------------------------------------------------------------------------------------------
// Inner rules. These mutate the draft; `run` records what happened for the wrapper.

interface Run {
  random: Random;
  /** The turn passed (or a round was dealt): the deadline restarts. */
  advanced: boolean;
  /** The same player gets a fresh decision (won a challenge, chose the opening colour): restart their timer. */
  restart?: boolean;
}

const fail = (message: string): never => {
  throw new GameError(message);
};

const handOf = (s: State, id: PlayerId): Card[] => {
  const hand = s.hands[id];
  if (!hand) return fail("You are not a player in this game");
  return hand;
};

const currentId = (s: State): PlayerId => s.players[s.turn] as PlayerId;

function draw(s: State, run: Run, id: PlayerId, count: number): Card[] {
  const hand = handOf(s, id);
  const cards: Card[] = [];
  for (let i = 0; i < count; i++) {
    if (s.drawPile.length === 0 && s.discard.length > 1) {
      const top = s.discard.pop() as Card;
      s.drawPile = run.random.shuffle(s.discard);
      s.discard = [top];
    }
    const card = s.drawPile.pop();
    if (!card) break; // Every remaining card may be in hands: never invent cards.
    hand.push(card);
    cards.push(card);
  }
  return cards;
}

function advance(s: State, run: Run, count = 1) {
  const n = s.players.length;
  s.turn = (s.turn + ((s.direction * count) % n) + n) % n;
  s.drawnCardId = null;
  s.hasDrawn = false;
  run.advanced = true;
}

/** Colour, symbol or wild; while a +2 stack waits only another +2. */
function matches(s: State, card: Card): boolean {
  if (s.pendingDraw > 0) return card.value === "draw2";
  const top = s.discard[s.discard.length - 1];
  return (
    top !== undefined &&
    (card.color === null || card.color === s.activeColor || card.value === top.value)
  );
}

/** The one legality check shared by `apply` (PLAY) and `view` (playable). */
function canPlayCard(s: State, who: PlayerId, card: Card): boolean {
  return (
    s.phase === "playing" &&
    s.pendingWild === null &&
    s.challenge === null &&
    currentId(s) === who &&
    matches(s, card) &&
    (!s.hasDrawn || card.id === s.drawnCardId)
  );
}

function finish(s: State, id: PlayerId) {
  if (handOf(s, id).length > 0 || s.challenge || s.pendingWild || s.pendingDraw > 0) return;
  let points = 0;
  for (const [pid, hand] of Object.entries(s.hands)) {
    if (pid !== id) for (const card of hand) points += cardPoints(card);
  }
  s.scores[id] = (s.scores[id] ?? 0) + points;
  s.wins[id] = (s.wins[id] ?? 0) + 1;
  s.winnerId = id;
  s.roundPoints = points;
  const reached = (s.goal.mode === "points" ? s.scores[id] : s.wins[id]) ?? 0;
  const match = reached >= s.goal.target;
  s.phase = match ? "match-over" : "round-over";
  s.catchable = null;
  s.note = { kind: "win", playerId: id, points, match };
}

function startRound(s: State, run: Run) {
  s.round++;
  s.phase = "playing";
  s.pendingDraw = 0;
  s.called = [];
  s.winnerId = null;
  s.roundPoints = 0;
  s.direction = 1;
  s.discard = [];
  s.challenge = null;
  s.pendingWild = null;
  s.catchable = null;
  s.hasDrawn = false;
  s.drawnCardId = null;
  const deck = makeDeck();
  const n = s.players.length;
  if (s.round === 1) {
    // Highest number deals; action cards count as zero; redraw ties.
    let contenders = s.players.map((_, i) => i);
    while (contenders.length > 1) {
      const picks = run.random
        .shuffle([...deck])
        .slice(0, contenders.length)
        .map((card) => (/^\d$/.test(card.value) ? Number(card.value) : 0));
      const high = Math.max(...picks);
      contenders = contenders.filter((_, i) => picks[i] === high);
    }
    s.dealer = contenders[0] as number;
  } else {
    s.dealer = (s.dealer + 1) % n;
  }
  s.drawPile = run.random.shuffle(deck);
  s.hands = Object.fromEntries(s.players.map((p) => [p, [] as Card[]]));
  for (let i = 0; i < HAND_SIZE; i++) for (const p of s.players) draw(s, run, p, 1);
  let opening = s.drawPile.pop() as Card;
  while (opening.value === "wild4") {
    s.drawPile.unshift(opening);
    s.drawPile = run.random.shuffle(s.drawPile);
    opening = s.drawPile.pop() as Card;
  }
  s.discard = [opening];
  s.activeColor = opening.color ?? "red";
  s.turn = (s.dealer + 1) % n;
  if (opening.value === "skip") advance(s, run);
  if (opening.value === "draw2") {
    draw(s, run, currentId(s), 2);
    advance(s, run);
  }
  if (opening.value === "reverse") {
    s.direction = -1;
    s.turn = s.dealer;
  }
  if (opening.value === "wild") s.pendingWild = currentId(s);
  run.advanced = true;
  s.note = { kind: "round", round: s.round, dealer: s.players[s.dealer] as PlayerId };
}

function playCard(s: State, run: Run, actor: PlayerId, cardId: string, color: Color | undefined) {
  if (s.pendingWild) fail("Choose a colour first");
  if (currentId(s) !== actor) fail("It is not your turn");
  if (s.challenge) fail("Accept or challenge the +4 first");
  const hand = handOf(s, actor);
  const index = hand.findIndex((c) => c.id === cardId);
  const card = hand[index];
  if (index < 0 || !card) return fail("That card is not in your hand");
  if (!matches(s, card)) {
    return fail(
      s.pendingDraw > 0
        ? "Answer with a +2 or draw the stack"
        : "Match the colour, number or symbol",
    );
  }
  if (s.hasDrawn && card.id !== s.drawnCardId)
    fail("After drawing, only the drawn card can be played");
  if (card.color === null && !color) fail("Choose a colour for your wild card");

  s.catchable = null;
  const previousHand = [...hand];
  hand.splice(index, 1);
  s.discard.push(card);
  const previousColor = s.activeColor;
  s.activeColor = card.color ?? (color as Color);
  if (s.rules.callPenalty && hand.length === 1) s.catchable = actor;
  s.note = { kind: "play", playerId: actor, card, color: s.activeColor };

  if (card.value === "reverse") {
    s.direction = s.direction === 1 ? -1 : 1;
    advance(s, run, s.players.length === 2 ? 2 : 1);
  } else if (card.value === "skip") {
    advance(s, run, 2);
  } else if (card.value === "draw2") {
    advance(s, run);
    if (s.rules.stackDrawTwo && hand.length > 0) {
      s.pendingDraw += 2;
      s.note = { kind: "stack", playerId: actor, targetId: currentId(s), total: s.pendingDraw };
    } else {
      // A final +2 settles the whole stack before scoring.
      draw(s, run, currentId(s), s.pendingDraw + 2);
      s.pendingDraw = 0;
      advance(s, run);
    }
  } else if (card.value === "wild4") {
    // An illegal +4 stays playable so the bluff/challenge rule works.
    advance(s, run);
    s.challenge = {
      offenderId: actor,
      targetId: currentId(s),
      illegal: previousHand.some((c) => c.color === previousColor),
    };
  } else {
    advance(s, run);
  }
  finish(s, actor);
}

function drawAction(s: State, run: Run, actor: PlayerId) {
  if (s.pendingWild) fail("Choose a colour first");
  if (currentId(s) !== actor) fail("It is not your turn");
  if (s.challenge) fail("Accept or challenge the +4 first");
  if (s.hasDrawn) fail("You have already drawn this turn");
  s.catchable = null;
  if (s.pendingDraw > 0) {
    const count = draw(s, run, actor, s.pendingDraw).length;
    s.pendingDraw = 0;
    advance(s, run);
    s.note = { kind: "penalty", playerId: actor, count };
    return;
  }
  let card = draw(s, run, actor, 1)[0];
  let count = card ? 1 : 0;
  // Bounded by the physical deck: stop cleanly when every available card is held.
  while (s.rules.drawUntilPlayable && card && !matches(s, card)) {
    const next = draw(s, run, actor, 1)[0];
    if (!next) break;
    card = next;
    count++;
  }
  s.hasDrawn = true;
  s.drawnCardId = card?.id ?? null;
  s.note = { kind: "draw", playerId: actor, count };
  if (!card || !matches(s, card)) advance(s, run);
}

function resolveChallenge(s: State, run: Run, actor: PlayerId, challenge: boolean) {
  if (s.pendingWild) fail("Choose a colour first");
  if (currentId(s) !== actor) fail("It is not your turn");
  const pending = s.challenge;
  if (!pending || pending.targetId !== actor) return fail("No +4 is waiting for an answer");
  s.catchable = null;
  if (challenge && pending.illegal) {
    draw(s, run, pending.offenderId, 4);
    run.restart = true;
    s.note = { kind: "challenge", playerId: actor, offenderId: pending.offenderId, success: true };
  } else {
    const count = draw(s, run, actor, challenge ? 6 : 4).length;
    advance(s, run);
    s.note = challenge
      ? { kind: "challenge", playerId: actor, offenderId: pending.offenderId, success: false }
      : { kind: "penalty", playerId: actor, count };
  }
  s.challenge = null;
  finish(s, pending.offenderId);
}

function applyInner(s: State, run: Run, actor: PlayerId, action: Action) {
  if (action.type === "nextRound") {
    if (s.phase !== "round-over") fail("The round has not ended");
    startRound(s, run);
    return;
  }
  if (s.phase !== "playing") fail("No round is in progress");

  switch (action.type) {
    case "call": {
      if (handOf(s, actor).length !== 1 || s.called.includes(actor)) {
        fail("You have nothing to call right now");
      }
      if (s.catchable === actor) s.catchable = null;
      s.called.push(actor);
      s.note = { kind: "call", playerId: actor };
      return;
    }
    case "catch": {
      if (!s.rules.callPenalty) fail("Catching is turned off at this table");
      if (action.playerId === actor || s.catchable !== action.playerId) {
        fail("That player cannot be caught now");
      }
      draw(s, run, action.playerId, 2);
      s.catchable = null;
      s.note = { kind: "caught", playerId: action.playerId, by: actor };
      return;
    }
    case "color": {
      if (s.pendingWild !== actor) fail("You are not choosing a colour");
      s.activeColor = action.color;
      s.pendingWild = null;
      run.restart = true;
      s.note = { kind: "color", playerId: actor, color: action.color };
      return;
    }
    case "challenge":
      return resolveChallenge(s, run, actor, action.challenge);
    case "draw":
      return drawAction(s, run, actor);
    case "pass": {
      if (s.pendingWild) fail("Choose a colour first");
      if (currentId(s) !== actor) fail("It is not your turn");
      if (s.challenge) fail("Accept or challenge the +4 first");
      if (!s.hasDrawn) fail("Draw a card before passing");
      if (s.rules.mustPlayDrawn) fail("This table requires you to play the drawn card");
      s.catchable = null;
      advance(s, run);
      s.note = { kind: "pass", playerId: actor };
      return;
    }
    case "play":
      return playCard(s, run, actor, action.cardId, action.color);
  }
}

// ---------------------------------------------------------------------------------------------
// Wrapper: deadline, called list, cue.

function commit(
  before: State,
  s: State,
  run: Run,
  now: number,
  played: { playerId: PlayerId; card: Card } | null,
) {
  if (s.phase !== "playing") s.deadline = null;
  else if (run.advanced || run.restart)
    s.deadline = s.turnSeconds > 0 ? now + s.turnSeconds * 1000 : null;
  s.called = s.called.filter((id) => s.hands[id]?.length === 1);

  const events: TableEvent[] = [];
  const newRound = s.round !== before.round;
  if (newRound) {
    for (const id of s.players) {
      events.push({ kind: "deal", playerId: id, count: s.hands[id]?.length ?? 0 });
    }
  } else if (before.phase === "playing") {
    if (played) events.push({ kind: "play", playerId: played.playerId, card: played.card });
    for (const id of s.players) {
      const old = new Set((before.hands[id] ?? []).map((c) => c.id));
      const count = (s.hands[id] ?? []).filter((c) => !old.has(c.id)).length;
      if (count > 0) events.push({ kind: "draw", playerId: id, count });
    }
  }
  if (s.phase === "playing" && run.advanced) {
    events.push({ kind: "turn", playerId: currentId(s) });
  }
  s.cue = { id: before.cue.id + 1, events };
}

// ---------------------------------------------------------------------------------------------
// Validation of untrusted input.

const isColor = (v: unknown): v is Color => COLORS.some((c) => c === v);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseAction(state: State, raw: unknown): Action {
  if (!isObject(raw)) return fail("Invalid action");
  switch (raw.type) {
    case "play": {
      if (typeof raw.cardId !== "string") return fail("Invalid card");
      if (raw.color !== undefined && !isColor(raw.color)) return fail("Invalid colour");
      return raw.color === undefined
        ? { type: "play", cardId: raw.cardId }
        : { type: "play", cardId: raw.cardId, color: raw.color };
    }
    case "draw":
    case "pass":
    case "call":
    case "nextRound":
      return { type: raw.type };
    case "color":
      if (!isColor(raw.color)) return fail("Invalid colour");
      return { type: "color", color: raw.color };
    case "catch":
      if (typeof raw.playerId !== "string" || !state.players.includes(raw.playerId)) {
        return fail("Invalid player");
      }
      return { type: "catch", playerId: raw.playerId };
    case "challenge":
      if (typeof raw.challenge !== "boolean") return fail("Invalid answer");
      return { type: "challenge", challenge: raw.challenge };
    default:
      return fail("Unknown action");
  }
}

function validateConfig(config: unknown): Config {
  if (!isObject(config)) return fail("Invalid settings");
  const { turnSeconds, goal, rules } = config;
  if (!TURN_OPTIONS.some((option) => option === turnSeconds)) {
    return fail("Choose one of the available turn times");
  }
  if (!isObject(goal)) return fail("Invalid goal");
  const target = goal.target;
  let cleanGoal: Config["goal"];
  if (goal.mode === "points") {
    if (!Number.isInteger(target) || (target as number) < 50 || (target as number) > 5000) {
      return fail("Points goal must be a whole number from 50 to 5000");
    }
    cleanGoal = { mode: "points", target: target as number };
  } else if (goal.mode === "rounds") {
    if (!Number.isInteger(target) || (target as number) < 1 || (target as number) > 20) {
      return fail("Rounds goal must be a whole number from 1 to 20");
    }
    cleanGoal = { mode: "rounds", target: target as number };
  } else {
    return fail("Invalid goal");
  }
  if (!isObject(rules)) return fail("Invalid house rules");
  const { stackDrawTwo, drawUntilPlayable, mustPlayDrawn, callPenalty } = rules;
  if (
    typeof stackDrawTwo !== "boolean" ||
    typeof drawUntilPlayable !== "boolean" ||
    typeof mustPlayDrawn !== "boolean" ||
    typeof callPenalty !== "boolean"
  ) {
    return fail("Invalid house rules");
  }
  const cleanRules: HouseRules = { stackDrawTwo, drawUntilPlayable, mustPlayDrawn, callPenalty };
  return { turnSeconds: turnSeconds as TurnSeconds, goal: cleanGoal, rules: cleanRules };
}

// ---------------------------------------------------------------------------------------------

export const game = defineGame<State, Action, View, Config>({
  id: "ohno",
  version: 1,
  minPlayers: 2,
  maxPlayers: 12,
  defaultConfig: DEFAULT_CONFIG,
  validateConfig,

  setup({ players, config, random, now }) {
    const state: State = {
      phase: "playing",
      players: [...players],
      rules: { ...config.rules },
      goal: { ...config.goal },
      turnSeconds: config.turnSeconds,
      scores: Object.fromEntries(players.map((p) => [p, 0])),
      wins: Object.fromEntries(players.map((p) => [p, 0])),
      round: 0,
      dealer: 0,
      hands: {},
      drawPile: [],
      discard: [],
      activeColor: "red",
      turn: 0,
      direction: 1,
      hasDrawn: false,
      drawnCardId: null,
      pendingDraw: 0,
      pendingWild: null,
      challenge: null,
      catchable: null,
      called: [],
      winnerId: null,
      roundPoints: 0,
      deadline: null,
      cue: { id: 0, events: [] },
      note: { kind: "round", round: 0, dealer: players[0] as PlayerId },
    };
    const run: Run = { random, advanced: false };
    startRound(state, run);
    state.deadline = state.turnSeconds > 0 ? now + state.turnSeconds * 1000 : null;
    return state;
  },

  apply(state, rawAction, { actor, now, random }) {
    if (!state.players.includes(actor)) throw new GameError("You are not a player in this game");
    const action = parseAction(state, rawAction);
    const before = structuredClone(state);
    const run: Run = { random, advanced: false };
    applyInner(state, run, actor, action);
    const card =
      action.type === "play" ? before.hands[actor]?.find((c) => c.id === action.cardId) : undefined;
    commit(before, state, run, now, card ? { playerId: actor, card } : null);
  },

  view(state, viewer) {
    const seated = viewer !== null && state.players.includes(viewer);
    const me = seated ? viewer : null;
    const hand = me ? (state.hands[me] ?? []) : [];
    const myTurn = me !== null && state.phase === "playing" && currentId(state) === me;
    const free = myTurn && !state.pendingWild && !state.challenge;
    const top = state.discard[state.discard.length - 1] as Card;
    return {
      phase: state.phase,
      seats: state.players.map((id) => ({
        id,
        cards: state.hands[id]?.length ?? 0,
        score: state.scores[id] ?? 0,
        wins: state.wins[id] ?? 0,
        called: state.called.includes(id) && state.hands[id]?.length === 1,
        catchable: state.rules.callPenalty && state.catchable === id && me !== null && me !== id,
      })),
      turn: currentId(state),
      direction: state.direction,
      dealer: state.players[state.dealer] as PlayerId,
      round: state.round,
      rules: state.rules,
      goal: state.goal,
      hand: [...hand],
      playable: me ? hand.filter((c) => canPlayCard(state, me, c)).map((c) => c.id) : [],
      top,
      activeColor: state.activeColor,
      drawCount: state.drawPile.length,
      discardCount: state.discard.length,
      pendingDraw: state.pendingDraw,
      pendingWild: state.pendingWild,
      challenge: state.challenge
        ? { offenderId: state.challenge.offenderId, targetId: state.challenge.targetId }
        : null,
      can: {
        draw: free && !state.hasDrawn,
        pass: free && state.hasDrawn && !state.rules.mustPlayDrawn,
        call:
          me !== null &&
          state.phase === "playing" &&
          hand.length === 1 &&
          !state.called.includes(me),
        chooseColor: me !== null && state.phase === "playing" && state.pendingWild === me,
        answerChallenge:
          state.phase === "playing" &&
          me !== null &&
          !state.pendingWild &&
          state.challenge?.targetId === me &&
          currentId(state) === me,
        nextRound: me !== null && state.phase === "round-over",
      },
      drawnCardId: myTurn ? state.drawnCardId : null,
      winnerId: state.winnerId,
      roundPoints: state.roundPoints,
      deadline: state.deadline,
      cue: state.cue,
      note: state.note,
    };
  },

  isOver: (state) => state.phase === "match-over",
  deadline: (state) => state.deadline,

  // Running out of time forfeits the move: penalties are taken, the turn passes.
  onDeadline(state, { now, random }) {
    if (state.phase !== "playing") {
      state.deadline = null;
      return;
    }
    const before = structuredClone(state);
    const run: Run = { random, advanced: false };
    const timedOut = currentId(state);
    const offender = state.challenge?.offenderId;
    if (state.challenge) draw(state, run, timedOut, 4);
    else if (state.pendingDraw > 0) draw(state, run, timedOut, state.pendingDraw);
    state.challenge = null;
    state.pendingDraw = 0;
    if (state.pendingWild) {
      state.activeColor = random.pick(COLORS);
      state.pendingWild = null;
    }
    state.catchable = null;
    advance(state, run);
    state.note = { kind: "timeout", playerId: timedOut } satisfies Note;
    if (offender) finish(state, offender);
    commit(before, state, run, now, null);
  },
});
