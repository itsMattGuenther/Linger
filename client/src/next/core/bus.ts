/**
 * How the Buddy list client's windows talk to each other
 * (docs/design/architecture.md): named events sent to one window by its
 * label, and a small request/answer on top with an id and a timeout.
 *
 * `Bus` is the seam. In the app it is Tauri's event system (`tauriBus`); in
 * tests it is an in-memory hub, so two windows can be run in one process and
 * every exchange checked without a desktop.
 */
import { emit, emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export interface Bus {
  /** This window's label: `main` for the owner (the list). */
  readonly label: string;
  /** Send an event to one window. */
  send(target: string, event: string, payload: unknown): Promise<void>;
  /** Send an event to every window, this one included. */
  broadcast(event: string, payload: unknown): Promise<void>;
  /** Receive events sent to this window (and those sent to every window). */
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
}

/** The owner window's label: the buddy list. */
export const OWNER = "main";

/** Bumped when a message's shape changes, so an old window can say so. */
export const PROTOCOL = 1;

export interface Envelope {
  v: number;
  id: string;
  from: string;
}

/** The bus as it is in the app. */
export function tauriBus(): Bus {
  const window = getCurrentWebviewWindow();
  return {
    label: window.label,
    send: (target, event, payload) => emitTo(target, event, payload),
    broadcast: (event, payload) => emit(event, payload),
    listen: <T>(event: string, handler: (payload: T) => void) => window.listen<T>(event, (message) => handler(message.payload)),
  };
}

/**
 * Ask another window something and wait for its answer. Rejects if nothing
 * answers in time, so a missing owner is a clear error rather than a hang
 * (lessons L-16: requests that never answer time out visibly).
 */
export async function ask<A>(bus: Bus, target: string, event: string, body: object, timeoutMs = 5_000): Promise<A> {
  const id = crypto.randomUUID();
  const held: { stop?: () => void; timer?: ReturnType<typeof setTimeout> } = {};
  try {
    return await new Promise<A>((resolve, reject) => {
      held.timer = setTimeout(() => reject(new Error(`no answer to ${event} from ${target}`)), timeoutMs);
      void bus
        .listen<Envelope & { answer: A }>(`${event}:answer`, (reply) => {
          if (reply.id === id) resolve(reply.answer);
        })
        .then((unlisten) => {
          held.stop = unlisten;
          const envelope: Envelope = { v: PROTOCOL, id, from: bus.label };
          return bus.send(target, event, { ...body, ...envelope });
        })
        .catch(reject);
    });
  } finally {
    clearTimeout(held.timer);
    held.stop?.();
  }
}

/**
 * Answer questions sent to this window. A question from a window speaking a
 * different protocol version is refused rather than half-understood.
 */
export function answer<Q, A>(bus: Bus, event: string, handler: (question: Q & Envelope) => Promise<A>): Promise<() => void> {
  return bus.listen<Q & Envelope>(event, (question) => {
    if (question.v !== PROTOCOL) return;
    void handler(question)
      .then((result) => bus.send(question.from, `${event}:answer`, { v: PROTOCOL, id: question.id, from: bus.label, answer: result }))
      .catch(() => undefined);
  });
}
