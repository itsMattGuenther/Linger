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
import { useEffect, useId, useRef, useState } from "react";

import type { AuthResponse } from "../generated/AuthResponse";
import type { User } from "../generated/User";
import { ApiError, PublicApi, type AuthedApi } from "../lib/api";
import { openExternal } from "../lib/external";
import {
  loadSoundPrefs,
  QUIET_FROM_HOUR,
  QUIET_UNTIL_HOUR,
  saveSoundPrefs,
  SOUND_CATEGORIES,
  cueAllowed,
  playSound,
  type SoundCategory,
  type SoundCue,
  type SoundPrefs,
} from "../lib/sound";
import { THEME_PREFS, type ThemePref } from "../lib/theme";
import {
  appVersion,
  checkForUpdate,
  installUpdate,
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
} from "../voice/voice";
import "./settings.css";
import {
  SCALE_OPTIONS,
  setInterfaceScale,
  useInterfaceScale,
} from "../lib/interface";
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
  { key: "sound", label: "Sound & voice" },
  { key: "computer", label: "Account & app" },
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
  const scale = useInterfaceScale();
  const gateway = useGateway(api.baseUrl);
  const [editingStatus, setEditingStatus] = useState(false);

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
      <header className="stream-header settings-head">
        <h2 className="panel-label">settings</h2>
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
        <button type="button" className="settings-close meta" onClick={onClose}>
          close
        </button>
      </header>
      <div className="settings-body">
        {section === "you" ? (
          <>
            <NameSection api={api} user={user} />
            <section className="settings-section">
              <h3 className="panel-label">Your status</h3>
              {editingStatus ? (
                <StatusEditor
                  api={api}
                  me={user}
                  onDone={() => setEditingStatus(false)}
                />
              ) : (
                <>
                  <p className="settings-lead">
                    {user.status?.line ||
                      "Let people know what you’re up to. Only what you choose to share."}
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
          <>
            <section className="settings-section">
              <h3 className="panel-label">Interface size</h3>
              <p className="settings-lead">
                Make text and controls comfortable to read. Saved on this
                computer.
              </p>
              <label className="settings-row">
                Scale
                <select
                  className="settings-select"
                  value={scale}
                  onChange={(event) => {
                    const control = event.currentTarget;
                    setInterfaceScale(Number(control.value));
                    requestAnimationFrame(() =>
                      control.scrollIntoView({ block: "nearest" }),
                    );
                  }}
                >
                  {SCALE_OPTIONS.map((size) => (
                    <option key={size} value={size}>
                      {size}%{size === 100 ? " — default" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <p className="settings-hint">
                Drag either panel edge to resize it. Use arrow keys on the edge,
                or double-click to reset.
              </p>
            </section>
            <section className="settings-section">
              <h3 className="panel-label">theme</h3>
              <p className="settings-lead">
                Choose a look, or follow your computer’s light and dark setting.
              </p>
              <div className="settings-choices">
                <div className="segmented" role="group" aria-label="theme">
                  {THEME_PREFS.map((pref) => (
                    <button
                      key={pref}
                      type="button"
                      className="segmented-option meta"
                      aria-pressed={pref === theme}
                      onClick={() => onThemeChange(pref)}
                    >
                      {pref}
                    </button>
                  ))}
                </div>
              </div>
              <p className="settings-lead settings-warmth-lead">
                Evening warmth softens the colors after sunset.
              </p>
              <button
                type="button"
                className="settings-mini settings-toggle"
                aria-pressed={warmth}
                onClick={() => onWarmthChange(!warmth)}
              >
                {warmth ? "evening warmth on" : "evening warmth off"}
              </button>
            </section>
            <section className="settings-section">
              <h3 className="panel-label">other people's names</h3>
              <p className="settings-lead">
                Everyone picks how their own name is drawn — a face, a color or
                two, sometimes a shimmer. If you would rather read a quiet room,
                turn this on and every name, including the fonts people set for
                their messages, comes out in your default style.
              </p>
              <button
                type="button"
                className="settings-mini settings-toggle"
                aria-pressed={normalize}
                onClick={() => onNormalizeChange(!normalize)}
              >
                {normalize ? "names normalized" : "normalize everyone"}
              </button>
            </section>
          </>
        ) : null}
        {section === "sound" ? (
          <>
            <SoundSection />
            <VoiceSection />
            <section className="settings-section">
              <h3 className="panel-label">Desktop notifications</h3>
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
              <h3 className="panel-label">this computer</h3>
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
 * Quiet hours is **on** by default and that is deliberate: the alternative is
 * an app that can wake somebody at 3am until they find the setting that stops
 * it. The window is 22:00–08:00 in your own time — a knock from a friend six
 * timezones away is judged by your clock, not theirs.
 *
 * Notification cues share the same player and listener-local policy as knocks.
 */
export function SoundSection() {
  const [prefs, setPrefs] = useState<SoundPrefs>(loadSoundPrefs);

  const change = (next: SoundPrefs): void => {
    setPrefs(next);
    saveSoundPrefs(next);
  };

  return (
    <section className="settings-section">
      <h3 className="panel-label">sound</h3>
      <p className="settings-lead">
        Choose which chimes you hear. These switches do not silence voice chat;
        use deafen in your voice session for that. Desktop notification rules
        are further down this page.
      </p>
      <button
        type="button"
        className="settings-mini settings-toggle"
        aria-pressed={prefs.muted}
        onClick={() => change({ ...prefs, muted: !prefs.muted })}
      >
        mute all notification sounds
      </button>
      <p className="settings-lead settings-warmth-lead">
        Quiet hours run from {QUIET_FROM_HOUR}:00 to 0{QUIET_UNTIL_HOUR}:00 on
        this computer's clock. Notification chimes stay silent during them.
      </p>
      <button
        type="button"
        className="settings-mini settings-toggle"
        aria-pressed={prefs.quietHours}
        onClick={() => change({ ...prefs, quietHours: !prefs.quietHours })}
      >
        {prefs.quietHours ? "quiet hours on" : "quiet hours off"}
      </button>
      {SOUND_CATEGORIES.map((category) => (
        <div key={category} className="settings-field">
          <label>
            <input
              type="checkbox"
              checked={prefs.categories[category]}
              onChange={(event) =>
                change({
                  ...prefs,
                  categories: {
                    ...prefs.categories,
                    [category]: event.target.checked,
                  },
                })
              }
            />
            {SOUND_LABELS[category]}
          </label>{" "}
          <button
            type="button"
            className="settings-mini"
            aria-label={`preview ${SOUND_LABELS[category]}`}
            disabled={!cueAllowed(SOUND_PREVIEWS[category], prefs, new Date())}
            onClick={() => {
              void playSound(SOUND_PREVIEWS[category]);
            }}
          >
            preview
          </button>
        </div>
      ))}
      <p className="settings-lead">
        Previews follow these switches and quiet hours too.
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
      <h3 className="panel-label">take everything with you</h3>
      <p className="settings-lead">
        A copy of this whole server: every message, every file, in one zip. One
        plain text file per room, a folder of the files, and an index. It opens
        in any text editor and needs nothing from Linger — that is the point.
        You can ask for one an hour.
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
      <h3 className="panel-label">voice</h3>
      <p className="settings-lead">
        Talking happens in a room: <em>join voice</em> under a room's name turns
        your microphone on there. Nothing is recorded, by anybody, ever.
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
      <h3 className="panel-label">updates</h3>
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
      {ready && check.notes !== null ? (
        <p className="settings-notes">{check.notes}</p>
      ) : null}
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
      <h3 className="panel-label">who you are</h3>
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
      <h3 className="panel-label">password</h3>
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
