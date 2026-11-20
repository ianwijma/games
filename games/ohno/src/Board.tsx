"use client";
import { CardBack, GameOver, type GameProps } from "@games/react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COLOR_SHAPE, COLOR_VAR, OhnoCard, type Shape, ShapeIcon } from "./Card";
import "./ohno.css";
import { Scoreboard } from "./Scoreboard";
import { useShapes } from "./shapes";
import { COLOR_NAMES, cardLabel, noteText, sortHand, type Who } from "./text";
import type { Action, Card, Color, Config, SeatView, View } from "./types";
import { COLORS } from "./types";
import { useArrivals } from "./useArrivals";
import { useCueFlights } from "./useCueFlights";

const SEAT_COLORS = ["var(--p1)", "var(--p2)", "var(--p3)", "var(--p4)"];
const SEAT_SHAPES: Shape[] = ["diamond", "triangle", "square", "circle"];

function useCountdown(deadline: number | null, serverNow: () => number) {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    if (deadline === null) return;
    setNow(serverNow());
    const timer = setInterval(() => setNow(serverNow()), 250);
    return () => clearInterval(timer);
  }, [deadline, serverNow]);
  return deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
}

function ColorChooser({
  title,
  hint,
  onPick,
  onCancel,
}: {
  title: string;
  hint?: string;
  onPick(color: Color): void;
  onCancel?: () => void;
}) {
  return (
    <section className="paper slip ohno-prompt" aria-label={title}>
      <h2>{title}</h2>
      {hint && <p className="muted">{hint}</p>}
      <div className="ohno-colors">
        {COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className="ohno-color-btn"
            style={{ "--ohno-pick": COLOR_VAR[color] } as CSSProperties}
            onClick={() => onPick(color)}
          >
            <ShapeIcon shape={COLOR_SHAPE[color]} />
            <span>{COLOR_NAMES[color]}</span>
          </button>
        ))}
      </div>
      {onCancel && (
        <button type="button" className="btn block" onClick={onCancel}>
          Cancel
        </button>
      )}
    </section>
  );
}

function Seat({
  seat,
  index,
  name,
  connected,
  isTurn,
  goalMode,
  onCatch,
}: {
  seat: SeatView;
  index: number;
  name: string;
  connected: boolean;
  isTurn: boolean;
  goalMode: "points" | "rounds";
  onCatch(): void;
}) {
  const fan = Math.min(seat.cards, 3);
  return (
    <li
      className="seat ohno-seat"
      data-ohno-anchor="seat"
      data-ohno-id={seat.id}
      aria-label={`${name}, ${seat.cards} ${seat.cards === 1 ? "card" : "cards"}${isTurn ? ", their turn" : ""}${connected ? "" : ", away"}`}
    >
      <div
        className={`token${isTurn ? " turn" : ""}${connected ? "" : " away"}`}
        style={{ "--c": SEAT_COLORS[index % SEAT_COLORS.length] } as CSSProperties}
        aria-hidden="true"
      >
        <span className="ohno-initial">{name.trim().charAt(0).toUpperCase() || "?"}</span>
        <ShapeIcon
          className="ohno-tshape"
          shape={SEAT_SHAPES[index % SEAT_SHAPES.length] ?? "circle"}
        />
      </div>
      <span className="tag">
        <span className="name">{name}</span>
      </span>
      <span className="ohno-hold" aria-hidden="true">
        <span className="ohno-fan">
          {Array.from({ length: fan }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: identical decorative backs
            <CardBack key={i} className="ohno-back" />
          ))}
        </span>
        <span className="ohno-count">{seat.cards}</span>
      </span>
      <span className="state">
        {goalMode === "points"
          ? `${seat.score} pts`
          : `${seat.wins} ${seat.wins === 1 ? "win" : "wins"}`}
      </span>
      {seat.called && <span className="state host">Oh no!</span>}
      {seat.catchable && (
        <button type="button" className="btn small ohno-catch" onClick={onCatch}>
          Catch
        </button>
      )}
    </li>
  );
}

export function Board({
  view,
  me,
  players,
  phase,
  isOwner,
  act,
  backToLobby,
  serverNow,
}: GameProps<Action, View, Config>) {
  const rootRef = useRef<HTMLElement>(null);
  const [shapes] = useShapes();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickingId, setPickingId] = useState<string | null>(null);
  const playing = phase === "playing" && view.phase === "playing";
  const seconds = useCountdown(playing ? view.deadline : null, serverNow);
  const flights = useCueFlights(rootRef, view.cue, me, shapes);
  const arrivals = useArrivals(view.cue, view.hand, me);

  const hand = useMemo(() => sortHand(view.hand), [view.hand]);
  const { can } = view;
  const myTurn = playing && me !== null && view.turn === me;
  const selected = hand.find((c) => c.id === selectedId) ?? null;
  const picking = hand.find((c) => c.id === pickingId) ?? null;

  useEffect(() => {
    if (selectedId !== null && !view.hand.some((c) => c.id === selectedId)) setSelectedId(null);
    if (pickingId !== null && !view.hand.some((c) => c.id === pickingId)) setPickingId(null);
  }, [view.hand, selectedId, pickingId]);

  const who = (id: string): Who => ({
    name: players.find((p) => p.id === id)?.name ?? "Player",
    you: id === me,
  });
  // With many players the row scrolls on a phone: keep the seat whose turn it is in sight.
  const seatsRef = useRef<HTMLUListElement>(null);
  const turnId = view.turn;
  useEffect(() => {
    const row = seatsRef.current;
    const seat = [...(row?.children ?? [])].find(
      (el) => (el as HTMLElement).dataset.ohnoId === turnId,
    );
    if (!row || !seat || row.scrollWidth <= row.clientWidth) return;
    const box = seat.getBoundingClientRect();
    const frame = row.getBoundingClientRect();
    const left = row.scrollLeft + box.left - frame.left - (frame.width - box.width) / 2;
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    row.scrollTo({ left, behavior: calm ? "auto" : "smooth" });
  }, [turnId]);

  const nameOf = (id: string) => who(id).name;
  const send = (action: Action) => {
    act(action).catch(() => {});
  };

  function play(card: Card) {
    if (card.color === null) {
      setPickingId(card.id);
      return;
    }
    setSelectedId(null);
    send({ type: "play", cardId: card.id });
  }

  function tap(card: Card) {
    if (selectedId !== card.id) {
      setSelectedId(card.id);
      return;
    }
    if (view.playable.includes(card.id)) play(card);
    else setSelectedId(null);
  }

  // ---- the status line ----
  let status: string;
  if (view.phase !== "playing") {
    status = noteText(view.note, who);
  } else if (view.pendingWild !== null) {
    status = can.chooseColor
      ? "Choose the colour to start with"
      : `${nameOf(view.pendingWild)} is choosing the colour to start with`;
  } else if (view.challenge !== null) {
    const { offenderId, targetId } = view.challenge;
    const offender = who(offenderId);
    status = `${offender.you ? "You play" : `${offender.name} plays`} a Wild +4. ${
      targetId === me ? "Draw four or challenge?" : `${nameOf(targetId)} is deciding.`
    }`;
  } else {
    const turn = who(view.turn);
    status = `${noteText(view.note, who)}. ${turn.you ? "Your turn" : `${turn.name}'s turn`}`;
  }

  // ---- which action gets the one brass button ----
  const playSelected =
    myTurn && selected !== null && view.playable.includes(selected.id) && !picking;
  const primary: "play" | "call" | "keep" | "draw" | null = playSelected
    ? "play"
    : can.call
      ? "call"
      : can.pass
        ? "keep"
        : can.draw && view.playable.length === 0
          ? "draw"
          : null;
  const cls = (which: typeof primary) => `btn${primary === which ? " primary" : ""}`;
  const drawLabel = view.pendingDraw > 0 && myTurn ? `Take ${view.pendingDraw}` : "Draw";
  const mySeat = view.seats.find((s) => s.id === me) ?? null;
  const opponents = view.seats.filter((s) => s.id !== me);
  const roundOver = view.phase === "round-over";
  const matchOver = phase === "ended" || view.phase === "match-over";
  const winner = view.winnerId;

  const scoreboard = (
    <Scoreboard seats={view.seats} goal={view.goal} me={me} winnerId={winner} nameOf={nameOf} />
  );

  if (matchOver) {
    const headline =
      winner === null
        ? "Match over"
        : winner === me
          ? "You win the match!"
          : `${nameOf(winner)} wins the match`;
    return (
      <section ref={rootRef} className="ohno" aria-label="Ohno!">
        {flights}
        <GameOver headline={headline} players={players} isOwner={isOwner} backToLobby={backToLobby}>
          {scoreboard}
        </GameOver>
      </section>
    );
  }

  // "Clockwise" means nothing on a screen where opponents sit in a row, so name who is next.
  const turnSeat = view.seats.findIndex((s) => s.id === view.turn);
  const nextSeat = view.seats[(turnSeat + view.direction + view.seats.length) % view.seats.length];
  const next = nextSeat ? (nextSeat.id === me ? "you" : nameOf(nextSeat.id)) : "";

  return (
    <section ref={rootRef} className="ohno" aria-label="Ohno!">
      {flights}

      <ul ref={seatsRef} className="ohno-seats" aria-label="Players">
        {opponents.map((seat) => (
          <Seat
            key={seat.id}
            seat={seat}
            index={view.seats.findIndex((s) => s.id === seat.id)}
            name={nameOf(seat.id)}
            connected={players.find((p) => p.id === seat.id)?.connected ?? true}
            isTurn={playing && view.turn === seat.id}
            goalMode={view.goal.mode}
            onCatch={() => send({ type: "catch", playerId: seat.id })}
          />
        ))}
      </ul>

      <div className="ohno-mid">
        <div className="ohno-piles">
          <button
            type="button"
            className={`ohno-pile ohno-draw${can.draw ? " ready" : ""}`}
            disabled={!can.draw}
            aria-label={`Draw pile, ${view.drawCount} ${view.drawCount === 1 ? "card" : "cards"}${can.draw ? ". Tap to draw" : ""}`}
            onClick={() => send({ type: "draw" })}
          >
            <span className="ohno-stack" aria-hidden="true">
              <CardBack className="ohno-back" />
              <CardBack className="ohno-back" />
              <CardBack className="ohno-back" />
              {/* Exactly where the top card lies: flights start from here, not from the whole pile. */}
              <span className="ohno-stack-top" data-ohno-anchor="draw" />
            </span>
            <span className="ohno-pile-count" aria-hidden="true">
              {view.drawCount}
            </span>
          </button>
          <div className="ohno-pile">
            <span className="ohno-top" data-ohno-anchor="discard">
              <OhnoCard card={view.top} shapes={shapes} />
            </span>
            <span className="ohno-pile-count">
              <span className="sr-only">Discard pile: </span>
              {view.discardCount}
            </span>
          </div>
        </div>
        <div className="ohno-info">
          <p className="pill ohno-colour">
            <ShapeIcon
              className="ohno-colour-shape"
              shape={COLOR_SHAPE[view.activeColor]}
              fill={COLOR_VAR[view.activeColor]}
              stroke="#fff"
            />
            <span>
              <span className="sr-only">Colour to match: </span>
              {COLOR_NAMES[view.activeColor]}
            </span>
          </p>
          <p className="pill ohno-dir">
            <span aria-hidden="true">{view.direction === 1 ? "↻" : "↺"}</span> Next: {next}
          </p>
          {view.pendingDraw > 0 && (
            <p className="pill warn ohno-stack-pill">+{view.pendingDraw} waiting</p>
          )}
          {seconds !== null && (
            <p className={seconds <= 5 ? "pill low" : "pill"}>
              <span className="sr-only">Time left: </span>
              {seconds}s
            </p>
          )}
        </div>
      </div>

      <p role="status" className={`pill ohno-status${myTurn ? " mine" : ""}`}>
        {status}
      </p>

      {roundOver && (
        <div className="paper slip ohno-prompt ohno-over">
          <h2>
            {winner === null
              ? "Round over"
              : winner === me
                ? "You win the round!"
                : `${nameOf(winner)} wins the round`}
          </h2>
          <p>
            {view.roundPoints} {view.roundPoints === 1 ? "point" : "points"} for the round
          </p>
          {scoreboard}
          {can.nextRound ? (
            <button
              type="button"
              className="btn primary block"
              onClick={() => send({ type: "nextRound" })}
            >
              Next round
            </button>
          ) : (
            <p className="muted">Waiting for the next round to be dealt.</p>
          )}
        </div>
      )}

      {playing && can.chooseColor && (
        <ColorChooser
          title="Choose the colour"
          hint="A Wild card opened the round. Everyone must match the colour you pick."
          onPick={(color) => send({ type: "color", color })}
        />
      )}

      {playing && can.answerChallenge && view.challenge && (
        <section className="paper slip ohno-prompt" aria-label="Answer the Wild +4">
          <h2>{nameOf(view.challenge.offenderId)} played a Wild +4</h2>
          <p className="muted">
            Challenge it: if the +4 was legal you draw six, if not they draw four.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn grow"
              onClick={() => send({ type: "challenge", challenge: false })}
            >
              Draw four
            </button>
            <button
              type="button"
              className="btn grow"
              onClick={() => send({ type: "challenge", challenge: true })}
            >
              Challenge
            </button>
          </div>
        </section>
      )}

      {picking && myTurn && (
        <ColorChooser
          title={`Pick a colour for your ${cardLabel(picking)}`}
          onPick={(color) => {
            setPickingId(null);
            setSelectedId(null);
            send({ type: "play", cardId: picking.id, color });
          }}
          onCancel={() => setPickingId(null)}
        />
      )}

      {me !== null && (
        <div className="ohno-mine">
          <div className="ohno-mine-head">
            <p className="felt-label">
              Your hand · {hand.length}
              <span className="sr-only"> {hand.length === 1 ? "card" : "cards"}</span>
            </p>
            {mySeat?.called && <span className="pill ohno-called">Oh no!</span>}
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: a fieldset cannot be a scrolling flex row */}
          <div className="ohno-hand" data-ohno-anchor="hand" role="group" aria-label="Your hand">
            {hand.map((card) => {
              const playable = myTurn && view.playable.includes(card.id);
              const isSelected = selectedId === card.id;
              const arrives = arrivals.get(card.id);
              return (
                <button
                  key={card.id}
                  type="button"
                  className={`ohno-hand-card${playable ? " playable" : ""}${
                    myTurn && !playable ? " dim" : ""
                  }${isSelected ? " selected" : ""}${view.drawnCardId === card.id ? " drawn" : ""}${
                    arrives === undefined ? "" : " arriving"
                  }`}
                  style={
                    arrives === undefined
                      ? undefined
                      : ({ "--ohno-arrive": `${arrives}ms` } as CSSProperties)
                  }
                  aria-pressed={isSelected}
                  aria-label={`${cardLabel(card)}${playable ? ", playable" : ""}${
                    view.drawnCardId === card.id ? ", just drawn" : ""
                  }`}
                  onClick={() => tap(card)}
                >
                  <OhnoCard card={card} shapes={shapes} decorative />
                </button>
              );
            })}
          </div>
          {/* Always there while playing, so the table does not jump when buttons come and go. */}
          {playing && (
            <div className="ohno-actions">
              {playSelected && selected && (
                <button type="button" className={cls("play")} onClick={() => play(selected)}>
                  Play {cardLabel(selected)}
                </button>
              )}
              {can.pass && (
                <button
                  type="button"
                  className={cls("keep")}
                  onClick={() => send({ type: "pass" })}
                >
                  Keep it
                </button>
              )}
              {can.draw && (
                <button
                  type="button"
                  className={cls("draw")}
                  onClick={() => send({ type: "draw" })}
                >
                  {drawLabel}
                </button>
              )}
              {can.call && (
                <button
                  type="button"
                  className={cls("call")}
                  onClick={() => send({ type: "call" })}
                >
                  Oh no!
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
