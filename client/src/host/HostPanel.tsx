/**
 * Running the server from inside the app (T-410).
 *
 * Three jobs that used to need `curl`: making and reshaping rooms, handing out
 * invite links, and naming the server. They share one panel because they are
 * one job — being the host — and because a settings screen per noun is three
 * screens nobody can find.
 *
 * The panel takes over the stream column rather than floating above it. There
 * is no modal stack in this product, and the roster stays reachable while you
 * work, which matters: an invite is something you make *for* somebody.
 *
 * **Host-only, and absent rather than greyed out.** Every endpoint under here
 * answers `FORBIDDEN` to anybody else — that is the lock. A disabled control is
 * a permission matrix drawn in CSS, and this product does not have one (AGENTS
 * rule 10, SPEC §2 anti-goals), so a member never sees the door at all.
 */
import { type ReactNode, useCallback, useEffect, useState } from "react";

import type { Invite } from "../generated/Invite";
import type { Room } from "../generated/Room";
import type { RoomId } from "../generated/RoomId";
import type { ServerInfo } from "../generated/ServerInfo";
import type { User } from "../generated/User";
import { ApiError, type AuthedApi } from "../lib/api";
import { useNow } from "../lib/clock";
import { useGateway } from "../lib/gateway";
import { nameProps } from "../lib/names";
import { colorVar, PALETTE_KEYS } from "../lib/palette";
import { deadWords, expiryWords, inviteUrl, moveRoom, useWords } from "./host";
import "./host.css";
import Removal from "./Removal";

export type HostSection = "rooms" | "invites" | "people" | "server";

const SECTIONS: Array<{ key: HostSection; label: string }> = [
  { key: "rooms", label: "rooms" },
  { key: "invites", label: "invites" },
  { key: "people", label: "people" },
  { key: "server", label: "server" },
];

/** The server's own words when it has any (PROTOCOL §1), ours when it doesn't. */
function problemText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export default function HostPanel({
  api,
  rooms,
  server,
  section,
  onSection,
  onServerChange,
  onClose,
}: {
  api: AuthedApi;
  /** Live from the gateway, so anything saved here shows up here too. */
  rooms: Room[];
  server: ServerInfo | null;
  section: HostSection;
  onSection: (section: HostSection) => void;
  onServerChange: (server: ServerInfo) => void;
  onClose: () => void;
}) {
  return (
    <main className="stream host">
      <header className="stream-header host-head">
        <h2 className="panel-label">Host tools</h2>
        <nav className="host-tabs">
          {SECTIONS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className="host-tab meta"
              aria-pressed={tab.key === section}
              onClick={() => onSection(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <button type="button" className="host-close meta" onClick={onClose}>
          close
        </button>
      </header>
      <div className="host-body">
        {section === "rooms" ? <RoomsSection api={api} rooms={rooms} /> : null}
        {section === "invites" ? <InvitesSection api={api} /> : null}
        {section === "people" ? <PeopleSection api={api} /> : null}
        {section === "server" ? (
          <ServerSection api={api} server={server} onSaved={onServerChange} />
        ) : null}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/**
 * The rail's contents, editable.
 *
 * Nothing here keeps its own copy of the room list. Every save goes to the
 * server, the server fans a `room.create`/`room.update` out to everybody, and
 * this panel re-renders off the same store the rail does — so the rail and this
 * list cannot disagree, and the other client sees it too.
 */
function RoomsSection({ api, rooms }: { api: AuthedApi; rooms: Room[] }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<RoomId | null>(null);
  const [archiving, setArchiving] = useState<RoomId | null>(null);

  const run = async (
    what: () => Promise<unknown>,
    fallback: string,
  ): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    try {
      await what();
      return true;
    } catch (error) {
      setProblem(problemText(error, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const move = (room: Room, delta: -1 | 1): void => {
    const changes = moveRoom(rooms, room.id, delta);
    if (changes.length === 0) return;
    void run(async () => {
      // One at a time. `PATCH /rooms/:id` moves one room, and the single-writer
      // discipline on the server means firing these in parallel buys nothing.
      for (const change of changes) {
        await api.updateRoom(change.id, {
          name: null,
          topic: null,
          position: change.position,
        });
      }
    }, "Couldn't reorder the rooms.");
  };

  return (
    <div className="host-section">
      <NewRoom api={api} onProblem={setProblem} />

      <h3 className="panel-label host-label">the rail</h3>
      {rooms.length === 0 ? (
        <p className="placeholder">No rooms yet. The one above is the first.</p>
      ) : (
        <ul className="host-list">
          {rooms.map((room, index) => (
            <li className="host-room" key={room.id}>
              {editing === room.id ? (
                <EditRoom
                  api={api}
                  room={room}
                  busy={busy}
                  onProblem={setProblem}
                  onDone={() => setEditing(null)}
                />
              ) : (
                <div className="host-room-row">
                  <span className="host-room-slug">#{room.slug}</span>
                  <span className="host-room-name">{room.name}</span>
                  <span className="host-room-topic meta">
                    {room.topic ?? ""}
                  </span>
                  <span className="host-room-actions">
                    <button
                      type="button"
                      className="host-mini meta"
                      disabled={busy || index === 0}
                      aria-label={`Move #${room.slug} up`}
                      onClick={() => move(room, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="host-mini meta"
                      disabled={busy || index === rooms.length - 1}
                      aria-label={`Move #${room.slug} down`}
                      onClick={() => move(room, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="host-mini meta"
                      disabled={busy}
                      onClick={() => {
                        setArchiving(null);
                        setEditing(room.id);
                      }}
                    >
                      edit
                    </button>
                    {archiving === room.id ? (
                      <>
                        <button
                          type="button"
                          className="host-mini host-danger meta"
                          disabled={busy}
                          onClick={() => {
                            void run(
                              () => api.archiveRoom(room.id),
                              "Couldn't archive that room.",
                            ).then((ok) => {
                              if (ok) setArchiving(null);
                            });
                          }}
                        >
                          yes, archive
                        </button>
                        <button
                          type="button"
                          className="host-mini meta"
                          disabled={busy}
                          onClick={() => setArchiving(null)}
                        >
                          keep it
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="host-mini meta"
                        disabled={busy}
                        onClick={() => setArchiving(room.id)}
                      >
                        archive
                      </button>
                    )}
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Archiving is the only delete this product has (SPEC §4.1), and it is
          one-way: there is no endpoint that brings a room back. Saying so
          before the click is cheaper than an apology after it. */}
      <p className="host-note meta">
        Archiving takes a room off the rail for everybody. Everything written in
        it stays in the database and in an export — but there is no way to put
        the room back.
      </p>

      {problem === null ? null : <p className="host-problem">{problem}</p>}
    </div>
  );
}

function NewRoom({
  api,
  onProblem,
}: {
  api: AuthedApi;
  onProblem: (problem: string | null) => void;
}) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    onProblem(null);
    try {
      await api.createRoom({
        slug: slug.trim(),
        name: name.trim() === "" ? slug.trim() : name.trim(),
        topic: topic.trim() === "" ? null : topic.trim(),
      });
      setSlug("");
      setName("");
      setTopic("");
    } catch (error) {
      // The slug rules live on the server and only there — this form has no
      // second copy of them, so the server's refusal is the whole explanation.
      onProblem(problemText(error, "Couldn't make that room."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="host-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && slug.trim() !== "") void submit();
      }}
    >
      <h3 className="panel-label host-label">new room</h3>
      <div className="host-fields">
        <Field label="slug" hint="What people type after the #.">
          <input
            type="text"
            className="host-input"
            value={slug}
            disabled={busy}
            onChange={(event) => setSlug(event.target.value)}
          />
        </Field>
        <Field label="name" hint="Defaults to the slug.">
          <input
            type="text"
            className="host-input"
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
      </div>
      <Field label="topic" hint="Optional. Sits in the room's header.">
        <input
          type="text"
          className="host-input"
          value={topic}
          disabled={busy}
          onChange={(event) => setTopic(event.target.value)}
        />
      </Field>
      <div className="host-actions">
        <button
          type="submit"
          className="host-save"
          disabled={busy || slug.trim() === ""}
        >
          {busy ? "making…" : "make the room"}
        </button>
      </div>
    </form>
  );
}

function EditRoom({
  api,
  room,
  busy,
  onProblem,
  onDone,
}: {
  api: AuthedApi;
  room: Room;
  busy: boolean;
  onProblem: (problem: string | null) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(room.name);
  const [topic, setTopic] = useState(room.topic ?? "");
  const [saving, setSaving] = useState(false);

  const submit = async (): Promise<void> => {
    setSaving(true);
    onProblem(null);
    try {
      await api.updateRoom(room.id, {
        name: name.trim(),
        // The server writes any topic it is handed, so "" is how a topic gets
        // cleared. `null` means "leave it alone", which is a different answer.
        topic: topic.trim(),
        position: null,
      });
      onDone();
    } catch (error) {
      onProblem(problemText(error, "Couldn't save that room."));
      setSaving(false);
    }
  };

  return (
    <form
      className="host-room-edit"
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving) void submit();
      }}
    >
      {/* The slug is not editable: it is in every link anybody has ever sent
          for this room, and renaming it would break them silently. */}
      <span className="host-room-slug">#{room.slug}</span>
      <input
        type="text"
        className="host-input"
        aria-label="Room name"
        value={name}
        disabled={busy || saving}
        onChange={(event) => setName(event.target.value)}
      />
      <input
        type="text"
        className="host-input"
        aria-label="Room topic"
        placeholder="topic"
        value={topic}
        disabled={busy || saving}
        onChange={(event) => setTopic(event.target.value)}
      />
      <button
        type="submit"
        className="host-mini meta"
        disabled={busy || saving}
      >
        {saving ? "saving…" : "save"}
      </button>
      <button
        type="button"
        className="host-mini meta"
        disabled={saving}
        onClick={onDone}
      >
        cancel
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

const EXPIRY_CHOICES: Array<{ label: string; hours: number | null }> = [
  { label: "a day", hours: 24 },
  { label: "a week", hours: 24 * 7 },
  { label: "never", hours: null },
];

const USE_CHOICES: Array<{ label: string; uses: number | null }> = [
  { label: "one person", uses: 1 },
  { label: "five people", uses: 5 },
  { label: "anyone", uses: null },
];

/**
 * The screen's whole job is to produce a link you can paste into a text
 * message. So the link is the widest thing on every row, it sits in a box you
 * can select from even though the rest of the app is unselectable, and the copy
 * button is the only thing next to it.
 */
function InvitesSection({ api }: { api: AuthedApi }) {
  const now = useNow();
  const gateway = useGateway(api.baseUrl);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expiry, setExpiry] = useState<number | null>(24 * 7);
  const [uses, setUses] = useState<number | null>(1);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        setInvites(await api.invites(signal));
      } catch (error) {
        if (signal?.aborted) return;
        setProblem(problemText(error, "Couldn't read the invites."));
      }
    },
    [api],
  );

  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);

  const create = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const made = await api.createInvite({
        expires_in_hours: expiry,
        max_uses: uses,
      });
      setInvites((held) => [made, ...(held ?? [])]);
      // The link is what you came for, so it arrives already on the clipboard.
      if (await copyText(inviteUrl(api.baseUrl, made.code)))
        setCopied(made.code);
    } catch (error) {
      setProblem(problemText(error, "Couldn't make an invite."));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (code: string): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await api.revokeInvite(code);
      await load();
    } catch (error) {
      setProblem(problemText(error, "Couldn't revoke that invite."));
    } finally {
      setBusy(false);
    }
  };

  const copy = (code: string): void => {
    void copyText(inviteUrl(api.baseUrl, code)).then((ok) => {
      setCopied(ok ? code : null);
      if (!ok)
        setProblem(
          "Couldn't reach the clipboard. Select the link and copy it yourself.",
        );
    });
  };

  const nameOf = (id: string): string =>
    gateway.users.find((person) => person.id === id)?.display_name ?? "someone";

  return (
    <div className="host-section">
      <form
        className="host-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void create();
        }}
      >
        <h3 className="panel-label host-label">new invite</h3>
        <div className="host-fields">
          <Choice
            label="good for"
            options={USE_CHOICES.map((choice) => ({
              label: choice.label,
              on: choice.uses === uses,
              pick: () => setUses(choice.uses),
            }))}
            disabled={busy}
          />
          <Choice
            label="expires after"
            options={EXPIRY_CHOICES.map((choice) => ({
              label: choice.label,
              on: choice.hours === expiry,
              pick: () => setExpiry(choice.hours),
            }))}
            disabled={busy}
          />
        </div>
        <div className="host-actions">
          <button type="submit" className="host-save" disabled={busy}>
            {busy ? "making…" : "make a link"}
          </button>
        </div>
      </form>

      <h3 className="panel-label host-label">links you have made</h3>
      {invites === null ? (
        <p className="placeholder">reading…</p>
      ) : invites.length === 0 ? (
        <p className="placeholder">
          No invites yet. The button above makes one.
        </p>
      ) : (
        <ul className="host-list">
          {invites.map((invite) => {
            const dead = deadWords(invite, now);
            return (
              <li
                className="host-invite"
                key={invite.code}
                data-dead={dead ? "true" : undefined}
              >
                <div className="host-invite-link">
                  <input
                    className="host-input host-link"
                    readOnly
                    aria-label={`Invite link ${invite.code}`}
                    value={inviteUrl(api.baseUrl, invite.code)}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <button
                    type="button"
                    className="host-mini meta"
                    disabled={dead !== null}
                    onClick={() => copy(invite.code)}
                  >
                    {copied === invite.code ? "copied" : "copy"}
                  </button>
                  {dead === null ? (
                    <button
                      type="button"
                      className="host-mini host-danger meta"
                      disabled={busy}
                      onClick={() => void revoke(invite.code)}
                    >
                      revoke
                    </button>
                  ) : null}
                </div>
                <p className="host-invite-life meta">
                  {dead === null
                    ? `${useWords(invite)} · ${expiryWords(invite, now)}`
                    : `${dead} · ${useWords(invite)}`}
                  {` · from ${nameOf(invite.created_by)}`}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {problem === null ? null : <p className="host-problem">{problem}</p>}
    </div>
  );
}

/**
 * Onto the clipboard, or honestly not.
 *
 * The Clipboard API needs a secure context and a permission the WebView may
 * refuse, and a copy button that silently does nothing is worse than no button
 * — so the answer is a boolean and the caller says so. The link is in a
 * selectable box either way, which is the fallback that always works.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/**
 * Membership changes belong in Host tools, away from everyday member cards.
 * The live list and removed list share this surface so the way back is clear.
 */
function PeopleSection({ api }: { api: AuthedApi }) {
  const gateway = useGateway(api.baseUrl);
  const [removed, setRemoved] = useState<User[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        setRemoved(await api.removedUsers(signal));
      } catch (error) {
        if (signal?.aborted) return;
        setProblem(problemText(error, "Couldn't read who has been removed."));
      }
    },
    [api],
  );

  // Who is *here* is the one thing that tells us this list has gone stale:
  // both removing and restoring somebody change it. The ids rather than the
  // array, so a display-name save is not a refetch.
  const here = gateway.users
    .map((person) => person.id)
    .sort()
    .join(" ");

  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load, here]);

  const restore = async (person: User): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await api.restoreUser(person.id);
      await load();
    } catch (error) {
      setProblem(problemText(error, "Couldn't let them back in."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="host-section">
      <h3 className="panel-label host-label">Members</h3>
      <p className="host-note">
        Manage who can use this server. Removing someone requires confirmation.
      </p>
      <ul className="host-list">
        {gateway.users
          .filter((person) => !person.is_host)
          .map((person) => (
            <li className="host-member" key={person.id}>
              <span {...nameProps(person, "host-person-name")}>
                {person.display_name}
              </span>
              <span className="host-person-username meta">
                {" "}
                @{person.username}
              </span>
              <Removal api={api} user={person} />
            </li>
          ))}
      </ul>
      <h3 className="panel-label host-label">removed</h3>
      {removed === null ? (
        <p className="placeholder">reading…</p>
      ) : removed.length === 0 ? (
        <p className="placeholder">Nobody has been removed.</p>
      ) : (
        <ul className="host-list">
          {removed.map((person) => (
            <li className="host-person" key={person.id}>
              <span {...nameProps(person, "host-person-name")}>
                {person.display_name}
              </span>
              <span className="host-person-username meta">
                @{person.username}
              </span>
              <button
                type="button"
                className="host-mini meta"
                disabled={busy}
                onClick={() => void restore(person)}
              >
                let them back in
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="host-note meta">
        Letting somebody back in is not an undo. Their old sign-ins stay dead
        and the invite links they had made stay revoked, so they sign in again
        with their password — the username is the one they always had, and
        everything they wrote is still where they left it.
      </p>

      {problem === null ? null : <p className="host-problem">{problem}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

function ServerSection({
  api,
  server,
  onSaved,
}: {
  api: AuthedApi;
  server: ServerInfo | null;
  onSaved: (server: ServerInfo) => void;
}) {
  const [name, setName] = useState(server?.name ?? "");
  const [accent, setAccent] = useState(server?.accent_key ?? null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // The panel can be opened before `GET /server` has answered, and the answer
  // is what the fields start from. It also arrives again after a save, which
  // is harmless: by then the form already holds what was saved.
  useEffect(() => {
    setName(server?.name ?? "");
    setAccent(server?.accent_key ?? null);
  }, [server]);

  const dirty =
    name.trim() !== (server?.name ?? "") ||
    accent !== (server?.accent_key ?? null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const info = await api.updateServer({
        name: name.trim(),
        accent_key: accent,
        icon_key: null,
      });
      onSaved(info);
      setSaved(true);
    } catch (error) {
      setProblem(problemText(error, "Couldn't save the server."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="host-section host-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && name.trim() !== "") void submit();
      }}
    >
      <h3 className="panel-label host-label">name</h3>
      <Field
        label=""
        hint="What the rail says, and what an invite link tells a stranger."
      >
        <input
          type="text"
          className="host-input"
          aria-label="Server name"
          value={name}
          disabled={busy}
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }}
        />
      </Field>

      <h3 className="panel-label host-label">accent</h3>
      {/*
        Sixteen named keys, and the name is the label — the swatch beside it is
        decoration. That is not a placeholder: nothing in this app carries
        meaning in color alone, and the palette itself lives in
        `linger-core::PALETTE`, which the server checks this against.
      */}
      <ul className="host-accents">
        {PALETTE_KEYS.map((key) => (
          <li key={key}>
            <button
              type="button"
              className="host-accent"
              aria-pressed={accent === key}
              disabled={busy}
              onClick={() => {
                setAccent(accent === key ? null : key);
                setSaved(false);
              }}
            >
              <span
                className="host-swatch"
                style={{ background: colorVar(key, "var(--hairline-strong)") }}
                aria-hidden="true"
              />
              <span className="meta">{key}</span>
            </button>
          </li>
        ))}
      </ul>
      {/* The same honesty the status editor uses about images: the key is
          stored now, and M6's generated palette stylesheet is what paints it.
          Delete this line when T-601 lands. */}
      <p className="host-note meta">
        Used for selection markers, focus rings and primary actions. Everyone
        keeps their own name colors.
      </p>

      {problem === null ? null : <p className="host-problem">{problem}</p>}
      <div className="host-actions">
        {saved && !dirty ? <span className="meta">saved</span> : null}
        <button
          type="submit"
          className="host-save"
          disabled={busy || !dirty || name.trim() === ""}
        >
          {busy ? "saving…" : "save"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <label className="host-field">
      {label === "" ? null : <span className="panel-label">{label}</span>}
      {children}
      <span className="host-hint meta">{hint}</span>
    </label>
  );
}

/** A row of words you pick one of. A `<select>` would be a menu, and this panel
 *  has three choices per question — small enough to just show them. */
function Choice({
  label,
  options,
  disabled,
}: {
  label: string;
  options: Array<{ label: string; on: boolean; pick: () => void }>;
  disabled: boolean;
}) {
  return (
    <div className="host-field">
      <span className="panel-label">{label}</span>
      <div className="host-choice">
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            className="host-choice-option"
            aria-pressed={option.on}
            disabled={disabled}
            onClick={option.pick}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
