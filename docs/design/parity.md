# Parity: what "ready to switch" means

**Status:** the gate for M15's switch (#198, T-1810), written 2026-09-25.

The Buddy list client becomes the default only when every item below is
**proved** in the new client, or deliberately dropped by a recorded decision.
"Proved" means the check in the *Proof* column exists and passes; it does not
mean "looks right". A PR that proves an item cites its ID (for example
`CONV-12`) and names the test.

Sources: SPEC §3–§5, PROTOCOL, ARCHITECTURE, TASKS and `docs/tasks/`, the user
and host guides, and the old client's code in `client/src/**` and
`client/src-tauri/src/**`. The design is [`buddy-list.md`](buddy-list.md) plus
the prototype (`client/prototypes/buddy-list/` on the `design/buddy-list`
branch). The architecture and test
layers are in [`architecture.md`](architecture.md), and the lessons every item
must respect are in [`lessons.md`](lessons.md).

## How to read the tables

- **Capability:** what a person can do or rely on, in plain words.
- **Today:** where it lives in the old client, or the spec section that defines
  it.
- **Buddy list:** what the design changes. "Same" means it carries over
  unchanged. **Silent** means the design doesn't say, and the item points at
  a decision below.
- **Proof:** how the new client proves it.

| Code | Proof |
|---|---|
| **U** | Unit test (vitest), for pure logic and view models. |
| **C** | Shared core, already covered by the old client's tests (`lib/gateway.ts`, `lib/api.ts`, `lib/session.ts` and others). The new client reuses the code, so the item also needs a **U** or **F** proving the new surface calls it correctly. |
| **F** | Fixture test: Playwright on a fixture page with a fake store, in Chromium and WebKit. |
| **G** | Geometry test: Playwright measuring boxes on the kit gallery or a fixture (heights, centers, alignment, overflow). |
| **D** | Desktop check: the real app under WebKitGTK (and WebView2 on Windows CI) through `tauri-driver`, per `docs/desktop-checks.md`. |
| **M** | Manual: people, real computers, real networks or ears. Only where nothing automated can do it. |

- **Status:** where the new client stands on the item.

| Mark | Status |
|---|---|
| ✅ | Done: built in the new client, and a test proves it (named in brackets). |
| 🟡 | Partly: built, but missing a piece, a test, or a check in the real desktop app (said in the cell). |
| ⬜ | Not started in the new client. |
| ⏸ | Waiting on a decision below. |

## Where things stand (2026-09-25, end of day)

Of 231 items: **149 done**, **64 partly**, **1 not started**,
and **17 waiting on a decision**. Nothing has been tried in the real
desktop app yet; every ✅ is proved in a browser test or a unit test.

What's left, biggest first:

- **Checks in the real app.** Windows, title bars, remembered window places,
  voice audio and connection trouble, typing speed, a 10,000-message room,
  downloads, dropped files on Windows, typing a date in WebKitGTK, and
  whether each window's permissions let it do what it does. The code is
  there; nobody has run it on a real desktop.
- **Smaller pieces still missing:** a per-server own window (MULTI-7),
  evening warmth (LOOK-2, waiting on an evening version of the colors) and
  the update check at launch (UPD-1, which has nowhere to say "update ready"
  until decision 1).
- **17 items wait on Matt**, mostly decisions 1 (the status bar's jobs),
  4 and 5 (the tray), 10 (message aging) and 21 (old gaps).

Four decisions were answered on 2026-09-25, all kept as built: 9 (names
inline, once per run), 14 (Away everywhere), 16 (signing in lives in the list
window) and 18 (the server's color is the host's accent). With 18 came a
change: a newcomer starts on the color the fewest people on the server wear,
not gray. They're written up in `buddy-list.md`.

Half of decision 10 is also settled: the 80ch line limit is the `--measure`
token in `system.md`.

## Decisions still needed

Each is referenced by the items it blocks. Matt decides; the answer goes into
`buddy-list.md` or `system.md`, and the item moves on.

1. **The status bar's jobs.** Today a permanent status bar (SPEC §5.6) shows
   connection state in protocol words ("connecting… tls ok… ready (28ms)"),
   the server's storage figure, "update ready" and "not remembered" (the
   keyring warning). The design has no status bar. Each of the four needs a
   home: the list's footer, the server header, or Settings. *(SRV-6, SRV-7,
   UPD-5, SIGN-9)*
   **Decided (2026-09-25):** a quiet line at the list's foot for each, only
   while it's true: a server not connected after five seconds, sign-ins not
   remembered, a new version (with Update…, which opens Settings). The
   storage figure moved to the Media window, beside how long files are kept.
   The protocol words ("tls ok…", "ready (28ms)") are gone.
2. **Light theme.** The design is dark only; today has dark, light and
   follow-the-system. Keep dark only, or design a light version before the
   switch? *(LOOK-3)*
3. **The host's time zone** for "4:52 AM there" needs one small server setting
   and a protocol field. Build it in M15.8, or drop the line? *(MULTI-8)*
4. **Closing the list:** keep running in the tray (the proposed default) or
   quit. Tray support varies on Linux: GNOME shows no tray without an
   extension, and Waybar needs its tray module. There needs to be a fallback.
   *(WIN-7)*
   **Decided (2026-09-25): the tray by default**, with Settings → Windows
   offering "quit" instead. A desktop with no tray quits, so the list can't
   be lost.
5. **Voice while the list is hidden.** Voice controls live only in the list's
   voice bar. If the list is tucked into the tray during a call, where are
   mute, deafen and leave: a tray menu, or does the list refuse to hide while
   you're in voice? *(VOICE-14, WIN-7)*
   **Decided (2026-09-25): a tray menu** with Mute (or Unmute) and Leave
   voice, next to Show Linger and Quit.
6. **Push-to-talk key.** Today it is fixed to Ctrl (`lib/voice.ts`). The
   design's Settings shows "push to talk with its key", which suggests
   choosing it. Ctrl also starts the new shortcuts (Ctrl+Tab, Ctrl+W, Ctrl+K,
   Ctrl+,), so while push-to-talk is on, every shortcut briefly opens the
   microphone. Choose: a different default key, a picker, or accept it.
   *(VOICE-8, KEY-1)*
7. **The speaking indicator.** SPEC §5.6 turns a speaking name over onto a
   block of its color. The prototype uses moving sound bars and a highlighted
   chip. Pick one. Whichever wins must change no geometry (#137, #139).
   *(VOICE-5)*
8. **Per-person volume.** Today it's a click or right-click on a voice seat.
   The design doesn't say where it lives: the voice bar's chips, or the person
   card. *(VOICE-10)*
   **Decided (2026-09-25): the voice bar's chips.** A chip opens a small card
   over it with a slider from 0% to 200% and Back to 100%.
9. **Names inline versus group heads.** The design writes `Eli: text` inline.
   SPEC §4.7 groups consecutive messages under one name with a 10-minute break,
   and puts a reply's quote under the name. Decide: does every message repeat
   the name inline, or only the first of a group? Where does a reply's quote
   sit? *(CONV-4, CONV-9)*
   **Decided (2026-09-25): kept as built**: once per run, and a reply's quote above its own line (`buddy-list.md`).
10. **Message aging** (bodies fade to 88% after an hour and 78% after a day,
    SPEC §4.7) and the **80ch line limit**. Neither appears in the design. Keep
    or drop? *(CONV-6, CONV-7)*
11. **Drafts.** Today a half-typed line is dropped when you switch rooms, and
    files carry over (`Stream.tsx`). With tabs, each conversation has its own
    composer. Should drafts survive closing a tab, or a restart?
    `architecture.md` lists drafts as local state. *(COMP-9)*
12. **Door sounds and entrance sounds.** The design adds arrival cards and an
    optional door chime. SPEC §4.1 specifies personal entrance sounds (unbuilt,
    T-901–T-903) with a once-per-5-minutes-per-listener limit and quiet hours.
    Is the door chime the first step toward entrance sounds, or its own
    feature? Does it follow the same limit? *(NEW-6)*
13. **Arrival cards.** Are they notifications? They must not take focus.
    Should they follow quiet hours and a quiet server? Should they be
    announced to screen readers? *(NEW-5)*
14. **Away everywhere.** Today away is per server, one account at a time. The
    design's single Away button writes to every ticked server. What does it
    say when one server refuses or is offline? *(PPL-9)*
    **Decided (2026-09-25): kept as built**: a refusal is said under that server, and the rest still go away (`buddy-list.md`).
15. **Where Media and Search open:** a tab in the chat window, their own
    window, or a panel of the list? *(MEDIA-1, SRCH-1)*
    **Decided (2026-09-25): their own windows**, as in the prototype, opened
    from Media and Search at the foot of the list.
16. **Sign-in and first run in the new shell.** The design shows only the
    signed-in list. Is the paste box a small list-sized window, and where does
    "+ Add a server" open? *(SIGN-1, SIGN-8)* Built for now as the list
    window itself: signed in nowhere, it opens on the paste box, in the
    list's size and look (`app/signin/SignInView.tsx`). "Add a server" is in
    Settings → Servers with several servers, and next to Sign out in
    Account & App with one; either shows the same screen in the list window,
    with a way back, and every server stays connected meanwhile.
    **Decided (2026-09-25): kept as built** (`buddy-list.md`).
17. **Empty states:** no rooms yet, no DMs, a quiet server, an empty search,
    an empty media collection. Today each has copy and the porch mark (SPEC
    §5.6 "quiet delight"). The design doesn't show them. *(LIST-9)*
18. **The server accent.** Today the host picks an accent palette key
    (`PATCH /server`). The design colors each server's stripe and tag. Is that
    color the host's accent? *(HOST-9, MULTI-6)*
    **Decided (2026-09-25):** yes, the host's accent, the same for everybody.
    Each person's own color is their name's, chosen per server in Profile; a
    newcomer now starts on the color fewest people there wear instead of gray
    (SPEC §4.5). The palette stays at 16; Profile should make gradients and
    fonts easier to find, so a big server can still tell people apart.
19. **Minimum window sizes, and interface scale across windows.** The old
    resizable columns and narrow-window drawers (SPEC §5.6) don't apply. Set
    minimum sizes for the list and chat windows, and confirm interface scale
    100–200% applies to every window. *(LOOK-1, WIN-4)*
20. **Notification clicks.** What does clicking a desktop banner do: focus
    the list, or open the conversation in a tab? *(NOTE-7)*
21. **Existing gaps: fix in the new client, or carry them over?**
    - T-907: healthy servers open while another server is down.
    - T-908: a pin action (the server supports pins, and media filters by
      them, but the conversation has no pin control).
    - T-921: outsiders see a private room's occupants as "in a room" rather
      than "around".

    *(SRV-3, CONV-16, DM-4)*
22. **Many rooms.** The narrow list suits three to six rooms per server. Decide
    what happens at fifteen. *(LIST-3)*

---

## SIGN — signing in and staying signed in

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| SIGN-1 | One box to paste into. What was pasted decides the next form: sign in, accept an invite, or first-run setup. | `auth/AuthScreens.tsx`, `lib/link.ts`, PROTOCOL §2.2 | Same flow; its window and look are **silent** (decision 16). | U (`link.ts` exists) + F | ✅ in the list window, the default until decision 16 (next-signin.spec.ts) |
| SIGN-2 | Understands `https://host/setup?token=…`, `https://host/invite/CODE` (and `?code=`), and a bare host. | `lib/link.ts` | Same | C + U | ✅ (lib/link.test.ts, core/signin.test.ts, next-signin.spec.ts); a sentence is no longer read as an address |
| SIGN-3 | Sign in with username and password. The username is trimmed and lowercased. | `AuthScreens.tsx` `Login`, `POST /auth/login` | Same | F | ✅ (next-signin.spec.ts, core/signin.test.ts) |
| SIGN-4 | Register from an invite: username, display name, password (8 characters minimum, no other rules). The button is greyed until valid. | `AuthScreens.tsx`, `POST /auth/register`, `GET /auth/invite/:code` | Same | F | ✅ (next-signin.spec.ts, core/signin.test.ts) |
| SIGN-5 | First-run setup: the server's name, username, display name, password. Needs a valid setup token. "Setting up a new server?" help. | `AuthScreens.tsx`, PROTOCOL §2.1 | Same | F | ✅ (next-signin.spec.ts) |
| SIGN-6 | Server errors shown as sentences, in the server's own words when it has them. | `messageFor`, PROTOCOL §1 | Same | U + F | ✅ (core/signin.test.ts, next-signin.spec.ts) |
| SIGN-7 | Sign-ins survive restarts. Refresh tokens live in the OS keyring, one entry per server; nothing about the account is cached. | `lib/session.ts`, `src-tauri/src/secrets.rs` | Same, **owner window only** (architecture: refresh tokens never leave the owner). | C + U (borrowed tokens) | ✅ (next-list-window.spec.ts, share.test.ts) |
| SIGN-8 | Several servers at once. Signing out of one leaves the rest alone. Signing back in keeps the server's place in the order. | `lib/session.ts` | Same; order shown as sections, and adding a server is **silent** (decision 16). | C + F | ✅ several servers, and adding one from Settings into the list window with every other server still connected (next-list-window.spec.ts, next-settings-window.spec.ts) |
| SIGN-9 | "Not remembered" warning when the keyring can't store a sign-in, shown before anyone is surprised by it. | `App.tsx` status bar, `session.ts` `keyringNotice` | On the sign-in screen, then a line at the list's foot (decision 1) | F | ✅ (next-signin.spec.ts; next-list-window.spec.ts "a computer that can't keep sign-ins") |
| SIGN-10 | Only an authentication rejection ends a sign-in. A server outage, rate limit or network failure keeps the saved token (T-906, PROTOCOL §2). | `lib/api.ts`, `session.ts` | Same | C | ✅ (lib/api.test.ts, next-chat-window.spec.ts) |
| SIGN-11 | A sign-in that ended on its own says why on the next screen. | `AuthScreens.tsx` `notice` | Same | F | ✅ (next-signin.spec.ts) |
| SIGN-12 | Restore happens exactly once per launch; the StrictMode double mount can't spend a refresh token twice. | `session.ts` module-scope promise | Same, plus viewers never refresh. | C + U | ✅ (next-list-window.spec.ts, lib/api.test.ts) |
| SIGN-13 | Signing out forgets the server on this computer and revokes the token family. It doesn't delete the account. | Settings → Account & App, `POST /auth/logout` | Settings → Account & App, and Settings → Servers per server | F | ✅ everything, or one server from Settings → Servers, and every open window lets it go (next-settings-window.spec.ts, next-list-window.spec.ts, share.test.ts) |

## SRV — servers and connections

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| SRV-1 | One gateway connection per server, owned by Rust: hello, identify or resume, heartbeat, backoff. | `src-tauri/src/gateway.rs`, PROTOCOL §8 | Same; **only the owner window connects** (`gateway_connect` replaces a connection). | C + U (owner-only) + D | 🟡 only the list connects (next-list-window.spec.ts, role.test.ts); needs a desktop check |
| SRV-2 | Resume replays missed frames with no gaps and no duplicates. A too-old gap re-identifies and refetches. | `gateway.rs`, `lib/gateway.ts` | Same; viewers catch up by snapshot plus buffered replay (`lib/catchup.ts`). | C + U (property test: a viewer's state equals the owner's) | ✅ (lib/catchup.test.ts, lib/gateway.catchup.test.ts, share.test.ts) |
| SRV-3 | One slow or down server doesn't block the others at startup. **Not done today (T-907).** | `session.ts` `Promise.all` | **Decision 21** | U + F | ⏸ decision 21 |
| SRV-4 | The server's name is fetched, and re-fetched every 2 minutes. On failure, the hostname is shown. | `App.tsx` `ServerLink` | Same, in the server header | F | ✅ (next-list-parity.spec.ts) |
| SRV-5 | You're only ever in one room: switching servers takes you out of the last room. | `App.tsx`, `watchPresence.ts` | In tabs, the visible tab of the focused chat window is where you are (design). | U + F | ✅ (showing.test.ts, share.test.ts) |
| SRV-6 | Connection state in words: ready, connecting, retrying, can't reach. | `App.tsx` status bar, gateway `status` | A line at the list's foot, only past a 5-second grace (decision 1) | U + F | ✅ (core/notes.test.ts; next-list-window.spec.ts "a server that can't be reached") |
| SRV-7 | Storage figure (used / limit, file expiry) visible to anyone sharing. | `App.tsx`, `lib/media.ts` `storageLine` | In the Media window, beside how long files are kept (decision 1) | U + F | ✅ (next-media.spec.ts "how full it is") |
| SRV-8 | Host controls are absent, not greyed out, for members. Decided per server. | `App.tsx`, `HostPanel.tsx` | Settings → Hosting appears only for the host. | F | ✅ (next-settings.spec.ts, next-settings-window.spec.ts) |
| SRV-9 | A server that goes away (signed out, refused) leaves nothing on screen pointing at it. | `App.tsx` | Same, including its tabs and windows | F | ✅ a signed-out server's tabs close, and the window with them when none are left (next-chat-window.spec.ts) |
| SRV-10 | A room that's archived, or a DM you've lost access to, is never held open. | `App.tsx` | Same; its tab closes or says so | F | ✅ (tabs.test.ts, conversation.test.ts) |

## LIST — the buddy list window

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| LIST-1 | Rooms show who's in them as a small stack of people, never a number. Sorted by name. | `App.tsx` rail stack, `lib/occupancy.ts` | Rooms section: dots of who's in, in a fixed marker column. | U + G | ✅ (list.test.ts, next-list.spec.ts) |
| LIST-2 | A room or DM with something new changes weight only: no number, no dot, no color. The accessible name says it in words. | `App.tsx` rail, SPEC §4.2 | Same, for rooms, DMs, tabs and folded server headers | F + G | ✅ (next-list.spec.ts, next-servers.spec.ts) |
| LIST-3 | Room order is the host's order ("The Rail"). | `HostPanel.tsx` `move`, `PATCH /rooms/:id` | Same order; the host section is renamed "Your rooms, in order". Many rooms: **decision 22**. | F | ✅ (list.test.ts, next-list.spec.ts); many rooms is decision 22 |
| LIST-4 | DMs are their own section, named by who's in them, never by a slug. | `lib/dm.ts`, SPEC §4.13 | Same, plus a new-message button (NEW-2) | C (dm.ts) + F | ✅ (list.test.ts, next-list.spec.ts) |
| LIST-5 | Voice activity shows in the room list. | `App.tsx` rail | Moving sound bars on the room row | F + G | ✅ (list.test.ts, next-list.spec.ts) |
| LIST-6 | Media and Search sit at the bottom. | `App.tsx` rail | Same; where they open is decision 15 | F | ✅ Media and Search at the foot of the list, each opening its own window (next-list-window.spec.ts, next-tool-window.spec.ts) |
| LIST-7 | Every row's names line up: one marker column, fixed row heights for every name face, ellipsis instead of clipping. | new (lessons L-01 to L-06) | The design's rule | G (all 12 faces, both marker counts) | ✅ (kit.spec.ts, next-list.spec.ts, next-servers.spec.ts) |
| LIST-8 | Room names are the same color: no amber `#` for open rooms (Matt, 2026-09-25). | new | Rule | G | ✅ (next-list.spec.ts) |
| LIST-9 | Empty states for no rooms (with "Make the first room" for the host), no DMs, nobody else here. | `App.tsx` `EmptyState`, `settings/copy.ts` | **Silent** (decision 17) | F | 🟡 only "No DMs yet" (next-list.spec.ts); decision 17 |
| LIST-10 | Your own card: your styled name, where you are, your status, and Away. | rail footer (#171 removed "you") | Top of the list; no avatar | F + G | ✅ (next-list.spec.ts) |

## CONV — reading a conversation

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| CONV-1 | The message list is virtualized: only rows on screen exist, with stable keys, so a measured row stays measured when history loads above it. | `stream/Stream.tsx`, AGENTS | Same, in every tab and window | F + D (10k-message room) | 🟡 virtualized (next-chat.spec.ts, 5,000 messages); needs the 10k desktop check |
| CONV-2 | The view hangs from the bottom: new messages follow when you're at the end, and history loading above never moves what you read. | `Stream.tsx` `anchorTo: "end"`, `lib/resize.ts` | Same | F | ✅ (next-chat.spec.ts) |
| CONV-3 | Sessions: a 3-hour gap inserts a divider in natural words ("late Tuesday night", "tonight"). | `lib/time.ts`, `lib/rows.ts`, SPEC §4.7 | Same (the prototype shows "TONIGHT") | U (exists) + F | ✅ (rows.test.ts, next-chat.spec.ts) |
| CONV-4 | Grouping: consecutive messages from one person group, and a 10-minute gap breaks the group. | `rows.ts`, SPEC §4.7 | Names inline; **decision 9** | U + F | ✅ (rows.test.ts, next-chat.spec.ts); decision 9: kept as built |
| CONV-5 | Styled sender names; message bodies in sans, with mono only for code. | `MarkdownBody.tsx`, `lib/names.ts` | Same | F + G | ✅ (next-chat-parity.spec.ts) |
| CONV-6 | Message aging: body opacity 100% under an hour, 88% under a day, 78% after (name and time never fade). | `time.ts`, SPEC §4.7, §5.6 | **Decision 10** | U (exists) | ⏸ decision 10; built as today (lib/time.test.ts) |
| CONV-7 | Bodies stop at 80ch on wide windows. | SPEC §5.6 | **Decision 10** | G | ⏸ decision 10; built (`--measure`), no test |
| CONV-8 | Markdown subset: bold, italic, strike, inline and fenced code, quotes, lists, links, escapes. No headings, tables, images or raw HTML. Anything ambiguous stays literal. | `lib/markdown.ts` | Same | C (tests exist) + F | ✅ (lib/markdown.test.ts, next-chat-parity.spec.ts) |
| CONV-9 | Replies: a short, clickable quote that jumps to the original. It belongs to the reply, not the message above (#116, #181). An unloaded original says so. | `Stream.tsx` `ReplyLine`, SPEC §4.7 | Quote placement with inline names: **decision 9** | F + G (spacing) | ✅ (rows.test.ts, next-chat.spec.ts) |
| CONV-10 | Deleting a reply hides its quote too; the original and other replies are unchanged (#115). A deleted message stays as "deleted". | `Stream.tsx` | Same | F | ✅ (rows.test.ts, next-chat.spec.ts) |
| CONV-11 | "You left off here": opening a room with something new lands on the line (#123). A caught-up room opens at the newest. The line stays put for the session; there's no catch-up band. | `Stream.tsx`, `rows.ts`, SPEC §4.2 | Same, per tab | F (exists: `console.spec`) | ✅ (rows.test.ts, conversation.test.ts, next-chat.spec.ts, next-chat-window.spec.ts) |
| CONV-12 | Reading marks read only when the newest message is on screen **and** the window has your attention (`isLooking`). | `Stream.tsx`, `lib/looking.ts`, `PUT /rooms/:id/read` | Same, per window. The focused window's visible tab only. | U + F | ✅ (showing.test.ts, share.test.ts, next-chat-window.spec.ts) |
| CONV-13 | Live arrivals never move someone reading older messages. | `Stream.tsx` | Same | F | ✅ (next-chat.spec.ts) |
| CONV-14 | Memory stays flat: far-off history is let go once scrolling stops, and rooms you've left keep only their newest page (#173). | `Stream.tsx`, `lib/gateway.ts` | Same, per window; each window loads what it shows (architecture) | C + F (`history-memory.spec`) + D | ✅ (next-chat-parity.spec.ts) |
| CONV-15 | "Back to the newest" when reading far back. Reading down brings the rest back with no gap. | `Stream.tsx` header | Same | F | ✅ (next-chat-parity.spec.ts) |
| CONV-16 | Pinning a message. **Not in the client today (T-908)**; the server and the media filter support it. | `POST/DELETE /messages/:id/pin` | **Decision 21** | F | ⏸ decision 21 |
| CONV-17 | Jump to a message (from search or media): walk back a few pages if it's close, or reopen the room *at* it (`around=`) if it's far. The target is marked briefly. Gives up cleanly if the message is gone. | `Stream.tsx` `openAround`, `loadUntil` | Same | C + F | ✅ a hit or tile opens its conversation at the message: jumped to if loaded, the room reopened around it if not, and marked (next-chat-window.spec.ts) |
| CONV-18 | A message that names you (`@username`) is marked in the stream. | `Stream.tsx` mentions | Same; marker style per `system.md` | F | ✅ (next-chat-parity.spec.ts) |
| CONV-19 | The room header shows the name and topic, and no names (#145). A DM is titled by who's in it. | `Stream.tsx` header, SPEC §4.1 | The tab title plus a pane header with dots and the topic | F | ✅ (conversation.test.ts, next-chat.spec.ts) |
| CONV-20 | Typing line: "X is typing" above the composer. It holds its space whether or not anyone types. Nobody sends "stopped typing", so the line re-checks the clock and clears within a couple of seconds of the 6-second signal lapsing. | `Stream.tsx` `Typing` | Same | U + G (no shift) | ✅ (conversation.test.ts, next-chat.spec.ts) |
| CONV-21 | Hovering a message shows its action button and changes nothing else (#139). | `stream.css`, `Stream.tsx` | Same | G (no box changes) | ✅ (next-chat-parity.spec.ts) |
| CONV-22 | Message menu: reply, edit (your own), delete (your own, or any if host) with a "delete for good" confirmation. A refusal is shown on that message. | `Stream.tsx` `MessageRow` | Same actions | F | ✅ (next-chat.spec.ts, next-chat-parity.spec.ts) |
| CONV-23 | Edit in place: Enter saves, Escape cancels, the text survives a refusal, and the cursor goes to the end. | `Stream.tsx` `EditBox` | Same | F | ✅ (next-chat.spec.ts, next-chat-parity.spec.ts) |
| CONV-24 | No reactions are drawn or offered (trial, #168). The server still stores them. | `Stream.tsx`, SPEC §4.8 | Same | F | ✅ (next-chat-parity.spec.ts) |
| CONV-25 | Links open in the system browser, never in the app. Only http(s) hrefs survive `safeHref`. | `lib/external.ts`, capabilities | Same, in every window's capabilities | U + D | 🟡 opens in the browser (lib/external.test.ts); needs a desktop check |

## COMP — writing

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| COMP-1 | Enter sends and clears the box immediately, keeping focus. Typing after Enter belongs to the next message (#117). Shift+Enter adds a new line. | `Stream.tsx` `Composer`, SPEC §4.7 | Same | F | ✅ (next-chat.spec.ts, next-chat-window.spec.ts) |
| COMP-2 | Optimistic send: the message appears at once as pending, several can be in flight, and confirmation merges by id (#128). | `lib/gateway.ts` pending, `Stream.tsx` | Same | C + F | ✅ (rows.test.ts, lib/gateway.test.ts, next-chat-window.spec.ts) |
| COMP-3 | A failed send restores its text if the box is empty, or keeps a separate "Retry unsent message" if a newer draft exists. Neither erases the newer draft. | `Stream.tsx` | Same | F | ✅ (sending.test.ts, next-chat.spec.ts) |
| COMP-4 | Requests that never answer time out visibly. An unconfirmed request isn't reported as definitely lost (#118). | SPEC §4.7, `lib/api.ts` | Same; every request has a deadline | U + F | ✅ a send nobody answers gives up at 30 s saying it wasn't confirmed, and keeps the words (next-chat-parity.spec.ts) |
| COMP-5 | The box grows with its content without laying out the page on every keystroke (#127, measured on a hidden copy). | `lib/autoGrow.ts` | Same | U + D (typing latency) | 🟡 built; needs the desktop typing check |
| COMP-6 | Up arrow in an empty box edits your last message (only at the live end). | `Stream.tsx` | Same | F | ✅ (next-chat.spec.ts) |
| COMP-7 | Emoji selector: ordinary Unicode, a short set, inserted at the cursor. | `lib/composerEmoji.ts` | Same | F | ✅ (next-chat.spec.ts) |
| COMP-8 | Limits mirrored before the round trip: 8,000 characters and 10 attachments. | `Stream.tsx`, `linger-core::limits` | Same | U | ✅ (next-chat-parity.spec.ts) |
| COMP-9 | Switching rooms doesn't carry a half-typed line; files already uploading go with the composer. | `Stream.tsx` | Each tab keeps its own composer; persistence is **decision 11** | F | ✅ (next-chat.spec.ts, handoff.test.ts); surviving a restart is decision 11 |
| COMP-10 | Typing announces itself with `typing.start`; the server accepts one per 4 seconds per room. | `lib/gateway.ts` `startedTyping`, PROTOCOL §8 | Same | C | ✅ (next-chat-window.spec.ts) |
| COMP-11 | Dropping a file on the composer shares it and never navigates the webview. Pasting files works too. | `Stream.tsx` | Same, and in every window | F | 🟡 the box takes a dropped or pasted file (next-chat-parity.spec.ts); Tauri's own drop handling is off in every window, so drops reach the page on Windows, and a file dropped anywhere else is refused (lib/drops.test.ts, window.rs tests). Needs a check in the desktop app, on Windows most |
| COMP-12 | Add menu (+): a compact menu above the button that focuses its first item and dismisses with Escape, an outside click or the trigger (#89). | `Stream.tsx`, SPEC §5.6 | Same | F + G | 🟡 one "Add a file" button, not a menu |

## FILE — files in messages

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| FILE-1 | Resumable uploads: a slot, then parts PUT straight to storage, then complete. Missing parts are re-sent. Per-file progress, and a refusal shown on its file. | `lib/upload.ts`, PROTOCOL §6 | Same | C + F | ✅ (next-chat-parity.spec.ts) |
| FILE-2 | Remove a file before sending ("don't send X"); an already-uploaded file is withdrawn (`DELETE /uploads/:id`). | `Stream.tsx` | Same | F | ✅ (drafts.test.ts, next-chat-parity.spec.ts) |
| FILE-3 | Images inline at true aspect ratio, capped at 400px tall. The box is sized before the bytes arrive, so rows don't jump. Lazy loaded. | `media/Attachments.tsx`, `lib/media.ts` | Same | U + G | ✅ (next-chat-parity.spec.ts) |
| FILE-4 | Click to expand: centered in the window, fitted without cropping or upscaling, refits on resize. Escape, a click or close dismisses it and returns focus. | `Attachments.tsx`, SPEC §4.10 | Same, per window | F | ✅ (next-chat.spec.ts) |
| FILE-5 | Video: poster frame and player. Audio: player. Anything else: one line and a download. | `Attachments.tsx` | Same | F | ✅ (next-chat-parity.spec.ts) |
| FILE-6 | Downloads go to the system browser and say so. A failed handoff offers a retry and a selectable URL, and never claims the file was saved. | `media/DownloadFile.tsx`, SPEC §4.10 | Same | F + D | 🟡 hands off to the browser, says so without claiming it's saved, and a failed handoff offers Try again; the address is there to copy either way (next-chat.spec.ts). Needs a check that the browser really opens in the desktop app |
| FILE-7 | Local media paths resolve against the server that supplied them, never the webview (T-920). | `Attachments.tsx`, `lib/url.ts` | Same | U + D | 🟡 built; needs a desktop check |
| FILE-8 | Link cards: one line with favicon, title and domain. Favicons arrive as `data:` URIs; the client never contacts a linked site. Fetched in batches per server. | `media/LinkCards.tsx`, `lib/previews.ts`, `POST /links/preview` | Same | C + F | ✅ (next-chat.spec.ts, words.test.ts) |

## MEDIA — the media collection

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| MEDIA-1 | A grid of everything shared: images, video, audio, links, files, pinned. | `media/MediaPanel.tsx`, SPEC §4.4 | Media at the bottom of the list; where it opens is **decision 15** | F | ✅ in the Media window (next-media.spec.ts, next-tool-window.spec.ts) |
| MEDIA-2 | Filter by person, type and date range. | `MediaPanel.tsx`, `GET /media` | Same | F + D | ✅ in the Media window (next-media.spec.ts, next-tool-window.spec.ts) |
| MEDIA-3 | Anyone can star an item; starred items sort first and never expire. A star confirms only after the server accepts it. | `MediaPanel.tsx`, `PUT/DELETE /media/:id/star` | Same | F | ✅ in the Media window (next-media.spec.ts, next-tool-window.spec.ts) |
| MEDIA-4 | Every item links back to its message and moment. | `MediaPanel.tsx` → CONV-17 | Same; opens the room's tab at the message | F | ✅ in the Media window (next-media.spec.ts, next-tool-window.spec.ts) |
| MEDIA-5 | DM files are visible only to the DM's members. | server `visible_rooms`, SPEC §4.13 | Same (server-enforced) | C (server tests) + F | ✅ in the Media window (next-media.spec.ts, next-tool-window.spec.ts) The server part holds already. |
| MEDIA-6 | Loading, empty and "nothing matches these filters" states. | `MediaPanel.tsx` | Same | F | ✅ in the Media window (next-media.spec.ts, next-tool-window.spec.ts) |

## SRCH — search

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| SRCH-1 | A search destination, opened from the list or with Ctrl/Cmd+K, which focuses the box (pressing it again re-focuses rather than closing). Works from the composer too. | `search/SearchPanel.tsx`, `App.tsx`, SPEC §4.12 | Search at the bottom of the list; where it opens is **decision 15** | F | ✅ in the Search window (next-search.spec.ts, next-tool-window.spec.ts) |
| SRCH-2 | Whole words, all terms, "quoted phrases". No operators, wildcards, history or suggestions. Newest first. 200-character cap. Debounced. | `search.ts`, PROTOCOL §6 | Same | U (exists) + F | ✅ in the Search window (next-search.spec.ts, next-tool-window.spec.ts) |
| SRCH-3 | Filter by room and by person, combined. DMs are named like everywhere else, never by id (#74). | `SearchPanel.tsx`, `dm.ts` | Same | F | ✅ in the Search window (next-search.spec.ts, next-tool-window.spec.ts) |
| SRCH-4 | A hit is one line: who, where, when, and the matched words marked. A filename-only hit says which file. Screen readers get one line. | `search.ts` `snippetText` | Same | U + F | ✅ in the Search window (next-search.spec.ts, next-tool-window.spec.ts) |
| SRCH-5 | Clicking a hit opens that room at that message (CONV-17). | `SearchPanel.tsx` | Same | F | ✅ in the Search window (next-search.spec.ts, next-tool-window.spec.ts) |

## DM — direct and group messages

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| DM-1 | Create-or-find: the same set of people always gets the same DM. Two to eight people, you included. You can't DM yourself. | `App.tsx` `openDm`, `POST /dms` | New-message picker (NEW-2); the person card's Message button | F | ✅ (newDm.test.ts, next-list.spec.ts) |
| DM-2 | A DM is named by the others in it, differently for each viewer. A removed member leaves a gap, not "unknown". | `lib/dm.ts` | Same | C (dm tests) | ✅ (lib/dm.test.ts, list.test.ts) |
| DM-3 | A new DM appears in the other people's lists without them doing anything (`room.create` to members only). | `lib/gateway.ts` | Same | C + F | ✅ (lib/gateway.test.ts, list.test.ts) |
| DM-4 | Presence never leaks a DM: outsiders see you as around, not in a room. **Outsiders currently see "in a room" (T-921).** | server fan-out, SPEC §4.13 | **Decision 21** | F | ⏸ decision 21 |
| DM-5 | Voice in a DM is as private as the DM. | server fan-out | Same | C (server) | ✅ (server tests) |

## PPL — people, presence and status

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| PPL-1 | Everyone on the server is listed with a presence marker, their styled name and their status or away message. Nothing is counted. | `roster/RosterPanel.tsx`, `roster.ts` | A People section, not grouped by room: here, then Away, then Offline (folded) | U + G | ✅ (list.test.ts, next-list.spec.ts) |
| PPL-2 | Presence states: in a room, around, idle (no input for 10 minutes), away (chosen, with a message), offline. | `lib/presence.ts`, SPEC §4.3 | One marker per state: a dot, a moon, a dimmed dot. The words are in the row, the tooltip and the screen-reader label. | U (exists) + G | ✅ (presence.test.ts, next-list.spec.ts) |
| PPL-3 | Focusing the app on a room puts you in it. Backgrounding the app, or 90 seconds idle, takes you out. `room.focus`/`idle`/`away` are sent per server. | `lib/watchPresence.ts` | The visible tab of the focused chat window, or the focused conversation window | U + F | ✅ (report.test.ts, showing.test.ts, share.test.ts) |
| PPL-4 | "Last here …" for offline people; "away 20m" counts from the server's `away_since`. | `roster.ts` | A faint note on the row | U | 🟡 "last here" done (list.test.ts); no "away 20m" |
| PPL-5 | Clicking or right-clicking a name opens a person card: status in their own styling, reading/listening/working, where they are, Message and Knock. Escape or an outside click closes it and returns focus. | `RosterPanel.tsx`, `status/PersonName.tsx`, `StatusCard.tsx` | Person card beside the list; Enter opens it; double-click opens a DM | F + G | ✅ (next-list.spec.ts) |
| PPL-6 | A name in the stream opens the same card, drawn in a portal so the virtualized list can't clip it. | `status/PersonName.tsx` | Same | F | ✅ the name heading a run of messages opens the same card beside it, drawn outside the scrolling list; Message opens the DM, Knock knocks (next-chat-window.spec.ts) |
| PPL-7 | Status editor: one line (240), reading/listening/working (80 each), an image (512 KB, shown at 400×200), and an away message. Local preview before save, and the draft survives layout changes. | `status/StatusEditor.tsx`, `status.ts` | Your card's status field plus Settings → Profile | U (exists) + F | ✅ (you.test.ts, next-list.spec.ts, next-settings.spec.ts) |
| PPL-8 | Save order: `PATCH /me` first, then going away on the wire (leave the room, then say away). | `StatusEditor.tsx` | Same | C + U | 🟡 away goes through the list (share.test.ts); the save order is untested |
| PPL-9 | Typing an away message makes you away; clearing it makes you back. | `StatusEditor.tsx` | An AIM-style editor with saved presets. Away everywhere with a checkbox per server: **decision 14**. | F | ✅ (next-servers.spec.ts, next-list.spec.ts); decision 14: kept as built |
| PPL-10 | A status image uploads when it's picked; an abandoned one is cleaned up. | `StatusEditor.tsx` | Same | F | ✅ (next-settings.spec.ts) |

## NAME — how names look

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| NAME-1 | Your name's face (12 bundled), weight (400/500/700), italic, one palette color or a 92° gradient of two, and an effect (none/shimmer/glow), with a live preview through the stream's own code. | `settings/StylePicker.tsx`, `lib/nameStyle.ts`, `lib/names.ts` | Settings → Profile "Make yourself at home" | C + F | ✅ (next-settings.spec.ts) |
| NAME-2 | Colors are palette keys, validated by the server. No hex anywhere. An unknown key falls back to something drawable. | `lib/palette.ts`, `generated/palette.generated.css`, AGENTS rules 8 and 12 | Same | C + U (discipline) | ✅ (discipline.test.ts, contrast.test.ts) |
| NAME-3 | Your message font: one of the four sans faces. Other saved choices draw in the default body face. | SPEC §4.5 | Same | F | ✅ chosen in Profile, and each message draws in its sender's face; a name-only face draws in the body face (next-chat-window.spec.ts) |
| NAME-4 | "Use plain names and message fonts" flattens every name and message font on your screen, with one attribute on `<html>`. | `lib/normalize.ts`, `styles/names.css` | Same, in every window at once | F | ✅ (appearance.test.ts, next-settings-window.spec.ts) |
| NAME-5 | Shimmer and glow stop under reduced motion. | `names.css` | Same | F | ✅ shimmer and glow both stop, and the name keeps its colors (next-motion.spec.ts) |
| NAME-6 | Every palette color passes 4.5:1 on every surface it's drawn on. | `linger-core` palette test | New surfaces added to the test | U (`contrast.test.ts`) | ✅ (contrast.test.ts) |

## KNOCK

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| KNOCK-1 | Knock someone from their card. The sender sees "knocked" for 3 seconds (acknowledging the request, not delivery), and the limit reply "That's three this hour. Give them a bit." Feedback never carries to a different person or server. | `RosterPanel.tsx` `KnockButton`, SPEC §4.9 | The person card, and row hover. The row wiggles. Offline people can't be knocked. | F | ✅ from the card or the row's hover buttons; the row shakes once (not under reduced motion), rests three seconds, and a refused knock from the row opens the card saying why; offline people can't be knocked; a double-click opens the DM (next-list.spec.ts) |
| KNOCK-2 | A received knock is a card that says who, disappears after 8 seconds, has no buttons, takes no focus, uses `aria-live="polite"` and leaves nothing behind. It comes from every signed-in server, with the server named when there's more than one. | `knock/KnockCards.tsx` | Same | F | ✅ (next-knocks.spec.ts, next-list-window.spec.ts) |
| KNOCK-3 | The knock sound follows mute, quiet hours and the knocks switch. | `lib/sound.ts` | Same; a quiet server still lets knocks through (design) | U | ✅ (lib/sound.test.ts, next-list-window.spec.ts) |

## NOTE — desktop notifications

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| NOTE-1 | Only two things notify: a message that names you (by username), or one from a person you asked to hear from. There's no `@everyone`. | `lib/notify-rules.ts` | Same | U (exists) | ✅ (lib/notify-rules.test.ts) |
| NOTE-2 | "Always notify me when [person] posts": everywhere, or in chosen rooms. | `notify/NotifyRules.tsx`, `GET/PUT/DELETE /me/notify-rules` | Settings → Notifications | F | ✅ (next-settings.spec.ts, next-settings-window.spec.ts) |
| NOTE-3 | Nothing notifies about the room you're looking at. | `notify.ts` | The focused window's visible tab | U | ✅ (share.test.ts, lib/notify.test.ts) |
| NOTE-4 | Messages are batched per server and room. A resume's replay makes one notification, and it never says how many. | `notify.ts` | Same, **owner only** | U + C | ✅ (lib/notify.test.ts, core/quietViewers.test.ts) |
| NOTE-5 | Banners are silent at the OS level, and the app's own chime plays instead. | `src-tauri/src/notifications.rs` | Same | D | 🟡 unchanged; needs a desktop check |
| NOTE-6 | Permission is asked once; a refusal is final and silent. | `notify.ts` | Same | U | ✅ (lib/notifyPermission.test.ts) |
| NOTE-7 | What clicking a banner does. | today: the OS default | **Decision 20** | F/D | ⏸ decision 20 |

## SND — sounds

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| SND-1 | Chime categories: voice, mic/deafen controls, DMs, room messages and knocks. Room messages are off by default; the others on. | `lib/sound.ts` | Same | U (exists) | ✅ (settings.test.ts, lib/sound.test.ts) |
| SND-2 | Mute all, and quiet hours from and until in half-hour steps (off by default; 22:00–08:00 until moved). | `sound.ts`, Settings | Same | U + F | ✅ (lib/sound.test.ts, settings.test.ts, next-settings.spec.ts) |
| SND-3 | Quiet hours silence DMs, rooms and knocks only; voice and mic/deafen cues still play (#186). | `sound.ts` `QUIET_HOURS_SILENCE` | Same; a per-server Quiet adds to it | U | ✅ (lib/sound.test.ts, lib/notify.test.ts) |
| SND-4 | Play previews ignore every gate. | Settings | Same | F | ✅ (next-settings.spec.ts) |
| SND-5 | No sound from startup snapshots, replays, your own messages, a room you're reading, edits or history loads. One chime per burst (a 1.2 s cooldown for messages). | `sound.ts`, `lib/sound-events.ts` | Same, **owner only** (architecture) | U | ✅ (lib/notify.test.ts, core/quietViewers.test.ts) |
| SND-6 | Chimes are synthesized from one score with 50 ms of silence first, so the attack isn't lost (#94, #95). Both knock taps play. | `lib/chimes.ts`, `sound.ts` | Same | C + D (packaged audio check) | 🟡 shared; needs the packaged audio check |
| SND-7 | Audio unlocks on the first pointer or key press in the window. | `main.tsx` `unlockAudio` | Same, in the owner window | D | 🟡 built in every window; needs a desktop check |

## VOICE

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| VOICE-1 | See who's in voice in a room before joining (#119). | `lib/gateway.ts` `ready.voice`, `voice.state` | Dots and bars on the room row, and the room's strip | C + F | ✅ (list.test.ts, chat/voice.test.ts, next-chat.spec.ts) |
| VOICE-2 | Join voice in the room you're in. You're in voice in one room at a time, across every server; joining elsewhere moves you. | `lib/gateway.ts` `joinVoice` | Join, "Move voice here" and "Talk here instead" are distinct labels | C + F | ✅ (chat/voice.test.ts, share.test.ts, next-chat.spec.ts, next-chat-window.spec.ts) |
| VOICE-3 | Voice survives reading another room, a destination or Settings. Only Leave, moving, quitting or losing the network ends it. | `voice/VoiceAway.tsx`, SPEC §5.6 | It also survives closing the room's tab or window; the voice bar lives in the list | F (tabs and windows) + D | ✅ closing the tab or window leaves voice alone (next-chat-parity.spec.ts); the rest is the list's |
| VOICE-4 | Mute and deafen: deafen also mutes; undeafen restores the earlier mic choice. Changes are queued so a quick click or push-to-talk edge never announces a mute that wasn't applied. | `lib/gateway.ts` `changeVoiceControls` | Same | C | ✅ (lib/gateway.voice.test.ts, next-list.spec.ts) |
| VOICE-5 | Who's talking is shown without moving anything. | `voice/VoiceBar.tsx` (turned-over block, #138) | **Decision 7** | G (no geometry change) | ⏸ decision 7; a highlight is built |
| VOICE-6 | Shared mute/deafen state: the control's own glyph beside the name, with the word for screen readers. An older client or server "does not share voice controls". | `VoiceBar.tsx` | Same | F | ✅ as the control's glyph beside each name in the voice bar and the conversation's strip, the word for screen readers, and "mic state unknown" when a client or server doesn't share it (next-list.spec.ts, next-chat-window.spec.ts, voice.test.ts) |
| VOICE-7 | Per-peer connection trouble: "connecting…" and "can't reach", one phrase centered on its person (#124). | `VoiceBar.tsx` | Same | G | 🟡 "connecting…" and "can't reach" beside the person in the voice bar (next-list.spec.ts, voice.test.ts); needs a real network that fails to prove |
| VOICE-8 | Push-to-talk: off by default, starts every call muted, and opens the mic only while the key is held. It releases on a view change or lost focus, and works while Settings is open. | `lib/voice.ts`, `VoiceControls.tsx` | Key choice: **decision 6** | U + F | ✅ (share.test.ts, next-list.spec.ts, next-chat-window.spec.ts); the key is decision 6 |
| VOICE-9 | Microphone and speakers chosen per computer, with the system default first. A missing remembered device is shown, marked, and falls back to the default. | Settings → Sound & Voice, `voice_devices` | Same | F + D | 🟡 Settings part done (next-settings.spec.ts); needs a desktop check |
| VOICE-10 | Per-person volume from 0% to 200%, remembered per server and person, shared by that person's sessions; never sent anywhere. | `lib/voice.ts`, `VoiceBar.tsx` | The voice bar's chips (decision 8) | U + F | ✅ (core/voice.test.ts; next-list-window.spec.ts "a voice chip opens that person's volume"; kit.spec.ts slider) |
| VOICE-11 | Devices that change mid-call recover within a second or two (hotplug, default change, sample rate). | `src-tauri/src/voice/device.rs` (T-1405) | Same | C + M | 🟡 unchanged Rust; needs a real-device check |
| VOICE-12 | The relay (TURN) password is fetched fresh at each join. With no relay, a join still works on one network. | `lib/gateway.ts`, `GET /voice/ice` | Same | C | ✅ (lib/gateway.voice.test.ts, share.test.ts) |
| VOICE-13 | A full voice room (8 people) refuses a join and says so in words. | server `MAX_VOICE_PEERS` | Words, never a number ("room for one more") | F | 🟡 "room for one more" (servers.test.ts); a refused join isn't shown |
| VOICE-14 | The voice controls stay reachable wherever you are. | `VoiceAway.tsx` | The voice bar in the list; with the list hidden, the tray menu (decision 5) | F | ✅ (next-list-window.spec.ts "the tray menu's Mute and Leave follow voice") |
| VOICE-15 | Join, leave, move and peer cues follow the voice and controls switches, not quiet hours. | `sound.ts`, `sound-events.ts` | Same | U | ✅ (lib/sound.test.ts) |
| VOICE-16 | Voice audio never passes through the webview; the Rust engine owns devices, Opus and peers. Frames go to it from **one** window. | `src-tauri/src/voice/`, `voice_frame` | The owner forwards frames (architecture) | U + D | 🟡 the list forwards frames; needs a desktop check |
| VOICE-17 | Join and leave draw the final layout from the first frame: no half-built bar, and the conversation doesn't blink (#141, #142). | `VoiceBar.tsx`, `lib/resize.ts` | Same | F (frame-by-frame) | 🟡 the strip keeps its height (next-chat.spec.ts); no frame-by-frame test |

## LOOK — appearance and reading comfort

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| LOOK-1 | Interface scale from 100% to 200%, applied before first paint, including sign-in. Text and controls grow together. Stays on this computer. | `lib/interface.ts`, Settings → Appearance | Every window, with a preview. Minimum sizes: **decision 19**. | G (every scale) + F | 🟡 every window (appearance.test.ts, next-settings-window.spec.ts); no geometry at every scale; decision 19 |
| LOOK-2 | Evening warmth after local "sunset", worked out from the clock (no location asked). It can be turned off, and re-checked every couple of minutes. | `lib/theme.ts` | Same | U (exists) | ⬜ hidden until the colors have an evening version |
| LOOK-3 | Color theme: dark, light, or follow the system. | `lib/theme.ts`, `AppearanceSettings.tsx` | Dark only so far: **decision 2** | F | ⏸ decision 2 |
| LOOK-4 | Reduced motion removes movement but keeps state and confirmation. | SPEC §5.6 | Same, including the prototype's wiggle, sound bars and pop-outs | F | ✅ every repeating animation repeats `--loop` times at `--motion` speed, both off for reduced motion, and what the movement said stays (next-motion.spec.ts; the design-rule test keeps new loops to it) |
| LOOK-5 | Bundled fonts only; no remote font URLs. | `src/fonts/`, CSP | Same | U (discipline) | 🟡 bundled fonts only; no check |
| LOOK-6 | Settings headings and navigation labels in title case (#90). | SPEC §5.6 | Same | U (copy test) | ✅ (settings.test.ts) |
| LOOK-7 | Preferences carry over. Today's saved choices live in `localStorage` under `linger.*` keys (scale, theme, warmth, normalize, sound, voice devices, push-to-talk, volumes). The new client reads the same keys, so switching loses nothing. | `lib/*.ts` | Same keys (same origin) | U | ✅ (appearance.test.ts, next-settings-window.spec.ts) |

## SET — settings coverage

Settings is its own window in the design (Profile, Appearance, Windows, Sound &
Voice, Notifications, Account & App, Servers, Hosting). Every item in the
PPL, NAME, LOOK, SND, VOICE, NOTE, UPD, EXP and HOST tables must be reachable
there or where the design puts it.

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| SET-1 | Who you are: change your display name (1–32 characters); the username is shown and can't be changed. | Settings → Profile, `PATCH /me` | Same | F | ✅ (next-settings.spec.ts, next-settings-window.spec.ts) |
| SET-2 | Change your password (current and new, 8 minimum). | Settings → Account & App, `PATCH /me/password` | Same | F | ✅ (next-settings.spec.ts, next-settings-window.spec.ts) |
| SET-3 | Settings opens from a gear (today: beside your name). Escape closes panels and returns focus. | `App.tsx` | Its own window, from the list's gear. New: Ctrl+, opens it too. | F | ✅ (next-list-window.spec.ts, next-settings-window.spec.ts) |
| SET-4 | Every section's copy is short and states effects (for example "Use plain names and message fonts"). | `settings/copy.ts` | Same | U | ✅ (settings.test.ts) |

## EXP — take everything with you

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| EXP-1 | Any member exports the server (public rooms and their own DMs) as a zip of Markdown and media. It polls with progress in words, and the finished file goes to the system browser. | `lib/export.ts`, `POST /export`, `GET /export/:job_id` | Settings → Account & App | C + F + D | 🟡 built (next-settings.spec.ts); needs a desktop check |
| EXP-2 | Once an hour: a second request says, in words, when you can ask again. | `export.ts` (`retry_after_ms`) | Same | U | ✅ (next-settings.spec.ts, lib/export.test.ts) |

## UPD — updates

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| UPD-1 | Checks at launch and when Settings opens. Nothing downloads until asked; every update is verified against the signing key. | `lib/updates.ts`, `src-tauri/src/updates.rs` | Same, **owner only**, and again every 12 hours while it runs in the tray | C + F | ✅ (next-list-window.spec.ts "looked for at launch", next-settings.spec.ts) |
| UPD-2 | States: ready (with version), current, unconfigured (a browser or dev build), failed (with reason), and managed (the system updates it). | `updates.ts` | Same | U | ✅ (lib/updates.test.ts, next-settings.spec.ts) |
| UPD-3 | Managed installs (the Arch package marker) say "updates with your system" and never try to replace themselves. | `src-tauri/src/packaging.rs`, `updates.ts` | Same | C + U | ✅ (lib/updates.test.ts, Rust tests) |
| UPD-4 | Release notes are a link to the release page, not printed in the app (#174). | Settings → Updates | Same | F | ✅ (next-settings.spec.ts) |
| UPD-5 | "Update ready" is a quiet hint that opens Settings, with no dialog and no restart. | `App.tsx` status bar | A line at the list's foot with Update…, which opens Settings (decision 1) | F | ✅ (next-list-window.spec.ts "a new version gets one quiet line") |
| UPD-6 | Installing replaces the app; a failure says why. | `update_install` | Same | D + M | 🟡 built; needs a desktop check |

## HOST — running the server

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| HOST-1 | Make a room: slug (the server's rules only), name (defaults to the slug) and topic. | `host/HostPanel.tsx`, `POST /rooms` | Settings → Hosting → Rooms | F | ✅ (next-settings.spec.ts) |
| HOST-2 | Rename a room and change its topic. | `HostPanel.tsx`, `PATCH /rooms/:id` | Same | F | ✅ (next-settings.spec.ts) |
| HOST-3 | Reorder rooms (move up/down, keyboard accessible). | `HostPanel.tsx` | "Your rooms, in order" | F | ✅ (next-settings.spec.ts) |
| HOST-4 | Archive a room with a confirmation; archiving is the only delete. | `HostPanel.tsx`, `POST /rooms/:id/archive` | Same | F | ✅ (next-settings.spec.ts) |
| HOST-5 | Invites: good for (one person, five people, anyone), expires after (a day, a week, never); a list of links you've made; revoke. | `HostPanel.tsx`, `GET/POST/DELETE /invites` | Same | F | ✅ (next-settings.spec.ts, settings.test.ts) |
| HOST-6 | Members: a list, and "Remove from the server" (never kick or ban) with a confirmation that names the person and the loss. | `HostPanel.tsx`, `host/Removal.tsx`, `POST /users/:id/remove` | Settings → Hosting → People | F | ✅ (next-settings.spec.ts) |
| HOST-7 | Removed people: a list, and letting someone back in. | `HostPanel.tsx`, `GET /users/removed`, `POST /users/:id/restore` | Same | F | ✅ (next-settings.spec.ts) |
| HOST-8 | Rename the server. | `HostPanel.tsx`, `PATCH /server` | Settings → Hosting → Server | F | ✅ (next-settings.spec.ts) |
| HOST-9 | The server's accent: a palette key or none. | `HostPanel.tsx` | Same; its use in the design is **decision 18** | F | ✅ (next-settings.spec.ts); decision 18: the server's color for everybody |
| HOST-10 | Every host action is enforced by the server; the client only decides what's drawn. | server `FORBIDDEN` | Same | C (server tests) | ✅ (server tests) |
| HOST-11 | A locked-out host recovers with `linger-server reset-password` on the server (no email, no link). | `crates/linger-server/src/reset.rs`, host guide | Same (docs only) | — | ✅ (docs; nothing to build) |

## MULTI — several servers

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| MULTI-1 | A separate account, connection, people and rooms per server. Host or member is decided per server. | `session.ts`, `App.tsx` | One list with a section per server | C + F | ✅ (next-list-window.spec.ts, next-servers.spec.ts) |
| MULTI-2 | Each server remembers which room you had open. | `App.tsx` `openRoomIds` | Tabs remember their conversations per server | F | ✅ (tabs.test.ts, next-chat-window.spec.ts) |
| MULTI-3 | Knocks and notifications from every server, keyed by server and room (two servers can both have `#garage`). | `KnockCards.tsx`, `notify.ts` | Same, with the server tag | U + F | ✅ (next-list-window.spec.ts, next-knocks.spec.ts, lib/notify.test.ts) |
| MULTI-4 | The order of servers is yours, and never reshuffles by activity. | `session.ts` | Move up and down in the server menu and Settings → Servers | F | ✅ the server menu and Settings → Servers, kept in step (next-list-window.spec.ts, next-settings-window.spec.ts) |
| MULTI-5 | A folded server shows its lights (dots) and a one-line summary, bold when something's new, with no numbers. A long server's header stays pinned. | new | Design | U (summary) + G | ✅ (servers.test.ts, next-servers.spec.ts) |
| MULTI-6 | Every conversation says where it's from: the server's stripe and tag. | new | Design; the color source is **decision 18** | G | ✅ (next-chat-window.spec.ts, kit.spec.ts) |
| MULTI-7 | Per-server Quiet (no chimes, no bold, no arrival cards; knocks still come through) and Own window. | new | Design | U + F | 🟡 Quiet done (next-list-window.spec.ts, servers.test.ts); Own window isn't built |
| MULTI-8 | "4:52 AM there" from the host's time zone. | new, needs a server field | **Decision 3** | U | ⏸ decision 3 |
| MULTI-9 | A different you on each server (name, styling, status); a friend on two servers appears twice, unlinked. | today, implicitly | Explicit in the design | F | ✅ (servers.test.ts, next-servers.spec.ts) |

## WIN — windows and tabs (new)

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| WIN-1 | The buddy list is the app's main window and the owner (sign-in, connections, side effects). | today: one window | Design and architecture | U + D | 🟡 role.test.ts, next-list-window.spec.ts; needs a desktop check |
| WIN-2 | Tabs by default everywhere (Hyprland too): the first conversation opens the chat window, and later ones add tabs. A tab goes bold on something new, with no number. Tabs reorder by dragging; Ctrl+Tab and Ctrl+W work. | new | Design | U (tab state machine) + F + D | 🟡 tabs.test.ts, keys.test.ts, kit.spec.ts, next-chat-window.spec.ts; needs a desktop check |
| WIN-3 | Pop a tab out into its own window, and "Back to tabs". "Each in its own window" is a setting, and switching moves what's open. | new | Design | F + D | 🟡 share.test.ts, next-chat-window.spec.ts; needs a desktop check |
| WIN-4 | Linger draws its own title bar in every window, with a drag region and window controls; the OS still snaps, resizes and tiles. | `src-tauri/src/window.rs` (today: no GTK bar on Hyprland) | Design. Minimum sizes: **decision 19**. | D (Hyprland, GNOME, Windows 11) | 🟡 built; needs desktop checks; decision 19 |
| WIN-5 | Window positions, open tabs and their order are remembered per server on this computer. | new | Architecture | U + D | 🟡 tabs (next-chat-window.spec.ts) and places (appearance.test.ts) kept; needs a desktop check |
| WIN-6 | Every window gets only the capabilities it needs: `capabilities/next.json` (the list), `next-chat.json` and `next-settings.json`. Only `main` can open windows, and only through fixed URL patterns. | `src-tauri/capabilities/` | Architecture | U (Rust) + D | 🟡 a file per window, URLs checked (Rust tests in window.rs); needs a desktop check |
| WIN-7 | Closing the list keeps Linger running in the tray, or quits. | new (no tray today) | Tray by default, quit in Settings (decisions 4 and 5) | D + M | 🟡 built (next-list-window.spec.ts "the list tells the desktop what closing it does", `tray.rs` tests); not yet tried on a real desktop tray |
| WIN-8 | Knock cards, arrival cards and banners appear once, not once per window. | new | Architecture (owner only) | F | 🟡 knocks, chimes and banners come only from the list (next-list-window.spec.ts, core/quietViewers.test.ts); arrival cards aren't built |
| WIN-9 | A viewer that opens after connecting catches up without gaps; its state always equals the owner's. | new | Architecture | U (property test) + F | ✅ (share.test.ts, lib/catchup.test.ts, next-chat-window.spec.ts) |

## NEW — other things the design adds

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| NEW-1 | The People section and person card replace the roster panel (PPL-1, PPL-5). | roster | Design | F | ✅ (list.test.ts, next-list.spec.ts) |
| NEW-2 | The new-message picker: search, pick one to seven people, see "already have this DM" before confirming. Enter picks the first match and Backspace removes the last. | new | Design | U + F | ✅ (newDm.test.ts, next-list.spec.ts) |
| NEW-3 | An AIM-style away editor with saved presets. | new | Design | F | ✅ (you.test.ts, next-list.spec.ts, next-servers.spec.ts) |
| NEW-4 | Settings → Windows (tabs or windows; tray or quit). | new | Design | F | ✅ (next-settings-window.spec.ts) |
| NEW-5 | Arrival cards ("Callie came into #general"). | new | Design; behavior is **decision 13** | F | ⏸ decision 13 |
| NEW-6 | Door sounds (an optional quiet chime on arrival, off by default). | new | Design; relation to entrance sounds is **decision 12** | U + F | ⏸ decision 12 |
| NEW-7 | The small title-bar logo mark: the porch door with the light on, also the tray icon. | `lib/PorchMark.tsx` (the porch picture) | Design | — | ✅ (`app/LogoMark.tsx`, `assets/logo/linger-door.svg`) |

## KEY — keyboard

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| KEY-1 | Shortcuts today: Ctrl/Cmd+K search; Enter and Shift+Enter; Up to edit; Escape closes panels and previews and returns focus. New in the design: Ctrl+Tab and Ctrl+Shift+Tab, Ctrl+W, a jump-to-tab key (the prototype's Alt+1…9), and Ctrl+,. Push-to-talk shares Ctrl (**decision 6**). | `App.tsx`, `Stream.tsx` | Design | F | 🟡 tab keys, Ctrl+, and Ctrl+K in every window (keys.test.ts, next-chat-window, next-list-window and next-tool-window specs); decision 6 |
| KEY-2 | Everything reachable without a mouse: roving focus in lists and tabs, Enter to open, context panels reachable by keyboard (the voice seat, the person card). | `lib/ContextPanel.tsx`, `PanelResize.tsx` | Same | F | ✅ (kit.spec.ts, next-list.spec.ts, next-chat.spec.ts) |

## A11Y — accessibility

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| A11Y-1 | Panels opened with a pointer focus the panel itself (no ring, no tooltip). A keyboard open focuses the close button with its ring. Decided by the last real input, not `:focus-visible` (#96, #143). | `lib/ContextPanel.tsx` | Same, for every overlay in the kit | F (both engines) | 🟡 uses `:focus-visible`, which #96 and #143 found unreliable; untested |
| A11Y-2 | A restrained, visible keyboard focus ring. | SPEC §5.3, §5.6 | Kit rule | G | ✅ (kit.spec.ts) |
| A11Y-3 | Accessible names for every icon-only control, with tooltips on hover and focus that are never clipped (#140). | `lib/IconButton.tsx`, `lib/Tooltip.tsx` | Kit rule | F + G | 🟡 names tested (kit.spec.ts, next-chat.spec.ts); tooltip clipping isn't |
| A11Y-4 | States said in words for screen readers: new activity, presence, talking, muted, "knocked". Color and shape are never the only signal. | throughout | Kit rule | F | ✅ (next-list.spec.ts, next-knocks.spec.ts, next-chat.spec.ts) |
| A11Y-5 | Hit targets of at least 24px. | style guide | Kit rule | G | ✅ (kit.spec.ts) |
| A11Y-6 | Forced colors: speaking and selection use system colors. | `voice.css` | Kit rule | F (emulated) | ✅ presence, the selected row, the showing tab and section, a switch that's on and who's talking keep system colors (kit.spec.ts, emulated) |
| A11Y-7 | Enlarged text (200%) removes no content or function. | T-909 (Console review) | Same | G (every scale) | 🟡 scale works; nothing checked at 200% |

## DESK — desktop and packaging

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| DESK-1 | The page tells the shell it drew (`graphics_started` after two frames), so the GPU-path probe knows the launch survived (#169). **The new entry must do this too**, or a working launch looks like a crash and the next one turns the GPU path off. | `main.tsx`, `src-tauri/src/graphics.rs` | Same, from the owner window | D | 🟡 built (`next/main.tsx`); needs a desktop check |
| DESK-2 | Linux launch plumbing before GTK: native Wayland when available (dictation, #122); the GBM probe and per-WebKit-version memory (#114, #187); NVIDIA explicit sync off by default (#135); AppImage hang-up and menu entry. | `src-tauri/src/linux_startup.rs` | Same (Rust, unchanged) | C (Rust tests) + D | 🟡 unchanged Rust; needs a desktop check |
| DESK-3 | The Arch package marker: the system updates it, and the stale AppImage menu entry is removed. | `packaging.rs`, `linux_startup.rs` | Same | C | ✅ (Rust tests; unchanged) |
| DESK-4 | Windows upgrades keep existing shortcuts and create no duplicates (#108). | installer config, `windows-update-checks.md` | Same | D (Windows CI) | 🟡 unchanged; needs the Windows check |
| DESK-5 | The selected app icon everywhere (T-919, T-925). | `scripts/app-icons.py` | Same | U (`--check`) | ✅ (`app-icons.py --check`; unchanged) |
| DESK-6 | A CSP that requires HTTPS/WSS for remote servers and blocks remote scripts and fonts. A server needs a name, not a bare IP. | `tauri.conf.json` | Same, for every window | D | 🟡 one CSP covers every window; needs a desktop check |
| DESK-7 | Chime playback works in every package (GStreamer plugins in the AppImage, .deb and .rpm; WebView2 on Windows). | `packaged-audio-checks.md` | Same | D (CI package checks) | 🟡 unchanged; needs the package checks |
| DESK-8 | Dictation (Voxtype and `wtype`) types correctly into the composer on native Wayland. | `linux-input-checks.md` | Same | D + M | 🟡 needs a desktop check |

## PERF — performance

| ID | Capability | Today | Buddy list | Proof | Status |
|---|---|---|---|---|---|
| PERF-1 | Typing never runs ahead of the letters in real WebKitGTK (#127, #169). | `autoGrow.ts`, GBM | Budget in `system.md` | D (key-to-frame probe) | 🟡 needs the desktop probe |
| PERF-2 | Scrolling a 10,000-message room holds steady frames. Only rows coming into view do work, and formatters are cached (#170). | `Stream.tsx`, `time.ts` | Budget in `system.md` | F (CPU-throttled) + D | 🟡 virtualized (next-chat.spec.ts); no frame-rate test |
| PERF-3 | Memory stays flat as you scroll and switch rooms (#173). | `Stream.tsx`, `gateway.ts` | Also per extra window | F + D (recorded) | 🟡 far history is let go; not measured |
| PERF-4 | A new window draws within a few hundred milliseconds. | new | Architecture budget | D | 🟡 not measured |

## PRIV — privacy and product rules (must hold throughout)

| ID | Rule | Where it's enforced | Proof | Status |
|---|---|---|---|---|
| PRIV-1 | No counts or badges anywhere; new activity is weight only. | SPEC §4.2, AGENTS rule 3 | U (view models return no numbers) + F | ✅ (servers.test.ts, next-list.spec.ts, next-servers.spec.ts, next-chat.spec.ts) |
| PRIV-2 | Nothing about which apps or windows anyone has open, ever. | AGENTS rule 2 | U (discipline) | ✅ (next/privacy.test.ts) |
| PRIV-3 | No telemetry, analytics or crash reporting. | AGENTS rule 4 | U (discipline: no network except the servers) | ✅ (next/privacy.test.ts) |
| PRIV-4 | No `@everyone` or `@here`. | AGENTS rule 5 | U | ✅ (settings.test.ts, lib/notify-rules.test.ts) |
| PRIV-5 | No avatars (Matt, 2026-09-25). | design | G / review | ✅ (review: no avatar in the kit) |
| PRIV-6 | Wire types come from `linger-core` through `ts-rs`; none are hand-written. | AGENTS rule 7 | CI drift check | ✅ (CI drift check) |
| PRIV-7 | No raw HTML from message bodies; no `dangerouslySetInnerHTML`. | `markdown.ts` | U (discipline) | ✅ (next/privacy.test.ts) |
| PRIV-8 | The client never fetches linked sites or remote images (previews are server-side). | `previews.ts` | U + D | ✅ (next-chat-parity.spec.ts) |
| PRIV-9 | Search keeps no history or suggestions, and exports belong to the person who asked (polled, not broadcast). | SPEC §4.11, §4.12 | U | 🟡 exports polled (lib/export.test.ts); search isn't built |
| PRIV-10 | Never claim end-to-end encryption. | AGENTS rule 9 | review | ✅ (settings.test.ts; review) |
| PRIV-11 | The vocabulary: server, room, in the room, host, media, status. | SPEC §1, AGENTS rule 6 | U (copy lint) | ✅ (settings.test.ts, `scripts/lint-rules.sh`) |
