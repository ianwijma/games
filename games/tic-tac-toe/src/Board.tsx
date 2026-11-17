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
    <section className="mx-auto w-full max-w-sm space-y-4" aria-label="Tic-tac-toe">
      <div className="flex items-center justify-between text-sm">
        <span>
          You: <strong>{view.yourMark ?? "watching"}</strong>
        </span>
        {seconds !== null && (
          <span className={seconds <= 5 ? "font-semibold text-red-600 dark:text-red-400" : ""}>
            <span className="sr-only">Time left: </span>
            {seconds}s
          </span>
        )}
      </div>
      <p
        role="status"
        className={`rounded-lg px-3 py-2 text-center text-lg font-semibold ${
          view.winner !== null
            ? "bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200"
            : "bg-neutral-100 dark:bg-neutral-800"
        }`}
      >
        {status}
      </p>
      <div className="grid grid-cols-3 gap-2">
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
              className={`aspect-square rounded-xl border border-neutral-300 bg-white text-5xl font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 enabled:hover:bg-indigo-50 disabled:cursor-default dark:border-neutral-700 dark:bg-neutral-900 dark:enabled:hover:bg-neutral-800 ${
                mark === "X"
                  ? "text-indigo-600 dark:text-indigo-400"
                  : "text-rose-600 dark:text-rose-400"
              }`}
            >
              {mark}
            </button>
          );
        })}
      </div>
    </section>
  );
}
