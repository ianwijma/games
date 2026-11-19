import { CardBack } from "@games/react";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { OhnoCard } from "./Card";
import type { Card, Cue } from "./types";

interface Point {
  dx: number;
  dy: number;
  scale: number;
  opacity: number;
}

interface Flight {
  key: number;
  /** null = a face-down card. */
  card: Card | null;
  /** Where the card sits at its natural size (fixed, viewport pixels). */
  left: number;
  top: number;
  width: number;
  from: Point;
  to: Point;
  delay: number;
}

const DURATION = 260;
const STAGGER = 50;
const MAX_FLIGHTS = 14;
const GIVE_UP_MS = 2000;

function Flier({
  flight,
  shapes,
  onDone,
}: {
  flight: Flight;
  shapes: boolean;
  onDone(key: number): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const frame = (p: Point) => ({
      transform: `translate(${p.dx}px, ${p.dy}px) scale(${p.scale})`,
      opacity: p.opacity,
    });
    const animation = el.animate([frame(flight.from), frame(flight.to)], {
      duration: DURATION,
      delay: flight.delay,
      easing: "ease-out",
      fill: "both",
    });
    animation.onfinish = () => onDone(flight.key);
    return () => animation.cancel();
  }, [flight, onDone]);
  return (
    <div
      ref={ref}
      className="ohno-flier"
      style={{ left: flight.left, top: flight.top, width: flight.width }}
    >
      {flight.card ? (
        <OhnoCard card={flight.card} shapes={shapes} decorative />
      ) : (
        <CardBack className="ohno-back" />
      )}
    </div>
  );
}

/**
 * Animates the events of `cue` while the table is mounted: a played card flies from its player to
 * the discard pile, draws and deals fly face-down cards from the draw pile to the player. The
 * first cue seen (mount, restore, reload) is only recorded. Only transform and opacity move, nothing
 * runs under prefers-reduced-motion, and the overlay never takes pointer events. Elements are found
 * through `data-ohno-anchor` attributes inside `rootRef`.
 */
export function useCueFlights(
  rootRef: RefObject<HTMLElement | null>,
  cue: Cue,
  me: string | null,
  shapes: boolean,
): ReactNode {
  const [flights, setFlights] = useState<Flight[]>([]);
  const last = useRef<number | null>(null);
  const counter = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const latest = useRef({ me });
  latest.current = { me };

  const done = useCallback((key: number) => {
    setFlights((current) => current.filter((f) => f.key !== key));
  }, []);

  useEffect(() => {
    const timerSet = timers.current;
    return () => {
      for (const t of timerSet) clearTimeout(t);
      timerSet.clear();
    };
  }, []);

  useEffect(() => {
    const previous = last.current;
    last.current = cue.id;
    if (previous === null || cue.id <= previous) return;
    const root = rootRef.current;
    if (!root || typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof root.animate !== "function") return;

    const anchors = Array.from(root.querySelectorAll<HTMLElement>("[data-ohno-anchor]"));
    const find = (name: string, id?: string) =>
      anchors.find(
        (el) => el.dataset.ohnoAnchor === name && (id === undefined || el.dataset.ohnoId === id),
      );
    const drawEl = find("draw");
    const discardEl = find("discard");
    if (!drawEl || !discardEl) return;
    const drawRect = drawEl.getBoundingClientRect();
    const discardRect = discardEl.getBoundingClientRect();
    const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    const seatRect = (id: string) => {
      const el = id === latest.current.me ? find("hand") : find("seat", id);
      return el?.getBoundingClientRect() ?? null;
    };

    const made: Flight[] = [];
    const add = (
      card: Card | null,
      natural: DOMRect,
      start: { x: number; y: number; scale: number },
      end: { x: number; y: number; scale: number; opacity: number },
    ) => {
      if (made.length >= MAX_FLIGHTS) return;
      const c = centre(natural);
      const height = natural.width * 1.4;
      counter.current += 1;
      made.push({
        key: counter.current,
        card,
        left: c.x - natural.width / 2,
        top: c.y - height / 2,
        width: natural.width,
        from: { dx: start.x - c.x, dy: start.y - c.y, scale: start.scale, opacity: 1 },
        to: { dx: end.x - c.x, dy: end.y - c.y, scale: end.scale, opacity: end.opacity },
        delay: made.length * STAGGER,
      });
    };

    for (const event of cue.events) {
      if (event.kind === "play") {
        const from = seatRect(event.playerId);
        if (!from) continue;
        const start = centre(from);
        const mine = event.playerId === latest.current.me;
        const end = centre(discardRect);
        add(
          event.card,
          discardRect,
          { ...start, scale: mine ? 0.9 : 0.4 },
          { ...end, scale: 1, opacity: 1 },
        );
      } else if (event.kind === "draw" || event.kind === "deal") {
        const to = seatRect(event.playerId);
        if (!to) continue;
        const end = centre(to);
        const mine = event.playerId === latest.current.me;
        const start = centre(drawRect);
        for (let i = 0; i < Math.min(event.count, 6); i++) {
          add(
            null,
            drawRect,
            { ...start, scale: 1 },
            { ...end, scale: mine ? 0.9 : 0.35, opacity: 0.2 },
          );
        }
      }
    }
    if (made.length === 0) return;

    setFlights((current) => [...current, ...made]);
    const keys = new Set(made.map((f) => f.key));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setFlights((current) => current.filter((f) => !keys.has(f.key)));
    }, GIVE_UP_MS);
    timers.current.add(timer);
  }, [cue, rootRef]);

  if (flights.length === 0) return null;
  return (
    <div className="ohno-fly" aria-hidden="true">
      {flights.map((f) => (
        <Flier key={f.key} flight={f} shapes={shapes} onDone={done} />
      ))}
    </div>
  );
}
