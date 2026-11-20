import type { Card, CardValue, Color, Goal, Note } from "./types";
import { COLORS } from "./types";

export const COLOR_NAMES: Record<Color, string> = {
  red: "Red",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
};

const VALUE_ORDER: CardValue[] = [
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "skip",
  "reverse",
  "draw2",
  "wild",
  "wild4",
];

function valueName(value: CardValue): string {
  if (value === "draw2") return "+2";
  return value;
}

/** "Red 7", "Blue skip", "Wild +4". */
export function cardLabel(card: Card): string {
  if (card.color === null) return card.value === "wild4" ? "Wild +4" : "Wild";
  return `${COLOR_NAMES[card.color]} ${valueName(card.value)}`;
}

/** Colour by colour, then by value; wild cards last. */
export function sortHand(cards: Card[]): Card[] {
  const colorRank = (c: Card) => (c.color === null ? COLORS.length : COLORS.indexOf(c.color));
  return [...cards].sort(
    (a, b) =>
      colorRank(a) - colorRank(b) ||
      VALUE_ORDER.indexOf(a.value) - VALUE_ORDER.indexOf(b.value) ||
      a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
}

export interface Who {
  name: string;
  you: boolean;
}

const cards = (n: number) => `${n} card${n === 1 ? "" : "s"}`;

/** Turns the last thing that happened into one sentence. */
export function noteText(note: Note, who: (id: string) => Who): string {
  const subject = (id: string) => (who(id).you ? "You" : who(id).name);
  const object = (id: string) => (who(id).you ? "you" : who(id).name);
  const verb = (id: string, base: string, third: string) => (who(id).you ? base : third);
  switch (note.kind) {
    case "round":
      return `Round ${note.round}, dealt by ${object(note.dealer)}`;
    case "play": {
      const p = note.playerId;
      const base = `${subject(p)} ${verb(p, "play", "plays")} ${cardLabel(note.card)}`;
      return note.card.color === null
        ? `${base} and ${verb(p, "choose", "chooses")} ${COLOR_NAMES[note.color]}`
        : base;
    }
    case "draw":
      return `${subject(note.playerId)} ${verb(note.playerId, "draw", "draws")} ${cards(note.count)}`;
    case "penalty":
      return `${subject(note.playerId)} ${verb(note.playerId, "take", "takes")} ${cards(note.count)} and ${verb(note.playerId, "miss", "misses")} the turn`;
    case "stack":
      return `${subject(note.playerId)} ${verb(note.playerId, "stack", "stacks")} a +2. ${subject(note.targetId)} must draw ${note.total} or stack again`;
    case "pass":
      return `${subject(note.playerId)} ${verb(note.playerId, "keep", "keeps")} the card`;
    case "color":
      return `${subject(note.playerId)} ${verb(note.playerId, "choose", "chooses")} ${COLOR_NAMES[note.color]}`;
    case "call":
      return `${subject(note.playerId)} ${verb(note.playerId, "call", "calls")} Oh no!`;
    case "caught":
      return `${subject(note.by)} ${verb(note.by, "catch", "catches")} ${object(note.playerId)}. ${subject(note.playerId)} ${verb(note.playerId, "draw", "draws")} 2 cards`;
    case "challenge":
      return note.success
        ? `The +4 was not allowed. ${subject(note.offenderId)} ${verb(note.offenderId, "draw", "draws")} 4 cards`
        : `The +4 was fine. ${subject(note.playerId)} ${verb(note.playerId, "draw", "draws")} 6 cards`;
    case "timeout":
      return `${subject(note.playerId)} ran out of time`;
    case "win":
      return note.match
        ? `${subject(note.playerId)} ${verb(note.playerId, "win", "wins")} the match`
        : `${subject(note.playerId)} ${verb(note.playerId, "win", "wins")} the round and ${verb(note.playerId, "take", "takes")} ${note.points} points`;
  }
}

export function goalText(goal: Goal): string {
  return goal.mode === "points"
    ? `First to ${goal.target} points`
    : `First to ${goal.target} round ${goal.target === 1 ? "win" : "wins"}`;
}
