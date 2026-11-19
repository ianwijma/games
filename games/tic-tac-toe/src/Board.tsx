"use client";
import { GameOver, type GameProps } from "@games/react";
import type { CSSProperties } from "react";
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
  isOwner,
  act,
  backToLobby,
  serverNow,
}: GameProps<Action, View, Config>) {
  const seconds = useCountdown(phase === "playing" ? view.deadline : null, serverNow);
  const nameOf = (id: string) => players.find((p) => p.id === id)?.name ?? "Player";
  const current = view.order[view.turn];
  const myTurn = phase === "playing" && current === me;
  const over = view.winner !== null;
  const marks = [view.order[0], view.order[1]];
  const line = view.line ?? null;

  let status: string;
  if (view.winner === "draw") status = "It's a draw";
  else if (view.winner !== null)
    status = view.winner === me ? "You win!" : `${nameOf(view.winner)} wins`;
  else status = myTurn ? "Your turn" : `${nameOf(current)}'s turn`;

  return (
    <section className="mx-auto flex w-full max-w-sm flex-col gap-4" aria-label="Tic-tac-toe">
      <div className="seats">
        {marks.map((id, i) => {
          const mark = i === 0 ? "X" : "O";
          const player = players.find((p) => p.id === id);
          const active = !over && current === id;
          return (
            <div key={id} className="seat">
              <div
                className={`token${active ? " turn" : ""}${player && !player.connected ? " away" : ""}`}
                style={{ "--c": i === 0 ? "var(--p1)" : "var(--p2)" } as CSSProperties}
                aria-hidden="true"
              >
                {mark}
              </div>
              <span className="tag">
                <span className="name">{id === me ? "You" : nameOf(id)}</span>
                <span className="suffix"> · {mark}</span>
              </span>
              {active && seconds !== null && (
                <span className={seconds <= 5 ? "pill low" : "pill"}>
                  <span className="sr-only">Time left: </span>
                  {seconds}s
                </span>
              )}
            </div>
          );
        })}
      </div>
      {over ? (
        <GameOver headline={status} players={players} isOwner={isOwner} backToLobby={backToLobby} />
      ) : (
        <p role="status" className={`pill text-lg${myTurn ? " mine" : ""}`}>
          {status}
        </p>
      )}
      <div className={`board${line ? " over" : ""}`}>
        {view.board.map((owner, cell) => {
          const mark = owner === null ? "" : owner === marks[0] ? "X" : "O";
          const win = line?.includes(cell) ?? false;
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: the board has a fixed set of cells
              key={cell}
              type="button"
              disabled={!myTurn || owner !== null}
              aria-label={`Row ${Math.floor(cell / 3) + 1}, column ${(cell % 3) + 1}: ${mark || "empty"}`}
              onClick={() => act({ type: "place", cell }).catch(() => {})}
              className={`cell ${mark === "X" ? "x" : mark === "O" ? "o" : "empty"}${win ? " win" : ""}`}
            >
              {mark}
            </button>
          );
        })}
      </div>
    </section>
  );
}
