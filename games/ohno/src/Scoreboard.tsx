import { goalText } from "./text";
import type { Goal, SeatView } from "./types";

/** Score and round wins for every seat, best score first. Lives on paper. */
export function Scoreboard({
  seats,
  goal,
  me,
  winnerId,
  nameOf,
}: {
  seats: SeatView[];
  goal: Goal;
  me: string | null;
  winnerId: string | null;
  nameOf(id: string): string;
}) {
  const rows = [...seats].sort((a, b) => b.score - a.score || b.wins - a.wins);
  return (
    <table className="ohno-score">
      <caption>{goalText(goal)}</caption>
      <thead>
        <tr>
          <th scope="col">Player</th>
          <th scope="col">Score</th>
          <th scope="col">Round wins</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((seat) => (
          <tr key={seat.id} className={seat.id === winnerId ? "ohno-score-win" : undefined}>
            <th scope="row">
              {seat.id === me ? "You" : nameOf(seat.id)}
              {seat.id === winnerId && <span className="sr-only"> (winner)</span>}
            </th>
            <td>{seat.score}</td>
            <td>{seat.wins}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
