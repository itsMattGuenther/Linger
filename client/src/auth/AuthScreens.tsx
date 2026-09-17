/**
 * Everything between opening the app and being signed in.
 *
 * One idea runs through it: a person arrives holding a link, not a mental model
 * of servers and invite codes. So the first screen is a single box, and what
 * they paste decides which form comes next — sign in, accept an invite, or set
 * up a brand new server.
 *
 * Console rules apply here as much as anywhere (SPEC §5): square panels,
 * hairline separation, mono for labels and metadata, accent on exactly one
 * thing per screen — the button that moves you forward.
 *
 * The same screen is also the `+ add` door in the server rail (T-412). Inside
 * the app it drops the wordmark — the panel it sits in already says what it is —
 * and everything else about it is identical, because adding your second server
 * is the same job as arriving at your first.
 */
import { useState } from "react";

import type { AuthResponse } from "../generated/AuthResponse";
import { ApiError, PublicApi } from "../lib/api";
import { hostOf, parsePastedLink } from "../lib/link";
import "./auth.css";
import {
  SCALE_OPTIONS,
  setInterfaceScale,
  useInterfaceScale,
} from "../lib/interface";

/**
 * `linger-core::limits::MIN_PASSWORD_CHARS`. The server is the authority and
 * refuses anything shorter; this copy exists so the form can grey the button
 * out before the round trip rather than after it. Minimum length is the only
 * rule — no symbols, no digits, no expiry (PROTOCOL §2).
 */
const MIN_PASSWORD_CHARS = 8;

type Step =
  | { name: "connect" }
  | { name: "login"; baseUrl: string; serverName: string | null }
  | {
      name: "register";
      baseUrl: string;
      code: string;
      serverName: string | null;
    }
  | { name: "setup"; baseUrl: string; token: string };

interface Props {
  /** Why the previous sign-in ended, if it ended without being asked to. */
  notice: string | null;
  /** Set when this computer can't remember a sign-in between launches. */
  keyringNotice: string | null;
  onAuthenticated: (baseUrl: string, auth: AuthResponse) => Promise<void>;
  /** Drawn inside the app frame rather than as the whole window (T-412). */
  inline?: boolean;
}

/** Turn any thrown thing into a sentence worth showing. */
function messageFor(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Something went wrong.";
}

export default function AuthScreens({
  notice,
  keyringNotice,
  onAuthenticated,
  inline = false,
}: Props) {
  const [step, setStep] = useState<Step>({ name: "connect" });
  const scale = useInterfaceScale();

  return (
    <div className={inline ? "auth auth-inline" : "auth"}>
      <div className="auth-panel">
        {inline ? null : (
          <header className="auth-head">
            <h1 className="auth-wordmark">Linger</h1>
            <p className="auth-tagline meta">
              a small server for people who like each other
            </p>
          </header>
        )}

        {notice && step.name === "connect" ? (
          <p className="auth-notice" role="status">
            {notice}
          </p>
        ) : null}

        {step.name === "connect" ? <Connect onStep={setStep} /> : null}
        {step.name === "login" ? (
          <Login
            step={step}
            onBack={() => setStep({ name: "connect" })}
            onDone={onAuthenticated}
          />
        ) : null}
        {step.name === "register" ? (
          <Register
            step={step}
            onBack={() => setStep({ name: "connect" })}
            onDone={onAuthenticated}
          />
        ) : null}
        {step.name === "setup" ? (
          <Setup
            step={step}
            onBack={() => setStep({ name: "connect" })}
            onDone={onAuthenticated}
          />
        ) : null}

        {keyringNotice ? (
          <p className="auth-keyring" role="status">
            {keyringNotice} You'll have to sign in again next time.
          </p>
        ) : null}
        {inline ? null : (
          <label className="auth-scale">
            Interface size
            <select
              value={scale}
              onChange={(event) =>
                setInterfaceScale(Number(event.target.value))
              }
            >
              {SCALE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}%
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}

function Connect({ onStep }: { onStep: (step: Step) => void }) {
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const link = parsePastedLink(pasted);
    if (!link) {
      setError("That doesn't look like a server address or a link.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const api = new PublicApi(link.baseUrl);
      if (link.kind === "setup") {
        const preview = await api.setupPreview(link.token);
        if (!preview.valid) {
          setError(
            "That setup link has already been used. Restart the server for a new one.",
          );
          return;
        }
        onStep({ name: "setup", baseUrl: link.baseUrl, token: link.token });
        return;
      }
      if (link.kind === "invite") {
        const preview = await api.invitePreview(link.code);
        if (!preview.valid) {
          setError("That invite isn't good anymore. Ask for a new one.");
          return;
        }
        onStep({
          name: "register",
          baseUrl: link.baseUrl,
          code: link.code,
          serverName: preview.server_name,
        });
        return;
      }
      await api.health();
      onStep({ name: "login", baseUrl: link.baseUrl, serverName: null });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <Field
        label="server or link"
        hint="New here? Paste the full invite link from your host. Already have an account? Use the server address. Hosts can paste their setup link."
        value={pasted}
        onChange={setPasted}
        placeholder="linger.example"
        autoFocus
      />
      <Problem message={error} />
      <button
        className="auth-go"
        type="submit"
        disabled={busy || pasted.trim() === ""}
      >
        {busy ? "checking…" : "continue"}
      </button>
    </form>
  );
}

function Login({
  step,
  onBack,
  onDone,
}: {
  step: Extract<Step, { name: "login" }>;
  onBack: () => void;
  onDone: Props["onAuthenticated"];
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const auth = await new PublicApi(step.baseUrl).login({
        username: username.trim().toLowerCase(),
        password,
      });
      await onDone(step.baseUrl, auth);
    } catch (caught) {
      setError(messageFor(caught));
      setBusy(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <Where
        baseUrl={step.baseUrl}
        serverName={step.serverName}
        onBack={onBack}
      />
      <Field
        label="username"
        value={username}
        onChange={setUsername}
        autoFocus
      />
      <Field
        label="password"
        value={password}
        onChange={setPassword}
        type="password"
      />
      <Problem message={error} />
      <button
        className="auth-go"
        type="submit"
        disabled={busy || !username || !password}
      >
        {busy ? "signing in…" : "sign in"}
      </button>
    </form>
  );
}

function Register({
  step,
  onBack,
  onDone,
}: {
  step: Extract<Step, { name: "register" }>;
  onBack: () => void;
  onDone: Props["onAuthenticated"];
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const auth = await new PublicApi(step.baseUrl).register({
        invite_code: step.code,
        username: username.trim().toLowerCase(),
        display_name: displayName.trim(),
        password,
      });
      await onDone(step.baseUrl, auth);
    } catch (caught) {
      setError(messageFor(caught));
      setBusy(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <Where
        baseUrl={step.baseUrl}
        serverName={step.serverName}
        onBack={onBack}
      />
      <p className="auth-lead">
        You're joining {step.serverName ?? hostOf(step.baseUrl)}. Pick a
        username people can mention you by, and a display name they'll see in
        the roster.
      </p>
      <Field
        label="username"
        hint="Lowercase letters, numbers and underscores. You can't change it later."
        value={username}
        onChange={setUsername}
        autoFocus
      />
      <Field
        label="display name"
        value={displayName}
        onChange={setDisplayName}
      />
      <Field
        label="password"
        hint={`At least ${MIN_PASSWORD_CHARS} characters. No silly rules about symbols.`}
        value={password}
        onChange={setPassword}
        type="password"
      />
      <Problem message={error} />
      <button
        className="auth-go"
        type="submit"
        disabled={
          busy ||
          !username ||
          !displayName ||
          password.length < MIN_PASSWORD_CHARS
        }
      >
        {busy ? "joining…" : "join"}
      </button>
    </form>
  );
}

function Setup({
  step,
  onBack,
  onDone,
}: {
  step: Extract<Step, { name: "setup" }>;
  onBack: () => void;
  onDone: Props["onAuthenticated"];
}) {
  const [serverName, setServerName] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const auth = await new PublicApi(step.baseUrl).setup({
        token: step.token,
        server_name: serverName.trim(),
        username: username.trim().toLowerCase(),
        display_name: displayName.trim(),
        password,
      });
      await onDone(step.baseUrl, auth);
    } catch (caught) {
      setError(messageFor(caught));
      setBusy(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <Where baseUrl={step.baseUrl} serverName={null} onBack={onBack} />
      <p className="auth-lead">
        Nobody has set this server up yet. Whoever does becomes its host —
        that's you.
      </p>
      <Field
        label="server name"
        hint="What your friends will see this place called."
        value={serverName}
        onChange={setServerName}
        autoFocus
      />
      <Field label="username" value={username} onChange={setUsername} />
      <Field
        label="display name"
        value={displayName}
        onChange={setDisplayName}
      />
      <Field
        label="password"
        hint={`At least ${MIN_PASSWORD_CHARS} characters.`}
        value={password}
        onChange={setPassword}
        type="password"
      />
      <Problem message={error} />
      <button
        className="auth-go"
        type="submit"
        disabled={
          busy ||
          !serverName ||
          !username ||
          !displayName ||
          password.length < MIN_PASSWORD_CHARS
        }
      >
        {busy ? "setting up…" : "set up this server"}
      </button>
    </form>
  );
}

/** Which server this form is talking to, and the way back to the first screen. */
function Where({
  baseUrl,
  serverName,
  onBack,
}: {
  baseUrl: string;
  serverName: string | null;
  onBack: () => void;
}) {
  return (
    <div className="auth-where">
      <span className="meta">{serverName ?? hostOf(baseUrl)}</span>
      <button className="auth-back meta" type="button" onClick={onBack}>
        change
      </button>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  type = "text",
  placeholder,
  autoFocus,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "password";
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <label className="auth-field">
      <span className="panel-label">{label}</span>
      <input
        className="auth-input"
        type={type}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <span className="auth-hint">{hint}</span> : null}
    </label>
  );
}

function Problem({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="auth-problem" role="alert">
      {message}
    </p>
  );
}
