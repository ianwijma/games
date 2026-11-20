import { useLayoutEffect, useRef, useState } from "react";
import type { Card, Cue } from "./types";
import { DRAW_GAP, DRAW_LANDS, MAX_DRAW_FLIGHTS } from "./useCueFlights";

/**
 * The cards the viewer just drew, with the delay (ms) after which each one may appear in the hand.
 * They are already in `hand`; the table keeps each hidden until its flight from the pile lands, so
 * a draw of four is seen as four cards arriving. Like the flights, nothing happens for the first
 * cue seen (mount, restore, reload). The hiding is a CSS animation, off under reduced motion.
 */
export function useArrivals(cue: Cue, hand: Card[], me: string | null): Map<string, number> {
  const [arrivals, setArrivals] = useState<Map<string, number>>(() => new Map());
  const lastCue = useRef<number | null>(null);
  const known = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    const previousCue = lastCue.current;
    const before = known.current;
    lastCue.current = cue.id;
    known.current = new Set(hand.map((c) => c.id));
    if (previousCue === null || cue.id <= previousCue || me === null) return;
    // Flights before the viewer's own draw in the same step (a card played on them) come first.
    let wait = 0;
    let mine = false;
    for (const event of cue.events) {
      if (event.kind === "draw" && event.playerId === me) {
        mine = true;
        break;
      }
      if (event.kind === "draw") wait += Math.min(event.count, MAX_DRAW_FLIGHTS) * DRAW_GAP;
      else if (event.kind === "play") wait += 50;
    }
    if (!mine) return;
    const fresh = hand.filter((c) => !before.has(c.id));
    if (fresh.length === 0) return;
    const next = new Map<string, number>();
    fresh.forEach((card, i) => {
      next.set(card.id, wait + Math.min(i, MAX_DRAW_FLIGHTS - 1) * DRAW_GAP + DRAW_LANDS);
    });
    setArrivals(next);
    if (timer.current) clearTimeout(timer.current);
    const longest = Math.max(...next.values());
    timer.current = setTimeout(() => setArrivals(new Map()), longest + 600);
  }, [cue, hand, me]);

  useLayoutEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return arrivals;
}
