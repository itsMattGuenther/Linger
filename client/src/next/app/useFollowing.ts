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
  started ??= followOwner(tauriBus());
  return started;
}

export type FollowingState = { kind: "waiting" } | { kind: "lost" } | { kind: "ready"; following: Following };

/**
 * A viewer window catching up with the list window's connection and following
 * it (core/mirror.ts): waiting, then ready, or lost if the list window never
 * answers.
 */
export function useFollowing(): FollowingState {
  const [held, setHeld] = useState<FollowingState>({ kind: "waiting" });
  useEffect(() => {
    let alive = true;
    followOnce().then(
      (following) => alive && setHeld({ kind: "ready", following }),
      () => alive && setHeld({ kind: "lost" }),
    );
    return () => {
      alive = false;
    };
  }, []);
  return held;
}
