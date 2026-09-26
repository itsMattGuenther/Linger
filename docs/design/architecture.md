# The Buddy list client: architecture

**Status:** accepted plan for M15 (#198), written 2026-09-25. The design is
`buddy-list.md`, the visual rules are `system.md`, the gate for switching is
`parity.md`, and the lessons it must not repeat are `lessons.md`, all in this
folder.

The Buddy list client replaces today's client (SPEC §3, §5 "Console"). It is
built next to it, in the same repository, and ships hidden until it can do
everything the old one does. This document says where the code goes, how the
windows share one connection, how the pieces are tested, and in what order they
are built.

## Goals

- **The prototype's look and feel, exactly.** It must stay fast and quiet on
  the slowest engine it runs on, WebKitGTK on Linux.
- **Built to last.** Clear layers, rules enforced by tests rather than by
  memory, and every lesson from the first client turned into a check.
- **No risk to the released app.** The old client keeps shipping and updating
  until the switch. Nothing a user runs changes before then.

Not in M15:

- **No server change**, except the host time zone (see *Open decisions*).
- **No voice forwarding** (#197) and **no voice encryption** (#200).
- **No macOS build.**
- **No light theme**, which is an open decision.

## Where the code lives

| Path | What it is |
|---|---|
| `client/next.html` | The entry page for every new-client window. The window's role and conversation come from the URL. |
| `client/src/next/styles/` | Design tokens and base styles (`system.md`). |
| `client/src/next/kit/` | The kit of parts: every button, row, marker, tab, title bar and field. Screens build only from these. |
| `client/src/next/core/` | New logic with no UI: window roles, the catch-up protocol, borrowed tokens, intents, view models. Pure where possible, and unit-tested. |
| `client/src/next/app/` | Screens: the list window, the chat window (tabs), Settings, the person card, the new-message picker. |
| `client/src/lib/`, `client/src/generated/`, `client/src/fonts/` | **The shared core, reused rather than copied:** the REST client, sessions, the gateway store and its pure `apply`, IPC, sounds, updates, name styling, the palette, and the wire types from `linger-core`. |
| Everything else in `client/src/` | The old client. Frozen: bug fixes only until the switch, then deleted. |
| `client/prototypes/buddy-list/` | The prototype. Reference only, never imported. |

`client/src/next/kit/discipline.test.ts` fails the build if new-client code
imports the old client's UI, or if its CSS uses raw colors or magic sizes.

**Why reuse the core instead of rewriting it.** The gateway store encodes the
hardest-won behavior in the project: history windows (#173), resume without
gaps, read positions without counts, and DM filtering. It is covered by about
1,350 lines of tests. Rewriting it would re-learn all of that. The new client
changes how things look and how windows work, not what a message is.

After the switch, the old UI is deleted, and `src/next/` can move up to `src/`
in one mechanical commit.

## Windows and their roles

Two terms first:

- **Owner:** the one window that holds sign-in, the server connection and the
  side effects.
- **Viewer:** any other window. It shows things and asks the owner for
  anything only the owner may do.

| Window | Tauri label | Role |
|---|---|---|
| The buddy list | `main` | **Owner** |
| The chat window (tabs mode, one window) | `chat` | Viewer |
| A popped-out or separate conversation (windows mode) | `chat-<server>-<room>` | Viewer |
| Settings | `settings` | Viewer |

**The owner is the only window that:**

- restores sessions and **refreshes tokens**;
- **connects** to each server's gateway;
- plays **chimes**, shows **desktop notifications** and plays the knock sound;
- **forwards voice frames** to the Rust voice engine, and starts, stops and
  changes voice;
- checks for **updates**;
- **opens, focuses and closes** the other windows.

**Why there has to be an owner.** Three facts from the current code:

1. **Refresh tokens rotate.** Two windows refreshing the same one would revoke
   the whole sign-in (PROTOCOL §2; `AuthedApi` already allows only one refresh
   in flight).
2. **`gateway_connect` replaces the server's connection.** A second window
   connecting would tear down the first one's session, and with it its voice
   seat.
3. **Every gateway and voice event reaches every window** (`app.emit`). Side
   effects run where the frame is handled. Two windows handling them means two
   chimes, two notifications, and voice signals forwarded twice.

Closing the list window never tears down the owner. It either hides into the
tray or quits the app, per the setting in `buddy-list.md`. The tray icon is new
work in the Rust shell.

## How windows share state

```text
server ⇄ Rust gateway (one connection per server)
            │  app.emit("gateway:frame")   — every window receives every frame, in order
            ├──────────────► list window (owner):  apply(state, frame) + side effects
            └──────────────► chat window (viewer): apply(state, frame), no side effects
```

Every window keeps its own copy of the store and updates it with the same pure
function, `apply(state, frame)` in `lib/gateway.ts`. The same frames in the same
order give the same state, so no window needs to be told what another knows.

**Catching up.** A viewer that opens after the connection is up has missed the
`ready` snapshot. It catches up like this, implemented in
`client/src/lib/catchup.ts`, part of the shared core so the store can track its position:

1. It starts listening for frames straight away, and **buffers** them.
2. It asks the owner for a snapshot. The owner replies with each server's
   current state (without loaded history), the connection's session id (its
   *epoch*), and the sequence number `s` of the last frame it applied.
3. The viewer adopts the snapshot and **replays the buffer**:
   - it skips frames with `s` at or below the snapshot's in the same epoch;
   - a `ready` always applies, because a new epoch resets everything;
   - after a `ready`, every frame applies.
4. From then on it applies frames as they arrive.

The few values that change without a frame (read positions, your voice seat,
notification rules; `sharedLocalOf` in `lib/gateway.ts`) come from the owner
as `next:shared` whenever one changes. A viewer still catching up keeps the
newest of those per server and applies it over the snapshot. The owner sends
one on every change, so the newest is never older than the snapshot.

**What is not shared through frames:**

- **Loaded history.** Each window loads the conversations it shows, over REST
  (`openRoom`, `loadOlder`, `loadNewer`).
- **Local-only state.** Some fields change without a frame. The server has no
  frame for read positions, for example, and your own voice seat is set the
  moment you join. For these, **the owner is the single keeper**:
  - a viewer that changes one sends the change to the owner as an intent;
  - the owner applies it and broadcasts the field's new value to every viewer.

  No window writes another window's copy directly, and there is no third
  channel.

| Field | Who changes it | How the other windows learn it |
|---|---|---|
| `myVoice` (your seat, mute, deafen, device health) | the owner: joining and controls; the Rust voice events for health and levels, which already reach every window | owner broadcast |
| `read`, `readLoaded` | the owner loads markers; whichever window you read in marks them | intent to the owner, then owner broadcast |
| `notifyRules` | Settings | intent to the owner, then owner broadcast |
| `leftOff` | the window showing the conversation | none: it matters only where the conversation is open |
| `knocks` | frames; the fade timer runs where the card is shown (the list window) | frames |
| `streams` (loaded history) | each window, for what it shows | none: per window |
| everything else in `GatewayState` | frames | frames, deterministically |

**The property that has to hold, and is tested:** for any stream of frames,
including reconnects, resumes and a snapshot taken at any point, a viewer's
shared state equals the owner's.

## Tokens across windows

`AuthedApi` gains a *token source*:

- **The owner's source** is today's behavior: rotate the refresh token, save it
  to the keyring, and allow one refresh in flight.
- **A viewer's source borrows.** It holds the current *access* token, which the
  owner sends on start and after every refresh. When a call is refused as
  expired, it asks the owner to refresh and retries once.
- **Each server is lent on its own.** A window that's opening gets every
  server's token in the snapshot, renewed first if it is about to run out.
  The owner waits at most `LEND_WAIT_MS` (1.5 s) for a renewal, then lends
  the token it holds, so one server that isn't answering never holds up the
  others or the window. A window lent an out-of-date token asks for a new one
  the first time a call is refused, like any other.

A question the owner can't answer gets a reply saying why (`answer` in
`core/bus.ts`), rather than silence the asking window would wait out. A
window that still can't catch up says so and offers **Try again**.

**Refresh tokens never leave the owner window**, or the keyring. The old client
uses the owner source, so its behavior does not change, and `api.test.ts`
proves that.

## Viewer → owner: intents

A viewer asks the owner to do the things only the owner may do. Each **intent**
is typed, versioned and handled in one place (`Intent` in `core/share.ts`):

- `read`: mark a conversation read up to a message (the owner keeps read
  positions and tells every window);
- `window`, `room`, `closing`: for presence, this window's focus, the person
  moving in it, the conversation it shows, and that it is going;
- `voice.join` (which also moves voice), `voice.leave`, `voice.mute`,
  `voice.deafen`, and `voice.talk` for push-to-talk pressed in that window.
  The owner remembers which windows hold the key down, and closes the
  microphone if one of them goes without letting go (Ctrl+W, with Ctrl as the
  key);
- `popout` and `tabs`: move a conversation into a window of its own, or back
  into the chat window's tabs (only the owner opens windows);
- `open`: show a conversation where conversations open, from a window of its
  own (Message on a person's card). It says whether it's a room or a DM, since
  a DM made a moment ago may not have reached the owner yet;
- `conversations`: tabs or windows, from Settings;
- `settings`: open Settings (Ctrl+, in any window), on a section;
- `away`: you went away or came back from Settings (presence is the owner's);
- `signout`: sign out of a server on this computer;
- `addserver`: show the sign-in for another server in the list window, which
  keeps every other server connected meanwhile;
- `serverprefs`: your servers' order and which are Quiet, from Settings →
  Servers. The list window keeps them, and tells every window whenever they
  change (`next:serverprefs`), so Settings shows the same order as the list.

**Signing out reaches every window.** The server doesn't cancel access tokens
when you sign out, so a window still holding one could go on working as you
for up to fifteen minutes. Whenever a server leaves the owner's signed-in list
(Settings, a sign-in that ran out, signing out of everything), the owner
tells every window (`next:signedout`). Each drops that server's borrowed
token, state and frames at once, and never takes it up from a snapshot that
was already on its way. The chat window closes that server's tabs, and closes
when none are left; Settings closes when no server is left.

**So does signing in.** A server signed in to while windows are open (Add a
server, or back after a sign-out) is announced too (`next:signedin`). Each open
window catches up with that one server the way it caught up when it opened:
it buffers the server's frames from then, asks the owner for a snapshot, takes
that server's share and replays what the snapshot lacks.

Two things Settings needs an answer to go through the owner as questions
(`ask`), not intents: turning a notification rule on or off (`next:notify`),
and changing your password (`next:password`), which the owner follows by
signing straight back in with the new password, since a change ends every
other sign-in.

**How it looks is the same in every window.** Plain names and interface size
are kept on this computer; Settings saves a change and announces it
(`next:appearance`), and every window applies it (`core/appearance.ts`).
Interface size zooms the page and grows the window by the same ratio, because
the new client's sizes are fixed pixels and a larger base font would grow
nothing.

Anything else a viewer can do with REST it does itself, with its borrowed
token: send, edit, delete, load history, upload, knock, and typing through the
shared connection.

**Presence with several windows.** You are in one room at a time (SPEC §4.3).
The owner keeps what each window shows and puts you in the room of the window
you were last in (`core/showing.ts`). A window that closes stops counting: it
says so itself, and the Rust shell also tells the owner whenever a viewer
window is destroyed (`next:closed`), so a crash or the desktop's own close
never leaves you standing in a room. The same bookkeeping tells the
notifier which conversation you're looking at: the one in the window that has
focus, if any. A message arriving there doesn't chime or pop a banner, as in
today's client.

## Several servers

The list window connects to every server you're signed in to and shares all
of them with the other windows. Your order of servers and which are Quiet are
kept on this computer (`core/serverPrefs.ts`). A quiet server makes no chime
(`setQuietServers` in `lib/notify.ts`) and its name isn't bold; a mention still
gets its banner and a knock still gets through. Knocks from every server land
as cards just above the voice bar, naming the server when there's more than
one.

## Window management

- **Opening windows.** The owner asks Rust to open or focus a window through a
  command: `next_open_chat { server, room }` for the tabs,
  `next_open_settings { section }` for Settings, and
  `next_open_conversation { server, room, kind }` for a conversation in its
  own window, labelled from the conversation so asking again brings the same
  window forward. Opening a conversation from the list shows it in its own
  window if it has one (`Sharing.open` in `core/share.ts`). Rust builds the URL from a fixed pattern: no page can open
  an arbitrary URL, and only `main` may call the command. That is least privilege, as ARCHITECTURE §7 asks. The
  capability file lists each window's permissions. Viewers get what they need
  to read events and open links, and nothing more.
- **The app's own commands are checked too.** `build.rs` declares every
  command, which turns on Tauri's access checks for them: a window may call
  only what its capability file grants. `owner.json` gives `main` all of them.
  The chat windows get `gateway_send` (typing) and `graphics_started`; Settings
  gets `graphics_started`, `voice_devices` and the three update commands. The
  keyring, the connections, voice, notifications and window opening stay the
  owner's, and `src-tauri/src/acl.rs` fails the build's tests if a capability
  ever hands one to another window.
- **Still open:** any window may send any event, and the owner can't tell a
  `gateway:frame` the Rust core sent from one a viewer made up. A viewer that
  renders a hostile message can't reach this without a way to run script,
  but the fix is for Rust to hand the owner its frames on a private channel
  (a Tauri `Channel`) instead of a broadcast event (T-1811).
- **Tabs mode** (the default): one `chat` window. Opening a conversation adds a
  tab or shows it. When the window is already open, Rust hands it the
  conversation as an event (`next:open`), which a window still catching up
  isn't listening for yet. So the owner also keeps every conversation it sends
  the tabs until the window asks what it missed (`next:opens`), once it is
  listening, and forgets them when the window closes. A tab can be popped out into its own window, and put back.
  A half-typed message goes along, through this computer's storage, taken
  once and thrown away after a minute (`core/handoff.ts`). Files waiting to
  be sent stay behind.
- **Windows mode:** one window per conversation. A tiling desktop such as
  Hyprland places them. The choice is kept on this computer
  (`core/conversations.ts`); Settings asks the owner to change it (the
  `conversations` intent), and the owner tells every window (`next:mode`).
  Switching moves what's open at once: every tab into a window of its own,
  the showing one last so it lands on top, or every such window back into the
  tabs.
- **Title bars.** Every new-client window is frameless and draws its own title
  bar from the kit, with a drag region and window controls where the desktop
  has none. Windows 11 shadows and resizing on frameless windows need checking
  early on Windows.
- **Remembering.** Open tabs and their order are remembered on this computer
  (`linger.next.tabs`). Closing the last tab closes the chat window, and the
  next conversation opened starts a fresh set. Every new-client window's size,
  position and maximized state are remembered by the desktop shell
  (`tauri-plugin-window-state`, `remembered_windows` in `window.rs`), for the
  new client only; today's client is left as it was. Each window also
  remembers which interface size it was sized for, so a remembered window
  isn't grown again on the next run (`core/appearance.ts`).

## The hidden switch

- **To try it:** `LINGER_NEXT=1` makes the Rust shell open `next.html` as the
  `main` window instead of the old client. Everything else stays the same:
  sessions, the keyring and the servers.
- **Later, when it's worth trying day to day:** a switch in the old client's
  Settings, stored on this computer, does the same after a restart.
- **The production build** includes `next.html` as a second Vite entry, so the
  hidden switch works in installed builds too. Without the switch, users see
  nothing different.

## Testing strategy

Every rule is enforced at the lowest layer that can catch it, and every bug
fixed gets a test at that layer.

| Layer | What is proved | How | Runs |
|---|---|---|---|
| Pure logic | view models (grouping people, room activity, DM order), the tab state machine, intents, window keys | vitest | `pnpm test`, CI |
| State across windows | a viewer's state equals the owner's for any frame stream, with reconnects, resumes and any snapshot point | vitest property tests over generated frame streams | `pnpm test`, CI |
| Tokens | one refresh at a time, and viewers never refresh; the old client's behavior unchanged | vitest (`api.test.ts` plus new tests) | `pnpm test`, CI |
| Visual discipline | no raw colors or magic sizes in CSS, and no imports of the old UI | vitest (`discipline.test.ts`) | `pnpm test`, CI |
| Contrast | text tokens and all 16 name colors against every surface | vitest (`contrast.test.ts`) | `pnpm test`, CI |
| Kit geometry and access | the three control heights, centered icons, identical row heights across all 12 faces, aligned names, ellipsis instead of clipping, 24px hit targets, visible focus, accessible names, keyboard roving | Playwright on the kit gallery | Chromium locally; Chromium and WebKit in CI |
| Screens | tabs, the voice bar, the person card, the new-message picker, Settings, driven with a fake store | Playwright on fixture pages | local and CI |
| Several windows | catch-up, borrowed tokens and every intent end to end: two copies of the store in one test sharing an in-memory bus (`core/share.test.ts`), and the real chat window against a faked shell, owner and server (`tests/fixtures/next-chat-window.html`) | vitest; Playwright | local and CI |
| Real WebKitGTK | real windows and title bars, fonts, typing latency, scrolling, several windows at once | `tauri-driver` desktop checks under Xvfb (`docs/desktop-checks.md`) | local, before each merge |
| Real world | the parity checklist, then the release checks on real computers and networks | people | before the switch |

**Performance budgets**, measured in the real Linux app:

- Typing never runs ahead of the letters (#169).
- Scrolling holds steady frames (#170).
- A new window draws within a few hundred milliseconds.
- Memory per extra window is recorded, not guessed.

Numbers go in `system.md` once they have been measured.

## Build order (M15)

Each step lands on `feat/198-buddy-list` with its tests. Each step also has a
real-app check before the next step leans on it.

| Step | Done when |
|---|---|
| M15.0 Foundations | These docs, the tokens, the kit, the gallery, and the discipline, contrast and geometry tests all pass. |
| M15.1 The switch and the owner | `LINGER_NEXT=1` opens the list window. It signs in with the existing sessions and shows real rooms, DMs and people, drawn only from the kit. |
| M15.2 The chat window | Opening a room opens the `chat` window with a tab. Catch-up and borrowed tokens work, and a conversation reads, sends and loads history. |
| M15.3 Voice | The voice bar in the list, the strips in rooms, and "move voice here" as an intent. Switching or closing tabs never leaves voice. |
| M15.4 People and DMs | The person card with Message and Knock, the new-message picker, away and away messages. |
| M15.5 Settings | Every setting in the parity list, in the Settings window. |
| M15.6 Media, search and uploads | Media, search and uploads, as the design places them. |
| M15.7 Windows mode | Separate windows, pop-out and back, positions remembered, the tray. |
| M15.8 Several servers | Folding server sections, the time there, quiet, and a server in its own window. |
| M15.9 Parity and the switch | Every item in `parity.md` is proved. The switch becomes the default, the old client stays one release as a fallback, then it is deleted, and SPEC §3/§5 are rewritten from `system.md`. |

## Open decisions for Matt

- **Light theme.** The design is dark only. Keep it that way, or design a light
  version before the switch?
- **The host time zone** for "4:52 AM there". It needs one small server
  setting. Build it in M15.8, or drop the line?
- **The small logo mark.** A placeholder until it is redesigned.
- **Closing the list.** The tray is the proposed default; quitting is the other
  option.
