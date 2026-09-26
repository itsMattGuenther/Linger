import { useState } from "react";
import { MIN_PASSWORD_CHARS, passwordReady } from "../../../lib/account";
import { exportLine, type ExportPhase } from "../../../lib/export";
import { type UpdateCheck, updateLine } from "../../../lib/updates";
import { HEADINGS } from "../../core/settings";
import { Button, TextField } from "../../kit";
import { Actions, Block, Fields, Note, useSave } from "./parts";

export interface AccountProps {
  /** The server you sign in to, for the password's sentence. */
  serverName: string;
  /**
   * Change your password (SET-2). The wiring signs back in with the new one,
   * since a change ends every other sign-in; resolves to the problem in words, or null.
   */
  changePassword: (current: string, next: string) => Promise<string | null>;
  /** Taking everything with you (EXP-1, EXP-2): how it stands, and the two things to do. */
  archive: { phase: ExportPhase; start: () => void; download: (url: string) => void };
  /** Updates (UPD-1 to UPD-4, UPD-6). */
  updates: {
    /** This copy's version, or null outside the desktop app. */
    version: string | null;
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
  /** Sign out on this computer (SIGN-13). With several servers this is all of them. */
  signOut: () => void;
  severalServers: boolean;
  /** Add a server (SIGN-8). Offered here with one server; with several it's in Servers. */
  addServer?: () => void;
}

/** Account & App: your password, your archive, updates and this computer. */
export function AccountSection({ serverName, changePassword, archive, updates, signOut, severalServers, addServer }: AccountProps) {
  return (
    <>
      <Password serverName={serverName} changePassword={changePassword} />
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
      <Block
        heading={HEADINGS.updates}
        lead="Linger checks for a new version when you open this. Nothing is downloaded until you ask for it, and every update is checked against this project's signing key before it's installed."
      >
        <Note tone="status">{updates.version === null ? "Running outside the desktop app, so there's no version to update." : `You're on version ${updates.version}.`}</Note>
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
      <Block
        heading={HEADINGS.computer}
        lead={
          severalServers
            ? "Signing out forgets every server on this computer. It doesn't delete your accounts. Each server signs out on its own, in Servers."
            : "Signing out forgets this server on this computer. It doesn't delete your account."
        }
      >
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
    </>
  );
}

function Password({ serverName, changePassword }: { serverName: string; changePassword: AccountProps["changePassword"] }) {
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
    </Block>
  );
}
