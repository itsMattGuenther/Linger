/**
 * The Settings window's words and the small decisions behind its controls
 * (docs/design/buddy-list.md, "Settings"; docs/design/parity.md, SET). Pure,
 * so the copy's casing and vocabulary (lessons L-09, SPEC §1) and every rule
 * here are unit-tested without a window.
 *
 * Headings and navigation labels are in title case; sentences are in
 * sentence case (SPEC §5.6, #90).
 */
import type { NotifyRule } from "../../generated/NotifyRule";
import type { Room } from "../../generated/Room";
import type { UserId } from "../../generated/UserId";
import { QUIET_STEP_MINUTES, type SoundCategory, type SoundCue } from "../../lib/sound";

export type SettingsKey =
  | "profile"
  | "appearance"
  | "windows"
  | "sound"
  | "notifications"
  | "account"
  | "servers"
  | "rooms"
  | "invites"
  | "people"
  | "server";

/** What the window has to show, which decides which sections exist. */
export interface SettingsScope {
  /** The server you host, by name, or null: Hosting appears only for the host (SRV-8). */
  hosting: string | null;
  /** More than one server signed in: Servers appears only then. */
  severalServers: boolean;
  /** Something to choose in Windows (it appears only when there is). */
  windows: boolean;
}

export type SettingsEntry =
  | { kind: "group"; label: string; sub?: string }
  | { kind: "item"; key: SettingsKey; label: string };

export const SECTION_LABELS: Record<SettingsKey, string> = {
  profile: "Profile",
  appearance: "Appearance",
  windows: "Windows",
  sound: "Sound & Voice",
  notifications: "Notifications",
  account: "Account & App",
  servers: "Servers",
  rooms: "Rooms",
  invites: "Invites",
  people: "People",
  server: "Server",
};

/** The sidebar, in order. Host sections sit under the server's name; a member never sees them. */
export function settingsEntries(scope: SettingsScope): SettingsEntry[] {
  const item = (key: SettingsKey): SettingsEntry => ({ kind: "item", key, label: SECTION_LABELS[key] });
  return [
    { kind: "group", label: "You" },
    item("profile"),
    { kind: "group", label: "This App" },
    item("appearance"),
    ...(scope.windows ? [item("windows")] : []),
    item("sound"),
    item("notifications"),
    item("account"),
    ...(scope.severalServers ? [item("servers")] : []),
    ...(scope.hosting === null
      ? []
      : [{ kind: "group" as const, label: "Hosting", sub: scope.hosting }, item("rooms"), item("invites"), item("people"), item("server")]),
  ];
}

/** The sections that exist for this scope, in order. */
export function settingsKeys(scope: SettingsScope): SettingsKey[] {
  return settingsEntries(scope).flatMap((entry) => (entry.kind === "item" ? [entry.key] : []));
}

/** The section to show: the one asked for if it exists here, otherwise the first. */
export function showable(scope: SettingsScope, wanted: SettingsKey): SettingsKey {
  const keys = settingsKeys(scope);
  return keys.includes(wanted) ? wanted : (keys[0] ?? "profile");
}

/** Each section's heading and the sentence under it. */
export function sectionLead(key: SettingsKey, scope: SettingsScope): string {
  switch (key) {
    case "profile":
      return scope.severalServers
        ? "Who you are on this server. Each server has its own name and look: see Servers."
        : "Who you are here, what you're up to, and how your name looks.";
    case "appearance":
      return "Make yourself comfortable. These choices stay on this computer.";
    case "windows":
      return "How Linger sits on your desktop.";
    case "sound":
      return "Choose your notification chimes. To silence people in voice, use deafen.";
    case "notifications":
      return "Desktop banners for mentions and the people you choose, and cards when somebody arrives.";
    case "account":
      return "Your password, your archive, updates and this computer.";
    case "servers":
      return "Each server is its own account: its own you, its own look. The order is yours; nothing reshuffles by activity.";
    case "rooms":
      return `You host ${scope.hosting ?? "this server"}. What you change here changes it for everyone.`;
    case "invites":
      return "A link lets somebody make an account here. Make one for the person you're asking.";
    case "people":
      return "Manage who can use this server. Removing someone asks you first.";
    case "server":
      return "Its name and its color, as everyone sees them.";
  }
}

/** Every heading inside the sections, in one place for the casing test. */
export const HEADINGS = {
  who: "Who You Are",
  status: "Your Status",
  look: "Make Yourself at Home",
  theme: "Color Theme",
  size: "Interface Size",
  names: "Names",
  conversations: "Conversations Open",
  closing: "When You Close Your List",
  chimes: "A Familiar Little Sound",
  voice: "Voice",
  banners: "Desktop Notifications",
  arrivals: "Arrivals",
  password: "Password",
  archive: "Take Everything with You",
  updates: "Updates",
  computer: "This Computer",
  newRoom: "New Room",
  rooms: "Your Rooms, in Order",
  newInvite: "New Invite",
  links: "Links You Have Made",
  members: "Members",
  removed: "Removed",
  serverName: "Name",
  accent: "Accent",
} as const;

/** The small words a title leaves lower case unless they start it. */
const MINOR = new Set(["a", "an", "and", "at", "for", "in", "of", "on", "or", "the", "to", "with"]);

/** Whether a heading is in title case: every word capitalized except the small ones inside it. */
export function isTitleCase(text: string): boolean {
  const words = text.split(/\s+/).filter((word) => /[a-z]/i.test(word));
  return words.every((word, index) => {
    const bare = word.replace(/[^A-Za-z']/g, "");
    if (bare === "") return true;
    if (index > 0 && MINOR.has(bare.toLowerCase())) return bare === bare.toLowerCase();
    const first = bare[0] ?? "";
    return first === first.toUpperCase();
  });
}

// ---------------------------------------------------------------------------
// Sound

/** Each chime's name, what it's for, and the cue its Play button sounds (SND-1, SND-4). */
export const CHIMES: readonly { category: SoundCategory; label: string; hint: string; cue: SoundCue }[] = [
  { category: "voice", label: "Voice joins, leaves and moves", hint: "Your voice session, and the people joining or leaving it.", cue: "peer-join" },
  { category: "controls", label: "Mute and deafen controls", hint: "A quiet confirmation when you mute, unmute or deafen.", cue: "unmute" },
  { category: "dms", label: "DM messages", hint: "A soft note for a new personal message.", cue: "dm" },
  { category: "rooms", label: "Room messages", hint: "Off by default. Your conversations don't need to compete for attention.", cue: "room" },
  { category: "knocks", label: "Knocks", hint: "Two gentle taps when someone wants your attention.", cue: "knock" },
  { category: "door", label: "Door chime", hint: "Off by default. A soft ding-dong when somebody comes into a room, at most once every five minutes for each person.", cue: "door" },
];

/** Every half hour of the day, plus a saved time that isn't on one, so the box never claims another. */
export function quietChoices(saved: number): number[] {
  const steps = Array.from({ length: (24 * 60) / QUIET_STEP_MINUTES }, (_, step) => step * QUIET_STEP_MINUTES);
  return steps.includes(saved) ? steps : [...steps, saved].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Voice devices

/** The empty value means "the system default", as `VoicePrefs` stores it (null). */
export const SYSTEM_DEFAULT = "";

/**
 * The choices for a microphone or speakers (VOICE-9): the system default
 * first, naming what it is right now; then what is plugged in; then a
 * remembered device that isn't, marked, so the choice is visible rather than
 * silently replaced.
 */
export function deviceOptions(present: readonly string[], fallback: string | null, saved: string | null): { value: string; label: string }[] {
  const options = [
    { value: SYSTEM_DEFAULT, label: fallback === null ? "System default" : `System default (${fallback})` },
    ...present.filter((name) => name !== SYSTEM_DEFAULT).map((name) => ({ value: name, label: name })),
  ];
  if (saved !== null && saved !== SYSTEM_DEFAULT && !present.includes(saved)) options.push({ value: saved, label: `${saved} (not plugged in)` });
  return options;
}

// ---------------------------------------------------------------------------
// Notifications

/** What a person's rules add up to, in words: everywhere, the rooms, or only mentions (NOTE-2). */
export function ruleSummary(rules: readonly NotifyRule[], person: UserId, rooms: readonly Room[]): string {
  const theirs = rules.filter((rule) => rule.target_user_id === person);
  if (theirs.some((rule) => rule.room_id === null)) return "everywhere";
  const named = rooms.filter((room) => theirs.some((rule) => rule.room_id === room.id));
  return named.length === 0 ? "only mentions" : named.map((room) => `#${room.name}`).join(", ");
}

// ---------------------------------------------------------------------------
// Text limits

/** "12 left" once a field is within `warnAt` of its limit, "3 over" past it, otherwise nothing. */
export function leftOf(value: string, max: number, warnAt: number): string | null {
  const left = max - [...value.trim()].length;
  if (left < 0) return `${-left} over`;
  return left <= warnAt ? `${left} left` : null;
}

// ---------------------------------------------------------------------------
// Invites (HOST-5)

export const INVITE_USES: readonly { label: string; uses: number | null }[] = [
  { label: "One person", uses: 1 },
  { label: "Five people", uses: 5 },
  { label: "Anyone", uses: null },
];

export const INVITE_EXPIRY: readonly { label: string; hours: number | null }[] = [
  { label: "A day", hours: 24 },
  { label: "A week", hours: 24 * 7 },
  { label: "Never", hours: null },
];
