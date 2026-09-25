import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { Invite } from "../../../generated/Invite";
import type { PresenceState } from "../../../generated/PresenceState";
import type { Room } from "../../../generated/Room";
import type { RoomId } from "../../../generated/RoomId";
import type { User } from "../../../generated/User";
import { deadWords, expiryWords, useWords } from "../../../lib/host";
import { PALETTE_KEYS } from "../../../lib/palette";
import { HEADINGS, INVITE_EXPIRY, INVITE_USES } from "../../core/settings";
import { Button, HashMark, IconButton, Marker, markerOf, Name, Swatch, TextField } from "../../kit";
import { Actions, Block, ChoiceRow, Fields, Note, type SavePhase, SaveLine, useSave } from "./parts";

/**
 * Hosting: running the server from Settings (HOST-1 to HOST-9). A member
 * never sees these: they are absent, not greyed out, and the server refuses
 * every one of them to anybody but the host (HOST-10).
 */

/** Escape backs out of an inline form or a question and returns focus to what opened it. */
function useBackOut(onBack: () => void, returnTo: () => HTMLElement | null | undefined) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onBack();
    requestAnimationFrame(() => returnTo()?.focus());
  };
}

// ---------------------------------------------------------------------------
// Rooms

export interface HostRoomsProps {
  /** The server's rooms, not archived, in their order. */
  rooms: readonly Room[];
  create: (room: { slug: string; name: string; topic: string | null }) => Promise<string | null>;
  update: (id: RoomId, change: { name: string; topic: string }) => Promise<string | null>;
  move: (id: RoomId, delta: -1 | 1) => Promise<string | null>;
  archive: (id: RoomId) => Promise<string | null>;
}

export function RoomsSection({ rooms, create, update, move, archive }: HostRoomsProps) {
  const [editing, setEditing] = useState<RoomId | null>(null);
  const [asking, setAsking] = useState<RoomId | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const save = useSave();
  const busy = save.phase.kind === "saving";
  const buttonOf = (id: RoomId, what: "edit" | "archive") => list.current?.querySelector<HTMLElement>(`[data-room="${CSS.escape(id)}"] [data-do="${what}"] button`);

  return (
    <>
      <NewRoom create={create} />
      <Block heading={HEADINGS.rooms} lead="The order everyone's list shows them in.">
        {rooms.length === 0 ? (
          <Note>No rooms yet. The one above will be the first.</Note>
        ) : (
          <ul className="nx-set-list" ref={list} aria-label="Rooms">
            {rooms.map((room, index) => (
              <li key={room.id} className="nx-set-item" data-room={room.id}>
                {editing === room.id ? (
                  <EditRoom
                    room={room}
                    update={update}
                    onDone={() => {
                      setEditing(null);
                      requestAnimationFrame(() => buttonOf(room.id, "edit")?.focus());
                    }}
                  />
                ) : (
                  <>
                    <div className="nx-set-item-line">
                      <HashMark />
                      <span className="nx-set-item-name">{room.name}</span>
                      <span className="nx-set-item-sub">{room.topic ?? ""}</span>
                      {asking === room.id ? null : (
                        <span className="nx-set-item-buttons">
                          <IconButton icon="up" label={`Move #${room.name} up`} size="sm" disabled={busy || index === 0} onClick={() => void save.run(move(room.id, -1))} />
                          <IconButton
                            icon="down"
                            label={`Move #${room.name} down`}
                            size="sm"
                            disabled={busy || index === rooms.length - 1}
                            onClick={() => void save.run(move(room.id, 1))}
                          />
                          <span data-do="edit">
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() => {
                                setAsking(null);
                                setEditing(room.id);
                              }}
                            >
                              Edit
                            </Button>
                          </span>
                          <span data-do="archive">
                            <Button size="sm" disabled={busy} onClick={() => setAsking(room.id)}>
                              Archive
                            </Button>
                          </span>
                        </span>
                      )}
                    </div>
                    {asking === room.id ? (
                      <Question
                        words={`Archive #${room.name} for everyone? There's no way to bring a room back.`}
                        yes="Yes, archive"
                        no="Keep it"
                        busy={busy}
                        onYes={() => void save.run(archive(room.id)).then((ok) => ok && setAsking(null))}
                        onNo={() => {
                          setAsking(null);
                          requestAnimationFrame(() => buttonOf(room.id, "archive")?.focus());
                        }}
                      />
                    ) : null}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <SaveLine phase={save.phase.kind === "problem" ? save.phase : { kind: "idle" }} />
        <Note>Archiving takes a room off everyone's list. What was written in it stays, and comes with an export, but the room can't be put back.</Note>
      </Block>
    </>
  );
}

function NewRoom({ create }: { create: HostRoomsProps["create"] }) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const save = useSave();
  const ready = slug.trim() !== "" && save.phase.kind !== "saving";
  const submit = async () => {
    if (!ready) return;
    const ok = await save.run(create({ slug: slug.trim(), name: name.trim() === "" ? slug.trim() : name.trim(), topic: topic.trim() === "" ? null : topic.trim() }));
    if (ok) {
      setSlug("");
      setName("");
      setTopic("");
    }
  };
  const typed = (set: (value: string) => void) => (value: string) => {
    set(value);
    if (save.phase.kind !== "saving") save.reset();
  };
  return (
    <Block heading={HEADINGS.newRoom}>
      <Fields>
        <TextField label="Slug" mono value={slug} placeholder="porch" hint="What people type after the #." onChange={typed(setSlug)} onEnter={() => void submit()} />
        <TextField label="Name" value={name} placeholder={slug.trim() || "porch"} hint="Defaults to the slug." onChange={typed(setName)} onEnter={() => void submit()} />
      </Fields>
      <TextField label="Topic" value={topic} placeholder="Pull up a chair." hint="Optional. Sits in the room's header." onChange={typed(setTopic)} onEnter={() => void submit()} />
      <Actions phase={save.phase} saved="Made">
        <Button variant="primary" icon="plus" disabled={!ready} busy={save.phase.kind === "saving"} onClick={() => void submit()}>
          Make the room
        </Button>
      </Actions>
    </Block>
  );
}

function EditRoom({ room, update, onDone }: { room: Room; update: HostRoomsProps["update"]; onDone: () => void }) {
  const [name, setName] = useState(room.name);
  const [topic, setTopic] = useState(room.topic ?? "");
  const save = useSave();
  const busy = save.phase.kind === "saving";
  const submit = async () => {
    if (busy || name.trim() === "") return;
    // The server writes any topic it's handed, so "" is how a topic is cleared.
    if (await save.run(update(room.id, { name: name.trim(), topic: topic.trim() }))) onDone();
  };
  const onKeyDown = useBackOut(onDone, () => null);
  return (
    <div className="nx-set-edit" role="group" aria-label={`Editing #${room.name}`} onKeyDown={onKeyDown}>
      <Fields>
        <TextField label="Name" value={name} autoFocus onChange={setName} onEnter={() => void submit()} />
        <TextField label="Topic" value={topic} placeholder="No topic" onChange={setTopic} onEnter={() => void submit()} />
      </Fields>
      <Actions phase={save.phase}>
        <Button variant="quiet" size="sm" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={name.trim() === ""} busy={busy} onClick={() => void submit()}>
          Save
        </Button>
      </Actions>
    </div>
  );
}

/** A yes-or-no asked in place: the question, then the two answers. Escape is "no". */
function Question({ words, yes, no, busy, onYes, onNo }: { words: string; yes: string; no: string; busy: boolean; onYes: () => void; onNo: () => void }) {
  const first = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    first.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);
  const onKeyDown = useBackOut(onNo, () => null);
  return (
    <div className="nx-set-question" role="group" aria-label={words} onKeyDown={onKeyDown}>
      <p className="nx-set-question-words">{words}</p>
      <div className="nx-set-buttons" ref={first}>
        <Button size="sm" disabled={busy} onClick={onNo}>
          {no}
        </Button>
        <Button size="sm" variant="danger" busy={busy} onClick={onYes}>
          {yes}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invites

export interface HostInvitesProps {
  /** Links you've made, newest first; null while they're being read. */
  invites: readonly Invite[] | null;
  /** The link to paste for a code (lib/host.ts, `inviteUrl`). */
  linkOf: (code: string) => string;
  /** Who made an invite, by name. */
  nameOf: (userId: string) => string;
  now: number;
  /** Make a link. The wiring puts it on the clipboard and says whether that worked. */
  create: (choice: { uses: number | null; hours: number | null }) => Promise<{ code: string; copied: boolean } | { problem: string }>;
  /** Put a link on the clipboard. False when the clipboard refused. */
  copy: (code: string) => Promise<boolean>;
  revoke: (code: string) => Promise<string | null>;
}

export function InvitesSection({ invites, linkOf, nameOf, now, create, copy, revoke }: HostInvitesProps) {
  const [uses, setUses] = useState<number | null>(1);
  const [hours, setHours] = useState<number | null>(24 * 7);
  const [copied, setCopied] = useState<string | null>(null);
  const making = useSave();
  const list = useSave();

  const make = async () => {
    const pending = create({ uses, hours });
    const done = await making.run(pending.then((result) => ("problem" in result ? result.problem : null)));
    if (!done) return;
    const result = await pending;
    if ("code" in result) {
      setCopied(result.copied ? result.code : null);
      if (!result.copied) making.fail("Made. The clipboard said no: copy the link below yourself.");
    }
  };

  const copyOne = (code: string) =>
    void copy(code).then((ok) => {
      setCopied(ok ? code : null);
      if (!ok) list.fail("Couldn't reach the clipboard. Select the link and copy it yourself.");
    });

  return (
    <>
      <Block heading={HEADINGS.newInvite}>
        <div className="nx-set-look">
          <ChoiceRow label="Good for">
            {INVITE_USES.map((choice) => (
              <Button key={choice.label} size="sm" pressed={uses === choice.uses} onClick={() => setUses(choice.uses)}>
                {choice.label}
              </Button>
            ))}
          </ChoiceRow>
          <ChoiceRow label="Expires after">
            {INVITE_EXPIRY.map((choice) => (
              <Button key={choice.label} size="sm" pressed={hours === choice.hours} onClick={() => setHours(choice.hours)}>
                {choice.label}
              </Button>
            ))}
          </ChoiceRow>
        </div>
        <Actions phase={making.phase} saved="Made, and copied">
          <Button variant="primary" icon="link" busy={making.phase.kind === "saving"} onClick={() => void make()}>
            Make a link
          </Button>
        </Actions>
      </Block>
      <Block heading={HEADINGS.links}>
        {invites === null ? (
          <Note tone="status">Reading your links…</Note>
        ) : invites.length === 0 ? (
          <Note>No links yet. Make one above.</Note>
        ) : (
          <ul className="nx-set-list" aria-label="Invite links">
            {invites.map((invite) => {
              const dead = deadWords(invite, now);
              return (
                <li key={invite.code} className="nx-set-item" data-dead={dead ? "yes" : undefined}>
                  <div className="nx-set-item-line">
                    <InviteLink link={linkOf(invite.code)} code={invite.code} />
                    <span className="nx-set-item-buttons">
                      {dead === null ? (
                        <>
                          <Button size="sm" icon={copied === invite.code ? "check" : undefined} onClick={() => copyOne(invite.code)}>
                            {copied === invite.code ? "Copied" : "Copy"}
                          </Button>
                          <Button size="sm" variant="danger" disabled={list.phase.kind === "saving"} onClick={() => void list.run(revoke(invite.code))}>
                            Revoke
                          </Button>
                        </>
                      ) : null}
                    </span>
                  </div>
                  <p className="nx-set-item-meta">
                    {dead === null ? `${useWords(invite)} · ${expiryWords(invite, now)}` : `${dead} · ${useWords(invite)}`} · made by {nameOf(invite.created_by)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        <SaveLine phase={list.phase.kind === "problem" ? list.phase : { kind: "idle" }} />
      </Block>
    </>
  );
}

/**
 * A link, drawn so its code always shows: the address before it gives way
 * first, and the scheme isn't drawn at all. Selecting it selects the whole
 * link, which is what gets pasted.
 */
function InviteLink({ link, code }: { link: string; code: string }) {
  const shown = link.replace(/^https?:\/\//, "");
  const base = shown.endsWith(code) ? shown.slice(0, shown.length - code.length) : shown;
  return (
    <span className="nx-set-link" title={link}>
      <span className="nx-set-link-base">{base}</span>
      {shown.endsWith(code) ? <span className="nx-set-link-code">{code}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// People

export interface HostPeopleProps {
  /** Everyone on the server, you included. */
  members: readonly User[];
  meId: string;
  /** Where each person is, for their marker. */
  presenceOf: (userId: string) => PresenceState;
  /** People who've been removed; null while being read. */
  removed: readonly User[] | null;
  remove: (userId: string) => Promise<string | null>;
  restore: (userId: string) => Promise<string | null>;
}

export function PeopleSection({ members, meId, presenceOf, removed, remove, restore }: HostPeopleProps) {
  const [asking, setAsking] = useState<string | null>(null);
  const save = useSave();
  const busy = save.phase.kind === "saving";
  const list = useRef<HTMLUListElement | null>(null);
  const ordered = [...members].sort((a, b) => Number(b.id === meId) - Number(a.id === meId) || a.display_name.localeCompare(b.display_name));

  return (
    <>
      <Block heading={HEADINGS.members}>
        <ul className="nx-set-list" ref={list} aria-label="Members">
          {ordered.map((person) => (
            <li key={person.id} className="nx-set-item" data-person={person.id}>
              <div className="nx-set-item-line">
                <span className="nx-set-item-mark">
                  <Marker {...markerOf(person, presenceOf(person.id))} size="md" />
                </span>
                <Name person={person} />
                <span className="nx-set-item-sub nx-set-mono">@{person.username}</span>
                <span className="nx-set-item-buttons">
                  {person.id === meId ? (
                    <span className="nx-set-tag">You, the host</span>
                  ) : person.is_host ? (
                    <span className="nx-set-tag">The host</span>
                  ) : asking === person.id ? null : (
                    <span data-do="remove">
                      <Button size="sm" disabled={busy} onClick={() => setAsking(person.id)}>
                        Remove from the server
                      </Button>
                    </span>
                  )}
                </span>
              </div>
              {asking === person.id ? (
                <Question
                  words={`Remove ${person.display_name} from this server? They lose their sign-in and any invite links they made. What they wrote stays, and you can let them back in below.`}
                  yes="Yes, remove"
                  no="Keep them"
                  busy={busy}
                  onYes={() => void save.run(remove(person.id)).then((ok) => ok && setAsking(null))}
                  onNo={() => {
                    setAsking(null);
                    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-person="${CSS.escape(person.id)}"] [data-do="remove"] button`)?.focus());
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
        <SaveLine phase={save.phase.kind === "problem" ? save.phase : { kind: "idle" }} />
      </Block>
      <Block heading={HEADINGS.removed}>
        {removed === null ? (
          <Note tone="status">Reading who has been removed…</Note>
        ) : removed.length === 0 ? (
          <Note>Nobody has been removed.</Note>
        ) : (
          <ul className="nx-set-list" aria-label="Removed">
            {removed.map((person) => (
              <li key={person.id} className="nx-set-item">
                <div className="nx-set-item-line">
                  {/* An empty lead, so these names start where the members' names do. */}
                  <span className="nx-set-item-mark" />
                  <Name person={person} />
                  <span className="nx-set-item-sub nx-set-mono">@{person.username}</span>
                  <span className="nx-set-item-buttons">
                    <Button size="sm" disabled={busy} onClick={() => void save.run(restore(person.id))}>
                      Let them back in
                    </Button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        <Note>
          Letting somebody back in isn't an undo. Their old sign-ins stay ended and the invite links they made stay revoked, so they sign in again with their
          password. Their username is the one they always had, and everything they wrote is where they left it.
        </Note>
      </Block>
    </>
  );
}

// ---------------------------------------------------------------------------
// The server

export interface HostServerProps {
  name: string;
  /** A palette key, or null for none (HOST-9). */
  accent: string | null;
  save: (change: { name: string; accent: string | null }) => Promise<string | null>;
}

export function ServerSection({ name: savedName, accent: savedAccent, save: saveServer }: HostServerProps) {
  const [name, setName] = useState(savedName);
  const [accent, setAccent] = useState<string | null>(savedAccent);
  const save = useSave();
  const dirty = name.trim() !== savedName || accent !== savedAccent;
  useEffect(() => {
    // Follow what's saved only while you haven't changed anything since: a
    // save that lands while you're choosing again must not undo your choice.
    if (!dirty) {
      setName(savedName);
      setAccent(savedAccent);
    }
    // `dirty` is left out on purpose: this follows the saved values, not the form.
  }, [savedName, savedAccent]);
  const ready = dirty && name.trim() !== "" && save.phase.kind !== "saving";
  const submit = () => {
    if (ready) void save.run(saveServer({ name: name.trim(), accent }));
  };
  const change = (next: { name?: string; accent?: string | null }) => {
    if (next.name !== undefined) setName(next.name);
    if (next.accent !== undefined) setAccent(next.accent);
    save.reset();
  };
  return (
    <>
      <Block heading={HEADINGS.serverName}>
        <TextField label="Server name" hideLabel value={name} hint="What the list says, and what an invite link tells a stranger." onChange={(value) => change({ name: value })} onEnter={submit} />
      </Block>
      <Block heading={HEADINGS.accent} lead="Its color in people's lists: the stripe beside its name, and along its tabs. Everyone keeps their own name colors.">
        <div className="nx-set-swatches" role="group" aria-label="Accent color">
          {PALETTE_KEYS.map((key) => (
            <Swatch key={key} colorKey={key} label={key} pressed={accent === key} onClick={() => change({ accent: accent === key ? null : key })} />
          ))}
        </div>
        <p className="nx-set-accent-name">{accent === null ? "No accent" : accent}</p>
        <Actions phase={save.phase satisfies SavePhase}>
          {accent !== null ? (
            <Button variant="quiet" onClick={() => change({ accent: null })}>
              No accent
            </Button>
          ) : null}
          <Button variant="primary" disabled={!ready} busy={save.phase.kind === "saving"} onClick={submit}>
            Save
          </Button>
        </Actions>
      </Block>
    </>
  );
}
