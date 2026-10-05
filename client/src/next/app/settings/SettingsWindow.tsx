import { isTauri } from "@tauri-apps/api/core";
import { copyText } from "../../core/copy";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Invite } from "../../../generated/Invite";
import type { Room } from "../../../generated/Room";
import type { ServerInfo } from "../../../generated/ServerInfo";
import type { User } from "../../../generated/User";
import { displayNameRequest } from "../../../lib/account";
import { ApiError, type AuthedApi, PublicApi, TransportError } from "../../../lib/api";
import { emojiPicture } from "../../../lib/emoji/picture";
import { uploadFile } from "../../../lib/upload";
import { useNow } from "../../../lib/clock";
import { type ExportPhase, runExport } from "../../../lib/export";
import { openExternal } from "../../../lib/external";
import { closeReport, type GatewayState, saveDisplayName, saveStatus, saveStyle, setBlocked, useServers } from "../../../lib/gateway";
import { hostsHere, inviteUrl, moveRoom } from "../../../lib/host";
import { type VoiceDeviceList, voiceDevices } from "../../../lib/ipc";
import { loadNormalize } from "../../../lib/normalize";
import { loadSoundPrefs, playPreview, saveSoundPrefs, type SoundPrefs } from "../../../lib/sound";
import {
  appVersion,
  checkForUpdate,
  HOST_UPDATE_GUIDE_URL,
  installUpdate,
  newestVersion,
  releaseNotesUrl,
  type ServerVersion,
  serverVersionLine,
  type UpdateCheck,
} from "../../../lib/updates";
import { loadVoicePrefs, saveVoicePrefs, type VoicePrefs } from "../../../lib/voice";
import { ask, OWNER, PROTOCOL, tauriBus } from "../../core/bus";
import { loadArrivalCards, saveArrivalCards } from "../../core/arrivals";
import { loadDmAlerts, saveDmAlerts } from "../../core/dmAlerts";
import { refusal, setStartsAtSignIn, START_GUIDE_URL, type StartAtSignIn, startsAtSignIn, unanswered } from "../../core/autostart";
import { loadCloseList, saveCloseList } from "../../core/closing";
import { loadMode } from "../../core/conversations";
import { isSettingsKey } from "../../core/keys";
import type { Following } from "../../core/mirror";
import { inOrder, loadServerPrefs, prefsFrom, type ServerPrefs } from "../../core/serverPrefs";
import { moveShown } from "../../core/servers";
import { NOTIFY, type NotifyQuestion, type Outcome, PASSWORD, type PasswordQuestion, SERVER_PREFS, type ServerPrefsMessage } from "../../core/share";
import { CHIMES, type SettingsKey, settingsKeys } from "../../core/settings";
import { presenceOf } from "../../core/chat/conversation";
import { Button, Spinner } from "../../kit";
import { announceAppearance, loadScale, saveNormalize, saveScale } from "../../core/appearance";
import { type Reporter, startReporting, windowTarget } from "../../core/report";
import { useFollowing } from "../useFollowing";
import { hostOf, useServerInfos } from "../useServerInfos";
import { WindowMessage } from "../WindowMessage";
import type { ServerEntry } from "./ServersSection";
import { SettingsView } from "./SettingsView";

/** A scope with every section in it, to check a section key against. */
const EVERY_SECTION = { hosting: "any", severalServers: true, windows: true };

/** The section asked for in the address (src-tauri/src/window.rs, `next_open_settings`). */
function sectionOf(search: string): SettingsKey | undefined {
  const wanted = new URLSearchParams(search).get("section");
  return settingsKeys(EVERY_SECTION).find((key) => key === wanted);
}

/**
 * What holds Settings, and how it reaches the list window (the owner): a
 * window of its own, over the shell's events, or the phone's one window,
 * which is the owner itself (SPEC §4.15, `ListWindow`).
 */
export interface SettingsHolder {
  following: Following;
  /** Turn a notification rule on or off: only the owner may (NOTIFY). */
  notify(question: NotifyQuestion): Promise<Outcome>;
  /** Change your password: only the owner may, since it signs straight back in (PASSWORD). */
  password(question: PasswordQuestion): Promise<Outcome>;
  /** Hear a section asked for again while Settings is open. Answers how to stop. */
  onSection(heard: (key: string | null) => void): () => void;
  /** Hear your servers' order and Quiet change (SERVER_PREFS). Answers how to stop. */
  onServerPrefs(heard: (message: ServerPrefsMessage) => void): () => void;
  /** Close Settings: its window, or back to the list. */
  close(): void;
  /** Whether Settings draws a close button of its own. */
  closable: boolean;
  /** The section it opens on. */
  section?: SettingsKey;
  /** The phone app: no Windows, no Notifications, no microphones and no updates (SPEC §4.15). */
  phone: boolean;
}

/** Listen on the shell's events, and answer how to stop even before the listening has started. */
function listening<T>(event: string, heard: (payload: T) => void): () => void {
  if (!isTauri()) return () => undefined;
  let stop: (() => void) | null = null;
  let gone = false;
  void tauriBus()
    .listen<T>(event, heard)
    .then((unlisten) => {
      if (gone) unlisten();
      else stop = unlisten;
    });
  return () => {
    gone = true;
    stop?.();
  };
}

/** Settings in a window of its own: it reaches the list window over the shell's events. */
function windowHolder(following: Following): SettingsHolder {
  return {
    following,
    notify: (question) => ask<Outcome>(tauriBus(), OWNER, NOTIFY, question, 30_000),
    password: (question) => ask<Outcome>(tauriBus(), OWNER, PASSWORD, question, 30_000),
    // Asked for again while open: window.rs emits `next:section`.
    onSection: (heard) => listening<string | null>("next:section", heard),
    onServerPrefs: (heard) => listening<ServerPrefsMessage>(SERVER_PREFS, heard),
    close: () => {
      if (isTauri()) void getCurrentWindow().close();
    },
    closable: isTauri(),
    section: sectionOf(window.location.search),
    phone: false,
  };
}

/**
 * The Settings window: a viewer (docs/design/architecture.md). It follows the
 * list window's connection and saves through its borrowed sign-in; what only
 * the owner may do (notification rules, a password change, signing out,
 * presence when you go away) it asks the list window for.
 */
export function SettingsWindow() {
  const held = useFollowing();
  const following = held.kind === "ready" ? held.following : null;
  const holder = useMemo(() => (following ? windowHolder(following) : null), [following]);
  if (held.kind === "waiting") {
    return (
      <WindowMessage>
        <Spinner />
        <span>Opening Settings…</span>
      </WindowMessage>
    );
  }
  if (held.kind === "lost") {
    return (
      <WindowMessage>
        <span>The list window didn't answer.</span>
        <span className="nx-window-hint">Close Settings and open it again from the list.</span>
        <Button size="sm" onClick={held.retry}>
          Try again
        </Button>
      </WindowMessage>
    );
  }
  return holder ? <Settings holder={holder} /> : null;
}

/** A request's failure as a sentence for the person. */
function inWords(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof TransportError ? error.message : fallback;
}

/** Run a save and say how it went: the problem in words, or null. */
async function said(work: Promise<unknown>, fallback: string): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (error: unknown) {
    return inWords(error, fallback);
  }
}

/** Settings, wherever it's held (`SettingsHolder`). */
export function Settings({ holder }: { holder: SettingsHolder }) {
  const { following, phone } = holder;
  const { apis, intend } = following;
  const servers = useServers();
  const now = useNow();
  // Bumped when a server is signed out of or in to, so what's shown is worked out again.
  const [signedOuts, setSignedOuts] = useState(0);
  // One server for now: several, each with its own you, come with T-1809.
  const [server, api] = useMemo((): [string, AuthedApi] | [null, null] => {
    void signedOuts;
    const [first] = apis;
    return first ?? [null, null];
  }, [apis, signedOuts]);
  const state: GatewayState | undefined = server === null ? undefined : servers[server];
  const [section, setSection] = useState<{ key: SettingsKey | undefined; asked: number }>({ key: holder.section, asked: 0 });

  // Presence: typing or moving in Settings is you being here (core/report.ts).
  const reporter = useRef<Reporter | null>(null);
  useEffect(() => {
    const reporting = startReporting(intend, windowTarget());
    reporter.current = reporting;
    return () => {
      reporting.stop();
      if (reporter.current === reporting) reporter.current = null;
    };
  }, [intend]);

  const closeWindow = useCallback(() => {
    reporter.current?.stop();
    holder.close();
  }, [holder]);

  // Signed out of a server: Settings shows what's left, or closes with nothing
  // left. Signed in to one: it shows that one too.
  useEffect(() => {
    const out = following.onSignedOut(() => {
      if (following.apis.size === 0) closeWindow();
      else setSignedOuts((count) => count + 1);
    });
    const joined = following.onSignedIn(() => setSignedOuts((count) => count + 1));
    return () => {
      out();
      joined();
    };
  }, [following, closeWindow]);

  // Asked for again while open: show that section.
  useEffect(
    () =>
      holder.onSection((key) => {
        const wanted = settingsKeys(EVERY_SECTION).find((one) => one === key);
        setSection((held) => ({ key: wanted ?? held.key, asked: held.asked + 1 }));
      }),
    [holder],
  );

  // Escape closes Settings when nothing inside it wanted Escape first, and
  // never from inside a text box, where it means "never mind this edit" and
  // closing would throw away what you typed. Ctrl+, (which opens it) does
  // nothing more here.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isSettingsKey(event)) event.preventDefault();
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const focused = document.activeElement;
      const typing = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement || (focused instanceof HTMLElement && focused.isContentEditable);
      if (typing) {
        focused.blur();
        return;
      }
      closeWindow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeWindow]);

  // Your servers' order and Quiet are the list window's: Settings asks it to
  // change them, and it says whenever they have changed (SERVER_PREFS).
  const [serverPrefs, setServerPrefs] = useState<ServerPrefs>(() => loadServerPrefs(localStore()));
  useEffect(
    () =>
      holder.onServerPrefs((message) => {
        if (message.v === PROTOCOL) setServerPrefs(prefsFrom(message.prefs));
      }),
    [holder],
  );
  const askServerPrefs = (next: ServerPrefs) => {
    setServerPrefs(next);
    void intend({ kind: "serverprefs", order: next.order, quiet: next.quiet }).catch(() => undefined);
  };
  const infos = useServerInfos(apis);
  const addServer = () => {
    void intend({ kind: "addserver" }).catch(() => undefined);
    closeWindow();
  };
  const signedInTo = inOrder(
    [...apis.keys()].map((baseUrl) => ({ baseUrl })),
    serverPrefs.order,
  ).flatMap(({ baseUrl }): ServerEntry[] => {
    const me = servers[baseUrl]?.me;
    if (!me) return [];
    const info = infos[baseUrl];
    return [{ id: baseUrl, name: info?.name ?? hostOf(baseUrl), accent: info?.accent ?? null, me, quiet: serverPrefs.quiet.includes(baseUrl) }];
  });

  // This computer's preferences: read once, saved as they change.
  const [sound, setSound] = useState<SoundPrefs>(loadSoundPrefs);
  const [voice, setVoice] = useState<VoicePrefs>(loadVoicePrefs);
  const [plain, setPlain] = useState<boolean>(loadNormalize);
  const [scale, setScale] = useState<number>(loadScale);
  const [mode, setMode] = useState(() => loadMode(localStore()));
  const [closeList, setCloseList] = useState(() => loadCloseList(localStore()));
  const [arrivalCards, setArrivalCards] = useState(() => loadArrivalCards(localStore()));
  const [dmAlerts, setDmAlerts] = useState(() => loadDmAlerts(localStore()));
  const [devices, setDevices] = useState<VoiceDeviceList | null | "looking">(isTauri() ? "looking" : null);
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void voiceDevices()
      .then((list) => alive && setDevices(list))
      .catch(() => alive && setDevices(null));
    return () => {
      alive = false;
    };
  }, []);

  // The server's own details, for its name and the host's settings.
  const [info, setInfo] = useState<ServerInfo | null>(null);
  useEffect(() => {
    if (!api) return;
    const abort = new AbortController();
    void api
      .serverInfo(abort.signal)
      .then(setInfo)
      .catch(() => undefined);
    return () => abort.abort();
  }, [api]);

  // Updates and the archive: how each stands.
  const [version, setVersion] = useState<string | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [looking, setLooking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [updateProblem, setUpdateProblem] = useState<string | null>(null);
  const checkAgain = useCallback(() => {
    setLooking(true);
    setUpdateProblem(null);
    void checkForUpdate()
      .then(setCheck)
      .finally(() => setLooking(false));
  }, []);
  useEffect(() => {
    void appVersion().then(setVersion);
    checkAgain();
  }, [checkAgain]);
  // Starting at sign-in: what the computer says, asked when the window opens
  // and answered again after every change (core/autostart.ts).
  const [startup, setStartup] = useState<StartAtSignIn | null>(null);
  useEffect(() => {
    let alive = true;
    void startsAtSignIn().then(
      (now) => {
        if (alive && now !== null) setStartup({ on: now.on, ignoredBy: now.ignored_by, changing: false, problem: null });
      },
      (error: unknown) => {
        if (alive) setStartup({ on: false, ignoredBy: null, changing: false, problem: unanswered(error) });
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  const changeStartup = useCallback((wanted: boolean) => {
    setStartup((held) => held && { ...held, changing: true, problem: null });
    void setStartsAtSignIn(wanted).then(
      (now) => setStartup({ on: now.on, ignoredBy: now.ignored_by, changing: false, problem: null }),
      async (error: unknown) => {
        // Show what the computer has now, whatever went wrong on the way.
        const now = await startsAtSignIn().catch(() => null);
        setStartup((held) => ({
          on: now?.on ?? held?.on ?? false,
          ignoredBy: now?.ignored_by ?? held?.ignoredBy ?? null,
          changing: false,
          problem: refusal(wanted, error),
        }));
      },
    );
  }, []);
  const [archive, setArchive] = useState<ExportPhase>({ kind: "idle" });
  // An export in flight stops asking when the window closes.
  const exportAbort = useRef(new AbortController());
  useEffect(() => {
    const abort = new AbortController();
    exportAbort.current = abort;
    return () => abort.abort();
  }, []);

  // The host's lists, read when the window opens: the host's, or a
  // co-host's, who has the same Hosting sections (#424).
  const hosting = hostsHere(state?.me);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [removed, setRemoved] = useState<User[] | null>(null);
  const readHostLists = useCallback(() => {
    if (!api || !hosting) return;
    void api.invites().then(setInvites, () => setInvites([]));
    void api.removedUsers().then(setRemoved, () => setRemoved([]));
  }, [api, hosting]);
  useEffect(readHostLists, [readHostLists]);

  // Which release the server runs, and the newest there is, so a host hears
  // when theirs is behind (#314). The server says on /health, which needs no
  // sign-in and every server answers; nobody but the host is asked or told.
  // Not a co-host: running the server machine isn't the app's (#424).
  const host = state?.me?.is_host === true;
  const [serverVersion, setServerVersion] = useState<ServerVersion>({ kind: "looking" });
  const [newest, setNewest] = useState<string | null>(null);
  useEffect(() => {
    if (!server || !host) return;
    const abort = new AbortController();
    setServerVersion({ kind: "looking" });
    new PublicApi(server).healthReport(abort.signal).then(
      (report) => setServerVersion({ kind: "known", version: report.version }),
      () => {
        if (!abort.signal.aborted) setServerVersion({ kind: "unknown" });
      },
    );
    return () => abort.abort();
  }, [server, host]);
  useEffect(() => {
    if (!host) return;
    let alive = true;
    newestVersion().then(
      (version) => alive && setNewest(version),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [host]);

  if (!state || !api || !server || !state.me) {
    return (
      <WindowMessage onClose={closeWindow}>
        <Spinner />
        <span>Waiting for the server…</span>
      </WindowMessage>
    );
  }
  const me = state.me;
  const serverName = info?.name ?? new URL(server).host;
  const rooms: Room[] = state.rooms.filter((room) => room.archived_at === null).sort((a, b) => a.position - b.position);

  return (
    <SettingsView
      phone={phone}
      key={section.asked}
      initialSection={section.key}
      onClose={holder.closable ? closeWindow : undefined}
      profile={{
        me,
        plainNames: plain,
        actions: {
          saveName: (name) => said(saveDisplayName(api, displayNameRequest(name)), "Couldn't save your name."),
          saveStatus: async (status) => {
            const problem = await said(saveStatus(api, status), "Couldn't save your status.");
            // Going away or coming back is presence too, which the list window keeps.
            if (problem === null) void intend({ kind: "away", server, message: status.away_message ?? null }).catch(() => undefined);
            return problem;
          },
          saveStyle: (style) => said(saveStyle(api, { display_name: null, style, status: null, entrance_sound: null }), "Couldn't save your look."),
        },
      }}
      appearance={{
        // A phone sizes things with its own display and text size (SPEC §4.15).
        scale: phone
          ? undefined
          : {
              value: scale,
              onChange: (value) => {
                setScale(saveScale(value));
                announceAppearance();
              },
            },
        plainNames: {
          value: plain,
          onChange: (value) => {
            setPlain(value);
            saveNormalize(value);
            announceAppearance();
          },
        },
      }}
      windows={{
        conversations: {
          value: mode,
          onChange: (value) => {
            setMode(value);
            void intend({ kind: "conversations", mode: value }).catch(() => undefined);
          },
        },
        closing: {
          value: closeList,
          onChange: (value) => {
            setCloseList(value);
            saveCloseList(localStore(), value);
            void intend({ kind: "tray", on: value === "tray" }).catch(() => undefined);
          },
        },
      }}
      sound={{
        sound,
        onSound: (prefs) => {
          saveSoundPrefs(prefs);
          setSound(prefs);
        },
        onPreview: (category) => {
          const cue = CHIMES.find((chime) => chime.category === category)?.cue;
          if (cue) void playPreview(cue);
        },
        voice,
        onVoice: (prefs) => {
          saveVoicePrefs(prefs);
          setVoice(prefs);
          // Push-to-talk and its key apply to the call you're in at once,
          // not at the next join: the list window keeps the voice seat (#231).
          if (prefs.pushToTalk !== voice.pushToTalk || prefs.pushToTalkKey !== voice.pushToTalkKey) {
            void intend({ kind: "voice.pushtotalk", on: prefs.pushToTalk, key: prefs.pushToTalkKey }).catch(() => undefined);
          }
          // So do the devices (#249).
          if (prefs.devices.input !== voice.devices.input || prefs.devices.output !== voice.devices.output) {
            void intend({ kind: "voice.devices", input: prefs.devices.input, output: prefs.devices.output }).catch(() => undefined);
          }
        },
        devices,
        now,
      }}
      notifications={{
        people: state.users.filter((user) => user.id !== me.id),
        rooms,
        rules: state.notifyRules,
        setRule: async (rule, on) => {
          return askOwner(holder.notify({ server, rule, on }), "Couldn't reach the list window.");
        },
        arrivals: {
          on: arrivalCards,
          onChange: (on) => {
            saveArrivalCards(localStore(), on);
            setArrivalCards(on);
          },
        },
        dmAlerts: {
          on: dmAlerts,
          onChange: (on) => {
            saveDmAlerts(localStore(), on);
            setDmAlerts(on);
          },
        },
      }}
      account={{
        serverName,
        // Who you've blocked here (T-1605), by the names the server has for them.
        blocked: state
          ? {
              people: state.blocked.flatMap((id) => state.users.filter((user) => user.id === id)),
              unblock: (id) => said(setBlocked(api, id, false), "Couldn't unblock them."),
            }
          : undefined,
        changePassword: (current, next) => {
          return askOwner(holder.password({ server, current, next }), "Couldn't reach the list window.");
        },
        archive: {
          phase: archive,
          start: () => {
            setArchive({ kind: "working", progress: 0 });
            void runExport(api, setArchive, exportAbort.current.signal);
          },
          download: (url) => openExternal(url),
        },
        // A phone app is updated by its store (SPEC §4.15).
        updates: phone
          ? undefined
          : {
              version,
              check,
              looking,
              installing,
              problem: updateProblem,
              checkAgain,
              install: () => {
                setInstalling(true);
                setUpdateProblem(null);
                void installUpdate()
                  .then((outcome) => {
                    if (outcome.kind === "failed") setUpdateProblem(outcome.reason);
                  })
                  .finally(() => setInstalling(false));
              },
              openNotes: (wanted) => openExternal(releaseNotesUrl(wanted)),
            },
        startAtSignIn: startup && !phone ? { ...startup, onChange: changeStartup, openGuide: () => openExternal(START_GUIDE_URL) } : undefined,
        signOut: () => {
          for (const one of apis.keys()) void intend({ kind: "signout", server: one }).catch(() => undefined);
          closeWindow();
        },
        severalServers: apis.size > 1,
        addServer,
      }}
      servers={{
        servers: signedInTo,
        // Within every server you're on, not just the ones shown: one Settings
        // can't draw yet keeps its place.
        onMove: (id, delta) =>
          askServerPrefs({
            ...serverPrefs,
            order: moveShown(
              inOrder(
                [...apis.keys()].map((baseUrl) => ({ baseUrl })),
                serverPrefs.order,
              ).map(({ baseUrl }) => baseUrl),
              signedInTo.map((entry) => entry.id),
              id,
              delta,
            ),
          }),
        onQuiet: (id, quiet) =>
          askServerPrefs({ ...serverPrefs, quiet: quiet ? [...serverPrefs.quiet.filter((one) => one !== id), id] : serverPrefs.quiet.filter((one) => one !== id) }),
        onSignOut: (id) => void intend({ kind: "signout", server: id }).catch(() => undefined),
        onAddServer: addServer,
      }}
      hosting={
        hosting
          ? {
              serverName,
              cohost: !host,
              rooms: {
                rooms,
                create: (room) => said(api.createRoom({ slug: room.slug, name: room.name, topic: room.topic }), "Couldn't make the room."),
                update: (id, change) => said(api.updateRoom(id, { name: change.name, topic: change.topic, position: null }), "Couldn't save the room."),
                move: (id, delta) =>
                  said(
                    (async () => {
                      // One at a time: the server moves one room per request.
                      for (const step of moveRoom(rooms, id, delta)) await api.updateRoom(step.id, { name: null, topic: null, position: step.position });
                    })(),
                    "Couldn't reorder the rooms.",
                  ),
                archive: (id) => said(api.archiveRoom(id), "Couldn't archive the room."),
              },
              invites: {
                invites,
                linkOf: (code) => inviteUrl(server, code),
                nameOf: (userId) => state.users.find((user) => user.id === userId)?.display_name ?? "someone",
                now,
                create: async (choice) => {
                  try {
                    const made = await api.createInvite({ max_uses: choice.uses, expires_in_hours: choice.hours });
                    setInvites((list) => [made, ...(list ?? [])]);
                    return { code: made.code, copied: await copyText(inviteUrl(server, made.code)) };
                  } catch (error: unknown) {
                    return { problem: inWords(error, "Couldn't make an invite.") };
                  }
                },
                copy: (code) => copyText(inviteUrl(server, code)),
                revoke: async (code) => {
                  const problem = await said(api.revokeInvite(code), "Couldn't revoke the link.");
                  if (problem === null) setInvites((list) => (list ?? []).filter((invite) => invite.code !== code));
                  return problem;
                },
              },
              // The server's own emoji (#359): the list follows `emoji.update`.
              emoji: {
                emoji: state.emoji,
                serverName,
                nameOf: (userId) => state.users.find((user) => user.id === userId)?.display_name ?? "someone",
                add: async (file, name) => {
                  const ready = await emojiPicture(file);
                  if (typeof ready === "string") return ready;
                  try {
                    const picture = await uploadFile(api, ready);
                    await api.createEmoji({ name, attachment_id: picture.id });
                    return null;
                  } catch (error: unknown) {
                    return inWords(error, "Couldn't add the emoji.");
                  }
                },
                rename: (id, name) => said(api.renameEmoji(id, { name }), "Couldn't rename the emoji."),
                remove: (id) => said(api.removeEmoji(id), "Couldn't remove the emoji."),
              },
              people: {
                members: state.users,
                meId: me.id,
                presenceOf: (userId) => presenceOf(state, userId),
                removed,
                remove: async (userId) => {
                  const problem = await said(api.removeUser(userId), "Couldn't remove them.");
                  if (problem === null) readHostLists();
                  return problem;
                },
                restore: async (userId) => {
                  const problem = await said(api.restoreUser(userId), "Couldn't let them back in.");
                  if (problem === null) readHostLists();
                  return problem;
                },
                // What was reported to the host (T-1605).
                reports: state.reports
                  ? {
                      open: state.reports,
                      personOf: (userId) => state.users.find((user) => user.id === userId) ?? removed?.find((user) => user.id === userId),
                      placeOf: (roomId) => {
                        const room = state.rooms.find((one) => one.id === roomId);
                        return room ? `#${room.name}` : "a DM";
                      },
                      deleteMessage: (report) =>
                        report.message
                          ? said(
                              api.delete(`/messages/${encodeURIComponent(report.message.id)}`).then(() => closeReport(api, report.id)),
                              "Couldn't delete the message.",
                            )
                          : Promise.resolve(null),
                      close: (reportId) => said(closeReport(api, reportId), "Couldn't take the report off the list."),
                    }
                  : undefined,
              },
              server: {
                // The host's alone (#424): a co-host isn't who updates it.
                version: host
                  ? {
                      ...serverVersionLine(serverVersion, newest),
                      newest,
                      openNotes: (wanted) => openExternal(releaseNotesUrl(wanted)),
                      openGuide: () => openExternal(HOST_UPDATE_GUIDE_URL),
                    }
                  : undefined,
                name: serverName,
                accent: info?.accent_key ?? null,
                save: async (change) => {
                  try {
                    setInfo(await api.updateServer({ name: change.name, accent_key: change.accent as ServerInfo["accent_key"], icon_key: null }));
                    return null;
                  } catch (error: unknown) {
                    return inWords(error, "Couldn't save the server.");
                  }
                },
              },
            }
          : undefined
      }
    />
  );

  /** What the list window said to something only it may do, in words. */
  async function askOwner(asking: Promise<Outcome>, fallback: string): Promise<string | null> {
    try {
      const outcome = await asking;
      return outcome.problem;
    } catch {
      return fallback;
    }
  }
}

/** Where this computer keeps its preferences, or none where storage is refused. */
function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}


