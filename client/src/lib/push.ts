/**
 * Phone notifications, the page's side (#830, SPEC §4.15, PROTOCOL §5
 * "Phone notifications").
 *
 * Per server, this phone keeps whether it's on and what it wants: the kinds
 * and the rooms. Turning it on asks the phone once for permission, gets the
 * push address from Apple or Google (the shell's `push_address`), has the
 * relay the server names seal it (`pushRelay.ts`), makes this phone's keys
 * for that server (`push_keys`), and registers all of it with the server.
 * "Nothing" turns it off: the server and the phone forget it, and the phone
 * keeps the choices for next time.
 *
 * The server keeps the real state; what's kept here is so the screen can
 * show it without asking, and so the phone can register again on every
 * start, which carries a new push address and brings back one the relay
 * said was gone. Kept on this device only, and never anything secret: the
 * keys are the shell's, and the push address is never kept at all.
 */
import { invoke } from "@tauri-apps/api/core";

import type { PushDevice } from "../generated/PushDevice";
import type { PushRoomChoice } from "../generated/PushRoomChoice";
import type { PushService } from "../generated/PushService";
import type { PushSettings } from "../generated/PushSettings";
import type { RegisterPushDeviceRequest } from "../generated/RegisterPushDeviceRequest";
import type { RoomId } from "../generated/RoomId";
import type { ServerInfo } from "../generated/ServerInfo";
import { ApiError, type AuthedApi } from "./api";
import { sealAddress } from "./pushRelay";

/** What this phone wants from one server. */
export interface PhonePush {
  on: boolean;
  settings: PushSettings;
  /** The server's id for this phone, once registered. */
  device: string | null;
}

/**
 * Whether a server can notify phones: `old`, from before (#830), `off`, its
 * host turned it off, or `on`. `unknown` until its info has come.
 */
export type PushSupport = "unknown" | "old" | "off" | "on";

export function pushSupport(info: Pick<ServerInfo, "push" | "push_relay"> | null | undefined): PushSupport {
  if (info === null || info === undefined) return "unknown";
  if (info.push === undefined) return "old";
  if (!info.push || typeof info.push_relay !== "string") return "off";
  return "on";
}

/** What somebody gets the first time they say yes: everything addressed to them, no rooms (#830, decision 3). */
export const FIRST_SETTINGS: PushSettings = { mentions: true, dms: true, knocks: true, follows: true, rooms: [] };

/** "Only when somebody mentions me": one tap. */
export function onlyMentions(settings: PushSettings): PushSettings {
  return { ...settings, mentions: true, dms: false, knocks: false, follows: false, rooms: [] };
}

export function isOnlyMentions(settings: PushSettings): boolean {
  return settings.mentions && !settings.dms && !settings.knocks && !settings.follows && settings.rooms.length === 0;
}

/** A room's choice on this phone: `null` is off. */
export function roomChoice(settings: PushSettings, room: RoomId): PushRoomChoice | null {
  return settings.rooms.find((each) => each.room_id === room)?.choice ?? null;
}

export function withRoom(settings: PushSettings, room: RoomId, choice: PushRoomChoice | null): PushSettings {
  const others = settings.rooms.filter((each) => each.room_id !== room);
  return { ...settings, rooms: choice === null ? others : [...others, { room_id: room, choice }] };
}

// ---------------------------------------------------------------------------
// What's kept, per server
// ---------------------------------------------------------------------------

const KEY = "linger.push.v1";
let held: Record<string, PhonePush> = load();
const listeners = new Set<() => void>();

function load(): Record<string, PhonePush> {
  try {
    const text = globalThis.localStorage?.getItem(KEY);
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, PhonePush> = {};
    for (const [server, value] of Object.entries(parsed)) {
      const kept = keptPush(value);
      if (kept) out[server] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

function keptPush(value: unknown): PhonePush | null {
  if (typeof value !== "object" || value === null) return null;
  const on: unknown = Reflect.get(value, "on");
  const device: unknown = Reflect.get(value, "device");
  const settings: unknown = Reflect.get(value, "settings");
  if (typeof on !== "boolean" || (device !== null && typeof device !== "string")) return null;
  if (typeof settings !== "object" || settings === null) return null;
  const flag = (name: string): boolean | null => {
    const got: unknown = Reflect.get(settings, name);
    return typeof got === "boolean" ? got : null;
  };
  const rooms: unknown = Reflect.get(settings, "rooms");
  const [mentions, dms, knocks, follows] = [flag("mentions"), flag("dms"), flag("knocks"), flag("follows")];
  if (mentions === null || dms === null || knocks === null || follows === null || !Array.isArray(rooms)) return null;
  const kept: PushSettings["rooms"] = [];
  for (const room of rooms) {
    if (typeof room !== "object" || room === null) continue;
    const id: unknown = Reflect.get(room, "room_id");
    const choice: unknown = Reflect.get(room, "choice");
    if (typeof id === "string" && (choice === "wakes" || choice === "every")) kept.push({ room_id: id, choice });
  }
  return { on, device, settings: { mentions, dms, knocks, follows, rooms: kept } };
}

function keep(server: string, next: PhonePush | null): void {
  const copy = { ...held };
  if (next === null) delete copy[server];
  else copy[server] = next;
  held = copy;
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(held));
  } catch {
    // Storage refused: it's only so the screen can show it without asking.
  }
  for (const listener of [...listeners]) listener();
}

/** Off, with the first-time settings: one object, so a screen showing it can tell nothing changed. */
const OFF: PhonePush = Object.freeze({ on: false, settings: FIRST_SETTINGS, device: null });

/** What this phone wants from `server`, `OFF` when nothing is kept. The same object until it changes. */
export function phonePush(server: string): PhonePush {
  return held[server] ?? OFF;
}

/** Every server's, as kept: the same object until one changes, for a screen to redraw by. */
export function allPhonePush(): Readonly<Record<string, PhonePush>> {
  return held;
}

/** Hear when any server's changes. Answers how to stop. */
export function onPhonePush(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For tests: start from nothing. */
export function resetPhonePush(): void {
  held = {};
  listeners.clear();
  turn = Promise.resolve();
}

// ---------------------------------------------------------------------------
// The phone (src-tauri/src/phone_push.rs)
// ---------------------------------------------------------------------------

export interface PushTarget {
  server: string;
  room: string | null;
  message: string | null;
}

/** What the page asks of the phone. Tests hand in a stand-in. */
export interface PushPhone {
  /** `granted`, `denied`, `ask` (not asked yet), or `asking` (asked now). */
  permission(ask: boolean): Promise<string>;
  address(): Promise<{ service: PushService; address: string }>;
  keys(server: string): Promise<{ public_key: string; auth_secret: string }>;
  forget(server: string): Promise<void>;
  opened(): Promise<PushTarget | null>;
}

export const tauriPhone: PushPhone = {
  permission: (ask) => invoke("push_permission", { ask }),
  address: () => invoke("push_address"),
  keys: (server) => invoke("push_keys", { server }),
  forget: (server) => invoke("push_forget", { server }),
  opened: () => invoke("push_opened"),
};

/** The phone's answer to the permission ask, as it arrives on Android (MainActivity). */
export const PERMISSION_EVENT = "linger:push-permission";
/** A tapped notification, on Android (MainActivity): ask the phone which (`opened`). */
export const OPENED_EVENT = "linger:push-opened";

/**
 * Ask once, and wait for the answer: on Android it comes as an event from
 * the phone's own dialog; on an iPhone the shell waits for it. A minute is
 * long enough to read the dialog, and no answer reads as no.
 */
async function permitted(phone: PushPhone, events: EventTarget | null): Promise<boolean> {
  const now = await phone.permission(false);
  if (now === "granted") return true;
  if (now === "denied") return false;
  const answered =
    events === null
      ? null
      : new Promise<string>((resolve) => {
          const done = (state: string) => {
            events.removeEventListener(PERMISSION_EVENT, heard);
            clearTimeout(timer);
            resolve(state);
          };
          const heard = (event: Event) => done(event instanceof CustomEvent && typeof event.detail === "string" ? event.detail : "denied");
          const timer = setTimeout(() => done("denied"), 60_000);
          events.addEventListener(PERMISSION_EVENT, heard);
        });
  const asked = await phone.permission(true);
  if (asked === "granted") return true;
  if (asked !== "asking" || answered === null) return false;
  return (await answered) === "granted";
}

/**
 * Every change, one at a time, in the order they were asked for, across
 * all servers. Turning off while turning on still waits on the relay would
 * otherwise finish first, and the turning on would then register a phone
 * whose keys the turning off had just deleted. And the servers share one
 * thing: the phone's push address, which forgetting the last server's keys
 * deletes. Turning one server off while another is registering could
 * delete the address that one was about to hand its server (#894 review).
 * So the last thing asked is what's true at the end, and nothing the phone
 * holds changes under a registration.
 */
let turn: Promise<unknown> = Promise.resolve();

function inTurn<T>(job: () => Promise<T>): Promise<T> {
  const mine = turn.then(job, job);
  turn = mine.catch(() => undefined);
  return mine;
}

/** An error, in the words a person can act on. */
function words(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Something went wrong. Try again.";
}

const DENIED =
  "Your phone isn't letting Linger show notifications. Turn them on for Linger in the phone's own settings, then here.";

/**
 * Register this phone with `server`, as `settings` say: everything a phone
 * hands over, fresh (PROTOCOL §5). Asking again from the same sign-in
 * replaces what it registered before. Answers a problem in words, or null.
 */
async function register(
  api: AuthedApi,
  server: string,
  relay: string,
  settings: PushSettings,
  phone: PushPhone,
): Promise<string | null> {
  try {
    const { service, address } = await phone.address();
    const sealed = await sealAddress(relay, service, address);
    const keys = await phone.keys(server);
    const ask = (): Promise<PushDevice> => {
      const request: RegisterPushDeviceRequest = {
        refresh_token: api.refreshToken,
        sealed_token: sealed,
        public_key: keys.public_key,
        auth_secret: keys.auth_secret,
        settings,
      };
      return api.post<PushDevice>("/push/devices", request);
    };
    // The sign-in's refresh token may be renewed while this was on its
    // way, and the old one is no longer a live sign-in: once more, with the
    // new one.
    const device = await ask().catch(async (error: unknown) => {
      if (error instanceof ApiError && error.code === "VALIDATION_FAILED" && /refresh token/i.test(error.message)) return ask();
      throw error;
    });
    keep(server, { on: true, settings: device.settings, device: device.id });
    return null;
  } catch (error) {
    return words(error);
  }
}

/**
 * Turn notifications on for `server`, asking the phone once if it hasn't
 * been asked. Starts from what was chosen before, or the first-time
 * settings. Answers a problem in words, or null.
 */
export async function turnOn(
  api: AuthedApi,
  server: string,
  info: Pick<ServerInfo, "push" | "push_relay">,
  phone: PushPhone = tauriPhone,
  events: EventTarget | null = globalThis.window ?? null,
): Promise<string | null> {
  const support = pushSupport(info);
  if (support === "old") return "This server needs an update before it can notify your phone.";
  const relay = info.push_relay;
  if (support !== "on" || typeof relay !== "string") return "This server's host turned phone notifications off.";
  return inTurn(async () => {
    if (!(await permitted(phone, events))) return DENIED;
    const problem = await register(api, server, relay, phonePush(server).settings, phone);
    // Not on after all: the keys made for it go, and with no server left,
    // the push address too (#894 review).
    if (problem !== null && !phonePush(server).on) await phone.forget(server).catch(() => undefined);
    return problem;
  });
}

/**
 * Change `server`'s choices with `edit`, applied to the choices as they are
 * when its turn comes, so two quick taps keep both: built from what the
 * screen showed, the second would undo the first (#894 review). Off,
 * they're kept for when it's turned on; on, the server is told, and a
 * phone it has forgotten registers again. Answers a problem in words, or
 * null.
 */
export function change(
  api: AuthedApi,
  server: string,
  info: Pick<ServerInfo, "push" | "push_relay">,
  edit: (now: PushSettings) => PushSettings,
  phone: PushPhone = tauriPhone,
): Promise<string | null> {
  return inTurn(() => changeNow(api, server, info, edit(phonePush(server).settings), phone));
}

async function changeNow(
  api: AuthedApi,
  server: string,
  info: Pick<ServerInfo, "push" | "push_relay">,
  settings: PushSettings,
  phone: PushPhone,
): Promise<string | null> {
  const now = phonePush(server);
  if (!now.on) {
    keep(server, { ...now, settings });
    return null;
  }
  if (now.device !== null) {
    try {
      const device = await api.patch<PushDevice>(`/push/devices/${now.device}`, { settings });
      keep(server, { on: true, settings: device.settings, device: device.id });
      return null;
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "NOT_FOUND")) return words(error);
    }
  }
  if (typeof info.push_relay !== "string") return "This server's host turned phone notifications off.";
  return register(api, server, info.push_relay, settings, phone);
}

/** "Nothing": the server and this phone forget it; the choices stay for next time. */
export function turnOff(api: AuthedApi, server: string, phone: PushPhone = tauriPhone): Promise<string | null> {
  return inTurn(async () => {
    const now = phonePush(server);
    try {
      if (now.device !== null) await api.delete(`/push/devices/${now.device}`);
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "NOT_FOUND")) return words(error);
    }
    await phone.forget(server).catch(() => undefined);
    keep(server, { on: false, settings: now.settings, device: null });
    return null;
  });
}

/**
 * Register again with every server this phone hears from, as it starts:
 * that carries a push address Apple or Google changed, and brings back a
 * phone a server forgot. A server turned off by its host is left alone.
 */
export async function keepRegistered(
  api: AuthedApi,
  server: string,
  info: Pick<ServerInfo, "push" | "push_relay">,
  phone: PushPhone = tauriPhone,
): Promise<string | null> {
  const relay = info.push_relay;
  if (pushSupport(info) !== "on" || typeof relay !== "string") return null;
  return inTurn(async () => {
    const now = phonePush(server);
    if (!now.on) return null;
    if ((await phone.permission(false)) !== "granted") return null;
    return register(api, server, relay, now.settings, phone);
  });
}

/**
 * Signed out of `server`: its server has already forgotten this phone (PROTOCOL §5),
 * so the phone forgets its keys, and nothing is kept about it.
 */
export function forgetPush(server: string, phone: PushPhone = tauriPhone): Promise<void> {
  return inTurn(async () => {
    if (server in held) keep(server, null);
    // Always: a registration that failed partway may have made keys this
    // page never kept a word about (#894 review). The phone forgets nothing
    // it doesn't hold, and never starts Google's service to do it.
    await phone.forget(server).catch(() => undefined);
  });
}
