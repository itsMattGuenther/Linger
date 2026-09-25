/**
 * The member's settings (T-411).
 *
 * Display name, password, interface size, whether other people's name styling is drawn
 * at all, sign out. One panel over the stream, the same way the host's controls
 * sit over it. On a wide window your name changes live in the roster alongside.
 *
 * Username is on this screen because people look for it next to the display
 * name, but it is not a field you can edit — PROTOCOL §2, usernames are
 * immutable. The server is the lock; this is just honest.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import type { AuthResponse } from "../generated/AuthResponse";
import type { User } from "../generated/User";
import { ApiError, PublicApi, type AuthedApi } from "../lib/api";
import { openExternal } from "../lib/external";
import {
  inQuietHours,
  loadSoundPrefs,
  QUIET_STEP_MINUTES,
  saveSoundPrefs,
  SOUND_CATEGORIES,
  playPreview,
  type SoundCategory,
  type SoundCue,
  type SoundPrefs,
} from "../lib/sound";
import { useNow } from "../lib/clock";
import { clockTime } from "../lib/time";
import { type ThemePref } from "../lib/theme";
import {
  appVersion,
  checkForUpdate,
  installUpdate,
  releaseNotesUrl,
  updateLine,
  type UpdateCheck,
} from "../lib/updates";
import { exportLine, type ExportPhase, runExport } from "./export";
import StylePicker from "./StylePicker";
import { saveDisplayName, useGateway } from "../lib/gateway";
import {
  displayNameReady,
  displayNameRequest,
  MAX_DISPLAY_NAME_CHARS,
  MIN_PASSWORD_CHARS,
  passwordReady,
  passwordRequest,
} from "./settings";
import { type VoiceDeviceList, voiceDevices } from "../lib/ipc";
import {
  loadVoicePrefs,
  PUSH_TO_TALK_KEY,
  saveVoicePrefs,
  type VoicePrefs,
} from "../lib/voice";
import "./settings.css";
import AppearanceSettings from "./AppearanceSettings";
import PreferenceSwitch from "./PreferenceSwitch";
import DestinationHeader from "../lib/DestinationHeader";
import IconButton from "../lib/IconButton";
import { ActionIcon } from "../lib/icons";
import StatusEditor from "../status/StatusEditor";
import NotifyRules from "../notify/NotifyRules";

/**
 * The panel's four tabs (T-1404 follow-up, 2026-09-04). One long column of
 * sixty controls was the thing a first-time user got lost in; the host panel
 * already answers the same problem with tabs, and the same answer here means
 * one thing to learn. Grouped by what you are doing rather than by feature:
 * who you are, how you read, what you hear, and this machine.
 */
export type SettingsSection = "you" | "reading" | "sound" | "computer";

const SECTIONS: Array<{ key: SettingsSection; label: string }> = [
  { key: "you", label: "Profile" },
  { key: "reading", label: "Appearance" },
  { key: "sound", label: "Sound & Voice" },
  { key: "computer", label: "Account & App" },
];

function problemText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export default function SettingsPanel({
  api,
  user,
  normalize,
  onNormalizeChange,
  theme,
  onThemeChange,
  warmth,
  onWarmthChange,
  onSignOut,
  onReauthenticated,
  onClose,
  initialSection = "you",
}: {
  api: AuthedApi;
  /** `ready` is fresher; the stored session is what we have before it arrives. */
  user: User;
  /** Which tab to open on. The status bar's "update ready" lands on the one
   *  with updates in it; everything else starts at the top. */
  initialSection?: SettingsSection;
  normalize: boolean;
  onNormalizeChange: (normalize: boolean) => void;
  theme: ThemePref;
  onThemeChange: (theme: ThemePref) => void;
  warmth: boolean;
  onWarmthChange: (warmth: boolean) => void;
  onSignOut: () => Promise<void>;
  onReauthenticated: (auth: AuthResponse) => Promise<void>;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const gateway = useGateway(api.baseUrl);
  const [editingStatus, setEditingStatus] = useState(false);

  // A different category begins at its heading, not halfway down where the
  // previous category happened to be scrolled.
  useLayoutEffect(() => {
    const body = panel.current?.querySelector(".settings-body");
    if (body) body.scrollTop = 0;
  }, [section]);

  useEffect(() => {
    panel.current
      ?.querySelector<HTMLButtonElement>(".settings-tab[aria-pressed='true']")
      ?.focus();
  }, []);

  useEffect(() => {
    const node = panel.current;
    if (node === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <main className="stream settings" ref={panel}>
      <DestinationHeader title="Settings" onClose={onClose}>
        <nav className="settings-tabs" aria-label="settings sections">
          {SECTIONS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className="settings-tab meta"
              aria-pressed={tab.key === section}
              onClick={() => setSection(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </DestinationHeader>
      <div className="settings-body">
        {section === "you" ? (
          <>
            <NameSection api={api} user={user} />
            <section className="settings-section">
              <h3 className="panel-label">Your Status</h3>
              {editingStatus ? (
                <StatusEditor
                  api={api}
                  me={user}
                  onDone={() => setEditingStatus(false)}
                />
              ) : (
                <>
                  <p className="settings-lead">
                    {user.status?.line || "Let people know what you’re up to."}
                  </p>
                  <button
                    type="button"
                    className="settings-mini settings-toggle"
                    onClick={() => setEditingStatus(true)}
                  >
                    Edit status
                  </button>
                </>
              )}
            </section>
            <StylePicker api={api} user={user} normalized={normalize} />
          </>
        ) : null}
        {section === "reading" ? (
          <AppearanceSettings
            theme={theme}
            onThemeChange={onThemeChange}
            warmth={warmth}
            onWarmthChange={onWarmthChange}
            normalize={normalize}
            onNormalizeChange={onNormalizeChange}
          />
        ) : null}
        {section === "sound" ? (
          <>
            <SoundSection />
            <VoiceSection />
            <section className="settings-section">
              <h3 className="panel-label">Desktop Notifications</h3>
              <p className="settings-lead">
                Mentions can show a desktop banner. Choose people whose other
                messages should also notify you, across this server or in
                selected rooms. Banners are separate from chimes.
              </p>
              <NotifyRules
                api={api}
                rooms={gateway.rooms.filter(
                  (room) => room.archived_at === null,
                )}
              />
            </section>
          </>
        ) : null}
        {section === "computer" ? (
          <>
            <PasswordSection
              api={api}
              username={user.username}
              onReauthenticated={onReauthenticated}
            />
            <ExportSection api={api} />
            <UpdatesSection />
            <section className="settings-section">
              <h3 className="panel-label">This Computer</h3>
              <p className="settings-lead">
                Signing out forgets this server on this computer. It does not
                delete your account.
              </p>
              <button
                type="button"
                className="settings-mini settings-signout"
                onClick={() => void onSignOut()}
              >
                sign out
              </button>
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}

/**
 * Sound (SPEC §4.1, §4.9, T-1102).
 *
 * Two switches, and both are about your own machine rather than anything
 * anybody else can see, so they live here beside appearance preferences.
 *
 * Quiet hours is **off** until they turn it on. The window is 22:00–08:00 in
 * your own time unless you move it (#185) — a knock from a friend six
 * timezones away is judged by your clock, not theirs.
 *
 * Notification cues share the same player and listener-local policy as knocks.
 */
export function SoundSection() {
  const [prefs, setPrefs] = useState<SoundPrefs>(loadSoundPrefs);
  const now = useNow();

  const change = (next: SoundPrefs): void => {
    setPrefs(next);
    saveSoundPrefs(next);
  };

  const from = quietTime(prefs.quietFrom);
  const until = quietTime(prefs.quietUntil);
  const liveSilenced = prefs.muted
    ? "All live chimes are off. Play still previews."
    : prefs.quietHours && inQuietHours(new Date(now), prefs.quietFrom, prefs.quietUntil)
      ? `Quiet hours are silencing message and knock chimes until ${until}. Voice and mute/deafen sounds still play.`
      : null;

  return (
    <section className="settings-section sound-settings">
      <h3 className="panel-label">A Familiar Little Sound</h3>
      <p className="settings-lead">
        Choose your notification chimes. To silence people in voice, use deafen.
      </p>
      <PreferenceSwitch
        label="Mute all notification sounds"
        hint="A little quiet, whenever you need it."
        checked={prefs.muted}
        onChange={(muted) => change({ ...prefs, muted })}
      />
      <PreferenceSwitch
        label="Quiet hours"
        hint={`No DM, room or knock chimes from ${from} to ${until}, on this computer’s clock. Voice and mute/deafen sounds still play.`}
        checked={prefs.quietHours}
        onChange={(quietHours) => change({ ...prefs, quietHours })}
      />
      {/* Where the window sits is yours to move (#185). Only shown while quiet
          hours are on: a time for something switched off is noise. */}
      {prefs.quietHours ? (
        <div className="quiet-window">
          <QuietTimePicker
            label="Quiet from"
            value={prefs.quietFrom}
            onChange={(quietFrom) => change({ ...prefs, quietFrom })}
          />
          <QuietTimePicker
            label="Quiet until"
            value={prefs.quietUntil}
            onChange={(quietUntil) => change({ ...prefs, quietUntil })}
          />
        </div>
      ) : null}
      {liveSilenced ? <p className="settings-lead">{liveSilenced}</p> : null}
      {SOUND_CATEGORIES.map((category) => (
        <div key={category} className="sound-preference">
          <PreferenceSwitch
            label={SOUND_LABELS[category]}
            hint={SOUND_HINTS[category]}
            checked={prefs.categories[category]}
            onChange={(checked) =>
              change({
                ...prefs,
                categories: { ...prefs.categories, [category]: checked },
              })
            }
          />
          <IconButton
            label={`Preview ${SOUND_LABELS[category]}`}
            tooltip="Preview"
            onClick={() => {
              void playPreview(SOUND_PREVIEWS[category]);
            }}
          >
            <ActionIcon name="play" />
          </IconButton>
        </div>
      ))}
      <p className="settings-lead">
        Play always sounds a preview. Live chimes still follow the switches and
        quiet hours above.
      </p>
    </section>
  );
}

const SOUND_LABELS: Record<SoundCategory, string> = {
  voice: "voice joins, leaves and moves",
  controls: "mute and deafen controls",
  dms: "DM messages",
  rooms: "room messages",
  knocks: "knocks",
};
const SOUND_HINTS: Record<SoundCategory, string> = {
  voice: "Your voice session, and the people joining or leaving it.",
  controls: "A quiet confirmation when you mute, unmute or deafen.",
  dms: "A soft note for a new personal message.",
  rooms:
    "Off by default. Your conversations don’t need to compete for attention.",
  knocks: "Two gentle taps when someone wants your attention.",
};
const SOUND_PREVIEWS: Record<SoundCategory, SoundCue> = {
  voice: "peer-join",
  controls: "unmute",
  dms: "dm",
  rooms: "room",
  knocks: "knock",
};

/**
 * Updates (T-701).
 *
 * Nothing here happens on its own. The check runs when this panel opens and
 * when the button is pressed; the download only ever starts because somebody
 * asked for it. A chat window that restarts itself mid-sentence is worse than
 * one that is a version behind, so installing is always the second click.
 *
 * The signature check is not a setting and is not mentioned as one — it is not
 * optional, and there is no build of this that installs an unsigned update.
 */
/**
 * Taking everything with you (SPEC §4.11, T-802).
 *
 * This is the anti-lock-in guarantee with a button on it, so it says plainly
 * what comes out and that it needs nothing from this project to read. The
 * finished archive goes to the system browser rather than to this window —
 * a WebView that follows a download has left the app (`lib/external.ts`).
 */
function ExportSection({ api }: { api: AuthedApi }) {
  const [phase, setPhase] = useState<ExportPhase>({ kind: "idle" });
  const stop = useRef<AbortController | null>(null);

  // Closing the panel stops the asking. The job carries on at the server, which
  // is the right way round: it is being built for a person, not for a window.
  useEffect(
    () => () => {
      stop.current?.abort();
    },
    [],
  );

  const ask = (): void => {
    stop.current?.abort();
    const controller = new AbortController();
    stop.current = controller;
    setPhase({ kind: "working", progress: 0 });
    void runExport(api, setPhase, controller.signal);
  };

  const working = phase.kind === "working";
  const line = exportLine(phase);

  return (
    <section className="settings-section">
      <h3 className="panel-label">Take Everything With You</h3>
      <p className="settings-lead">
        Download public rooms and your own DMs, including shared files, as a
        zip. Messages open in any text editor. Available once an hour.
      </p>
      <p
        className={phase.kind === "failed" ? "settings-problem" : "settings-ok"}
        aria-live="polite"
      >
        {line}
      </p>
      <div className="settings-update-actions">
        <button
          type="button"
          className="settings-mini"
          disabled={working}
          onClick={ask}
        >
          {working ? "building…" : "export everything"}
        </button>
        {phase.kind === "ready" ? (
          <button
            type="button"
            className="settings-mini"
            onClick={() => openExternal(phase.url)}
          >
            download it
          </button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Voice (SPEC §4.14, T-1404): which microphone and speakers, and whether the
 * microphone waits for a key.
 *
 * Both are remembered on this machine and read at the next join. A device
 * you pick that is not plugged in next time falls back to the system default
 * rather than stopping you talking; the list here shows what is present now.
 *
 * Push-to-talk is off by default because a room is "a room you leave
 * running" (SPEC §4.14) and a key you have to hold is the opposite of that.
 * It is here for people who share a desk.
 */
function VoiceSection() {
  const [prefs, setPrefs] = useState<VoicePrefs>(loadVoicePrefs);
  // Null until the core answers; also null in a browser, where there is no
  // core and nothing to pick for.
  const [devices, setDevices] = useState<VoiceDeviceList | null>(null);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    let alive = true;
    voiceDevices()
      .then((list) => {
        if (alive) setDevices(list);
      })
      .catch(() => {
        // Enumeration failed: the pickers stay on "system default", which is
        // what a join would use anyway.
      })
      .finally(() => {
        if (alive) setAsked(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const change = (next: VoicePrefs): void => {
    setPrefs(next);
    saveVoicePrefs(next);
  };

  return (
    <section className="settings-section">
      <h3 className="panel-label">Voice</h3>
      <p className="settings-lead">
        Talking happens in a room: <em>Join Voice</em> under a room's name turns
        your microphone on there.
      </p>
      {devices === null ? (
        <p className="settings-lead settings-warmth-lead">
          {asked
            ? "Devices are picked in the desktop app."
            : "Looking for devices…"}
        </p>
      ) : (
        <>
          <DevicePicker
            label="microphone"
            choices={devices.inputs}
            fallback={devices.default_input}
            value={prefs.devices.input}
            onChange={(input) =>
              change({ ...prefs, devices: { ...prefs.devices, input } })
            }
          />
          <DevicePicker
            label="speakers"
            choices={devices.outputs}
            fallback={devices.default_output}
            value={prefs.devices.output}
            onChange={(output) =>
              change({ ...prefs, devices: { ...prefs.devices, output } })
            }
          />
          <p className="settings-lead settings-warmth-lead">
            A change applies the next time you join voice.
          </p>
        </>
      )}
      <p className="settings-lead settings-warmth-lead">
        Push to talk starts every call muted and opens the microphone only while
        you hold <span className="meta">{PUSH_TO_TALK_KEY.toLowerCase()}</span>.
      </p>
      <button
        type="button"
        className="settings-mini settings-toggle"
        aria-pressed={prefs.pushToTalk}
        onClick={() => change({ ...prefs, pushToTalk: !prefs.pushToTalk })}
      >
        {prefs.pushToTalk ? "push to talk" : "open microphone"}
      </button>
    </section>
  );
}

/** A minute of the day as this computer writes clock times: `9:00 PM` or `21:00`. */
function quietTime(minutes: number): string {
  return clockTime(new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).getTime());
}

/** Every half hour of the day, as minutes after midnight. */
const QUIET_CHOICES = Array.from(
  { length: (24 * 60) / QUIET_STEP_MINUTES },
  (_, step) => step * QUIET_STEP_MINUTES,
);

/**
 * One edge of the quiet window. A saved time that isn't on the half hour
 * (none are today) still shows, rather than the picker claiming another.
 */
function QuietTimePicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (minutes: number) => void;
}) {
  const choices = QUIET_CHOICES.includes(value)
    ? QUIET_CHOICES
    : [...QUIET_CHOICES, value].sort((a, b) => a - b);
  return (
    <label className="settings-row">
      <span className="settings-row-label">{label}</span>
      <select
        className="settings-select"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {choices.map((minutes) => (
          <option key={minutes} value={minutes}>
            {quietTime(minutes)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** One `<select>` of device names, with the system default as the first choice. */
function DevicePicker({
  label,
  choices,
  fallback,
  value,
  onChange,
}: {
  label: string;
  choices: string[];
  /** What "system default" is right now, so the option can say so. */
  fallback: string | null;
  value: string | null;
  onChange: (name: string | null) => void;
}) {
  // A remembered device that is not plugged in today still shows, marked, so
  // the choice is visible rather than silently replaced.
  const missing = value !== null && !choices.includes(value);
  return (
    <label className="settings-row">
      <span className="settings-row-label">{label}</span>
      <select
        className="settings-select"
        value={value ?? ""}
        onChange={(event) =>
          onChange(event.target.value === "" ? null : event.target.value)
        }
      >
        <option value="">
          system default{fallback === null ? "" : ` (${fallback})`}
        </option>
        {choices.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
        {missing ? (
          <option value={value}>{value} (not plugged in)</option>
        ) : null}
      </select>
    </label>
  );
}

function UpdatesSection() {
  const [version, setVersion] = useState<string | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [looking, setLooking] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const look = async (): Promise<void> => {
    setLooking(true);
    setProblem(null);
    setCheck(await checkForUpdate());
    setLooking(false);
  };

  useEffect(() => {
    let open = true;
    void (async () => {
      const [found, current] = await Promise.all([
        checkForUpdate(),
        appVersion(),
      ]);
      if (!open) return;
      setCheck(found);
      setVersion(current);
      setLooking(false);
    })();
    return () => {
      open = false;
    };
  }, []);

  const install = async (): Promise<void> => {
    setInstalling(true);
    setProblem(null);
    // On success this never comes back: the app is replaced by the new one.
    const outcome = await installUpdate();
    setInstalling(false);
    setProblem(
      outcome.kind === "failed"
        ? `Couldn't install the update: ${outcome.reason}`
        : "This copy was not built to update itself.",
    );
  };

  const ready = check?.kind === "ready";

  return (
    <section className="settings-section">
      <h3 className="panel-label">Updates</h3>
      <p className="settings-lead">
        Linger checks for a new version when you open this panel. Nothing is
        downloaded until you ask for it, and every update is checked against
        this project's signing key before it is installed.
      </p>
      <p className="settings-lead settings-warmth-lead">
        {version === null
          ? "Running from a browser, so there is no version to update."
          : `You are on version ${version}.`}
      </p>
      <p
        className={problem === null ? "settings-ok" : "settings-problem"}
        aria-live="polite"
      >
        {problem ?? updateLine(check, looking)}
      </p>
      <div className="settings-update-actions">
        <button
          type="button"
          className="settings-mini"
          disabled={looking || installing}
          onClick={() => void look()}
        >
          check again
        </button>
        {ready ? (
          // The notes themselves stay on the release page (#174).
          <button
            type="button"
            className="settings-mini"
            onClick={() => openExternal(releaseNotesUrl(check.version))}
          >
            what's new
          </button>
        ) : null}
        {ready ? (
          <button
            type="button"
            className="settings-mini"
            disabled={installing}
            onClick={() => void install()}
          >
            {installing ? "downloading…" : "install and restart"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function NameSection({ api, user }: { api: AuthedApi; user: User }) {
  const nameId = useId();
  const userId = useId();
  const [name, setName] = useState(user.display_name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const dirty = name.trim() !== user.display_name;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  // Follow a name that changed somewhere else (another device, or the
  // `user.update` from our own save) — but not while this box is mid-edit.
  useEffect(() => {
    if (!dirty) setName(user.display_name);
  }, [user.display_name, dirty]);

  const submit = async (): Promise<void> => {
    if (!displayNameReady(name, user.display_name) || busy) return;
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      await saveDisplayName(api, displayNameRequest(name));
      setSaved(true);
    } catch (error) {
      setProblem(problemText(error, "Couldn't save your display name."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <h3 className="panel-label">Who You Are</h3>
      <p className="settings-lead">
        Your display name is what people see in the roster and next to your
        messages. It can change. Your username cannot.
      </p>
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="settings-field" htmlFor={nameId}>
          <span className="panel-label">display name</span>
          <input
            id={nameId}
            ref={input}
            className="settings-input"
            value={name}
            maxLength={MAX_DISPLAY_NAME_CHARS}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => {
              setName(event.target.value);
              setSaved(false);
            }}
          />
        </label>
        <label className="settings-field" htmlFor={userId}>
          <span className="panel-label">username</span>
          <input
            id={userId}
            className="settings-input"
            value={user.username}
            readOnly
          />
          <span className="settings-hint meta">
            People mention you with @{user.username}. This never changes.
          </span>
        </label>
        {problem === null ? null : (
          <p className="settings-problem" role="alert">
            {problem}
          </p>
        )}
        {saved ? (
          <p className="settings-ok meta" role="status">
            saved
          </p>
        ) : null}
        <div className="settings-actions">
          <button
            type="submit"
            className="settings-save"
            disabled={busy || !displayNameReady(name, user.display_name)}
          >
            {busy ? "saving…" : "save"}
          </button>
        </div>
      </form>
    </section>
  );
}

function PasswordSection({
  api,
  username,
  onReauthenticated,
}: {
  api: AuthedApi;
  username: string;
  onReauthenticated: (auth: AuthResponse) => Promise<void>;
}) {
  const currentId = useId();
  const nextId = useId();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async (): Promise<void> => {
    if (!passwordReady(current, next) || busy) return;
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      await api.changePassword(passwordRequest(current, next));
    } catch (error) {
      setProblem(problemText(error, "Couldn't change your password."));
      setBusy(false);
      return;
    }

    // Changing a password revokes every refresh family this account owns
    // (the server treats it as "someone else may have had the old one").
    // Sign back in with the new password so this window is not kicked out
    // the moment the access token dies.
    try {
      const auth = await new PublicApi(api.baseUrl).login({
        username,
        password: next,
      });
      await onReauthenticated(auth);
      setCurrent("");
      setNext("");
      setSaved(true);
    } catch {
      setProblem("Password changed. Sign out and back in with the new one.");
      setCurrent("");
      setNext("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <h3 className="panel-label">Password</h3>
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="settings-field" htmlFor={currentId}>
          <span className="panel-label">current password</span>
          <input
            id={currentId}
            className="settings-input"
            type="password"
            value={current}
            autoComplete="current-password"
            onChange={(event) => {
              setCurrent(event.target.value);
              setSaved(false);
            }}
          />
        </label>
        <label className="settings-field" htmlFor={nextId}>
          <span className="panel-label">new password</span>
          <input
            id={nextId}
            className="settings-input"
            type="password"
            value={next}
            autoComplete="new-password"
            onChange={(event) => {
              setNext(event.target.value);
              setSaved(false);
            }}
          />
          <span className="settings-hint meta">
            At least {MIN_PASSWORD_CHARS} characters. No silly rules about
            symbols.
          </span>
        </label>
        {problem === null ? null : (
          <p className="settings-problem" role="alert">
            {problem}
          </p>
        )}
        {saved ? (
          <p className="settings-ok meta" role="status">
            password changed
          </p>
        ) : null}
        <div className="settings-actions">
          <button
            type="submit"
            className="settings-mini"
            disabled={busy || !passwordReady(current, next)}
          >
            {busy ? "saving…" : "change password"}
          </button>
        </div>
      </form>
    </section>
  );
}
