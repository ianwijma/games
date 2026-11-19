"use client";
import { GameError, type Session } from "@games/game";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { inviteLink } from "./code";
import type { GameModule } from "./types";
import { Button, cardClass } from "./ui";
import { useSession } from "./useSession";

// biome-ignore lint/suspicious/noExplicitAny: the shell is generic over every game
type AnySession = Session<any, any, any>;
// biome-ignore lint/suspicious/noExplicitAny: the shell is generic over every game
type AnyGame = GameModule<any, any, any, any>;

const messageOf = (error: unknown) =>
  error instanceof GameError || error instanceof Error ? error.message : "Something went wrong";

const closedText: Record<string, string> = {
  kicked: "You were removed from the game.",
  replaced: "This game was opened in another tab, so this one was disconnected.",
  "room-closed": "The room was closed.",
  left: "You left the game.",
  "resume-failed": "Could not get your seat back. The room may have expired.",
  error: "The connection failed.",
};

export function Closed({
  reason,
  message,
  onExit,
}: {
  reason: string;
  message?: string | undefined;
  onExit(): void;
}) {
  return (
    <div className={`${cardClass} narrow flex flex-col gap-3`} role="alert">
      <h1 className="text-xl">Disconnected</h1>
      <p>{closedText[reason] ?? message ?? "The game has ended."}</p>
      <Button variant="primary" onClick={onExit}>
        Back to start
      </Button>
    </div>
  );
}

function useCopy(text: string) {
  const [done, setDone] = useState(false);
  const copy = () => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      })
      .catch(() => {});
  };
  return [done, copy] as const;
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [done, copy] = useCopy(text);
  return (
    <Button onClick={copy} aria-live="polite">
      {done ? "Copied" : label}
    </Button>
  );
}

export function Room({
  game,
  session,
  onExit,
}: {
  game: AnyGame;
  session: AnySession;
  onExit(): void;
}) {
  const snap = useSession(session);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const showError = useCallback((error: unknown) => {
    setToast(messageOf(error));
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const act = useCallback(
    (action: unknown) =>
      session.act(action).catch((error: unknown) => {
        showError(error);
        throw error;
      }),
    [session, showError],
  );
  const backToLobby = useCallback(
    () =>
      session.backToLobby().catch((error: unknown) => {
        showError(error);
        throw error;
      }),
    [session, showError],
  );
  const quiet = (promise: Promise<void>) => promise.catch(showError);

  if (snap.closed) {
    return <Closed reason={snap.closed.reason} message={snap.closed.message} onExit={onExit} />;
  }
  if (snap.code === null || snap.phase === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <p role="status" className="pill">
          Connecting...
        </p>
        <Button onClick={onExit}>Cancel</Button>
      </div>
    );
  }

  const leave = () => {
    session.leave();
    onExit();
  };
  const away = snap.players.filter((p) => !p.connected && !p.isYou).map((p) => p.name);
  const you = snap.players.find((p) => p.isYou);
  const { minPlayers } = game.definition;

  return (
    <div className="flex flex-1 flex-col gap-4">
      {(snap.status === "reconnecting" || away.length > 0) && (
        <p role="status" className="pill warn self-center">
          {snap.status === "reconnecting"
            ? "Connection lost. Reconnecting..."
            : `${away.join(", ")} ${away.length === 1 ? "is" : "are"} disconnected`}
        </p>
      )}

      {snap.phase === "lobby" ? (
        <>
          <div className="flex flex-col items-center gap-3 text-center">
            <h1 className="felt-title">{game.title}</h1>
            <div className="plaque">
              <small>Invite code</small>
              <strong>{snap.code}</strong>
            </div>
            <div className="row center">
              <CopyButton label="Copy code" text={snap.code} />
              <CopyButton
                label="Copy link"
                text={
                  typeof location === "undefined" ? snap.code : inviteLink(location.href, snap.code)
                }
              />
            </div>
          </div>

          <div className="lobby">
            <section className="printed">
              <div className="felt-label mb-3">Players</div>
              <ul className="seats" aria-label="Players">
                {snap.players.map((p, i) => (
                  <li key={p.id} className="seat">
                    <div
                      className={`token${p.connected ? "" : " away"}`}
                      style={{ "--c": `var(--p${(i % 4) + 1})` } as CSSProperties}
                      aria-hidden="true"
                    >
                      {Array.from(p.name)[0]?.toUpperCase() ?? "?"}
                    </div>
                    <span
                      className="sr-only"
                      role="img"
                      aria-label={p.connected ? "connected" : "disconnected"}
                    />
                    <span className="tag">{p.name}</span>
                    {p.isYou && <Badge>you</Badge>}
                    {p.isOwner && <Badge>owner</Badge>}
                    <span className={`state${p.ready ? "" : " wait"}`}>
                      {p.ready ? "Ready" : "Not ready"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            {game.Settings && snap.config !== null && (
              <section className="paper slip">
                <fieldset className="flex flex-col gap-2" disabled={!snap.isOwner}>
                  <legend>Settings</legend>
                  <game.Settings
                    config={snap.config}
                    disabled={!snap.isOwner}
                    onChange={(config: unknown) => quiet(session.configure(config))}
                  />
                  {!snap.isOwner && <p className="muted">Only the owner can change settings.</p>}
                </fieldset>
              </section>
            )}
          </div>

          <p className="pill self-center" role="status">
            {snap.players.length < minPlayers
              ? `Waiting for ${minPlayers - snap.players.length} more player${minPlayers - snap.players.length === 1 ? "" : "s"} to join.`
              : snap.isOwner
                ? "You can start the game now."
                : "Waiting for the owner to start."}
          </p>

          <div className="row actions mt-auto">
            <Button variant="danger" onClick={leave}>
              Leave
            </Button>
            <span className="grow" />
            {you ? (
              <Button
                variant={!snap.isOwner && !you.ready ? "primary" : "secondary"}
                aria-pressed={you.ready}
                onClick={() => quiet(session.setReady(!you.ready))}
              >
                {you.ready ? "Not ready" : "I'm ready"}
              </Button>
            ) : (
              <p className="pill">The game is full; you are watching.</p>
            )}
            {snap.isOwner && (
              <Button
                variant="primary"
                disabled={snap.players.length < minPlayers}
                onClick={() => quiet(session.start())}
              >
                Start
              </Button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="stage flex flex-1 flex-col gap-4">
            <game.Board
              view={snap.view}
              me={snap.me}
              players={snap.players}
              config={snap.config}
              phase={snap.phase}
              isOwner={snap.isOwner}
              act={act}
              backToLobby={backToLobby}
              serverNow={session.serverNow}
            />
          </div>
          <div className="row actions center">
            {snap.phase === "ended" && !snap.isOwner && (
              <p className="pill">Waiting for the owner to return to the lobby.</p>
            )}
            <Button variant="danger" onClick={leave}>
              Leave
            </Button>
            {snap.phase === "ended" && snap.isOwner && (
              <Button variant="primary" onClick={() => quiet(session.backToLobby())}>
                Back to lobby
              </Button>
            )}
          </div>
        </>
      )}

      {toast && (
        <div role="alert" className="toast">
          <span className="flex-1">{toast}</span>
          <button type="button" className="btn small" onClick={() => setToast(null)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function Badge({ children }: { children: string }) {
  return <span className="tag">{children}</span>;
}
