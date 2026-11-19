"use client";
import type { GameProps } from "@games/react";
import { useEffect, useState } from "react";
import type { Action, Config, View } from "./game";

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

export function Board({
  view,
  me,
  players,
  phase,
  act,
  serverNow,
}: GameProps<Action, View, Config>) {
  const seconds = useCountdown(phase === "playing" ? view.deadline : null, serverNow);
  const nameOf = (id: string) => players.find((p) => p.id === id)?.name ?? "Player";
  const current = view.order[view.turn];
  const myTurn = phase === "playing" && current === me;
  const marks = [view.order[0], view.order[1]];

  let status: string;
  if (view.winner === "draw") status = "It's a draw.";
  else if (view.winner !== null)
    status = view.winner === me ? "You win!" : `${nameOf(view.winner)} wins.`;
  else status = myTurn ? "Your turn" : `${nameOf(current)}'s turn`;

  return (
    <section className="mx-auto flex w-full max-w-sm flex-col gap-4" aria-label="Tic-tac-toe">
      <div className="flex items-center justify-between gap-2">
        <span className="pill">
          You: <strong>{view.yourMark ?? "watching"}</strong>
        </span>
        {seconds !== null && (
          <span className={seconds <= 5 ? "pill low" : "pill"}>
            <span className="sr-only">Time left: </span>
            {seconds}s
          </span>
        )}
      </div>
      <p role="status" className="pill text-lg">
        {status}
      </p>
      <div className="board">
        {view.board.map((owner, cell) => {
          const mark = owner === null ? "" : owner === marks[0] ? "X" : "O";
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: the board has a fixed set of cells
              key={cell}
              type="button"
              disabled={!myTurn || owner !== null}
              aria-label={`Row ${Math.floor(cell / 3) + 1}, column ${(cell % 3) + 1}: ${mark || "empty"}`}
              onClick={() => act({ type: "place", cell }).catch(() => {})}
              className={`cell ${mark === "X" ? "x" : mark === "O" ? "o" : "empty"}`}
            >
              {mark}
            </button>
          );
        })}
      </div>
    </section>
  );
}
