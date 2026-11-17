"use client";
import { GameError, type Session } from "@games/game";
import { useCallback, useEffect, useRef, useState } from "react";
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
    <div className={`mx-auto w-full max-w-md space-y-4 ${cardClass}`} role="alert">
      <h1 className="text-xl font-semibold">Disconnected</h1>
      <p className="text-sm">{closedText[reason] ?? message ?? "The game has ended."}</p>
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
      <div className="mx-auto max-w-md space-y-4 text-center">
        <p role="status">Connecting...</p>
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
    <div className="mx-auto w-full max-w-2xl space-y-4">
      {(snap.status === "reconnecting" || away.length > 0) && (
        <div
          role="status"
          className="rounded-lg bg-amber-100 px-3 py-1.5 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {snap.status === "reconnecting"
            ? "Connection lost. Reconnecting..."
            : `${away.join(", ")} ${away.length === 1 ? "is" : "are"} disconnected`}
        </div>
      )}

      {snap.phase === "lobby" ? (
        <div className={`space-y-5 ${cardClass}`}>
          <div className="text-center">
            <h1 className="text-lg font-semibold">{game.title}</h1>
            <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">Invite code</p>
            <p className="font-mono text-4xl font-bold tracking-[0.25em] sm:text-5xl">
              {snap.code}
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <CopyButton label="Copy code" text={snap.code} />
              <CopyButton
                label="Copy link"
                text={
                  typeof location === "undefined" ? snap.code : inviteLink(location.href, snap.code)
                }
              />
            </div>
          </div>

          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800" aria-label="Players">
            {snap.players.map((p) => (
              <li key={p.id} className="flex items-center gap-2 py-2">
                <span
                  className={`size-2.5 shrink-0 rounded-full ${p.connected ? "bg-green-500" : "bg-neutral-400"}`}
                  role="img"
                  aria-label={p.connected ? "connected" : "disconnected"}
                />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {p.isYou && <Badge>you</Badge>}
                {p.isOwner && <Badge>owner</Badge>}
                <span
                  className={`text-sm ${p.ready ? "text-green-700 dark:text-green-400" : "text-neutral-500"}`}
                >
                  {p.ready ? "Ready" : "Not ready"}
                </span>
              </li>
            ))}
          </ul>

          {game.Settings && snap.config !== null && (
            <fieldset className="space-y-2" disabled={!snap.isOwner}>
              <legend className="mb-1 text-sm font-medium">Settings</legend>
              <game.Settings
                config={snap.config}
                disabled={!snap.isOwner}
                onChange={(config: unknown) => quiet(session.configure(config))}
              />
              {!snap.isOwner && (
                <p className="text-xs text-neutral-500">Only the owner can change settings.</p>
              )}
            </fieldset>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {you ? (
              <Button
                variant={you.ready ? "secondary" : "primary"}
                aria-pressed={you.ready}
                onClick={() => quiet(session.setReady(!you.ready))}
              >
                {you.ready ? "Not ready" : "I'm ready"}
              </Button>
            ) : (
              <p className="text-sm text-neutral-500">The game is full; you are watching.</p>
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
            <Button variant="danger" className="ml-auto" onClick={leave}>
              Leave
            </Button>
          </div>
          <p className="text-sm text-neutral-600 dark:text-neutral-400" role="status">
            {snap.players.length < minPlayers
              ? `Waiting for ${minPlayers - snap.players.length} more player${minPlayers - snap.players.length === 1 ? "" : "s"} to join.`
              : snap.isOwner
                ? "You can start the game now."
                : "Waiting for the owner to start."}
          </p>
        </div>
      ) : (
        <>
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
          <div className="flex flex-wrap items-center justify-center gap-2">
            {snap.phase === "ended" && snap.isOwner && (
              <Button variant="primary" onClick={() => quiet(session.backToLobby())}>
                Back to lobby
              </Button>
            )}
            {snap.phase === "ended" && !snap.isOwner && (
              <p className="text-sm text-neutral-500">
                Waiting for the owner to return to the lobby.
              </p>
            )}
            <Button variant="danger" onClick={leave}>
              Leave
            </Button>
          </div>
        </>
      )}

      {toast && (
        <div
          role="alert"
          className="fixed inset-x-4 bottom-4 z-10 mx-auto flex max-w-sm items-center gap-3 rounded-lg bg-neutral-900 px-4 py-3 text-sm text-white shadow-lg dark:bg-neutral-100 dark:text-neutral-900"
        >
          <span className="flex-1">{toast}</span>
          <button
            type="button"
            className="rounded px-2 py-1 underline focus-visible:outline-2 focus-visible:outline-indigo-400"
            onClick={() => setToast(null)}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function Badge({ children }: { children: string }) {
  return (
    <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
      {children}
    </span>
  );
}
