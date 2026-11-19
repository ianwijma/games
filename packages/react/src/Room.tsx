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
      <Button variant="primary" onClick={() => onExit()}>
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
    <Button size="small" onClick={copy} aria-live="polite">
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
  onExit(left?: boolean): void;
}) {
  const snap = useSession(session);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
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
        <Button onClick={() => onExit()}>Cancel</Button>
      </div>
    );
  }

  const leave = () => {
    session.leave();
    onExit(true);
  };
  const away = snap.players.filter((p) => !p.connected && !p.isYou).map((p) => p.name);
  const you = snap.players.find((p) => p.isYou);
  const owner = snap.players.find((p) => p.isOwner);
  const ownerName = owner?.name ?? "the owner";
  const { minPlayers, maxPlayers } = game.definition;
  const reconnecting = snap.status === "reconnecting";
  const guests = snap.players.filter((p) => !p.isOwner);
  const readyCount = guests.filter((p) => p.ready).length;
  const needed = minPlayers - snap.players.length;

  let lobbyStatus: string;
  if (needed > 0) {
    lobbyStatus =
      needed === 1 ? "Waiting for another player" : `Waiting for ${needed} more players`;
  } else if (snap.isOwner) {
    const waiting = guests.filter((p) => !p.ready);
    lobbyStatus =
      waiting.length === 0
        ? "Everyone's ready"
        : waiting.length === 1 && guests.length === 1
          ? `${waiting[0]?.name} isn't ready yet`
          : `${readyCount} of ${guests.length} ready`;
  } else if (you) {
    lobbyStatus = you.ready ? `Ready · waiting for ${ownerName}` : `Tell ${ownerName} you're ready`;
  } else {
    lobbyStatus = `Waiting for ${ownerName} to start`;
  }
  const openSeats = Math.max(0, Math.min(maxPlayers, 6) - snap.players.length);

  return (
    <div className="relative flex flex-1 flex-col gap-3">
      {(reconnecting || away.length > 0) && (
        <div className="notice-slot">
          <p role="status" className="pill warn">
            {reconnecting ? "Reconnecting…" : `${away.join(", ")} disconnected`}
          </p>
        </div>
      )}

      {snap.phase === "lobby" ? (
        <>
          <div className="flex flex-col items-center gap-2 text-center">
            <h1 className="felt-label nowrap">{game.title} · lobby</h1>
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
              {/* biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics when list-style is none */}
              <ul className="seats" role="list" aria-label="Players">
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
                    <span className="tag">
                      <span className="name">{p.name}</span>
                      {(p.isYou || !p.connected) && (
                        <span className="suffix">
                          {p.isYou ? " · you" : ""}
                          {p.connected ? "" : " · away"}
                        </span>
                      )}
                    </span>
                    {p.isOwner ? (
                      <span className="state host">Host</span>
                    ) : (
                      <span className={`state${p.ready ? "" : " wait"}`}>
                        {p.ready ? "✓ Ready" : "Not ready"}
                      </span>
                    )}
                  </li>
                ))}
                {Array.from({ length: openSeats }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: open seats are interchangeable
                  <li key={`open-${i}`} className="seat" aria-hidden="true">
                    <div className="token empty">+</div>
                    <span className="tag">Open</span>
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
                  {!snap.isOwner && <p className="muted">Only {ownerName} can change these.</p>}
                </fieldset>
              </section>
            )}
          </div>

          <p className="pill self-center" role="status">
            {lobbyStatus}
          </p>

          <div className="row actions sticky-bar mt-auto">
            <Button variant="danger" onClick={leave}>
              Leave
            </Button>
            <span className="grow" />
            {you && !snap.isOwner && (
              <Button
                variant={you.ready ? "secondary" : "primary"}
                aria-pressed={you.ready}
                onClick={() => quiet(session.setReady(!you.ready))}
              >
                {you.ready ? "Undo ready" : "I'm ready"}
              </Button>
            )}
            {!you && <p className="pill">The game is full; you are watching.</p>}
            {snap.isOwner && (
              <Button
                variant="primary"
                disabled={needed > 0}
                onClick={() => quiet(session.start())}
              >
                {needed > 0 ? `Start (needs ${minPlayers} players)` : "Start"}
              </Button>
            )}
          </div>
        </>
      ) : (
        <>
          <div
            className={`stage flex flex-1 flex-col justify-center gap-4${reconnecting ? " dimmed" : ""}`}
            inert={reconnecting}
          >
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
            {confirmLeave && snap.phase === "playing" ? (
              <>
                <span className="pill">Leave the game?</span>
                <Button onClick={() => setConfirmLeave(false)}>Stay</Button>
                <Button variant="danger" onClick={leave}>
                  Leave
                </Button>
              </>
            ) : (
              <Button
                variant="danger"
                onClick={() => (snap.phase === "playing" ? setConfirmLeave(true) : leave())}
              >
                Leave
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
