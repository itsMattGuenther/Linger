import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Invite } from "../../../generated/Invite";
import type { Room } from "../../../generated/Room";
import type { ServerInfo } from "../../../generated/ServerInfo";
import type { User } from "../../../generated/User";
import { displayNameRequest } from "../../../lib/account";
import { ApiError, type AuthedApi, TransportError } from "../../../lib/api";
import { useNow } from "../../../lib/clock";
import { type ExportPhase, runExport } from "../../../lib/export";
import { openExternal } from "../../../lib/external";
import { type GatewayState, saveDisplayName, saveStatus, saveStyle, useServers } from "../../../lib/gateway";
import { inviteUrl, moveRoom } from "../../../lib/host";
import { type VoiceDeviceList, voiceDevices } from "../../../lib/ipc";
import { loadNormalize } from "../../../lib/normalize";
import { loadSoundPrefs, playPreview, saveSoundPrefs, type SoundPrefs } from "../../../lib/sound";
import { imageProblem } from "../../../lib/status";
import { appVersion, checkForUpdate, installUpdate, releaseNotesUrl, type UpdateCheck } from "../../../lib/updates";
import { uploadFile } from "../../../lib/upload";
import { absoluteUrl } from "../../../lib/url";
import { loadVoicePrefs, saveVoicePrefs, type VoicePrefs } from "../../../lib/voice";
import { ask, OWNER, tauriBus } from "../../core/bus";
import { loadMode } from "../../core/conversations";
import { isSettingsKey } from "../../core/keys";
import type { Following } from "../../core/mirror";
import { NOTIFY, type NotifyQuestion, type Outcome, PASSWORD, type PasswordQuestion } from "../../core/share";
import { CHIMES, type SettingsKey, settingsKeys } from "../../core/settings";
import { presenceOf } from "../../core/chat/conversation";
import { Spinner } from "../../kit";
import { announceAppearance, loadScale, saveNormalize, saveScale } from "../../core/appearance";
import { type Reporter, startReporting, windowTarget } from "../../core/report";
import { useFollowing } from "../useFollowing";
import { WindowMessage } from "../WindowMessage";
import { SettingsView } from "./SettingsView";

/** A scope with every section in it, to check a section key against. */
const EVERY_SECTION = { hosting: "any", severalServers: true, windows: true };

/** The section asked for in the address (src-tauri/src/window.rs, `next_open_settings`). */
function sectionOf(search: string): SettingsKey | undefined {
  const wanted = new URLSearchParams(search).get("section");
  return settingsKeys(EVERY_SECTION).find((key) => key === wanted);
}

/**
 * The Settings window: a viewer (docs/design/architecture.md). It follows the
 * list window's connection and saves through its borrowed sign-in; what only
 * the owner may do (notification rules, a password change, signing out,
 * presence when you go away) it asks the list window for.
 */
export function SettingsWindow() {
  const held = useFollowing();
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
      </WindowMessage>
    );
  }
  return <Settings following={held.following} />;
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

function Settings({ following }: { following: Following }) {
  const { apis, intend } = following;
  const servers = useServers();
  const now = useNow();
  // One server for now: several, each with its own you, come with T-1809.
  const [server, api] = useMemo((): [string, AuthedApi] | [null, null] => {
    const [first] = apis;
    return first ?? [null, null];
  }, [apis]);
  const state: GatewayState | undefined = server === null ? undefined : servers[server];
  const [section, setSection] = useState<{ key: SettingsKey | undefined; asked: number }>({ key: sectionOf(window.location.search), asked: 0 });

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
    if (isTauri()) void getCurrentWindow().close();
  }, []);

  // Asked for again while open: show that section (window.rs emits `next:section`).
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void tauriBus()
      .listen<string | null>("next:section", (key) => {
        const wanted = settingsKeys(EVERY_SECTION).find((one) => one === key);
        setSection((held) => ({ key: wanted ?? held.key, asked: held.asked + 1 }));
      })
      .then((unlisten) => {
        if (gone) unlisten();
        else stop = unlisten;
      });
    return () => {
      gone = true;
      stop?.();
    };
  }, []);

  // Escape closes Settings when nothing inside it wanted Escape first, and
  // Ctrl+, (which opens it) does nothing more here.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isSettingsKey(event)) event.preventDefault();
      if (event.key === "Escape" && !event.defaultPrevented) closeWindow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeWindow]);

  // This computer's preferences: read once, saved as they change.
  const [sound, setSound] = useState<SoundPrefs>(loadSoundPrefs);
  const [voice, setVoice] = useState<VoicePrefs>(loadVoicePrefs);
  const [plain, setPlain] = useState<boolean>(loadNormalize);
  const [scale, setScale] = useState<number>(loadScale);
  const [mode, setMode] = useState(() => loadMode(localStore()));
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
  const [archive, setArchive] = useState<ExportPhase>({ kind: "idle" });
  // An export in flight stops asking when the window closes.
  const exportAbort = useRef(new AbortController());
  useEffect(() => {
    const abort = new AbortController();
    exportAbort.current = abort;
    return () => abort.abort();
  }, []);

  // The host's lists, read when the window opens.
  const host = state?.me?.is_host === true;
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [removed, setRemoved] = useState<User[] | null>(null);
  const readHostLists = useCallback(() => {
    if (!api || !host) return;
    void api.invites().then(setInvites, () => setInvites([]));
    void api.removedUsers().then(setRemoved, () => setRemoved([]));
  }, [api, host]);
  useEffect(readHostLists, [readHostLists]);

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
      key={section.asked}
      initialSection={section.key}
      onClose={isTauri() ? closeWindow : undefined}
      profile={{
        me,
        plainNames: plain,
        mediaUrl: (path) => absoluteUrl(server, path),
        actions: {
          saveName: (name) => said(saveDisplayName(api, displayNameRequest(name)), "Couldn't save your name."),
          saveStatus: async (status) => {
            const problem = await said(saveStatus(api, status), "Couldn't save your status.");
            // Going away or coming back is presence too, which the list window keeps.
            if (problem === null) void intend({ kind: "away", server, message: status.away_message ?? null }).catch(() => undefined);
            return problem;
          },
          uploadImage: async (file) => {
            const refusal = imageProblem(file);
            if (refusal !== null) return { problem: refusal };
            try {
              const attachment = await uploadFile(api, file);
              return { image: { id: String(attachment.id), url: attachment.url } };
            } catch (error: unknown) {
              return { problem: inWords(error, "That image didn't go up.") };
            }
          },
          dropImage: (id) => void api.cancelUpload(id).catch(() => undefined),
          saveStyle: (style) => said(saveStyle(api, { display_name: null, style, status: null, entrance_sound: null }), "Couldn't save your look."),
        },
      }}
      appearance={{
        scale: {
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
        },
        devices,
        now,
      }}
      notifications={{
        people: state.users.filter((user) => user.id !== me.id),
        rooms,
        rules: state.notifyRules,
        setRule: async (rule, on) => {
          const question: NotifyQuestion = { server, rule, on };
          return askOwner(question, NOTIFY, "Couldn't reach the list window.");
        },
      }}
      account={{
        serverName,
        changePassword: (current, next) => {
          const question: PasswordQuestion = { server, current, next };
          return askOwner(question, PASSWORD, "Couldn't reach the list window.");
        },
        archive: {
          phase: archive,
          start: () => {
            setArchive({ kind: "working", progress: 0 });
            void runExport(api, setArchive, exportAbort.current.signal);
          },
          download: (url) => openExternal(url),
        },
        updates: {
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
        signOut: () => {
          for (const one of apis.keys()) void intend({ kind: "signout", server: one }).catch(() => undefined);
          closeWindow();
        },
        severalServers: apis.size > 1,
      }}
      hosting={
        host
          ? {
              serverName,
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
              },
              server: {
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

  /** Ask the list window something only it may do, and say how it went. */
  async function askOwner(question: object, event: string, fallback: string): Promise<string | null> {
    try {
      const outcome = await ask<Outcome>(tauriBus(), OWNER, event, question, 30_000);
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

/** Onto the clipboard, or honestly not. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

