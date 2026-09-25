/**
 * Test support: an in-memory stand-in for Tauri's event system, so several
 * windows can run in one process. Imported only by tests; never shipped.
 */
import type { Bus } from "./bus";

/**
 * An in-memory bus for tests: every window created from one hub can send to
 * the others by label, in order, as Tauri delivers events.
 */
export function memoryHub() {
  const windows = new Map<string, Map<string, Set<(payload: unknown) => void>>>();
  const deliver = (target: string, event: string, payload: unknown) => {
    const handlers = windows.get(target)?.get(event);
    // A copy, so JSON-shaped data crosses windows the way Tauri serializes it.
    for (const handler of [...(handlers ?? [])]) handler(structuredClone(payload));
  };
  return {
    bus(label: string): Bus {
      const events = new Map<string, Set<(payload: unknown) => void>>();
      windows.set(label, events);
      return {
        label,
        async send(target, event, payload) {
          await Promise.resolve();
          deliver(target, event, payload);
        },
        async broadcast(event, payload) {
          await Promise.resolve();
          for (const target of windows.keys()) deliver(target, event, payload);
        },
        async listen(event, handler) {
          const set = events.get(event) ?? new Set();
          events.set(event, set);
          const wrapped = handler as (payload: unknown) => void;
          set.add(wrapped);
          return () => set.delete(wrapped);
        },
      };
    },
    /** What the Rust core does with `app.emit`: every window gets it. */
    broadcast(event: string, payload: unknown): void {
      for (const label of windows.keys()) deliver(label, event, payload);
    },
  };
}
