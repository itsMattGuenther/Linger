import { type FormEvent, useState } from "react";
import { hostOf } from "../../../lib/link";
import { loginReady, MIN_PASSWORD_CHARS, registerReady, type SignInActions, type SignInStep, setupReady } from "../../core/signin";
import { Button, TextField, TitleBar } from "../../kit";
import { LogoMark } from "../LogoMark";
import "./SignInView.css";

export interface SignInViewProps {
  actions: SignInActions;
  /** Why the last sign-in ended, when it ended on its own (SIGN-11). */
  notice?: string | null;
  /** This computer can't remember a sign-in between runs (SIGN-9). */
  keyringNotice?: string | null;
  /** Adding another server: the way back to the list. Left out when there's nothing to go back to. */
  onCancel?: () => void;
  /** Where the desktop draws no close button, Linger draws its own. */
  onClose?: () => void;
}

/**
 * Signing in, in the list window (parity SIGN-1…6, SIGN-9, SIGN-11): one box
 * to paste into, and what's pasted decides the next form. The same screen adds
 * another server, with a way back to the list. Where it lives is decision 16;
 * the list window is the default until that's decided.
 */
export function SignInView({ actions, notice, keyringNotice, onCancel, onClose }: SignInViewProps) {
  const [step, setStep] = useState<SignInStep>({ kind: "paste" });
  const back = () => setStep({ kind: "paste" });

  return (
    <div className="nx-signin" data-screen="signin">
      <TitleBar leading={<LogoMark />} onClose={onClose}>
        Linger
      </TitleBar>
      <div className="nx-signin-body">
        {notice && step.kind === "paste" ? (
          <p className="nx-signin-notice" role="status">
            {notice}
          </p>
        ) : null}
        {step.kind === "paste" ? <Paste check={actions.check} onStep={setStep} onCancel={onCancel} /> : null}
        {step.kind === "login" ? <Login step={step} login={actions.login} onBack={back} /> : null}
        {step.kind === "register" ? <Register step={step} register={actions.register} onBack={back} /> : null}
        {step.kind === "setup" ? <Setup step={step} setup={actions.setup} onBack={back} /> : null}
        {keyringNotice ? (
          <p className="nx-signin-keyring" role="status">
            {keyringNotice} You'll have to sign in again next time.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** A form's send: busy while it runs, and the problem in words if it comes back with one. */
function useSend() {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const send = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setProblem(null);
    const said = await work();
    // Signed in: this screen is about to go, so there's nothing to reset.
    if (said !== null) {
      setProblem(said);
      setBusy(false);
    }
  };
  return { busy, problem, send, setProblem };
}

function Paste({
  check,
  onStep,
  onCancel,
}: {
  check: SignInActions["check"];
  onStep: (step: SignInStep) => void;
  onCancel?: () => void;
}) {
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pasted.trim() === "" || busy) return;
    setBusy(true);
    setProblem(null);
    const answer = await check(pasted);
    setBusy(false);
    if ("problem" in answer) setProblem(answer.problem);
    else onStep(answer.step);
  };
  return (
    <form className="nx-signin-form" onSubmit={(event) => void submit(event)} aria-label="Where to go">
      <div className="nx-signin-intro">
        <h1 className="nx-signin-title">Join your people.</h1>
        <p className="nx-signin-lead">Your invite is the way in.</p>
      </div>
      <TextField
        label="Server or link"
        value={pasted}
        onChange={setPasted}
        placeholder="linger.example"
        hint="An invite to join, or an address to sign in."
        error={problem ?? undefined}
        autoFocus
      />
      <Button variant="primary" type="submit" icon="go" busy={busy} disabled={pasted.trim() === ""} fill>
        Continue
      </Button>
      {onCancel ? (
        <Button variant="quiet" onClick={onCancel} fill>
          Back to the list
        </Button>
      ) : null}
      <p className="nx-signin-help">Setting up a new server? Paste the whole setup link from its logs, token and all.</p>
    </form>
  );
}

/** Which server this form is for, and the way back to the paste box. */
function Where({ baseUrl, serverName, onBack }: { baseUrl: string; serverName: string | null; onBack: () => void }) {
  return (
    <div className="nx-signin-where">
      <span className="nx-signin-server">{serverName ?? hostOf(baseUrl)}</span>
      <Button variant="quiet" size="sm" onClick={onBack}>
        Change
      </Button>
    </div>
  );
}

function Login({ step, login, onBack }: { step: Extract<SignInStep, { kind: "login" }>; login: SignInActions["login"]; onBack: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const { busy, problem, send } = useSend();
  const ready = loginReady(username, password) && !busy;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) void send(() => login(step.baseUrl, username, password));
  };
  return (
    <form className="nx-signin-form" onSubmit={submit} aria-label="Sign in">
      <Where baseUrl={step.baseUrl} serverName={step.serverName} onBack={onBack} />
      <TextField label="Username" value={username} onChange={setUsername} autoFocus literal />
      <TextField label="Password" type="password" value={password} onChange={setPassword} />
      <Problem words={problem} />
      <Button variant="primary" type="submit" busy={busy} disabled={!ready} fill>
        Sign in
      </Button>
    </form>
  );
}

function Register({
  step,
  register,
  onBack,
}: {
  step: Extract<SignInStep, { kind: "register" }>;
  register: SignInActions["register"];
  onBack: () => void;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const { busy, problem, send } = useSend();
  const ready = registerReady(username, displayName, password) && !busy;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) void send(() => register(step.baseUrl, step.code, username, displayName, password));
  };
  return (
    <form className="nx-signin-form" onSubmit={submit} aria-label="Join">
      <Where baseUrl={step.baseUrl} serverName={step.serverName} onBack={onBack} />
      <p className="nx-signin-lead">
        You're joining {step.serverName ?? hostOf(step.baseUrl)}. Pick a username people can mention you by, and the name they'll see in their lists.
      </p>
      <TextField label="Username" value={username} onChange={setUsername} hint="Lowercase letters, numbers and underscores. It can't change later." autoFocus literal />
      <TextField label="Display name" value={displayName} onChange={setDisplayName} />
      <TextField
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        hint={`At least ${MIN_PASSWORD_CHARS} characters. No rules about symbols.`}
      />
      <Problem words={problem} />
      <Button variant="primary" type="submit" busy={busy} disabled={!ready} fill>
        Join
      </Button>
    </form>
  );
}

function Setup({ step, setup, onBack }: { step: Extract<SignInStep, { kind: "setup" }>; setup: SignInActions["setup"]; onBack: () => void }) {
  const [serverName, setServerName] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const { busy, problem, send } = useSend();
  const ready = setupReady(serverName, username, displayName, password) && !busy;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) void send(() => setup(step.baseUrl, step.token, serverName, username, displayName, password));
  };
  return (
    <form className="nx-signin-form" onSubmit={submit} aria-label="Set up this server">
      <Where baseUrl={step.baseUrl} serverName={null} onBack={onBack} />
      <p className="nx-signin-lead">Nobody has set this server up yet. Whoever does becomes its host: that's you.</p>
      <TextField label="Server name" value={serverName} onChange={setServerName} hint="What your friends will see this place called." autoFocus />
      <TextField label="Username" value={username} onChange={setUsername} literal />
      <TextField label="Display name" value={displayName} onChange={setDisplayName} />
      <TextField
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        hint={`At least ${MIN_PASSWORD_CHARS} characters.`}
      />
      <Problem words={problem} />
      <Button variant="primary" type="submit" busy={busy} disabled={!ready} fill>
        Set up this server
      </Button>
    </form>
  );
}

function Problem({ words }: { words: string | null }) {
  return words ? (
    <p className="nx-signin-problem" role="alert">
      {words}
    </p>
  ) : null;
}
