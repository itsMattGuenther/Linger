/**
 * The top of the client: sign-in first, the Console frame once you're in.
 *
 * The frame is [rail | stream | roster] over a permanent status bar, and the
 * roster is the point of it (SPEC §3): people get the right-hand panel, not a
 * gutter. Narrow windows keep the same cards behind the People button.
 *
 * The rail starts with the server list (SPEC §3, T-412): a live dot per server,
 * a mark when one is holding something you have not read, and `+ add` for the
 * next one. You can be signed into several at once. Each has its own connection,
 * its own people and its own rooms, and switching between them takes the stream,
 * the roster and your presence with it — you are only ever standing in one room.
 *
 * Below that, the rail is where the host's own controls hang: `+ room` beside
 * the room list and server options beside the selected server. They are *absent* for
 * everybody else rather than greyed out — a disabled control is a permission
 * matrix drawn in CSS, and this product refuses to have one. Host or member is
 * decided per server: you can host one and be a guest on the next.
 *
 * `Settings` is the other door: profile, appearance, sound, account. It is
 * drawn for everybody, because those are yours, not the host's. The panel
 * takes the stream column the same way Host tools does (T-411).
 *
 * The rail is where SPEC §4.2's other half lives: a room holding something you
 * have not seen changes *weight*, and nothing else. No number, no dot, no
 * color. It is one line of CSS and it is the whole feature.
 */
import { type CSSProperties, useCallback, useEffect, useState } from "react";

import AuthScreens from "./auth/AuthScreens";
import type { AuthResponse } from "./generated/AuthResponse";
import type { RoomId } from "./generated/RoomId";
import type { ServerInfo } from "./generated/ServerInfo";
import type { User } from "./generated/User";
import type { UserId } from "./generated/UserId";
import HostPanel, { type HostSection } from "./host/HostPanel";
import KnockCards from "./knock/KnockCards";
import type { MessageId } from "./generated/MessageId";
import MediaPanel from "./media/MediaPanel";
import { storageDetail, storageLine } from "./media/media";
import { useNow } from "./lib/clock";
import { applyNormalize, loadNormalize } from "./lib/normalize";
import {
  applyTheme,
  applyWarmth,
  loadTheme,
  loadWarmth,
  type ThemePref,
  watchSystemTheme,
} from "./lib/theme";
import SettingsPanel from "./settings/SettingsPanel";
import { noRoomsBody, noRoomsRail } from "./settings/copy";
import {
  anyNewActivity,
  connect,
  disconnect,
  type GatewayState,
  hasNewActivity,
  loadNotifyRules,
  loadReadMarkers,
  noteDm,
  statusText,
  useGateway,
  useServers,
} from "./lib/gateway";
import { dmLabel, noDms, orderDms } from "./lib/dm";
import { frameLayout, useWindowWidth } from "./lib/layout";
import {
  applyInterfaceScale,
  loadPanel,
  savePanel,
  useInterfaceScale,
} from "./lib/interface";
import PanelResize from "./lib/PanelResize";
import AdaptivePanel from "./lib/AdaptivePanel";
import { hostOf } from "./lib/link";
import { personStyle } from "./lib/names";
import { occupancyLine, occupantsOf, STACK_VISIBLE } from "./lib/occupancy";
import { colorVar } from "./lib/palette";
import { type ServerSession, useSessions } from "./lib/session";
import {
  dropPresence,
  setPresenceLive,
  setPresenceRoom,
  startPresence,
} from "./lib/watchPresence";
import { forgetPreviews } from "./lib/previews";
import { checkForUpdate } from "./lib/updates";
import {
  forgetNotifications,
  resetNotifications,
  setViewing,
} from "./lib/notify";
import RosterPanel from "./roster/RosterPanel";
import SearchPanel from "./search/SearchPanel";
import Stream from "./stream/Stream";
import VoiceAway from "./voice/VoiceAway";
import { ActionIcon, CogIcon } from "./lib/icons";
import IconButton from "./lib/IconButton";
import ContextPanel from "./lib/ContextPanel";
import EmptyState from "./lib/EmptyState";
import Button from "./lib/Button";
import "./app.css";

/**
 * How often each server is re-asked for its name and its storage figure. Slow
 * on purpose: nothing here is urgent, and it is one small GET per server.
 */
const INFO_REFRESH_MS = 120_000;

/** How often the frame re-asks whether the sun has gone down (SPEC §4.7). */
const WARMTH_TICK_MS = 120_000;

export default function App() {
  const sessions = useSessions();

  if (sessions.state.status === "restoring") {
    return (
      <div className="auth">
        <p className="meta">signing you back in…</p>
      </div>
    );
  }

  // Destructured rather than length-checked so the type says what the frame
  // relies on: there is always a server to be looking at.
  const [first, ...rest] = sessions.state.servers;
  if (first === undefined) {
    return (
      <AuthScreens
        notice={sessions.notice}
        keyringNotice={sessions.keyringNotice}
        onAuthenticated={sessions.addServer}
      />
    );
  }

  return (
    <Console
      servers={[first, ...rest]}
      keyringNotice={sessions.keyringNotice}
      onSignOut={sessions.signOut}
      onAddServer={sessions.addServer}
    />
  );
}

/**
 * One server's connection, as a component.
 *
 * Connecting in an effect keyed on the sign-in is what makes adding and
 * removing a server clean: React mounts one of these per server and unmounts
 * it when the server goes, so the socket, the pending notifications and the
 * presence record all die with it. Doing the same thing in a loop over the
 * list would reconnect every server whenever any one of them changed.
 *
 * It draws nothing. The server's name is the one thing `ready` does not carry,
 * so it is fetched here and handed up for the rail to draw.
 */
function ServerLink({
  session,
  onInfo,
}: {
  session: ServerSession;
  onInfo: (baseUrl: string, info: ServerInfo | null) => void;
}) {
  const { api, baseUrl } = session;

  useEffect(() => {
    void connect(api);
    return () => {
      forgetNotifications(baseUrl);
      forgetPreviews(baseUrl);
      dropPresence(baseUrl);
      void disconnect(baseUrl);
    };
  }, [api, baseUrl]);

  // Where you had got to, and who you asked to hear from. Both are small, both
  // are needed before the first frame is judged worth interrupting anyone for,
  // and neither is worth a screen of its own if it fails.
  useEffect(() => {
    void loadReadMarkers(api);
    void loadNotifyRules(api).catch(() => undefined);
  }, [api]);

  // A server that has gone must not leave its name and its storage figure in
  // the frame. Separate from the fetch below, which re-runs on the clock and
  // must not blank the rail every time it does.
  useEffect(() => () => onInfo(baseUrl, null), [baseUrl, onInfo]);

  // Fetched, not pushed: the name changes about once ever, and the storage
  // figure is a rounded number that moves when somebody shares something big.
  // Neither is worth a gateway frame, and both go stale enough to notice if
  // this only ran at sign-in — so the slow clock re-asks.
  const asOf = useNow(INFO_REFRESH_MS);
  useEffect(() => {
    const abort = new AbortController();
    // A failure isn't worth a screen of its own: the rail falls back to the
    // hostname.
    void api
      .serverInfo(abort.signal)
      .then((info) => onInfo(baseUrl, info))
      .catch(() => undefined);
    return () => abort.abort();
  }, [api, baseUrl, onInfo, asOf]);

  return null;
}

export function Console({
  servers,
  keyringNotice,
  onSignOut,
  onAddServer,
}: {
  /** At least one, always. The frame has nothing to draw without it. */
  servers: [ServerSession, ...ServerSession[]];
  keyringNotice: string | null;
  onSignOut: (baseUrl: string) => Promise<void>;
  onAddServer: (baseUrl: string, auth: AuthResponse) => Promise<void>;
}) {
  const all = useServers();
  const [activeUrl, setActiveUrl] = useState(servers[0].baseUrl);
  // Each server's own name, once it has answered. Keyed by base URL like
  // everything else about a server.
  const [info, setInfo] = useState<Record<string, ServerInfo>>({});
  // Which room you were reading on each server, so switching back returns you
  // to where you were rather than to the top of its list.
  const [openRoomIds, setOpenRoomIds] = useState<Record<string, RoomId>>({});
  // "Normalize everyone" (SPEC §4.5): the reader's answer to other people's
  // name styling. It is one attribute on `<html>`, so it lives with other display preferences
  // rather than anywhere near the components that draw a name.
  const [normalize, setNormalize] = useState<boolean>(loadNormalize);
  // Theme and the post-sunset warmth (SPEC §4.7, §5.3). Both are the reader's
  // own and both are one attribute on `<html>`, so they sit here together.
  const [theme, setTheme] = useState<ThemePref>(loadTheme);
  const [warmth, setWarmth] = useState<boolean>(loadWarmth);
  // Slow on purpose: this is the clock that lets dusk arrive without a reload,
  // and a 200K tint does not need to be punctual to the second.
  const clock = useNow(WARMTH_TICK_MS);
  // Which host surface is open over the stream, if any (T-410).
  const [hostSection, setHostSection] = useState<HostSection | null>(null);
  // The member's own settings (T-411). Mutually exclusive with the host panel:
  // both take the stream column, and two overlays is a modal stack.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The paste box, reached from inside the app rather than only before
  // sign-in (T-301's screen, T-412's door to it).
  const [addingServer, setAddingServer] = useState(false);
  // The media collection (T-504). A destination in the rail, not a search
  // result (SPEC §4.4) — it takes the stream column like the other panels.
  const [mediaOpen, setMediaOpen] = useState(false);
  // Search (T-1203), the other destination. Same column, same pattern.
  const [searchOpen, setSearchOpen] = useState(false);
  // Bumped on every Ctrl/Cmd+K. The panel is already open on the second press,
  // so this is what puts the cursor back in the box rather than a remount.
  const [searchFocus, setSearchFocus] = useState(0);
  // A message the collection pointed at, on its way to the stream that holds
  // it. Cleared once that stream has been and looked.
  const [jumpTo, setJumpTo] = useState<MessageId | null>(null);

  // A new version, found once at launch (T-701). It gets one quiet word in the
  // status bar and nothing else: no dialog, no nag, no automatic restart. The
  // panel is where you decide, and it is also where the check runs again.
  const [updateWaiting, setUpdateWaiting] = useState(false);
  const scale = useInterfaceScale();
  const width = useWindowWidth();
  const [railWidth, setRailWidth] = useState(() => loadPanel("rail"));
  const [rosterWidth, setRosterWidth] = useState(() => loadPanel("roster"));
  const layout = frameLayout(width, scale, railWidth, rosterWidth);
  const { narrow, stacked } = layout;
  const [drawer, setDrawer] = useState<"rail" | "roster" | null>(null);
  useEffect(() => setDrawer(null), [narrow, stacked]);
  useEffect(applyInterfaceScale, [scale]);
  useEffect(() => savePanel("rail", railWidth), [railWidth]);
  useEffect(() => savePanel("roster", rosterWidth), [rosterWidth]);

  // A server that has gone — signed out of, or refused — must not leave the
  // frame pointing at nothing.
  const active =
    servers.find((server) => server.baseUrl === activeUrl) ?? servers[0];
  const api = active.api;
  const server = info[active.baseUrl] ?? null;
  const gateway = useGateway(active.baseUrl);

  // Stable, because the keyboard shortcut below holds them in an effect.
  // Every setter React hands back is stable, so the empty dependency list is
  // the truth rather than a shortcut.
  const closePanels = useCallback((): void => {
    setDrawer(null);
    setHostSection(null);
    setSettingsOpen(false);
    setAddingServer(false);
    setMediaOpen(false);
    setSearchOpen(false);
  }, []);
  const openSearch = useCallback((): void => {
    closePanels();
    setSearchOpen(true);
    setSearchFocus((held) => held + 1);
  }, [closePanels]);
  const openMedia = (): void => {
    closePanels();
    setMediaOpen(true);
  };
  const openSettings = (): void => {
    closePanels();
    setSettingsOpen(true);
  };
  const closeSettings = (): void => {
    setSettingsOpen(false);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLButtonElement>(
          stacked ? ".navigation-access" : ".rail-settings",
        )
        ?.focus(),
    );
  };
  const openHost = (section: HostSection): void => {
    closePanels();
    setHostSection(section);
  };
  const openAdd = (): void => {
    closePanels();
    setAddingServer(true);
  };

  // Stable, because the stream holds it in an effect's dependency list.
  const forgetJump = useCallback(() => setJumpTo(null), []);

  const noteInfo = useCallback(
    (baseUrl: string, next: ServerInfo | null): void => {
      setInfo((held) => {
        if (next === null) {
          if (!(baseUrl in held)) return held;
          const without = { ...held };
          delete without[baseUrl];
          return without;
        }
        return { ...held, [baseUrl]: next };
      });
    },
    [],
  );

  useEffect(() => {
    let open = true;
    void checkForUpdate().then((found) => {
      if (open) setUpdateWaiting(found.kind === "ready");
    });
    return () => {
      open = false;
    };
  }, []);

  /**
   * `Ctrl`/`Cmd`+`K` (SPEC §4.12).
   *
   * A way *into* the search destination, never a second surface: it opens the
   * same panel the rail opens and puts the cursor in its box. Pressed again
   * while it is open, it re-focuses the box rather than toggling the panel shut
   * — somebody reaching for the shortcut is reaching for the box.
   *
   * Not excluded from the composer on purpose. A shortcut that stops working
   * where people spend their time is a shortcut nobody learns.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "k" || event.altKey) return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      openSearch();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSearch]);

  useEffect(() => {
    applyNormalize(normalize);
  }, [normalize]);

  // Re-applied when the OS changes its mind too, which is the whole of what
  // the `system` preference means.
  useEffect(() => {
    applyTheme(theme);
    return watchSystemTheme(() => applyTheme(theme));
  }, [theme]);

  // The slow clock is what makes dusk arrive without a reload. It ticks every
  // couple of minutes, which is as precise as a 200K tint needs to be.
  useEffect(() => {
    applyWarmth(warmth, new Date(clock));
  }, [warmth, clock]);

  // One watcher for the window, however many servers there are. The per-server
  // records live inside it and are added and dropped by `ServerLink`.
  //
  // Nothing here closes a connection. Each `ServerLink` owns exactly one and
  // closes it when it unmounts, and reaching around them from up here to close
  // all of them is how the frame listener ends up racing a connect that has not
  // finished — a live socket with nobody following it (see `lib/gateway.ts`).
  useEffect(() => {
    const stop = startPresence();
    return () => {
      stop();
      resetNotifications();
    };
  }, []);

  const rooms = [...gateway.rooms]
    .filter((room) => room.archived_at === null)
    .sort((a, b) => a.position - b.position);
  // Your DMs (SPEC §4.13). Kept apart from `rooms` all the way from the wire,
  // and drawn as its own section — a DM is not one of the server's rooms and
  // putting it in that list would be the first step towards it being treated
  // as one.
  const dms = orderDms(gateway.dms, (room) => hasNewActivity(gateway, room.id));
  // Everything the stream can be opened on. Land in the first room, and don't
  // hold a room that was archived, a DM you are no longer in, or anything this
  // account can no longer see.
  const openable = [...rooms, ...dms];
  const open =
    openable.find((room) => room.id === openRoomIds[active.baseUrl]) ??
    rooms[0] ??
    null;

  // Nothing interrupts you about the room you are already reading, and you are
  // only ever standing in one room — switching servers takes you out of the
  // last one.
  useEffect(() => {
    setViewing(
      open === null ? null : { server: active.baseUrl, roomId: open.id },
    );
    setPresenceRoom(active.baseUrl, open?.id ?? null);
  }, [active.baseUrl, open?.id]);

  // A fresh `ready` is a new session on the server: we are `around` until
  // this clock re-announces the room. Anything short of ready is not a
  // connection worth sending presence on.
  useEffect(() => {
    setPresenceLive(active.baseUrl, gateway.status.kind === "ready");
  }, [active.baseUrl, gateway.status.kind]);

  const status = statusText(gateway.status);
  const statusDetail =
    gateway.status.kind === "waiting" ? gateway.status.reason : undefined;

  // One roster, in one of two places. Rendering it twice and hiding one would
  // mean two of everything it holds — two open cards, two scroll positions.
  /**
   * Open a DM with somebody, from their card in the roster (SPEC §4.13).
   *
   * Create-or-find on the server, so this is the same call whether the
   * conversation is new or eight months old — there is no "start" and "open" to
   * tell apart, on this side or the other. The room the server hands back is
   * folded in here rather than waited for on the socket: its `room.create`
   * arrives too, and the store merges by id, but the button should not feel
   * like it did nothing while a frame is in flight.
   */
  const openDm = useCallback(
    async (userId: UserId): Promise<void> => {
      const dm = await api.openDm([userId]);
      noteDm(api.baseUrl, dm);
      setOpenRoomIds((held) => ({ ...held, [api.baseUrl]: dm.id }));
      closePanels();
    },
    [api, closePanels],
  );

  const roster = <RosterPanel api={api} onOpenDm={openDm} />;

  // `ready` is the fresher answer about who we are; the stored session is what
  // we have before it arrives. Neither is the lock — every host endpoint checks
  // for itself — so this only decides whether the controls are drawn at all.
  const isHost = gateway.me?.is_host ?? active.user.is_host;
  const host = isHost ? hostSection : null;
  // `ready` is the live copy of who we are; the stored session is the fallback
  // until it arrives. The status bar and settings both prefer the live one so
  // a display-name save shows up without a reload.
  const you = gateway.me ?? active.user;
  const conversationVisible =
    !addingServer &&
    !settingsOpen &&
    !mediaOpen &&
    !searchOpen &&
    host === null;

  // The server's accent, if the host picked one (SPEC §5.3, `PATCH /server`).
  // It names a palette key, and the variable that key points at is generated
  // from `linger-core::PALETTE` in M6 — until then every key falls back to the
  // built-in accent and this line quietly does nothing.
  const frameStyle: CSSProperties = {
    "--accent": colorVar(server?.accent_key ?? "", "var(--accent-default)"),
    "--rail-w": `${layout.rail / 16}rem`,
    "--roster-w": `${layout.roster / 16}rem`,
  };

  return (
    <div
      className="frame"
      data-narrow={narrow ? "true" : undefined}
      data-stacked={stacked ? "true" : undefined}
      style={frameStyle}
    >
      {servers.map((session) => (
        <ServerLink key={session.baseUrl} session={session} onInfo={noteInfo} />
      ))}

      {narrow ? (
        <div className="panel-access">
          {stacked ? (
            <button
              type="button"
              className="navigation-access"
              aria-haspopup="dialog"
              aria-controls="rail-drawer"
              aria-expanded={drawer === "rail"}
              onClick={() => setDrawer("rail")}
            >
              Navigation
            </button>
          ) : null}
          <button
            type="button"
            className="people-access"
            aria-haspopup="dialog"
            aria-controls="roster-drawer"
            aria-expanded={drawer === "roster"}
            onClick={() => setDrawer("roster")}
          >
            People
          </button>
        </div>
      ) : null}
      <AdaptivePanel
        side="rail"
        collapsed={stacked}
        open={drawer === "rail"}
        onClose={() => setDrawer(null)}
      >
        <aside className="rail" id="navigation" aria-label="Navigation">
          <div className="rail-content">
            <section className="rail-section">
              <div className="rail-head">
                <h2 className="panel-label">servers</h2>
                <IconButton
                  label="Add a server"
                  tooltipSide="below"
                  aria-pressed={addingServer}
                  onClick={() =>
                    addingServer ? setAddingServer(false) : openAdd()
                  }
                >
                  <ActionIcon name="plus" />
                </IconButton>
              </div>
              <ul className="server-list">
                {servers.map((session) => (
                  <li key={session.baseUrl}>
                    <ServerRow
                      name={
                        info[session.baseUrl]?.name ?? hostOf(session.baseUrl)
                      }
                      state={all[session.baseUrl]}
                      current={session.baseUrl === active.baseUrl}
                      onManage={
                        session.baseUrl === active.baseUrl && isHost
                          ? openHost
                          : undefined
                      }
                      onOpen={() => {
                        setActiveUrl(session.baseUrl);
                        closePanels();
                      }}
                    />
                  </li>
                ))}
              </ul>
            </section>
            <section className="rail-section rail-rooms">
              <div className="rail-head">
                <h2 className="panel-label">rooms</h2>
                {isHost ? (
                  <IconButton
                    label="Create a room"
                    tooltipSide="below"
                    onClick={() => openHost("rooms")}
                  >
                    <ActionIcon name="plus" />
                  </IconButton>
                ) : null}
              </div>
              {rooms.length === 0 ? (
                <p className="placeholder">{noRoomsRail()}</p>
              ) : (
                <ul className="room-list">
                  {rooms.map((room) => (
                    <li key={room.id}>
                      <button
                        type="button"
                        className="room-item"
                        aria-current={
                          conversationVisible && room.id === open?.id
                            ? "true"
                            : undefined
                        }
                        // The entire "there is something here" signal (SPEC §4.2).
                        // A boolean, on purpose: there is nothing to count and no
                        // endpoint that would answer if there were.
                        data-new={
                          hasNewActivity(gateway, room.id) ? "true" : undefined
                        }
                        onClick={() => {
                          setOpenRoomIds((held) => ({
                            ...held,
                            [active.baseUrl]: room.id,
                          }));
                          // You clicked a room to read it, so the host panel gets
                          // out of the way rather than sitting over the stream.
                          closePanels();
                        }}
                      >
                        <span className="room-slug">#{room.slug}</span>
                        <RoomStack
                          people={occupantsOf(
                            room.id,
                            gateway.occupancy,
                            gateway.presence,
                            gateway.users,
                          )}
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="rail-section rail-dms">
              {/* SPEC §4.13. Under the rooms because a DM is not one of the
              server's rooms — it is yours, and everybody's list here is
              different. A DM holding something new gets the same weight change
              a room gets and nothing else: no number, no dot, no colour, no
              matter how urgent a DM feels (AGENTS rule 3). */}
              <div className="rail-head">
                <h2 className="panel-label">DMs</h2>
              </div>
              {dms.length === 0 ? (
                <p className="placeholder">{noDms()}</p>
              ) : (
                <ul className="room-list">
                  {dms.map((dm) => (
                    <li key={dm.id}>
                      <button
                        type="button"
                        className="room-item"
                        aria-current={
                          conversationVisible && dm.id === open?.id
                            ? "true"
                            : undefined
                        }
                        data-new={
                          hasNewActivity(gateway, dm.id) ? "true" : undefined
                        }
                        onClick={() => {
                          setOpenRoomIds((held) => ({
                            ...held,
                            [active.baseUrl]: dm.id,
                          }));
                          closePanels();
                        }}
                      >
                        {/* No `#`: a DM is not a channel, it is who is in it. */}
                        <span className="room-slug">
                          {dmLabel(dm, gateway.users, gateway.me?.id ?? null)}
                        </span>
                        <RoomStack
                          people={occupantsOf(
                            dm.id,
                            gateway.occupancy,
                            gateway.presence,
                            gateway.users,
                          )}
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="rail-section rail-places">
              {/* The two destinations (SPEC §3): places that are not rooms. They
              sit under the room list and open in place of the message stream,
              so nothing in this app ever floats over the conversation.
              `media` is everything anybody has shared (SPEC §4.4); `search`
              is everything anybody said (SPEC §4.12). */}
              <button
                type="button"
                className="room-item"
                aria-pressed={mediaOpen}
                onClick={() => (mediaOpen ? setMediaOpen(false) : openMedia())}
              >
                <ActionIcon name="media" />
                <span className="room-slug">Media</span>
              </button>
              <button
                type="button"
                className="room-item"
                aria-pressed={searchOpen}
                onClick={() =>
                  searchOpen ? setSearchOpen(false) : openSearch()
                }
              >
                <ActionIcon name="search" />
                <span className="room-slug">Search</span>
              </button>
            </section>
          </div>
          <section className="rail-account" aria-label="Your account">
            <div className="rail-self">
              {/* No "you" under it: this corner is already yours, and the
              section's label says so to a screen reader (#171). */}
              <span className="rail-self-name">{you.display_name}</span>
              <IconButton
                label="Settings"
                className="rail-settings"
                aria-pressed={settingsOpen}
                onClick={() =>
                  settingsOpen ? closeSettings() : openSettings()
                }
              >
                <CogIcon size={20} />
              </IconButton>
            </div>
          </section>
        </aside>
      </AdaptivePanel>

      {stacked ? null : (
        <PanelResize
          side="rail"
          value={layout.rail}
          scale={scale}
          onChange={setRailWidth}
        />
      )}
      {narrow ? null : (
        <PanelResize
          side="roster"
          value={layout.roster}
          scale={scale}
          onChange={setRosterWidth}
        />
      )}

      <div className="workspace">
        {addingServer ? (
          <main className="stream">
            <header className="stream-header">
              <span className="room-name">add a server</span>
              <button
                type="button"
                className="rail-action meta"
                onClick={() => setAddingServer(false)}
              >
                close
              </button>
            </header>
            <AuthScreens
              inline
              notice={null}
              keyringNotice={keyringNotice}
              onAuthenticated={async (baseUrl, auth) => {
                await onAddServer(baseUrl, auth);
                setActiveUrl(baseUrl);
                setAddingServer(false);
              }}
            />
          </main>
        ) : settingsOpen ? (
          <SettingsPanel
            api={api}
            user={you}
            normalize={normalize}
            onNormalizeChange={setNormalize}
            theme={theme}
            onThemeChange={setTheme}
            warmth={warmth}
            onWarmthChange={setWarmth}
            onSignOut={() => onSignOut(active.baseUrl)}
            onReauthenticated={(auth) => onAddServer(api.baseUrl, auth)}
            onClose={closeSettings}
            initialSection={updateWaiting ? "computer" : "you"}
          />
        ) : mediaOpen ? (
          <MediaPanel
            api={api}
            users={gateway.users}
            me={gateway.me?.id ?? null}
            rooms={[...rooms, ...dms]}
            onOpen={(roomId, messageId) => {
              setOpenRoomIds((held) => ({ ...held, [active.baseUrl]: roomId }));
              setJumpTo(messageId);
              closePanels();
            }}
            onClose={() => setMediaOpen(false)}
            expiryDays={server?.file_expiry_days}
          />
        ) : searchOpen ? (
          <SearchPanel
            api={api}
            users={gateway.users}
            me={gateway.me?.id ?? null}
            // Rooms *and* your DMs: since T-1303 a member's own DMs are in their
            // results, and a hit the panel cannot name reads as one from a room
            // that is gone.
            rooms={[...rooms, ...dms]}
            focusNonce={searchFocus}
            onOpen={(roomId, messageId) => {
              setOpenRoomIds((held) => ({ ...held, [active.baseUrl]: roomId }));
              setJumpTo(messageId);
              closePanels();
            }}
            onClose={() => setSearchOpen(false)}
          />
        ) : host !== null ? (
          <HostPanel
            api={api}
            rooms={rooms}
            server={server}
            section={host}
            onSection={setHostSection}
            onServerChange={(next) => noteInfo(active.baseUrl, next)}
            onClose={() => setHostSection(null)}
          />
        ) : open === null ? (
          <main className="stream">
            <header className="stream-header">
              <span className="room-name">
                {gateway.status.kind === "ready" ? "no rooms yet" : "welcome"}
              </span>
            </header>
            <div className="stream-body">
              {gateway.status.kind === "ready" ? (
                <EmptyState title="A place for your people." action={isHost ? (
                  <Button variant="primary" onClick={() => openHost("rooms")}>Make the first room</Button>
                ) : undefined}>
                  {noRoomsBody(true, isHost)}
                </EmptyState>
              ) : <p className="placeholder">{noRoomsBody(false, isHost)}</p>}
            </div>
          </main>
        ) : (
          <Stream
            api={api}
            room={open}
            users={gateway.users}
            focus={jumpTo}
            onFocused={forgetJump}
          />
        )}
        <VoiceAway
          servers={servers}
          visibleServer={active.baseUrl}
          visibleRoom={conversationVisible ? (open?.id ?? null) : null}
          onReturn={(baseUrl, roomId) => {
            setActiveUrl(baseUrl);
            setOpenRoomIds((held) => ({ ...held, [baseUrl]: roomId }));
            closePanels();
          }}
        />
      </div>

      <AdaptivePanel
        side="roster"
        collapsed={narrow}
        open={drawer === "roster"}
        onClose={() => setDrawer(null)}
      >
        {roster}
      </AdaptivePanel>

      {/* Knocks (SPEC §4.9, T-1102). Every server you are signed into, not
          only the one on screen: somebody knocking is the reason to go and
          look at the other one. It draws nothing when nobody has knocked. */}
      <KnockCards
        servers={servers.map((session) => ({
          baseUrl: session.baseUrl,
          name: info[session.baseUrl]?.name ?? hostOf(session.baseUrl),
        }))}
      />

      <footer className="status-bar meta">
        <span className="status-left">
          <span title={statusDetail}>{status}</span>
          {/* SPEC §5.6's third figure. Not the host's business alone: whether
              there is room for the video you are about to share is a question
              whoever is sharing it has. */}
          {server === null ? null : (
            <span
              title={storageDetail(
                server.storage_used_bytes,
                server.storage_limit_bytes,
                server.file_expiry_days,
              )}
            >
              {storageLine(
                server.storage_used_bytes,
                server.storage_limit_bytes,
              )}
            </span>
          )}
        </span>
        <span className="status-right">
          {updateWaiting && !settingsOpen ? (
            <button
              type="button"
              className="status-action"
              onClick={openSettings}
              title="A new version is ready. Nothing installs until you say so."
            >
              update ready
            </button>
          ) : null}
          {keyringNotice ? (
            <span className="status-warn">not remembered</span>
          ) : null}
        </span>
      </footer>
    </div>
  );
}

/**
 * One server in the rail: a dot, a name, and nothing else (SPEC §3).
 *
 * The dot is the connection — filled once that server has said `ready`, hollow
 * while it is retrying. A server holding something you have not read gets the
 * same weight change the room list uses: heavier text, never a badge and never
 * a count (SPEC §4.2, AGENTS rule 3). The accessible name says it in words,
 * because a font weight is not something a screen reader can read out.
 */
function ServerRow({
  name,
  state,
  current,
  onOpen,
  onManage,
}: {
  name: string;
  state: GatewayState | undefined;
  current: boolean;
  onOpen: () => void;
  onManage?: (section: HostSection) => void;
}) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null);
  const live = state?.status.kind === "ready";
  const waiting = state !== undefined && anyNewActivity(state);
  const label = [
    name,
    live ? "connected" : "not connected",
    waiting ? "something new" : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
  return (
    <div className="server-row" data-current={current || undefined}>
      <button
        type="button"
        className="server-item"
        aria-current={current ? "true" : undefined}
        aria-label={label}
        data-live={live ? "true" : undefined}
        data-new={waiting ? "true" : undefined}
        onClick={onOpen}
      >
        <span className="server-name" title={name}>
          {name}
        </span>
      </button>
      {onManage ? (
        <>
          <IconButton
            label="Server options"
            className="server-options-trigger"
            tooltipSide="below"
            aria-haspopup="dialog"
            aria-expanded={menuAnchor !== null}
            onClick={(event) => setMenuAnchor(event.currentTarget)}
          >
            <ActionIcon name="more" />
          </IconButton>
          {menuAnchor ? (
            <ContextPanel
              anchor={menuAnchor}
              label="Server options"
              className="server-options"
              onClose={() => setMenuAnchor(null)}
            >
              <h3>Manage server</h3>
              <p className="context-hint">Only the host sees these controls.</p>
              <div className="context-actions">
                <button
                  type="button"
                  onClick={() => {
                    setMenuAnchor(null);
                    onManage("server");
                  }}
                >
                  Server Settings
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuAnchor(null);
                    onManage("invites");
                  }}
                >
                  Invite people
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuAnchor(null);
                    onManage("rooms");
                  }}
                >
                  Manage rooms
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuAnchor(null);
                    onManage("people");
                  }}
                >
                  Manage members
                </button>
              </div>
            </ContextPanel>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * The small stack of who is in a room, on the rail (SPEC §4.1).
 *
 * Dots, not faces: there are no avatars in this app, and the rail is not
 * allowed colored icon squares either. Five is as many as the column will
 * hold without crowding the name; the rest live in the accessible label,
 * never as a "+N".
 */
function RoomStack({ people }: { people: User[] }) {
  if (people.length === 0) return null;
  const visible = people.slice(0, STACK_VISIBLE);
  const label = `${occupancyLine(people)} in the room`;
  return (
    <span
      className="room-stack"
      aria-label={label}
      title={occupancyLine(people)}
    >
      {visible.map((person) => (
        <span
          key={person.id}
          className="room-stack-dot"
          style={personStyle(person)}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}
