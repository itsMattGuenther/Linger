import { useEffect, useState } from "react";
import { tauriBus } from "../core/bus";
import { type Following, followOwner } from "../core/mirror";

/**
 * One follow per page. A viewer window lives as long as its page, and
 * following twice (React's StrictMode runs effects twice) would register the
 * same server twice in the store.
 */
let started: Promise<Following> | null = null;
function followOnce(): Promise<Following> {
  started ??= followOwner(tauriBus()).catch((error: unknown) => {
    // Not kept: the list window may only have been busy, and trying again
    // should ask it again.
    started = null;
    throw error;
  });
  return started;
}

export type FollowingState = { kind: "waiting" } | { kind: "lost"; retry: () => void } | { kind: "ready"; following: Following };

/**
 * A viewer window catching up with the list window's connection and following
 * it (core/mirror.ts): waiting, then ready, or lost if the list window never
 * answers, with a way to ask again.
 */
export function useFollowing(): FollowingState {
  const [attempt, setAttempt] = useState(0);
  const [held, setHeld] = useState<FollowingState>({ kind: "waiting" });
  useEffect(() => {
    let alive = true;
    const retry = () => {
      setHeld({ kind: "waiting" });
      setAttempt((count) => count + 1);
    };
    followOnce().then(
      (following) => alive && setHeld({ kind: "ready", following }),
      () => alive && setHeld({ kind: "lost", retry }),
    );
    return () => {
      alive = false;
    };
  }, [attempt]);
  return held;
}
