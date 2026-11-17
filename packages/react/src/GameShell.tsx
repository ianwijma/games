"use client";
import { createSession, type Session } from "@games/game";
import { browserStorage, localTransport, webSocketTransport } from "@games/net";
import { Hub } from "@games/relay-core";
import { useEffect, useRef, useState } from "react";
import { parseCode } from "./code";
import { Entry } from "./Entry";
import { Room } from "./Room";
import type { GameModule } from "./types";

type Op =
  | { kind: "create" }
  | { kind: "join"; code: string }
  /** Resume if a seat is stored for the code, otherwise show the join form with the code filled in. */
  | { kind: "auto"; code: string }
  | { kind: "local" };

interface Run {
  id: number;
  name: string;
  op: Op;
}

export interface GameShellProps {
  // biome-ignore lint/suspicious/noExplicitAny: the shell is generic over every game
  game: GameModule<any, any, any, any>;
  /** WebSocket URL of the relay; null leaves only "Play on this device". */
  relayUrl: string | null;
  initialCode?: string | null | undefined;
  onCodeChange?(code: string | null): void;
}

export function GameShell({ game, relayUrl, initialCode, onCodeChange }: GameShellProps) {
  const initial = initialCode ? parseCode(initialCode) : null;
  const [run, setRun] = useState<Run | null>(() =>
    initial && relayUrl ? { id: 0, name: "", op: { kind: "auto", code: initial } } : null,
  );
  const [prefill, setPrefill] = useState(initialCode ?? "");
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(1);

  const start = (name: string, op: Op) => {
    setError(null);
    setRun({ id: nextId.current++, name, op });
  };
  const exit = (message?: string, code?: string) => {
    setRun(null);
    setError(message ?? null);
    if (code) setPrefill(code);
  };

  if (run) {
    return (
      <Active
        key={run.id}
        game={game}
        relayUrl={relayUrl}
        run={run}
        onExit={exit}
        {...(onCodeChange && { onCodeChange })}
      />
    );
  }
  return (
    <Entry
      title={game.title}
      description={game.description}
      online={relayUrl !== null}
      solo={game.definition.minPlayers === 1}
      prefillCode={prefill}
      error={error}
      onCreate={(name) => start(name, { kind: "create" })}
      onJoin={(name, code) => start(name, { kind: "join", code })}
      onLocal={(name) => start(name, { kind: "local" })}
    />
  );
}

/** Owns exactly one session, created when it mounts and destroyed when it unmounts. */
function Active({
  game,
  relayUrl,
  run,
  onExit,
  onCodeChange,
}: {
  game: GameShellProps["game"];
  relayUrl: string | null;
  run: Run;
  onExit(message?: string, code?: string): void;
  onCodeChange?(code: string | null): void;
}) {
  // biome-ignore lint/suspicious/noExplicitAny: the shell is generic over every game
  const [session, setSession] = useState<Session<any, any, any> | null>(null);
  const latest = useRef({ onExit, onCodeChange });
  latest.current = { onExit, onCodeChange };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `run` never changes for a mounted Active (it is keyed by run.id); the session must be created once
  useEffect(() => {
    const local = run.op.kind === "local";
    const s = createSession(game.definition, {
      transport:
        local || relayUrl === null ? localTransport(new Hub()) : webSocketTransport(relayUrl),
      ...(!local && { storage: browserStorage() }),
    });
    setSession(s);

    // Deferred so React 19 StrictMode's mount/unmount/mount never reaches the relay twice.
    let cancelled = false;
    const timer = setTimeout(() => {
      const { op, name } = run;
      let started: Promise<unknown>;
      if (op.kind === "auto") {
        if (!s.hasSeat(op.code)) return latest.current.onExit(undefined, op.code);
        started = s.resume(op.code);
      } else if (op.kind === "join") started = s.join(op.code, { name });
      else started = s.create({ name });
      started.catch((error: unknown) => {
        if (cancelled) return;
        const code = op.kind === "create" || op.kind === "local" ? undefined : op.code;
        const message = error instanceof Error ? error.message : "Could not connect";
        latest.current.onExit(message, code);
      });
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      s.destroy();
    };
  }, []);

  const code = useSyncCode(session);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `run` is constant for a mounted Active
  useEffect(() => {
    if (!code || run.op.kind === "local") return;
    latest.current.onCodeChange?.(code);
    return () => latest.current.onCodeChange?.(null);
  }, [code]);

  if (!session) return null;
  return <Room game={game} session={session} onExit={() => onExit()} />;
}

/** The room code of a session, as state, without calling useSession on a null session. */
// biome-ignore lint/suspicious/noExplicitAny: generic over every game
function useSyncCode(session: Session<any, any, any> | null): string | null {
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    if (!session) return;
    const update = () => setCode(session.getSnapshot().code);
    update();
    return session.subscribe(update);
  }, [session]);
  return code;
}
