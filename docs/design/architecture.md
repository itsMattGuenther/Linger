# The Buddy list client: architecture

**Status:** built as M15 (#198), and the app from 0.4.0. The design is
`buddy-list.md`, the visual rules are `system.md`, what it had to match is
`parity.md`, and the lessons it must not repeat are `lessons.md`, all in this
folder.

The Buddy list client replaced the previous client (the "Console" design),
which stayed three releases behind `LINGER_CLASSIC=1` and was deleted after
0.4.3 (#306). This document says where the code goes, how the windows share
one connection, and how the pieces are tested.

## Goals

- **The prototype's look and feel, exactly.** It must stay fast and quiet on
  the slowest engine it runs on, WebKitGTK on Linux.
- **Built to last.** Clear layers, rules enforced by tests rather than by
  memory, and every lesson from the first client turned into a check.
- **No risk to the released app.** The old client kept shipping and updating
  until the switch, and stayed behind a switch for three releases after it.

Not in M15:

- **No server change**, except the host time zone (see *Open decisions*).
- **No voice forwarding** (#197, shipped separately in 0.4.1) and **no voice
  encryption** (#200).
- **No macOS build.**
- **No light theme.** Decided 2026-09-28: the app is dark only, for good.

## Where the code lives

| Path | What it is |
|---|---|
| `client/next.html` | The entry page for every new-client window. The window's role and conversation come from the URL. |
| `client/src/next/styles/` | Design tokens and base styles (`system.md`). |
| `client/src/next/kit/` | The kit of parts: every button, row, marker, tab, title bar and field. Screens build only from these. |
| `client/src/next/core/` | New logic with no UI: window roles, the catch-up protocol, borrowed tokens, intents, view models. Pure where possible, and unit-tested. |
| `client/src/next/app/` | Screens: the list window with the conversations beside it, a conversation's own window, Settings, the person card, the new-message picker. |
| `client/src/lib/`, `client/src/generated/`, `client/src/fonts/` | **The shared core:** the REST client, sessions, the gateway store and its pure `apply`, IPC, sounds, updates, name styling, the palette, and the wire types from `linger-core`. `lib/` is logic only, no components. |

`client/src/next/kit/discipline.test.ts` fails the build if code under
`src/next` imports anything in `src/` but the shared core, if `src/lib` holds
a component or leans on anything outside the core, or if CSS uses raw colors
or magic sizes.

**Why reuse the core instead of rewriting it.** The gateway store encodes the
hardest-won behavior in the project: history windows (#173), resume without
gaps, read positions without counts, and DM filtering. It is covered by about
1,350 lines of tests. Rewriting it would re-learn all of that. The new client
changes how things look and how windows work, not what a message is.

With the old UI deleted (#306), `src/next/` could move up to `src/` in one
mechanical commit. It hasn't: every path in these docs and the tests would
move with it, for no change anybody sees.

## Windows and their roles

Two terms first:

- **Owner:** the one window that holds sign-in, the server connection and the
  side effects.
- **Viewer:** any other window. It shows things and asks the owner for
  anything only the owner may do.

| Window | Tauri label | Role |
|---|---|---|
| The buddy list, and the conversations beside it (#337) | `main` | **Owner** |
| A popped-out or separate conversation (windows mode) | `chat-<server>-<room>` | Viewer |
| Settings | `settings` | Viewer |

**The conversations beside the list are the owner's, not a viewer** (#337,
`app/chat/SidePane.tsx`). They're drawn in the list window's own page, so
there's nothing to catch up on and no sign-in to borrow: they read the same
store and use the owner's own sign-ins. What they'd ask of the owner goes
straight to the same handler every window's intents reach (`Sharing.local` in
`core/share.ts`), without a trip through the shell, and reports as `side`
(`SIDE`), so presence and the notifier treat it like a window showing a
conversation (`core/showing.ts`). Folded away, it isn't drawn, so it says
it's closing and you're around rather than in its room. Mute, Deafen and
Leave on its voice lines act directly, as the voice bar does.

- **The cost, taken knowingly:** other people's messages and links are now
  drawn in the window that holds the keyring, the connections and voice,
  where before only viewers with fewer permissions drew them (`acl.rs`). The
  split was a second wall, not the only one: the client inserts no raw HTML
  anywhere (`lib/markdown.ts` builds elements, never markup) and the page's
  content security policy runs no script Linger didn't ship (`script-src
  'self'`, `tauri.conf.json`). Anything that loosens either of those has to
  put the split back first, as a second webview in the same window
  (issue #337 has why that wasn't done now).

**The owner is the only window that:**

- restores sessions and **refreshes tokens**;
- **connects** to each server's gateway;
- plays **chimes**, shows **desktop notifications** and plays the knock sound.
  The one sound it leaves to another window is the one that confirms a voice
  control pressed there: it plays where it was pressed (see *Viewer → owner:
  intents*);
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
            └──────────────► other windows (viewers): apply(state, frame), no side effects
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
| `read`, `readLoaded` | the owner loads markers, again on every fresh `ready` (#453); whichever window you read in marks them | intent to the owner, then owner broadcast |
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

**Refresh tokens never leave the owner window**, or the keyring, and
`api.test.ts` proves that.

## Viewer → owner: intents

A viewer asks the owner to do the things only the owner may do. Each **intent**
is typed, versioned and handled in one place (`Intent` in `core/share.ts`):

- `read`: mark a conversation read up to a message (the owner keeps read
  positions and tells every window);
- `window`, `room`, `closing`: for presence, this window's focus, the person
  moving in it, the conversation it shows, and that it is going;
- `voice.join` (which also moves voice), and `voice.talk` for push-to-talk
  pressed in that window. The owner remembers which windows hold the key
  down, and closes the microphone if one of them goes without letting go
  (Ctrl+W, with Ctrl as the key). Mute, Deafen and Leave are questions
  instead (below), so the window pressed can play their sound;
- `voice.pushtotalk`: Settings turned push-to-talk on or off, or picked its
  key. Joining only reads the choice, so this applies it to the call you're
  in at once (#231), and tells the list window's voice bar which key to name;
- `voice.devices`: Settings picked another microphone or speakers. It applies
  to the call you're in at once (#249): the devices are reopened in place,
  under the call. Out of voice it does nothing, since the next join reads what
  Settings saved. (`voice.forwarding`, Settings' switch for the old way of
  voice, went with the mesh, #306);
- `popout` and `tabs`: move a conversation into a window of its own, or back
  beside the list as a tab (only the owner opens windows);
- `open`: show a conversation where conversations open, from a window of its
  own (Message on a person's card). It says whether it's a room or a DM, since
  a DM made a moment ago may not have reached the owner yet;
- `conversations`: beside the list or each in its own window, from Settings;
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
was already on its way. A conversation's own window on that server closes, the
tabs beside the list lose that server's tabs, and Settings closes when no
server is left.

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

**A voice control's sound plays where it was pressed (#241).** Mute, Deafen
and Leave on the voice line of a conversation in its own window are questions too
(`next:voicecontrol`). The owner makes the change exactly as it does for its
own voice bar, but doesn't play the sound that confirms it. Once the voice
engine has taken the change, it answers with that sound, and the window that
was pressed plays it (`core/voiceControl.ts`). A change that fails is
answered with the problem, and nothing plays.

- **Why there:** a sound is the answer to a click. The window just clicked
  has had a gesture, so its audio is awake. The list window may be hidden or
  behind, and on Linux its sound for a click in another window came several
  seconds late, though the mute itself was instant. Beside the list the click
  is in the list window itself, which acts and plays the sound as its voice
  bar does.
- **Never two:** the owner never plays a sound it has answered with.
- **Never late:** the pressed window waits at most a second
  (`CONFIRM_WITHIN_MS`). A later answer plays nothing, since a sound that late
  reads as a fault; the change still happens.
- **The same settings:** every window uses the one player (`lib/sound.ts`),
  and reads the same saved choices, so Mute all and each kind's switch apply
  wherever the sound plays.
- **Unchanged:** the list window's own voice bar, and the tray menu, which
  the list window carries out, still sound in the list window. Joining still
  sounds there too, when the server's frame seats you.

**How it looks is the same in every window.** Plain names and interface size
are kept on this computer; Settings saves a change and announces it
(`next:appearance`), and every window applies it (`core/appearance.ts`).
Interface size zooms the page and grows the window by the same ratio, because
the new client's sizes are fixed pixels and a larger base font would grow
nothing.

**Sound preferences need no message.** Mute, quiet hours, the chime switches
and the sound volume are kept on this computer (`linger.sound.*`, `lib/sound.ts`).
The list window plays every sound, and its player reads them from storage
again for each one, so a change saved in Settings holds from the list's next
sound. Settings plays its own previews, in its own window.

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
focus, if any. A message arriving there doesn't chime or pop a banner.

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
  command: `next_open_settings { section }` for Settings, and
  `next_open_conversation { server, room, kind }` for a conversation in its
  own window, labelled from the conversation so asking again brings the same
  window forward. Opening a conversation from the list shows it in its own
  window if it has one, and otherwise where conversations open: beside the
  list, or a window of its own (`Sharing.open` in `core/share.ts`). Rust builds the URL from a fixed pattern: no page can open
  an arbitrary URL, and only `main` may call the command. That is least privilege, as ARCHITECTURE §7 asks. The
  capability file lists each window's permissions. Viewers get what they need
  to read events and open links, and nothing more.
- **The app's own commands are checked too.** `build.rs` declares every
  command, which turns on Tauri's access checks for them: a window may call
  only what its capability file grants. `owner.json` gives `main` all of them.
  A conversation's own window (`chat-*`) gets `gateway_send` (typing), `graphics_started`,
  `sound_play` (#241) and `clipboard_image`, which reads a picture off the
  clipboard when one is pasted into the message box on Linux, since
  WebKitGTK never shows the page one (#276, `src-tauri/src/clipboard.rs`),
  and `clip_start`, `clip_stop` and `clip_cancel`, which record a voice
  message from the message box's panel (#401, `src-tauri/src/clip.rs`). Only
  a window with a message box may record; a recording goes with the window
  that started it.
  Settings gets `graphics_started`, `voice_devices`, the three update commands,
  `newest_version` for the version note in Hosting → Server (#314), and
  `autostart_state` and `autostart_set` for starting Linger when you sign in
  to the computer (#228). That last is a setting of this computer that no
  other window shares, so Settings asks the operating system itself rather
  than going through the owner. The keyring, the connections, voice,
  notifications and window opening stay the owner's, and
  `src-tauri/src/acl.rs` fails the build's tests if a capability ever hands
  one to another window, starting at sign-in to any window but Settings
  and the list, or the clipboard to any but a conversation's window and the list.
- **Still open:** any window may send any event, and the owner can't tell a
  `gateway:frame` the Rust core sent from one a viewer made up. A viewer that
  renders a hostile message can't reach this without a way to run script,
  but the fix is for Rust to hand the owner its frames on a private channel
  (a Tauri `Channel`) instead of a broadcast event (T-1811).
- **Search and Media** (decision 15) open as tabs beside the list (#337):
  the list window draws them (`app/tools/panels.tsx`) and they ask each
  server with its own sign-in. When everything opens in a window of its own,
  or one is popped out, they're windows of their own, `search` and `media`,
  opened by the owner (`next_open_tool`), which come back as a tab with the
  `tool` intent.
  They are viewers: they catch up like a conversation's own window, ask the
  server with the borrowed sign-in, and ask the owner (the `open` intent, with
  a message) to show what was found. The conversation then jumps to that
  message if it's loaded, or reopens the room around it (`openAround`) and
  goes there.
  Walking into the tab doesn't open the room a second time: the visit waits
  for the opening already on its way, because the store drops a page asked
  for under an earlier opening of the room (#266).
- **Beside the list** (the default, #337): the list window holds the tabs
  (`linger.next.tabs`) and whether it's unfolded to show them
  (`linger.next.side`, with how wide the list and the conversations were
  left). Opening a conversation adds a tab or shows it, and unfolds the
  window: it grows to the right by the conversations' width, and moves left
  where its screen ends (`core/side.ts`, `growBeside` in `ListWindow.tsx`).
  Folding shrinks it back to the list's width. A maximized window keeps its
  size, and so does one a tiling desktop sizes: Linger asks, and the desktop
  may say no. Too narrow for both, the conversation takes the window
  (`beside`), and a narrower window squeezes the list before that. The line
  between the list and the conversations drags (the kit's `Splitter`): the
  list's width, kept with the rest. A conversation opened from elsewhere (a banner, a
  conversation's own window, Search) brings the list window forward, out of
  the tray if it was there, but only when it doesn't have the focus: some
  desktops move the pointer to a window an app focuses (#226). There's
  nothing to hand over and nothing to miss, since the tabs are in the
  owner's own page. A tab can be popped out into its own window, and put back.
  A half-typed message goes along, through this computer's storage, taken
  once and thrown away after a minute (`core/handoff.ts`). Files waiting to
  be sent stay behind.
- **Windows mode:** one window per conversation. A tiling desktop such as
  Hyprland places them. The choice is kept on this computer
  (`core/conversations.ts`); Settings asks the owner to change it (the
  `conversations` intent), and the owner tells every window (`next:mode`).
  Switching moves what's open at once: every tab into a window of its own,
  the showing one last so it lands on top, or every such window back beside
  the list. The list window doesn't hear its own broadcast, so the owner tells
  it directly (`ListControls.conversations`).
- **Title bars.** Every new-client window is frameless and draws its own title
  bar from the kit, with a drag region and window controls where the desktop
  has none: close everywhere, and minimize on Windows (#386,
  `core/windowControls.ts`), since a tiling Linux desktop has no minimizing.
  Windows 11 shadows and resizing on frameless windows need checking early on
  Windows.
- **Remembering.** Open tabs and their order are remembered on this computer
  (`linger.next.tabs`), and whether the list was unfolded (`linger.next.side`).
  Closing the last tab folds the list window back, and the next conversation
  opened starts a fresh set. Every new-client window's size,
  position and maximized state are remembered by the desktop shell
  (`tauri-plugin-window-state`, `remembered_windows` in `window.rs`). They are written to
  disk when Linger quits and whenever a window other than the list closes,
  since an update on Windows or a crash ends Linger without quitting. Each
  window also remembers which interface size it was sized for, so a
  remembered window isn't grown again on the next run (`core/appearance.ts`).

## The phone's one window

The phone app (SPEC §4.15) is this client in one window, the list, which is
the owner. Its shell opens `next.html?shell=phone` (`tauri.android.conf.json`,
`tauri.ios.conf.json`), and `core/phone.ts` reads that; the desktop never adds
`shell`, so a browser test opens the phone's layout by adding it.

- **One screen at a time, no tabs.** The list is home. A conversation, Media
  or Search opens as a screen over it, filling the phone, with ← Back at the
  start of its bar and its name beside it (`ChatView`'s `stack`), the way
  phone chat apps do it (Discord's is the model Matt picked, 2026-10-03).
  Underneath, they're still the side's tabs, kept as a stack: what opens
  goes on top (`pushTab` in `core/tabs.ts`), Back takes the top off
  (`backTab`), and the last one off folds back to the list. So a search hit
  opens over Search, and Back from it is Search again. Rows and the title bar
  are taller on the phone (`--row-1`, `--titlebar` in `tokens.css`), so a
  thumb can hit them, and nothing may reach past the screen's right edge
  (`next-phone.spec.ts` checks every screen).
- **Nothing opens a window.** The phone's capability (`capabilities/phone.json`)
  grants none of the window commands. Settings, a window of its own on a
  computer, is drawn over the list (`.nx-phone-over` in `ListWindow.tsx`):
  `Settings` takes a `SettingsHolder`, which is either its own window, reaching
  the owner over the shell's events, or the owner itself, answering Settings'
  questions directly (`Sharing.localNotify`, `Sharing.localPassword`). There,
  Settings is its list of sections, then one section over it, each with ←
  Back where a computer has its close button.
- **Android's Back.** The newest thing open answers it (`useBackButton`, a
  stack behind one listener): a picture closes, the top screen over the list
  comes off, and in Settings a section goes back to the list of them and
  then out. With nothing open, nobody listens, and Android does what it does
  with Back: leaves the app. Its back gesture, a swipe in from the screen's
  edge, is the same Back.
- **Sounds follow the phone.** A chime asks the phone's ringer first
  (`followDeviceSound` in `lib/sound.ts`, `src-tauri/src/phone_sound.rs`):
  on vibrate it buzzes, on silent or Do Not Disturb nothing happens. Android
  plays chimes and buzzes itself, as notification sounds, through
  `sound_play` (the desktop's call) and `phone_buzz`, so they follow the
  notification volume and need no tap on the page first.
- **No desktop furniture.** No notifications at all (`setNoNotifications`
  in `lib/notify.ts`, set at startup: no banner, nothing asking for
  attention; in-app sounds still play), no close button on the list (the
  phone closes apps), no pop-out, no voice line (voice messages, yes: the page
  records them itself, `app/chat/recorders.ts`), and Settings has no Windows or
  Notifications, no microphones, no updates and no Interface size: it zooms
  the window, which the phone can't, and the phone's own display and text
  size do that job.
- **In the background, and without a network.** Thirty seconds after the
  app goes into the background its connections close, so it shows offline,
  and they open again when it's back (`watchBackground`,
  `BACKGROUND_GRACE_MS`). Android freezes an app it has stopped showing after
  about a minute, after which no timer runs, so the grace has to come first.
  Android 17 on a Pixel also blocks a background app's network after about
  five seconds, so there the connections drop sooner and their tries back
  off into the block. Back on the screen within the grace, the app asks them
  to try again at once (`retryAllNow`, `gateway_retry`, `Handle::retry`)
  rather than wait out a backoff that can reach half a minute.
  When the phone loses its network the connections close too, and they open
  the moment it's back (`watchNetwork`) rather than when missed heartbeats
  notice; the web view hears about the network only with Android's
  `ACCESS_NETWORK_STATE` permission (`AndroidManifest.xml`).
- **The phone's text size.** Linger follows the phone's Font size, up to
  twice the usual (`phone_text_scale` reads it, `followTextSize` sets
  `--text-scale`, and the phone's tokens multiply text, line boxes, rows and
  controls by it). The web view's own text zoom is off (`textZoom` 100 in
  MainActivity.kt): it enlarged fonts and line spacing and no box around them,
  and cut names in half. Icons and marks keep their size, as in Android's own
  apps, and `next-phone.spec.ts` checks every screen at twice the size for
  words cut off or reaching past the edge.
- **The phone's bars.** The page is drawn under the phone's status bar and
  gesture bar; `styles/phone.css` pads it by the safe areas the phone reports,
  and `--window-height`, the whole window on a computer, is what's left
  between them.
- **The keyboard.** A phone's keyboard covers the page instead of shortening
  it, and the browser slides the page up to show the box being typed in,
  which left the message box half under the keyboard and the conversation's
  header gone. `followKeyboard` holds the page to the part of the screen
  that's visible (`--phone-top`, `--phone-height`, `data-keyboard`), so the
  message box sits on the keyboard. Android's web view ignores the viewport's
  `interactive-widget`, which was tried first.

## The list window

- **The Buddy list is the app** from 0.4.0: the shell opens `next.html` as the
  `main` window, tall, narrow and frameless, as `tauri.conf.json` says. The
  previous client that `LINGER_CLASSIC=1` used to open instead was deleted
  after 0.4.3 (#306).
- **Closing the list** hides it and keeps the connections, sounds and voice
  running; the tray icon (`src-tauri/src/tray.rs`) brings it back, mutes,
  leaves voice or quits. Settings → Windows turns that off
  (`core/closing.ts`), and so does a desktop with no tray. A second launch
  shows the running copy's list (`tauri-plugin-single-instance`). Hiding it
  tells the list (`next:hidden`), which the first time ever on that computer
  shows a notification saying where Linger went (#400).

## Testing strategy

Every rule is enforced at the lowest layer that can catch it, and every bug
fixed gets a test at that layer.

| Layer | What is proved | How | Runs |
|---|---|---|---|
| Pure logic | view models (grouping people, room activity, DM order), the tab state machine, intents, window keys | vitest | `pnpm test`, CI |
| State across windows | a viewer's state equals the owner's for any frame stream, with reconnects, resumes and any snapshot point | vitest property tests over generated frame streams | `pnpm test`, CI |
| Tokens | one refresh at a time, and viewers never refresh | vitest (`api.test.ts` plus new tests) | `pnpm test`, CI |
| Visual discipline | no raw colors or magic sizes in CSS, and imports only from the shared core | vitest (`discipline.test.ts`) | `pnpm test`, CI |
| Contrast | text tokens and all 16 name colors against every surface | vitest (`contrast.test.ts`) | `pnpm test`, CI |
| Kit geometry and access | the three control heights, centered icons, identical row heights across all 12 faces, aligned names, ellipsis instead of clipping, 24px hit targets, visible focus, accessible names, keyboard roving | Playwright on the kit gallery | Chromium locally; Chromium and WebKit in CI |
| Screens | tabs, the voice bar, the person card, the new-message picker, Settings, driven with a fake store | Playwright on fixture pages | local and CI |
| Several windows | catch-up, borrowed tokens and every intent end to end: two copies of the store in one test sharing an in-memory bus (`core/share.test.ts`), a conversation's own window against a faked shell, owner and server (`tests/fixtures/next-chat-window.html`), and the tabs beside the list in the real list window, with its size faked (`next-side.spec.ts`) | vitest; Playwright | local and CI |
| Real WebKitGTK and WebView2 | the packaged app starts and draws its list at every interface size, and plays sound | `scripts/linux-next-check.mjs`, `client/scripts/windows-next-check.mjs`, the packaged audio checks (`docs/packaged-audio-checks.md`) | CI's package check |
| Real windows, signed in | real windows and title bars, fonts, typing latency, scrolling, several windows at once, against a real server | a `tauri-driver` desktop check under Xvfb (T-1820, not built yet) | local, before a release |
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
| M15.1 The switch and the owner | The shell opens the list window. It signs in with the existing sessions and shows real rooms, DMs and people, drawn only from the kit. |
| M15.2 The chat window | Opening a room opens the `chat` window with a tab. Catch-up and borrowed tokens work, and a conversation reads, sends and loads history. |
| M15.3 Voice | The voice bar in the list, the strips in rooms, and "move voice here" as an intent. Switching or closing tabs never leaves voice. |
| M15.4 People and DMs | The person card with Message and Knock, the new-message picker, away and away messages. |
| M15.5 Settings | Every setting in the parity list, in the Settings window. |
| M15.6 Media, search and uploads | Media, search and uploads, as the design places them. |
| M15.7 Windows mode | Separate windows, pop-out and back, positions remembered, the tray. |
| M15.8 Several servers | Folding server sections, the time there, quiet, and a server in its own window. |
| M15.9 Parity and the switch | Every item in `parity.md` is proved. The switch becomes the default (0.4.0), the old client stays behind as a fallback, then it is deleted (#306), and SPEC §3/§5 are rewritten from `system.md`. |

## Open decisions for Matt

- **Light theme.** Decided (2026-09-28): dark only. No light version is
  planned.
- **The host time zone** for "4:52 AM there". It needs one small server
  setting. Build it in M15.8, or drop the line?
- The rest are listed, with what each blocks, in `parity.md` ("Decisions
  still needed").
