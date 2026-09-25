# The Buddy list design

**Status: chosen, not built.** On 2026-09-25 Matt picked this as the design
Linger will move to. It is parked on the `design/buddy-list` branch until the
build starts. Nothing here is in the app, and the app still follows SPEC §5
("Console") until this design replaces it.

It came out of #101's design exploration. Seven other directions were tried and
dropped. This page and the prototype in `client/prototypes/` are what is left.

![The list and two conversations](buddy-list/buddy-list-1-desktop.webp)

## The idea

Eight friends don't need Discord's four columns; they need a buddy list. The
spec already calls name styling "the AIM feature" and the status "the AIM away
message". This goes all the way: the main window is a tall list of your
friends, and conversations open beside it, as tabs in one window or each in
its own window.

It fits either way of working. Keep it minimal, with one slim list at the edge
of the screen, or fill the screen with rooms side by side.

## Try the prototype

```sh
git switch design/buddy-list
cd client
pnpm exec vite --port 1421
```

Open <http://localhost:1421/prototypes/buddy-list/>. The prototype is plain
HTML and JavaScript. Nothing talks to a server. It is alive, though: friends
arrive, type and talk in voice, and if you send a message somebody answers.

Add these to the address to change how it starts:

| Address | What it shows |
|---|---|
| `?tabs` | conversations as tabs in one window |
| `?servers` | the list for somebody on three servers |
| `?tabs&servers` | both |
| `?still` | one frozen moment, for screenshots |

The gear at the top of the list switches between tabs and windows, and a
dashed prototype-only switch in the top bar toggles one server or three.

## The look

It takes its colors from the logo, a lamp-lit porch at night:

- **Surfaces:** night blue.
- **Lamp amber:** for the few things that matter, such as the primary action
  and "you left off here".
- **Cyan:** a faint outline on the focused window, like the logo's sign.
- **Labels:** Departure Mono.
- **The top bar:** Silkscreen, the logo's pixel face.
- **Message text:** always a plain sans.

People are colored dots in their own palette color, next to names in their own
styling.

## The buddy list

- **You are at the top:** your styled name, your status (click to edit), and an
  **Away** button. It opens an AIM-style away-message editor with saved
  presets.
- **Friends are grouped by where they are:** In #general, In #listening-room,
  Around, Away, Offline.
  - There are no counts in the headings.
  - Away messages show in full; in this design they are the stars.
  - Offline starts folded.
- **Hover a friend** for Knock and Message. Double-click opens a DM, the old
  AIM habit.
- **A knock** makes the friend's row wiggle, and the button says "knocked" for
  three seconds.
- **Rooms and DMs sit below the people,** with the dots of who is in each. A
  room with something new gets a bold name and nothing else.
- **Arrivals** show as small cards at the bottom right, like AIM's door sounds.
  A very quiet door chime is there, off by default.

| The away message | The list alone at the edge of the screen |
|---|---|
| ![](buddy-list/buddy-list-2-away.webp) | ![](buddy-list/buddy-list-4-edge.webp) |

## Conversations: tabs or windows

A setting chooses how conversations open: **As tabs in one window** or **Each
in its own window**. Switching moves whatever is open straight away.

![Tabs, reading #listening-room while in voice in #general](buddy-list/buddy-list-8-tabs.webp)

**Tabs** are the recommended default, because they work on any desktop.

- The chat window's title bar is a row of tabs, like a browser. Opening a room
  or DM adds a tab, or shows it if it's already open.
- A tab goes bold when something new arrives in it, with no number.
- Tabs can be dragged to reorder them. Drag one off the row, or use its pop-out
  button, and it becomes its own window with **Back to tabs**.
- The desktop app would use Ctrl+Tab and Ctrl+W. The prototype uses Alt+←/→
  and Alt+W, because a browser keeps the Ctrl keys for itself.

**Windows** are one setting away. They are what a tiling desktop like Omarchy
wants: each conversation is a real window, and Hyprland lays them out by
itself. The prototype's **Tile** button (or the T key) previews that.

![Windows, tiled, with a knock landing on Dave](buddy-list/buddy-list-3-tiled.webp)

Conversations are compact either way. Names sit inline (`Eli: A bit of
Khruangbin…`), which suits smaller windows.

## Voice belongs to the room, not the tab or window

- **You stay in voice.** If you're in voice in #general, you can read
  #listening-room, close #general's tab, or close the whole chat window, and
  you stay in voice.
- **Only Leave, or moving voice to another room, ends it.** You are in voice in
  one room at a time, across every server.
- **Mute, Deafen and Leave live in one place:** a voice bar at the bottom of the
  buddy list, which is always open.
- **The tab of your voice room** shows moving sound bars.
- **Other rooms offer "Move voice here"** (or "Talk here instead" when they're
  quiet), so moving is never mistaken for a fresh join.

Today's app already keeps you in voice while you read another room (SPEC §5.6);
Matt confirmed it in the real app. The design keeps that rule.

## Several servers

![Three servers in one list](buddy-list/buddy-list-5-servers.webp)

- **One list, each server a section,** like AIM's buddy groups. You choose the
  order, and it never reshuffles by activity. A long server's header stays
  pinned while you scroll through it.
- **A folded server still shows its lights.** The header carries:
  - the server's color;
  - its name, bold when something inside is new;
  - the dots of who's on right now;
  - one plain line, like "#raid-night in voice · room for one more" or
    "☾ 4:52 AM there · quiet · Rui's up".

  There are no numbers.
- **Far-away servers show the time there.** The host sets the server's time
  zone once, so it isn't anyone's personal location.
- **A different you on each server.** Each server is its own account, because
  Linger has no account that spans servers. You might be Matt at home and
  Lamplighter in the guild, styled differently, with a status per server.
  - The top card keeps only what's true everywhere: you, and Away.
  - A friend on two of your servers appears twice, not linked, on purpose.
- **Away goes everywhere, with a choice.** The away editor has a checkbox per
  server.
- **Each server has a small menu:**
  - **Quiet:** no chimes, no bold and no arrival cards for that server. Knocks
    still get through.
  - **Own window:** the server pops out into its own list.
- **Every conversation says where it's from.** A stripe in the server's color
  and a server tag mean two rooms called #general can't be confused.

| Raid night: the guild in its own list, tiled | Most days: every server folded |
|---|---|
| ![](buddy-list/buddy-list-6-raid-night.webp) | ![](buddy-list/buddy-list-7-edge-servers.webp) |

![The setting, tabs from three servers, and one popped out](buddy-list/buddy-list-9-tabs-setting.webp)

## Rules it changes

Building it means rewriting SPEC §5 and parts of §3 in the same change. It
breaks these current rules:

- **Surfaces** are night blue instead of cool gray (§5.3).
- **Windows and panels** get rounded corners and soft shadows (§5.1).
- **The three-column layout** gives way to a list plus conversation windows
  (§3).
- **Names sit inline** before the text, not above it (§4.7).
- **Labels** use pixel-style faces (§5.2).
- **Your own picture** sits at the top of the list; the porch icon stands in.
  That is an avatar, which §5.1 bans. Keep it or drop it when building.

The principles don't change:

- no counts or badges;
- new activity shows as weight only;
- nothing about which apps anyone has open;
- no AI, no telemetry;
- the same vocabulary.

## What building it would take

- **A small real slice first,** per #101's method: the list, one room as a tab,
  the message box and the voice bar. Use it for a while before spreading it.
- **Real windows.** Tauri can open several windows, but the connection to the
  server has to live in one place and feed all of them.
- **Voice keeps running** with its room's tab or window closed.
- **Window positions and open tabs are remembered.** Closing the list means
  quitting, or tucking Linger into the system tray.
- **The contrast test** needs the new backgrounds added, so all 16 name colors
  still pass on them.

## Open questions

- **New DMs.** A new DM only turns its row bold. AIM popped a window open, which
  is the kind of obligation Linger avoids, but some people will miss it.
- **Many rooms.** The narrow list suits three to six rooms per server, not
  fifteen.
- **Your picture.** Keep the avatar at the top of the list, or drop it?
- **Big groups.** Voice rooms above eight people and servers of 50–60 are a
  separate piece of work, tracked in #197.
