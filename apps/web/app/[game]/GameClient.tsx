"use client";
import { type GameModule, GameShell } from "@games/react";
import { useEffect, useState } from "react";
import { findGame } from "../../src/games";
import { relayUrl } from "../../src/relay";

// biome-ignore lint/suspicious/noExplicitAny: generic over every game
type AnyModule = GameModule<any, any, any, any>;

const readHash = () => decodeURIComponent(location.hash.slice(1)) || null;

export function GameClient({ slug }: { slug: string }) {
  const [module, setModule] = useState<AnyModule | null>(null);
  // undefined until the hash has been read (it does not exist during prerendering)
  const [code, setCode] = useState<string | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setCode(readHash());
    let cancelled = false;
    findGame(slug)
      ?.load()
      .then((m) => !cancelled && setModule(m))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (failed) return <p role="alert">Could not load the game. Try reloading the page.</p>;
  if (!module || code === undefined) return <p role="status">Loading...</p>;
  return (
    <GameShell
      game={module}
      relayUrl={relayUrl}
      initialCode={code}
      onCodeChange={(next) => {
        const url = `${location.pathname}${location.search}${next ? `#${next}` : ""}`;
        history.replaceState(null, "", url);
      }}
    />
  );
}
