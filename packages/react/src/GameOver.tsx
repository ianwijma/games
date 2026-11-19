import type { SessionPlayer } from "@games/game";
import type { ReactNode } from "react";
import { Button } from "./ui";

/**
 * The end-of-game slip: a headline, optional detail (scores, say), then the way back. The owner
 * gets the brass "Back to lobby" button; everyone else is told who they are waiting for.
 */
export function GameOver({
  headline,
  players,
  isOwner,
  backToLobby,
  children,
}: {
  headline: string;
  players: SessionPlayer[];
  isOwner: boolean;
  backToLobby(): Promise<void>;
  children?: ReactNode;
}) {
  const ownerName = players.find((p) => p.isOwner)?.name ?? "the owner";
  return (
    <div className="paper slip result">
      <h2 role="status">{headline}</h2>
      {children}
      {isOwner ? (
        <Button variant="primary" className="w-full" onClick={() => backToLobby().catch(() => {})}>
          Back to lobby
        </Button>
      ) : (
        <p className="muted">Waiting for {ownerName} to return to the lobby.</p>
      )}
    </div>
  );
}
