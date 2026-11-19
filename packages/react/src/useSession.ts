"use client";
import type { Session, SessionSnapshot } from "@games/game";
import { useSyncExternalStore } from "react";

export function useSession<A, V, C>(session: Session<A, V, C>): SessionSnapshot<V, C> {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}
