import { useState } from "react";
import { MIN_PASSWORD_CHARS, passwordReady } from "../../../lib/account";
import { exportLine, type ExportPhase } from "../../../lib/export";
import { type UpdateCheck, updateLine } from "../../../lib/updates";
import { ignoredLine, type StartAtSignIn } from "../../core/autostart";
import { thisDevice } from "../../core/phone";
import { HEADINGS } from "../../core/settings";
import type { User } from "../../../generated/User";
import { Button, Checkbox, Name, SettingRow, Switch, TextField } from "../../kit";
import { Actions, Block, Fields, Note, SaveLine, useSave } from "./parts";

export interface AccountProps {
  /** The phone app: "this phone", and no updates or start at sign-in (SPEC §4.15). */
  phone?: boolean;
  /** The server you sign in to, for the password's sentence. */
  serverName: string;
  /**
   * This copy's version, or null outside the app. The desktop shows it with
   * Updates; the phone, which has none, under This Phone, since updating it
   * by hand starts with knowing which one you have (SPEC §4.15).
   */
  version: string | null;
  /**
   * Change your password (SET-2). The wiring signs back in with the new one,
   * since a change ends every other sign-in; resolves to the problem in words, or null.
   */
  changePassword: (current: string, next: string) => Promise<string | null>;
  /**
   * The last sign-in link somebody made you (#581), in words: who, when, and
   * whether it was used. Shown under your password, so one you didn't ask
   * for doesn't go unnoticed. Left out when there's none.
   */
  signInLink?: string | null;
  /** Taking everything with you (EXP-1, EXP-2): how it stands, and the two things to do. */
  archive: { phase: ExportPhase; start: () => void; download: (url: string) => void };
  /** Updates (UPD-1 to UPD-4, UPD-6). */
  /** Leave out on the phone, which its store updates (SPEC §4.15). */
  updates?: {
    check: UpdateCheck | null;
    looking: boolean;
    installing: boolean;
    /** Why an install didn't happen, in words. */
    problem: string | null;
    checkAgain: () => void;
    install: () => void;
    /** Open the release page for a version (#174). */
    openNotes: (version: string) => void;
  };
  /**
   * Start Linger when you sign in to the computer (#228), as the computer has
   * it. Left out where it isn't offered (a browser, macOS) and until the
   * computer has answered.
   */
  startAtSignIn?: StartAtSignIn & {
    onChange: (on: boolean) => void;
    /** Open the user guide's lines for a desktop that won't start Linger by itself. */
    openGuide: () => void;
  };
  /**
   * Who you've blocked on this server (T-1605), and unblocking one: null when
   * the server took it, or what went wrong in words. Shown only while there's
   * somebody on it.
   */
  blocked?: { people: readonly User[]; unblock: (id: User["id"]) => Promise<string | null> };
  /**
   * Delete your account on this server (#650, SPEC §4.19), after your
   * password, with what you wrote if `everything`. Resolves to the problem in
   * words, or null, after which the wiring signs this server out. `host` is
   * true for the host, who can't, and is told why instead; `outdated` for a
   * server from before it, which needs an update first.
   */
  deleteAccount?: { host: boolean; outdated: boolean; run: (password: string, everything: boolean) => Promise<string | null> };
  /** Sign out on this computer (SIGN-13). With several servers this is all of them. */
  signOut: () => void;
  severalServers: boolean;
  /** Add a server (SIGN-8). Offered here with one server; with several it's in Servers. */
  addServer?: () => void;
}

/** Account & App: your password, your archive, updates and this computer. */
export function AccountSection({
  serverName,
  version,
  changePassword,
  signInLink,
  archive,
  updates,
  startAtSignIn,
  blocked,
  deleteAccount,
  signOut,
  severalServers,
  addServer,
  phone = false,
}: AccountProps) {
  const device = thisDevice(phone);
  return (
    <>
      <Password serverName={serverName} changePassword={changePassword} signInLink={signInLink ?? null} />
      {blocked && blocked.people.length > 0 ? <Blocked serverName={serverName} {...blocked} /> : null}
      <Block
        heading={HEADINGS.archive}
        lead="Download public rooms and your own DMs, including shared files, as a zip. Messages open in any text editor. Available once an hour."
      >
        <Note tone={archive.phase.kind === "failed" ? "problem" : "status"}>{exportLine(archive.phase) || "Nothing built yet."}</Note>
        <Actions start>
          <Button busy={archive.phase.kind === "working"} onClick={archive.start}>
            Export everything
          </Button>
          {archive.phase.kind === "ready" ? (
            <Button
              variant="primary"
              icon="go"
              onClick={() => {
                if (archive.phase.kind === "ready") archive.download(archive.phase.url);
              }}
            >
              Download it
            </Button>
          ) : null}
        </Actions>
      </Block>
      {updates === undefined ? null : (
        <Block
          heading={HEADINGS.updates}
          lead="Linger checks for a new version when you open this. Nothing is downloaded until you ask for it, and every update is checked against this project's signing key before it's installed."
        >
          <Note tone="status">{version === null ? "Running outside the desktop app, so there's no version to update." : `You're on version ${version}.`}</Note>
          <Note tone={updates.problem ? "problem" : "status"}>{updates.problem ?? (updateLine(updates.check, updates.looking) || "Not checked yet.")}</Note>
          <Actions start>
            <Button disabled={updates.looking || updates.installing} busy={updates.looking} onClick={updates.checkAgain}>
              Check again
            </Button>
            {updates.check?.kind === "ready" ? (
              <>
                <Button
                  variant="quiet"
                  icon="go"
                  onClick={() => {
                    if (updates.check?.kind === "ready") updates.openNotes(updates.check.version);
                  }}
                >
                  What's new
                </Button>
                <Button variant="primary" busy={updates.installing} onClick={updates.install}>
                  Install and restart
                </Button>
              </>
            ) : null}
          </Actions>
        </Block>
      )}
      <Block heading={phone ? HEADINGS.phone : HEADINGS.computer}>
        {phone && version !== null ? <Note tone="status">{`You're on version ${version}.`}</Note> : null}
        {startAtSignIn ? (
          <>
            <SettingRow
              title={START_AT_SIGN_IN}
              description="Linger opens your list by itself each time you sign in to this computer."
              control={<Switch label={START_AT_SIGN_IN} checked={startAtSignIn.on} disabled={startAtSignIn.changing} onChange={startAtSignIn.onChange} />}
            />
            {startAtSignIn.problem ? <Note tone="problem">{startAtSignIn.problem}</Note> : null}
            {startAtSignIn.ignoredBy !== null ? (
              <>
                <Note tone="status">{ignoredLine(startAtSignIn.ignoredBy)}</Note>
                <Actions start>
                  <Button icon="go" onClick={startAtSignIn.openGuide}>
                    How to add it
                  </Button>
                </Actions>
              </>
            ) : null}
          </>
        ) : null}
        <p className="nx-set-lead">
          {severalServers
            ? `Signing out forgets every server on ${device}. It doesn't delete your accounts. Each server signs out on its own, in Servers.`
            : `Signing out forgets this server on ${device}. It doesn't delete your account.`}
        </p>
        <Actions start>
          {addServer && !severalServers ? (
            <Button icon="plus" onClick={addServer}>
              Add a server
            </Button>
          ) : null}
          <Button variant="danger" icon="leave" onClick={signOut}>
            {severalServers ? "Sign out of everything" : "Sign out"}
          </Button>
        </Actions>
      </Block>
      {deleteAccount ? <DeleteAccount serverName={serverName} device={device} archive={archive} {...deleteAccount} /> : null}
    </>
  );
}

/**
 * Deleting your account on this server (#650, SPEC §4.19). One button until
 * it's asked for; then what goes, the one box, a way to take a copy first,
 * and the password, so a borrowed, unlocked phone can't do it. The host
 * can't, and is told why instead.
 */
function DeleteAccount({
  serverName,
  device,
  archive,
  host,
  outdated,
  run,
}: { serverName: string; device: string; archive: AccountProps["archive"] } & NonNullable<AccountProps["deleteAccount"]>) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [everything, setEverything] = useState(false);
  const save = useSave();
  const working = save.phase.kind === "saving";
  const ready = password !== "" && !working;
  const submit = async () => {
    if (!ready) return;
    await save.run(run(password, everything));
  };

  if (host) {
    return (
      <Block heading={HEADINGS.deleteAccount}>
        <Note>
          {`You're the host, so your account on ${serverName} can't be deleted: the server would have nobody in charge. To close the server, shut it down and delete its data. The host guide says how.`}
        </Note>
      </Block>
    );
  }
  if (outdated) {
    return (
      <Block heading={HEADINGS.deleteAccount}>
        <Note>{`${serverName} needs an update before an account can be deleted from the app. Ask its host to update it.`}</Note>
      </Block>
    );
  }
  const copy = archive.phase;
  return (
    <Block heading={HEADINGS.deleteAccount} lead={`Deletes your account on ${serverName} for good, and signs ${device} out of it. Your accounts on other servers stay.`}>
      {open ? (
        <>
          <Note>Your name, status, style, sign-ins and settings here go at once, and can't be brought back. Your username stays taken, so nobody new can pass as you.</Note>
          <Checkbox checked={everything} disabled={working} onChange={setEverything}>
            Also delete everything I wrote
          </Checkbox>
          <Note>
            {everything
              ? "Your messages and the files on them go, and so do your reactions and your votes in polls still open."
              : "Left unticked, what you wrote stays where it is, and shows as “Deleted account”."}
          </Note>
          <Actions start>
            {copy.kind === "ready" ? (
              <Button icon="go" onClick={() => archive.download(copy.url)}>
                Download your copy
              </Button>
            ) : (
              <Button variant="quiet" busy={copy.kind === "working"} disabled={working} onClick={archive.start}>
                Download your copy first
              </Button>
            )}
          </Actions>
          {copy.kind === "idle" ? null : <Note tone={copy.kind === "failed" ? "problem" : "status"}>{exportLine(copy)}</Note>}
          <Fields>
            <TextField
              label="Your password"
              type="password"
              value={password}
              onChange={(value) => {
                setPassword(value);
                save.reset();
              }}
              onEnter={() => void submit()}
            />
          </Fields>
          <Actions phase={save.phase} saved="Deleted">
            <Button
              variant="quiet"
              disabled={working}
              onClick={() => {
                setOpen(false);
                setPassword("");
                setEverything(false);
                save.reset();
              }}
            >
              Keep my account
            </Button>
            <Button variant="danger" disabled={!ready} busy={working} onClick={() => void submit()}>
              Delete my account
            </Button>
          </Actions>
        </>
      ) : (
        <Actions start>
          <Button variant="danger" onClick={() => setOpen(true)}>
            {`Delete my account on ${serverName}…`}
          </Button>
        </Actions>
      )}
    </Block>
  );
}

/** The switch's words, as the issue asked for them: plain, for somebody who has never heard of autostart. */
const START_AT_SIGN_IN = "Start Linger when I sign in to the computer";

function Password({ serverName, changePassword, signInLink }: { serverName: string; changePassword: AccountProps["changePassword"]; signInLink: string | null }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const save = useSave();
  const ready = passwordReady(current, next) && save.phase.kind !== "saving";
  const submit = async () => {
    if (!ready) return;
    const ok = await save.run(changePassword(current, next));
    if (ok) {
      setCurrent("");
      setNext("");
    }
  };
  return (
    <Block heading={HEADINGS.password} lead={`The password you sign in to ${serverName} with.`}>
      <Fields>
        <TextField
          label="Current password"
          type="password"
          value={current}
          onChange={(value) => {
            setCurrent(value);
            save.reset();
          }}
        />
        <TextField
          label="New password"
          type="password"
          value={next}
          hint={`At least ${MIN_PASSWORD_CHARS} characters. No rules about symbols.`}
          onChange={(value) => {
            setNext(value);
            save.reset();
          }}
          onEnter={() => void submit()}
        />
      </Fields>
      <Actions phase={save.phase} saved="Password changed">
        <Button variant="primary" disabled={!ready} busy={save.phase.kind === "saving"} onClick={() => void submit()}>
          Change password
        </Button>
      </Actions>
      {signInLink ? <Note>{signInLink}</Note> : null}
    </Block>
  );
}

/**
 * Who you've blocked (T-1605): where a block is undone, besides the person's
 * own card. Only there while somebody's on it.
 */
function Blocked({ serverName, people, unblock }: { serverName: string } & NonNullable<AccountProps["blocked"]>) {
  const save = useSave();
  const busy = save.phase.kind === "saving";
  return (
    <Block heading={HEADINGS.blocked} lead={`Their messages fold into a grey line for you on ${serverName}, and their DMs and knocks don't reach you. They aren't told.`}>
      <ul className="nx-set-list" aria-label="Blocked">
        {people.map((person) => (
          <li key={person.id} className="nx-set-item">
            <div className="nx-set-item-line">
              <span className="nx-set-item-mark" />
              <Name person={person} />
              <span className="nx-set-item-sub nx-set-mono">@{person.username}</span>
              <span className="nx-set-item-buttons">
                <Button size="sm" disabled={busy} onClick={() => void save.run(unblock(person.id))}>
                  Unblock
                </Button>
              </span>
            </div>
          </li>
        ))}
      </ul>
      <SaveLine phase={save.phase.kind === "problem" ? save.phase : { kind: "idle" }} />
    </Block>
  );
}
