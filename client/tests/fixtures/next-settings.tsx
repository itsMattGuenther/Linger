/**
 * The Settings window (`src/next/app/settings/SettingsView.tsx`) on the
 * prototype's Friday evening (`next/evening.ts`), with no server and no
 * desktop shell. The rules behind it are unit-tested in
 * `src/next/core/settings.test.ts`; this page is for looking at the sections
 * and for `tests/browser/next-settings.spec.ts` to measure and drive.
 *
 * Open it with `pnpm exec vite` at /tests/fixtures/next-settings.html. The
 * window is Settings' own size, 720 by 640.
 *
 * - `?section=invites` (any section key): which section shows first.
 * - `?member`: you're not the host, so there's no Hosting.
 * - `?servers`: you're signed in to three servers, so there's Servers.
 * - `?fail`: every save is refused, in the server's words.
 * - `?away`: you're away already.
 * - `?picture`: your status still has a picture, the way an older server
 *   hands one back (#269). Profile shows nothing for it, and saves drop it.
 * - `?fields`: your status has fields with labels of your own (#270);
 *   with `&long`, as long as the server takes.
 * - `?devices=none`: outside the desktop app; `?devices=looking`: still asking.
 * - `?long`: names and topics far too long for their places.
 * - `?nowindows`: nothing to choose in Windows yet, so there's no Windows.
 * - `?nostart`: starting at sign-in isn't offered (a browser, macOS);
 *   `?hyprland`: it is, on a desktop that won't start it by itself.
 * - `?server=behind`: Hosting → Server says the server runs an older release
 *   than the newest (#314); `?server=looking` is still asking, and
 *   `?server=unknown` couldn't ask. Otherwise it runs the newest.
 *
 * What the page was asked to do is written to `body[data-did]`, `|`-separated.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CustomEmoji } from "../../src/generated/CustomEmoji";
import type { Invite } from "../../src/generated/Invite";
import type { NotifyRule } from "../../src/generated/NotifyRule";
import type { Room } from "../../src/generated/Room";
import type { User } from "../../src/generated/User";
import { emojiPicture } from "../../src/lib/emoji/picture";
import { type ExportPhase } from "../../src/lib/export";
import { inviteUrl } from "../../src/lib/host";
import { DEFAULT_SOUND_PREFS, type SoundPrefs } from "../../src/lib/sound";
import { DEFAULT_VOICE_PREFS, type VoicePrefs } from "../../src/lib/voice";
import { serverVersionLine, type ServerVersion, type UpdateCheck } from "../../src/lib/updates";
import { type SettingsKey } from "../../src/next/core/settings";
import { SettingsView } from "../../src/next/app/settings/SettingsView";
import type { CloseList, ConversationMode } from "../../src/next/app/settings/WindowsSection";
import "../../src/next/styles/app.css";
import { customEmoji, NOW, SERVER, SERVER_NAME, ownFields, people, rooms as eveningRooms, withFields } from "./next/evening";

const query = new URLSearchParams(location.search);

/** What Hosting → Server knows of the server's release, from `?server=` (#314). */
function serverVersionOf(option: string | null): ServerVersion {
  if (option === "looking") return { kind: "looking" };
  if (option === "unknown") return { kind: "unknown" };
  return { kind: "known", version: option === "behind" ? "0.4.3" : "0.4.4" };
}
const FAIL = query.has("fail");
const LONG = query.has("long");
const HOUR = 3_600_000;

const did: string[] = [];
const note = (what: string) => {
  did.push(what);
  document.body.dataset.did = did.join("|");
};

/** A save that takes a beat, as the network does, and is refused under `?fail`. */
function saving(what: string, words = "The server is busy. Try again in a moment."): Promise<string | null> {
  note(what);
  return new Promise((settle) => window.setTimeout(() => settle(FAIL ? words : null), 120));
}

const fielded: User = query.has("fields") ? withFields(people.matt, ownFields(LONG)) : people.matt;
const pictured: User = query.has("picture")
  ? { ...fielded, status: fielded.status && { ...fielded.status, image_id: "img-porch", image_url: "/objects/im/g-/img-porch" } }
  : fielded;
const matt: User = query.has("away")
  ? { ...pictured, status: pictured.status && { ...pictured.status, away_message: "walking the dog 🐕", away_since: NOW - HOUR } }
  : pictured;
const cast: User[] = [people.eli, people.jules, people.dave, people.callie, people.sam, people.jen].map((person) =>
  LONG && person.id === "u-eli" ? { ...person, display_name: "Eli Bartholomew-Maximilian the Considerably Long" } : person,
);

const presence: Record<string, "in_room" | "around" | "away" | "offline"> = {
  "u-matt": "in_room",
  "u-eli": "in_room",
  "u-jules": "in_room",
  "u-dave": "in_room",
  "u-callie": "around",
  "u-sam": "away",
  "u-jen": "offline",
};

const startRooms: Room[] = [eveningRooms.general, eveningRooms.listening, eveningRooms.plans].map((room) =>
  LONG && room.id === "r-plans" ? { ...room, name: "weekend-plans-for-the-long-walk-by-the-river-and-the-picnic-after", topic: "Saturday walk, maybe, if the weather holds and everybody can make it down to the trailhead by nine." } : room,
);

const startInvites: Invite[] = [
  { code: "7QK2-MX4P", created_by: "u-matt", expires_at: NOW + 6 * 24 * HOUR, max_uses: 1, uses: 0, revoked_at: null, created_at: NOW - HOUR },
  { code: "D8RW-2HNT", created_by: "u-matt", expires_at: null, max_uses: null, uses: 3, revoked_at: null, created_at: NOW - 30 * 24 * HOUR },
  { code: "Z4TE-9LKC", created_by: "u-matt", expires_at: NOW - 24 * HOUR, max_uses: 5, uses: 2, revoked_at: null, created_at: NOW - 9 * 24 * HOUR },
];

const removedPeople: User[] = [{ ...people.jen, id: "u-rory", username: "rory", display_name: "Rory" }];

function Fixture() {
  const [me, setMe] = useState<User>(matt);
  const [plain, setPlain] = useState(false);
  const [reactions, setReactions] = useState(true);
  const [scale, setScale] = useState(100);
  const [warmth, setWarmth] = useState(true);
  const [mode, setMode] = useState<ConversationMode>("tabs");
  const [closing, setClosing] = useState<CloseList>("tray");
  const [sound, setSound] = useState<SoundPrefs>(DEFAULT_SOUND_PREFS);
  const [voice, setVoice] = useState<VoicePrefs>({ ...DEFAULT_VOICE_PREFS, devices: { input: "Headset", output: null } });
  const [rules, setRules] = useState<NotifyRule[]>([
    { target_user_id: "u-jules", room_id: "r-general" },
    { target_user_id: "u-eli", room_id: null },
  ]);
  const [archive, setArchive] = useState<ExportPhase>({ kind: "idle" });
  const [check, setCheck] = useState<UpdateCheck | null>({ kind: "ready", version: "0.4.0", notes: null });
  const [looking, setLooking] = useState(false);
  const [rooms, setRooms] = useState<Room[]>(startRooms);
  const [invites, setInvites] = useState<Invite[]>(startInvites);
  // The server's own emoji (#359); `?noemoji` starts with none, and
  // `?oldserver` is a server from before them.
  const [emoji, setEmoji] = useState<CustomEmoji[]>(query.has("noemoji") ? [] : customEmoji);
  const [members, setMembers] = useState<User[]>([matt, ...cast]);
  const [removed, setRemoved] = useState<User[]>(removedPeople);
  const [server, setServer] = useState({ name: SERVER_NAME, accent: "amber" as string | null });
  const [order, setOrder] = useState(["home", "work", "raid"]);
  const [startsAtSignIn, setStartsAtSignIn] = useState(false);

  const devicesQuery = query.get("devices");
  const devices =
    devicesQuery === "none"
      ? null
      : devicesQuery === "looking"
        ? ("looking" as const)
        : { inputs: ["Built-in microphone", "USB microphone"], outputs: ["Headphones", "Speakers"], default_input: "Built-in microphone", default_output: "Headphones" };

  const several = query.has("servers");
  const serverEntries = order.map((id) =>
    id === "home"
      ? { id, name: SERVER_NAME, accent: "amber", me, quiet: false, ownWindow: false }
      : id === "work"
        ? { id, name: "Night Shift", accent: "teal", me: { ...me, display_name: "matty" }, quiet: true, ownWindow: false }
        : { id, name: "Raid Night", accent: "violet", me: { ...me, display_name: "Guenther" }, quiet: false, ownWindow: true },
  );

  return (
    <SettingsView
      initialSection={(query.get("section") ?? "profile") as SettingsKey}
      onClose={() => note("close")}
      profile={{
        me,
        plainNames: plain,
        actions: {
          saveName: async (name) => {
            const problem = await saving(`name:${name}`);
            if (problem === null) setMe((held) => ({ ...held, display_name: name }));
            return problem;
          },
          saveStatus: async (status) => {
            const problem = await saving(`status:${JSON.stringify(status)}`);
            if (problem === null) setMe((held) => ({ ...held, status: { ...status, away_since: status.away_message ? NOW : null } }));
            return problem;
          },
          saveStyle: async (style) => {
            const problem = await saving(`style:${JSON.stringify(style)}`);
            if (problem === null) setMe((held) => ({ ...held, style }));
            return problem;
          },
        },
      }}
      appearance={{
        scale: { value: scale, onChange: (value) => (note(`scale:${value}`), setScale(value)) },
        warmth: { value: warmth, onChange: (value) => (note(`warmth:${value}`), setWarmth(value)) },
        plainNames: { value: plain, onChange: (value) => (note(`plain:${value}`), setPlain(value)) },
        reactions: { value: reactions, onChange: (value) => (note(`reactions:${value}`), setReactions(value)) },
      }}
      windows={
        query.has("nowindows")
          ? undefined
          : {
              conversations: { value: mode, onChange: (value) => (note(`mode:${value}`), setMode(value)) },
              closing: { value: closing, onChange: (value) => (note(`closing:${value}`), setClosing(value)) },
            }
      }
      sound={{
        sound,
        onSound: (prefs) => (note(`sound:${JSON.stringify(prefs)}`), setSound(prefs)),
        onPreview: (category) => note(`play:${category}`),
        voice,
        onVoice: (prefs) => (note(`voice:${JSON.stringify(prefs)}`), setVoice(prefs)),
        devices,
        now: NOW,
      }}
      notifications={{
        people: cast,
        rooms,
        rules,
        setRule: async (rule, on) => {
          const problem = await saving(`rule:${rule.target_user_id}:${rule.room_id ?? "everywhere"}:${on}`, "Couldn't reach the server.");
          if (problem === null) {
            setRules((held) =>
              on
                ? [...held.filter((one) => !(one.target_user_id === rule.target_user_id && one.room_id === rule.room_id)), rule]
                : held.filter((one) => !(one.target_user_id === rule.target_user_id && one.room_id === rule.room_id)),
            );
          }
          return problem;
        },
      }}
      account={{
        serverName: SERVER_NAME,
        version: "0.3.6",
        changePassword: (current, next) => saving(`password:${current.length}:${next.length}`, "That isn't your current password."),
        archive: {
          phase: archive,
          start: () => {
            note("export");
            setArchive({ kind: "working", progress: 0 });
            window.setTimeout(() => setArchive(FAIL ? { kind: "waiting", retryAfterMs: 50 * 60_000 } : { kind: "ready", url: `${SERVER}/exports/archive.zip` }), 200);
          },
          download: (url) => note(`download:${url}`),
        },
        updates: {
          check,
          looking,
          installing: false,
          problem: null,
          checkAgain: () => {
            note("check");
            setLooking(true);
            window.setTimeout(() => {
              setLooking(false);
              setCheck({ kind: "current" });
            }, 150);
          },
          install: () => note("install"),
          openNotes: (version) => note(`notes:${version}`),
        },
        startAtSignIn: query.has("nostart")
          ? undefined
          : {
              on: startsAtSignIn,
              ignoredBy: query.has("hyprland") ? "Hyprland" : null,
              changing: false,
              problem: FAIL ? "Couldn't turn this on. This computer didn't allow it." : null,
              onChange: (on) => {
                note(`autostart:${on}`);
                if (!FAIL) setStartsAtSignIn(on);
              },
              openGuide: () => note("autostart-guide"),
            },
        signOut: () => note("signout"),
        severalServers: several,
      }}
      servers={
        several
          ? {
              servers: serverEntries,
              onMove: (id, delta) => {
                note(`move-server:${id}:${delta}`);
                setOrder((held) => {
                  const at = held.indexOf(id);
                  const to = at + delta;
                  if (at < 0 || to < 0 || to >= held.length) return held;
                  const next = [...held];
                  [next[at], next[to]] = [next[to] ?? id, next[at] ?? id];
                  return next;
                });
              },
              onQuiet: (id, on) => note(`quiet:${id}:${on}`),
              onOwnWindow: (id, on) => note(`own:${id}:${on}`),
              onSignOut: (id) => note(`signout:${id}`),
              onAddServer: () => note("add-server"),
            }
          : undefined
      }
      hosting={
        query.has("member")
          ? undefined
          : {
              serverName: server.name,
              rooms: {
                rooms,
                create: async (room) => {
                  const problem = await saving(`create:${room.slug}:${room.name}:${room.topic ?? ""}`, "A room called #porch already exists.");
                  if (problem === null) {
                    setRooms((held) => [
                      ...held,
                      { id: `r-${room.slug}`, slug: room.slug, name: room.name, topic: room.topic, kind: "room", member_ids: null, position: held.length, archived_at: null, last_message_id: null },
                    ]);
                  }
                  return problem;
                },
                update: async (id, change) => {
                  // A message of the day goes only when it changed (#464).
                  const motd = change.motd === undefined ? "" : `:motd=${change.motd}`;
                  // So do reactions on or off (#485).
                  const reactionsOff = change.reactions_off === undefined ? "" : `:reactions_off=${change.reactions_off}`;
                  const problem = await saving(`update:${id}:${change.name}:${change.topic}${motd}${reactionsOff}`);
                  if (problem === null) {
                    setRooms((held) =>
                      held.map((room) => {
                        if (room.id !== id) return room;
                        const named = { ...room, name: change.name, topic: change.topic === "" ? null : change.topic };
                        const { reactions_off: _was, ...on } = named;
                        const changed = change.reactions_off === undefined ? named : change.reactions_off ? { ...named, reactions_off: true } : on;
                        if (change.motd === undefined) return changed;
                        const { motd: _old, ...rest } = changed;
                        return change.motd === "" ? rest : { ...changed, motd: { text: change.motd, set_by: "u-matt", set_at: Date.now() } };
                      }),
                    );
                  }
                  return problem;
                },
                move: async (id, delta) => {
                  const problem = await saving(`move:${id}:${delta}`);
                  if (problem === null) {
                    setRooms((held) => {
                      const at = held.findIndex((room) => room.id === id);
                      const next = [...held];
                      const [moved] = next.splice(at, 1);
                      if (moved) next.splice(at + delta, 0, moved);
                      return next;
                    });
                  }
                  return problem;
                },
                archive: async (id) => {
                  const problem = await saving(`archive:${id}`);
                  if (problem === null) setRooms((held) => held.filter((room) => room.id !== id));
                  return problem;
                },
              },
              invites: {
                invites,
                linkOf: (code) => inviteUrl(SERVER, code),
                nameOf: (id) => members.find((person) => person.id === id)?.display_name ?? "someone",
                now: NOW,
                create: async ({ uses, hours }) => {
                  note(`invite:${uses ?? "any"}:${hours ?? "never"}`);
                  await new Promise((settle) => window.setTimeout(settle, 120));
                  if (FAIL) return { problem: "Couldn't make an invite." };
                  const code = `NEW${invites.length}-CODE`;
                  setInvites((held) => [
                    { code, created_by: "u-matt", expires_at: hours === null ? null : NOW + hours * HOUR, max_uses: uses, uses: 0, revoked_at: null, created_at: NOW },
                    ...held,
                  ]);
                  return { code, copied: true };
                },
                copy: async (code) => {
                  note(`copy:${code}`);
                  return !FAIL;
                },
                revoke: async (code) => {
                  const problem = await saving(`revoke:${code}`);
                  if (problem === null) setInvites((held) => held.map((invite) => (invite.code === code ? { ...invite, revoked_at: NOW } : invite)));
                  return problem;
                },
              },
              emoji: {
                emoji,
                serverName: server.name,
                nameOf: (id) => members.find((person) => person.id === id)?.display_name ?? "someone",
                // The app's own picture preparing, then a server that takes a beat.
                add: async (file, name) => {
                  const ready = await emojiPicture(file);
                  if (typeof ready === "string") return ready;
                  note(`emoji-add:${name}:${ready.type}:${ready.size <= 256 * 1024 ? "fits" : "big"}`);
                  await new Promise((settle) => window.setTimeout(settle, 120));
                  if (FAIL) return "Couldn't add the emoji.";
                  setEmoji((held) => [
                    ...held,
                    { id: `e-${name}`, name, url: URL.createObjectURL(ready), animated: ready.type === "image/gif", created_by: "u-matt", created_at: NOW },
                  ]);
                  return null;
                },
                rename: async (id, name) => {
                  const problem = await saving(`emoji-rename:${id}:${name}`);
                  if (problem === null) setEmoji((held) => held.map((one) => (one.id === id ? { ...one, name } : one)));
                  return problem;
                },
                remove: async (id) => {
                  const problem = await saving(`emoji-remove:${id}`);
                  if (problem === null) setEmoji((held) => held.filter((one) => one.id !== id));
                  return problem;
                },
                supported: !query.has("oldserver"),
                openGuide: () => note("open-update-guide"),
              },
              people: {
                members,
                meId: me.id,
                presenceOf: (id) => presence[id] ?? "offline",
                removed,
                remove: async (id) => {
                  const problem = await saving(`remove:${id}`);
                  if (problem === null) {
                    const gone = members.find((person) => person.id === id);
                    setMembers((held) => held.filter((person) => person.id !== id));
                    if (gone) setRemoved((held) => [...held, gone]);
                  }
                  return problem;
                },
                restore: async (id) => {
                  const problem = await saving(`restore:${id}`);
                  if (problem === null) {
                    const back = removed.find((person) => person.id === id);
                    setRemoved((held) => held.filter((person) => person.id !== id));
                    if (back) setMembers((held) => [...held, back]);
                  }
                  return problem;
                },
              },
              server: {
                version: {
                  ...serverVersionLine(serverVersionOf(query.get("server")), "0.4.4"),
                  newest: "0.4.4",
                  openNotes: (version) => note(`notes:${version}`),
                  openGuide: () => note("host-guide"),
                },
                name: server.name,
                accent: server.accent,
                save: async (change) => {
                  const problem = await saving(`server:${change.name}:${change.accent ?? "none"}`);
                  if (problem === null) setServer(change);
                  return problem;
                },
              },
            }
      }
    />
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
