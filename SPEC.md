# Linger — Product Specification

**Version:** 0.1 (pre-implementation)
**Status:** Draft for V1 build
**Author:** Matt Guenther
**License:** AGPL-3.0

---

## 1. What this is

Linger is a small, self-hosted place for a group of friends to hang out. Text rooms,
presence, and file sharing. One person runs a server; their friends install a client
and connect to it.

It is not federated. It is not a platform. There is no company in the middle, no
account system that spans servers, and no discovery mechanism in V1.

It borrows the good parts of Discord, IRC, Ventrilo, and AIM, and deliberately omits
the machinery those platforms added once they had to serve millions of people or
generate revenue.

**The name.** To linger is to stay somewhere with no agenda and no obligation to be
doing anything. That is the product thesis in one word.

The product name is **Linger**, capitalized in UI text, window titles and
installer metadata. Technical identifiers, commands and filenames may remain
lowercase; they are not the displayed brand.

An instance is **a server**. Earlier drafts coined a private vocabulary for these
concepts; it was dropped before any UI was built. Plain words travel further than
clever ones, and everyone joining a Linger server already knows what a server, a
room, and a status are.

### Vocabulary (use these terms everywhere — UI, code, docs, error messages)

| Concept | Term | Never call it |
|---|---|---|
| An instance | **a server** | stoop, guild, workspace, community |
| A text channel | **a room** | channel |
| Being present in a room | **in the room** | sitting in, joined, connected |
| The person running it | **the host** | admin, owner |
| Media/link archive | **media** | the shelf, gallery |
| A user's status card | **their status** | their sign, bio, about me |

Language does more design work than features. Hold this vocabulary in the code too:
`RoomId`, not `ChannelId`. One thing "server" is *not*: the `linger-server` binary is
the process that hosts an instance, never the instance itself.

---

## 2. Design thesis

Discord's interface is built for a stadium of 50,000 strangers. Linger is built for a
dinner party of eight. Nearly every complaint about Discord traces back to that
mismatch:

| Stadium feature | Effect on 8 friends |
|---|---|
| Unread badge counts | Turns friends into a to-do list |
| Role colors and hierarchy | Invents status where none existed |
| `@everyone` | A weapon nobody should have in a group of 8 |
| Infinite scroll, no archive | Everything you shared is functionally destroyed |
| "Online" member list | Meaningless — everyone is always online |

**Core problem to solve: a quiet Discord server looks abandoned. A quiet Linger
server with four people in it must feel populated.**

### Three principles

Every feature decision resolves against these, in order.

1. **Presence over messages.** The app should feel alive when nobody is typing.
   Ambient signal — who is around, what they are doing — carries the room.
2. **Remove obligation.** No counters. No streaks. No red dots. No "you're behind."
   Nothing that converts a friendship into a queue.
3. **Keep the artifact.** A friendship produces things: photos, clips, links, jokes.
   Do not let them scroll away into nothing.

### Anti-goals (never build these)

- XP, levels, streaks, leaderboards, or engagement metrics of any kind
- Federation
- A bot marketplace
- A role/permission matrix
- Video calls or screen sharing
- Threads
- Any algorithmic ordering
- Analytics or telemetry of any kind, opt-in or otherwise
- Ephemeral-by-default messaging (fights principle 3)
- AI features of any kind
- A paid tier, a storefront, cosmetics for sale, or any payment surface at all

---

## 3. Layout

Discord's layout is `[server rail] [channel list] [messages] [member list]`. Linger
inverts the priority. **People are the primary surface, not a gutter.**

```
┌──────────┬────────────────────────────────────┬─────────────────┐
│ SERVERS  │  #garage                           │  WHO'S AROUND   │
│          │  Matt, Callie in the room          │                 │
│  ● home  │                                    │ ┌─────────────┐ │
│  ○ work  │                                    │ │● Callie     │ │
│  + add   │  ─── Saturday morning ───          │ │ in #garage  │ │
│          │                                    │ │ Elden Ring  │ │
├──────────┤  Callie   9:14                     │ │ 40m         │ │
│ ROOMS    │  │ did the drive get here          │ └─────────────┘ │
│          │  │ yet                             │ ┌─────────────┐ │
│  #porch  │                                    │ │● Dave       │ │
│  #garage │  Matt     9:31                     │ │ Blender     │ │
│  #shop   │  │ yeah, mounting it now           │ │ ♪ Bill Evans│ │
│          │  │ [img]                           │ └─────────────┘ │
│ DMs      │                                    │ ┌─────────────┐ │
│  Callie  │                                    │ │○ Jen        │ │
│  Dave,   │  ┌──────────────────────────────┐  │ │ 2h · "back  │ │
│   Jen    │  │ say something                │  │ │ after work" │ │
│          │  └──────────────────────────────┘  │ └─────────────┘ │
│  media   │                                    │                 │
│  search  │                                    │                 │
└──────────┴────────────────────────────────────┴─────────────────┘
```

**`media` and `search` are destinations, not rooms.** They sit under the room list
and open in place of the message stream. Anything that is a place but is not a room
goes there; nothing floats over the stream.

**`DMs` is your DMs** (§4.13), between the rooms and the destinations. It is a
different list for every person on the server, and each one is named by who is in it
rather than by a slug — a DM has no name of its own. A DM holding something new gets
the same weight change a room gets and nothing else (§4.2).

**The roster (right) is a card stack, not a name list.** Each card shows: name in the
user's own styling, presence dot, which room they are in, and their status. Offline
users show last-seen and their away message.
This panel is what makes an empty server feel like a house with the lights on.

On wide windows the roster stays visible. When three readable columns will not
fit, a labelled **People** button opens the same cards in an edge panel. At still
narrower effective widths, **Navigation** opens the server and room list the same
way. These panels close with Escape or their labelled close button and return
keyboard focus. The conversation stays usable without reducing text size.

---

## 4. Feature specifications

### 4.1 Rooms you are in

A room is a place, not a filing cabinet.

- Focusing the app on a room means you are **in the room**. Others see this.
- Room headers show occupancy: `#garage · Matt, Callie`
- Sidebar rooms show a small stack of who is in them.
- Backgrounding the app or idling >90 seconds takes you out of the room.

**Entrance sounds.** Each user picks a personal sound that plays for others already
in a room when they arrive. This is the cheapest piece of emotional design
available and no modern app does it, because a 50,000-member server can't.

Requirements:
- Ship 12–16 curated sounds (<1.2s, normalized to −16 LUFS).
- Custom upload allowed: max 2 seconds, max 200 KB, transcoded server-side to Opus and
  loudness-normalized. Reject anything longer — do not truncate.
- Rate limit: a given user's sound plays at most once per 5 minutes per listener,
  regardless of how many times they enter.
- Global mute, per-user mute, and automatic mute between 22:00–08:00 listener-local
  time (off until they opt in).

### 4.2 No unread counts

Delete the badge. It is a slot machine that converts friends into obligations.

Replace with:
- A **"you left off here"** divider at the last-read message. It persists until scrolled
  past and stays visible for the rest of the session.
- Rooms with new activity get a **weight change only** — label weight goes from normal to
  bold. No number, no dot, no color. Read rooms must remain readable too.
- A **"since you were gone"** view the user *pulls* from the room header. Never pushed.

**One exception:** direct mentions produce a real notification and a marker. Mentions
are person-to-person only. `@everyone` and `@here` do not exist and will not be added.

**Person-centric notifications.** Users may set "always notify me when [person] posts",
per person, per room. This is the notification setting people actually want, and no
keyword-based system delivers it.

**Notification chimes** (2026-09-17). Optional, short, quiet cues, with one
master silence switch and separate controls for voice sessions, microphone/
deafen controls, DMs, room messages and knocks. Voice/control/DM/knock sounds
default on; ordinary room-message sounds default off. Quiet hours remain
22:00–08:00 listener-local, off until they opt in. These settings silence *live*
notification chimes, not other people's voice; deafen is the control for that
(§4.14). The play control in settings is a deliberate click and is not gated
by mute, quiet hours or category switches.

- Voice cues: your join, leave or move, and other sessions arriving/leaving
  the voice session you are already in. No cue for browsing a text room, no
  ringing someone who has not joined voice, and no sound on push-to-talk edges.
- DM/room-message cues: new messages from others, not messages currently being
  read in the focused app, edits, history loads, replay or duplicates. One
  short cue per message burst, not a sound per line. DMs remain membership-filtered.
- No sound from startup snapshots or reconnect replay. Audio-device failures
  do not produce a success chime. Muting notification chimes leaves visual
  notifications intact; desktop banners request silent presentation so they
  do not double the app's chime.
- Use the existing player. No uploads, remote assets or libraries for these
  cues. Personal entrance sounds remain a separate, unbuilt feature (§4.1).

Expect pushback on removing counts from people conditioned by ten years of them. Hold
the line for at least one month of real use before revisiting.

### 4.3 Presence

Presence states: `in_room`, `around` (app focused, no room), `idle` (no
input >10 min), `away` (explicit, with message), `offline`.

That is the whole of it. Where somebody is, and nothing about what they are doing.

**Activity detection was cut on 2026-08-28** (Matt — `docs/decisions.md`). This
section used to specify a feature that watched which application you had in front
of you, resolved it against a bundled registry, and showed it to the room. It is
gone: the crate, the registry, the wire field, and the seven tasks that would have
built it.

**What replaces it is the status** (§4.6). If you want people to know you are
playing something or listening to something, you type it. That is one line of
effort, it is always accurate, it says what you meant rather than what a process
name implies, and it cannot leak anything you did not choose to say. The feature
it replaces needed four operating-system backends, a poller, a curated app
registry, and five separate privacy controls to be safe — and the best case was
still a worse version of a sentence somebody could have written themselves.

**Do not build it back.** Not as an opt-in, not as a small version, not as "just
the game you're playing". The reasoning is in `docs/decisions.md` and reversing it
is Matt's call, not a maintenance decision.

**And the rule that outlives it: never report or transmit window titles.** There is
no code left that reads one, and there is no field on any type that could carry one.
Keep it that way.

### 4.4 Media

Everything shared on a server accumulates into a browsable collection: images, video,
audio, links, files, and pinned messages.

- Grid view, filterable by person, type, and date range.
- Each item links back to the message and moment it was posted in.
- Anyone can star an item; starred items sort first and never expire.
- First-class sidebar destination, not a search result.

This fixes the deepest wound: you shared something great eight months ago and it is
gone. For a friend group, that collection *is* the relationship.

### 4.5 Name styling (the AIM feature)

AIM had no profile pictures. It had decorated names, and people put real effort into
them. Bring that back with modern typography.

Each user controls the rendering of their own display name:

| Property | Options |
|---|---|
| Font | One of ~12 curated bundled faces (§5) |
| Weight | 400 / 500 / 700 |
| Style | roman / italic |
| Fill | one of the 16 named palette colors, or a gradient of any two of them |
| Effect | none / slow shimmer / soft glow |

**Implementation constraints, non-negotiable:**

1. **Colors come from the named 16-color palette (§5.4), never from a picker.** The wire
   format is a palette key (`"azure"`), not a color value. Contrast safety is structural
   — the palette is defined once with theme-mirrored lightness, so there is nothing to
   clamp at runtime and no way to produce an unreadable name.
2. **No arbitrary fonts.** Curated bundled set only. Arbitrary font URLs are a
   fingerprinting vector and a remote-load dependency.
3. **Gradient angle is fixed at 92°**, not user-configurable.
4. **Shimmer and glow respect `prefers-reduced-motion`.**
5. **A global "Use plain names and message fonts" toggle** renders all names in the reader's default
   style. Some people will want this. Give it to them without friction.

**Message body styling** gets a much lighter touch, deliberately. The AIM era's
hot-pink-Comic-Sans-on-black was funny for a week and unreadable forever. Users get:
- Optional font override from the sans-serif faces in the curated set: Geist
  Sans, IBM Plex Sans, Inter and Space Grotesk. Other saved message-font choices
  render in the default body face; all twelve faces remain available for names.
- Nothing else. No message-text color, no per-message formatting, no size changes, no
  backgrounds. The name carries the identity; the body stays legible.

"Normalize everyone" flattens message styling too.

### 4.6 Statuses and away messages

The AIM away message is the most-missed feature of that era — a status, a mood board,
and a joke delivery mechanism in one field.

A user's **status** is a small card, not a bio field:
- One line of free text (240 chars, rendered in their name styling)
- Optional: reading / listening to / working on (three labeled short fields)
- Optional: one image, max 512 KB, displayed at 400×200
- Optional: an away message that supersedes the status when set

The roster previews the status line. The full status appears in the member
popout opened from their name; expanding it does not rearrange the roster.

### 4.7 Text presentation

Discord is simultaneously low-density and visually noisy. Fix both.

**Aging.** Message opacity steps down with age: <1h at 100%, <1d at 88%, older at 78%,
and it stops there — see §5.6 for the steps and the floor. Scrolling up feels like
walking into the past. One CSS custom property computed from the timestamp.

**Sessions, not a stream.** Group consecutive messages by the same author; break the
group on a 10-minute gap. Break the *session* on a 3-hour gap, which inserts real
whitespace and a soft divider labeled in natural language: `late Tuesday night`,
`Saturday morning`, `yesterday afternoon`.

**No avatar column.** A 3px colored gutter rule per person, name in the group header.
Density up, noise down.

**Restrained embeds.** A link renders as a one-line inline card: favicon, title, domain.
Not a 400px billboard. Images render inline at true aspect ratio, capped at 400px
height, click to expand.

**One comfortable layout.** Readable text and grouped messages are the default,
not a mode to discover. The layout adapts to the available window space. Interface
scale is an optional reading preference, not a requirement for a usable layout.
There is no Density setting or Compact/IRC presentation.

**Time-of-day warmth.** Background and text colors shift ~200K warmer after local
sunset. Subtle enough that most people never consciously notice. User-disableable.

### 4.8 Reactions

Fixed palette of 12. No custom emoji in V1. Reactions are those twelve keys —
there is no picker of arbitrary marks. The composer can insert ordinary Unicode
emoji into a message body from a small selector; that is typing, not a reaction.

Reactions accumulate **visibly by weight, not by number**. Six people hitting the same
reaction produces a denser, larger mark, not `👍 6`. Hover reveals who.

Rationale: numbers invite comparison. Weight carries the same information without
inviting anyone to count.

Local reaction feedback is brief and silent: a pressed treatment acknowledges
input, and a one-shot emphasis confirms a successful request. Initial history,
remote reactions and replay never trigger that emphasis. A refusal restores
the mark and shows an error; it must not claim success. A check distinguishes
your reactions without relying on color. No counters or confetti.

### 4.9 Knock

A lightweight nudge to a specific person that explicitly does not demand a reply. A soft
sound and a transient card on their screen — no message, no thread, no unread state,
nothing to dismiss or respond to.

Low-obligation contact is the thing group chats are worst at.

Rate limit: 3 knocks per person per hour.

The sender sees `knocked` for three seconds, then the control resets. This
acknowledges the request, not delivery; it is not knock history. The recipient's
card still disappears after eight seconds. Changing cards or servers must not
carry sender feedback to a different person.

### 4.10 File sharing

- 500 MB per file
- 50 GB per server pool (host-configurable)
- Non-starred, non-pinned files expire after 365 days (host-configurable, can be off)
- Resumable uploads
- **EXIF stripped from all images on upload, always, no toggle.** Camera photos carry
  GPS coordinates; silently sharing your home address in a privacy-focused app would be
  an embarrassing bug.
- Video: server generates a poster frame and a blurhash. No transcoding in V1.
- Download controls say that they open the system browser. A failed handoff
  shows a retryable error and a selectable download URL; a successful handoff
  does not claim the browser saved the file. Never navigate the app to an upload.
- Expanded images are centered in the app viewport, not the message row. Fit
  both dimensions without cropping, stretching or enlarging small originals;
  keep fitting when the window resizes. Escape, a click or the close control
  dismisses the preview and returns keyboard focus to its opener.

### 4.11 Export

Any member can export the entire server at any time: messages as markdown, media as
files, in one archive. No gatekeeping, no host approval, one export per hour.

This is a trust feature and an anti-lock-in guarantee. It costs a weekend and it is the
most credible thing in the product.

### 4.12 Search

Search exists because principle 3 — keep the artifact — is a promise that a thing said
two years ago is still *reachable*, and scrollback alone is not reachable. It is the
smallest feature that makes the archive worth having.

**Where it lives: a destination in the rail, under the rooms, next to `media`** (§3).
It opens in place of the message stream, the way the media collection does, so there is
one pattern for a place that is not a room and nothing floats over the conversation.
`Ctrl`/`Cmd`+`K` opens that same destination with the box focused — a shortcut *into*
the rail item, never a second surface with its own behavior.

**What it covers: what people typed, and the names of the files they shared.** A photo
is findable by its filename, because "the invoice pdf" is how people remember files.
Link titles are deliberately *not* covered: a title is a page's own words fetched into
a cache the server refreshes on its own schedule, so indexing them would mean search
results changing under people with nobody having edited anything. A link is findable by
the text somebody wrote around it, which is theirs.

**What it refuses.**

- **No ranking that is not time.** Results are newest first. Relevance ordering is an
  algorithm deciding what matters, and §2 rules those out; with eight people and one
  server, recency is the ordering anybody can predict.
- **No search history, no saved searches, no suggestions.** Nothing about a search is
  written down anywhere, on either side.
- **Nothing a deleted message can be found by.** A deleted message is deleted — its
  words *and* the names of the files it carried leave the index, the same rule the
  export follows (§4.11).

**Behavior.**

- Whole words, not substrings. Simple English endings are folded together, so `photo`
  finds `photos` and `running` finds `run`.
- Several words means *all* of them, in one message, in any order. A run inside double
  quotes means those words in that order.
- No wildcards and no operators. `AND`, `OR` and `NEAR` are words to look for like any
  others — a search box that quietly has a query language is a search box that lies to
  most of the people typing in it.
- Filterable by room and by person, combinable.
- A hit is a line: who, which room, when, and a few words either side of the match with
  the matched words marked. When the match was a filename, the hit says which file.
- Clicking a hit opens that room and goes to that message.
- Rate limit: 30 searches per person per minute.

### 4.13 DMs and group DMs

**The first private space in the product**, and the reason it needs its own section is
not the feature — it is that every other surface was written assuming everybody can see
everything. A DM is a room with members. That is the whole model.

**Not a permission system.** A DM has members and nothing else: no roles, no per-DM
settings, no admin view. The host is a member of a DM or they cannot see it, and there
is no override — a host who can read everybody's DMs is the thing people leave other
apps to get away from, and "trusted friend running the server" is not an argument, it
is the position that makes the feature pointless.

**Membership is fixed when the DM is made.** Asking for a DM with the same set of
people twice gives you the same DM, so there is no way to end up with four
conversations with the same three people. Adding somebody later would mean deciding
whether they can read what was said before they arrived, and that question is a
permission system in its first disguise: a new set of people is a new DM.

**Two to eight people.** The same ceiling as the rest of the product (§2's dinner party
of eight), and a group DM that wants to be bigger is a room. You cannot DM yourself —
a note to yourself is a text file, and every messaging app that added one did it
because it had somewhere to put a feature, not because anybody asked.

**A DM is a room everywhere it can be.** It holds messages, files and reactions the way
a room does; typing and presence work inside it the way they do in a room. What differs
is who it is fanned out to, and that is the whole of the implementation.

**Where the leaks are.** Every surface that lists things has to ask *whose*: the room
list, the message stream, the media collection, search, the export, notifications, link
previews, and the media origin. A surface that forgets is not a bug that looks like a
bug — it silently shows somebody a conversation they were not in. So membership is
checked in one place per surface, and a frame the gateway does not have a reason to
send is not sent.

Two of those are answered by something other than a check, and both are worth stating
so nobody goes looking for the check and concludes it is missing. **Notifications** are
decided from the frames a client receives, and a non-member receives none — so the
gateway's filter is the notification's filter. **The media origin** serves bytes to a
browser that carries no session and so cannot be filtered at all; what keeps a DM's
files private is that no list hands a non-member the URL, and an object key is not
guessable.

**Presence does not leak a DM's existence.** Somebody in a DM is *in a room* — but a
person who cannot see that DM is told only that they are around, never which room. The
alternative, dropping the presence update entirely, would make them look offline to
everybody they are not currently talking to.

**No unread counts, still** (§4.2). A DM holding something new gets the same weight
change a room gets, and no number appears anywhere. Feeling more urgent is not an
argument; it is exactly the argument that puts a badge on everything.

### 4.14 Voice rooms

**Voice happens *in a room*, not in a call.** You are already in the room (§4.1);
joining voice is turning your microphone on where you already are. There is no separate
voice channel to switch to, no call object, and nothing to be invited to — those are all
the same idea, which is that talking is an event with a beginning and an end. It is not,
and §4.9's knock is the same argument in miniature.

That is also why M13's ambient voice is a small step rather than a rewrite: a room you
leave running is what this already is.

**No ringing and no calling.** Joining voice never rings somebody who has not
joined. People already in that voice session may hear a quiet join/leave cue,
controlled by their notification sound settings (§4.2). Muting or unmuting
someone else's microphone never makes a sound on your computer.

**Full mesh, up to eight.** Every pair of clients connects directly to each other. At
eight people that is 28 connections and a laptop does not notice; a selective forwarding
server would be a second piece of infrastructure for every host to run and the scale
that needs one is a scale this product refuses. The ceiling is the same one everything
else has (§2).

**Voice follows the room's membership.** A voice room inside a DM is as private as the
DM (§4.13) — who is in voice is a fact about a room, so it reaches the room's members
and nobody else. Nothing about voice is a way to find out a conversation exists.

**Nothing is recorded, ever.** Not by the server, not by a client, not "for
transcription", not opt-in. Audio passes between clients and the server never sees it —
the server's whole part in voice is introducing two clients to each other. There is no
feature here to add later; a room where the microphone might be being recorded is a
different product.

**Two people behind two home routers need a relay.** Most pairs connect directly once
each has learned its own public address (STUN); the rest — carrier-grade NAT, a strict
office network — cannot, and a relay (TURN) carries the packets between them. The host
runs one beside the server, and it is the host's, not a third party's. What it carries is
the encrypted stream, which it cannot read, and the server's only part is handing a
member a short-lived password for it at the moment they join. A host who runs no relay
has voice that works within one network and nowhere else, and is told so at startup.

**Your microphone is yours.** Nobody can mute anybody else or turn anybody's
microphone on. Mute stops your outgoing voice. Deafen stops all incoming voice
and mutes your microphone together. Undeafening restores your previous mic
choice; with push-to-talk it stays closed until you press the key again.
Deafen does not change per-person volume or notification preferences. Its
speaker gate discards queued audio, so undeafening never plays missed speech.

The room can see each session's self-reported `muted` or `deafened` state,
filtered by the same membership rule as voice itself. It is not proof someone
is listening: an older client or server reports no state, and the UI says so.
These controls last for the voice session, not in the database. Device failure
and connection failure remain separate from a deliberate mute. Moving voice
keeps your mute/deafen choices; leaving and joining starts afresh.

**Leaving is leaving.** Closing the app, losing the network, or joining voice somewhere
else all end it, and the people you were talking to see you go. You are in voice in at
most one room at a time, for the same reason you are in one room at a time.

---

## 5. Design system — "Console"

The aesthetic is **a refined instrument, not a terminal and not a document.** It takes
mIRC's *structure* (hairline panel separation, density, the aligned nick column, the
live status bar) and AIM's *personalization*, and renders both with modern craft.

Reference class: Zed, Bitwig Studio, Raycast, well-made audio software. Braun and Swiss
typographic discipline underneath.

**Explicitly not:** terminal cosplay (green phosphor, everything monospace, 11px
everything), neon gamer, enterprise Slack-gray, warm paper/newspaper, or a dark-mode
Discord reskin.

### 5.1 Hard visual rules

| Rule | Reason |
|---|---|
| **No chat bubbles.** Messages are text on the surface. | Bubbles are the iMessage/Discord signature |
| **No avatars.** Identity is carried by styled names and color. | The whole personalization thesis |
| **No shadows** except 1px focus rings. | Shadows imply floating cards; panels don't float |
| **No gradients on surfaces.** Gradients exist only in user name fills. | Keeps the one expressive element expressive |
| **No rounded panels.** Radius: 4px buttons/inputs, pill switches, 6px inline media, **0 on panels.** | Panels butt against each other via hairlines |
| **No colored icon squares in the rail.** | Discord's signature; instant clone read |
| Panel separation is **1px hairlines, full-bleed.** | The mIRC structural inheritance |

### 5.2 Typography

| Role | Face | Size | Notes |
|---|---|---|---|
| Message body | Geist Sans (or IBM Plex Sans) | 16px / 1.6 | **Sans, not mono** |
| UI labels, room names | same | 14–18px / 500 | Actions use sans too |
| Timestamps, status bar, all numerals, file sizes, code | Geist Mono (or JetBrains Mono) | 12px | **Mono is metadata-only** |
| Time dividers | mono, uppercase, `0.1em` tracking | 12px | `SATURDAY MORNING` |

Mono appearing in a message body is a defect. That was the failure mode of the earlier
direction.

### 5.3 Color

Cool neutral gray. **Not green-shifted, not blue-black, not warm.**

```
                    DARK (primary)      LIGHT
surface-0  app bg   #16181C             #F7F8F9
surface-1  rails    #1A1D22             #FFFFFF
surface-2  raised   #21252B             #FFFFFF
hairline            #2A2E35             #E3E5E9
hairline-strong     #363B44             #CFD3DA
text-primary        #E4E7EC             #16181C
text-secondary      #ADB4C0             #505967
text-muted          #969DAA             #626C7A
text-faint          same as muted      same as muted
accent              #6E9BFF             #2563C9
```

Accent marks the "you left off here" line, focus rings, the active-room rule,
and primary actions such as joining voice, continuing setup and sending. Selected
preferences may use it with a separate shape or state label. It never decorates
entire panels, ordinary body text or arbitrary rail icons.

### 5.4 The 16-color name palette

**This replaces free color picking.** Users choose a *named* color, not a hex or a wheel.

Derived from the IRC 16, remapped through OKLCH. Each color is one hue with a
theme-mirrored lightness, so contrast is guaranteed by construction and no runtime
clamping is needed.

```
ember 32   rust 50    amber 68   brass 90
lime 118   fern 145   mint 162   teal 180
cyan 200   sky 230    azure 255  indigo 275
violet 295 orchid 320 rose 350   slate 250*
```
*(numbers are OKLCH hue; slate uses chroma 0.02, the rest 0.13)*

```
dark theme:   oklch(0.76 0.13 <hue>)
light theme:  oklch(0.50 0.14 <hue>)
```

Build generates hex fallbacks from these. **Verify `oklch()` renders in the target
WebKitGTK version during M0** — if it doesn't, ship the generated hex and drop the
runtime function.

Why this is better than a color wheel:
- Contrast safety is structural, not enforced by a clamp nobody can see working
- Two clicks instead of a fiddly picker
- Instantly familiar to anyone who ever typed `Ctrl-K` in mIRC
- 16 distinct colors across ~15 people means near-unique identity per person

**Gradients** are "pick two of the sixteen." Angle is fixed at 92°, not user-configurable
— one less control, and it guarantees every gradient name reads consistently.

### 5.5 Layout metrics

```
rail (servers + rooms)     232px default, adjustable
roster (who's around)      264px default, adjustable
message stream             flex, min 420px
panel gutters              20px
gap between message groups 20px
hairlines                  1px
radius                     4px buttons + inputs / pill switches / 6px media / 0 panels
```

### 5.6 Behavior

**Control hierarchy.** Actions have visible control
boundaries at rest, not only on hover. A primary action uses a solid accent
fill; secondary actions use a contrasting border and surface. Navigation uses
full-row targets with a distinct selected state. Immediate on/off preferences
use labelled switches, not ambiguous text buttons. Familiar toolbar actions
(add, settings, close, collapse) may be icon-only, with accessible names and
hover/focus tooltips. Less familiar actions keep visible labels. A person's
name is not drawn as a selector. Buttons and inputs keep Console's 4px radius;
switches use a pill track and circular thumb. Panels stay square and shadow-free.
The single-line composer input and Send button share an outer height; Send
keeps that height when the input grows. The attachment action opens a compact
menu above Add, focuses its first action and dismisses with Escape, outside
click or its trigger. Settings headings and navigation labels use title case.
The shared control language covers chat, settings and welcome; see
`docs/style-guide.md` for the reference and verification limits.

**Quiet delight (2026-09-17).** Use the final pixel-porch icon on welcome, centered
and sized to fit, without a duplicate wordmark. Small static porch illustrations
may accompany genuinely empty conversations/collections; never animate idle
surfaces. Control presses and contextual panels use short, consistent feedback.
Reduced motion removes movement without removing state or confirmation.
Name styling previews include a sample message; status drafts preview locally
before Save, without publishing keystrokes. Media thumbnails preserve the image,
expanded previews remain fitted, and starring confirms only after acceptance.
Existing notification cues share a soft musical family, with distinct rising/
falling patterns and a quieter peer/message register. Keep all current sound
gates and defaults; no sound for reactions, typing, saves or browsing.

**Reader controls.** Interface scale is 100–200%, available in Settings →
Appearance, not on the server/link screen. Saved scale also applies to sign-in
screens; first-run typography must be readable without configuration.
Text and controls grow together. Scale and panel
widths stay on this computer, never on the wire. Resize either panel by dragging
its boundary or focusing it and using arrow keys; Home/End choose the limits,
double-click resets. Navigation ranges 200–360px, people 232–400px before scale.
Narrow windows fit the panels without replacing the saved widths. Below 960px
of effective width People becomes an on-demand panel; below 640px Navigation
does too. Effective width accounts for the reader's interface scale. Widening
the window restores the side panels automatically.

**Navigation.** Show the selected server once in the server list, not again
under a `SERVER` label. `DMs` has the empty state `empty`. Personal Settings lives
beside your name in the navigation footer as a gear. Media and Search are
anchored immediately above that footer. Host controls open from the selected
server's options, under Server Settings; member removal lives in its People
section with confirmation, never in an ordinary member's action panel.
Clicking or right-clicking a roster name opens a compact, dismissible person
panel with their status and a spaced row of Message / Knock actions. Escape
and outside click close it and return focus. No roles or permission matrix
are introduced.
Desktop notification rules and notification chimes both live in Settings →
Sound & Voice, in separately labelled sections. The people panel stays about people.

**Voice.** A typographic participant strip stays under the room header. Names
remain legible when not speaking; a simple rule marks speech. Click, right-click
or keyboard-activate a participant to open their local volume controls. Names
have no selector borders or dropdown arrows. A chevron on the bar collapses
only the participants; joining and session controls align to the right. Hiding
the participants leaves join/leave, mute and deafen available. No avatars.
In a short window, participants start collapsed unless the reader chose otherwise;
the bar's expand control reveals them. This never changes the voice connection or audio.
When reading another room/server or opening a destination such as Settings,
a compact strip names the ongoing voice room and keeps mute, deafen, leave
and a return-to-room action available. Only one set of active controls is drawn.
Push-to-talk works while these controls are visible, including in Settings;
leaving the room view releases a held key, as does losing window focus.

- **Message aging** applies to the message *body only* — never the name or timestamp.
  Steps: <1h 100%, <1d 88%, older 78%. Floor at 78%; do not go lower.
- **System messages** (joins, leaves, pins, "dave stood up") are hairline rules with
  centered mono small-caps text. Never chat lines.
- **Status bar** is permanent, mono, 12px: connection state, latency in ms, storage
  used. This is the cheapest "real tool" signal available and no competitor has it.
- **Connection states show protocol text, not spinners:**
  `connecting… tls ok… identify… ready (28ms)`
- **Motion:** 120–160ms, ease-out. No spring, no bounce. The only slow animation in the
  app is name shimmer (4s linear).
- **Message presentation:** 16px/1.6 sans body, consecutive messages grouped.
  One comfortable default, with no density modes. Message bodies are limited
  to 80ch on wide windows; extra window width must not produce page-wide prose.

### 5.7 Bundled fonts

Open-licensed, subset and bundled, no CDN:
Geist Sans, Geist Mono, IBM Plex Sans, IBM Plex Mono, JetBrains Mono, Inter, Space
Grotesk, Commit Mono, Newsreader, Instrument Serif, Departure Mono, Silkscreen.

The last three are deliberately characterful — people will want them for names. The
first two are the system defaults.

---

## 6. Scope

### V1 — "it replaces the text half of Discord for one friend group"

| # | Feature | Spec |
|---|---|---|
| 1 | Self-hosted server: single binary + Docker image | ARCHITECTURE |
| 2 | Invite-link registration; host/member roles only | §2 |
| 3 | Rooms with occupancy and in-room presence | §4.1 |
| 4 | Entrance sounds | §4.1 |
| 5 | Text: markdown, edit, delete, reply | §4.7 |
| 6 | No unread counts; "left off here" line | §4.2 |
| 7 | Roster-forward layout | §3 |
| 9 | Name styling + message accent color | §4.5 |
| 10 | Statuses and away messages | §4.6 |
| 11 | Reactions by weight | §4.8 |
| 12 | File upload 500 MB, EXIF stripped | §4.10 |
| 13 | Media collection | §4.4 |
| 14 | Readable, responsive message layout | §4.7 |
| 15 | Full export | §4.11 |
| 16 | Desktop client: Linux, Windows, macOS | ARCHITECTURE |
| 17 | Multi-server list in the client | §3 |

One V1 item is parked and does not block the rest of the build: **entrance sounds**
(item 4). They go after M8 (export) — see `TASKS.md` *Backburner* (T-901…T-903).

**Activity detection used to be item 8 and is gone** (Matt, 2026-08-28 —
`docs/decisions.md`). It was parked on 2026-08-23 and cut five days later. §4.3
says what replaced it: a status somebody typed.

### V2

- Voice rooms (WebRTC mesh + coturn), push-to-talk, per-user gain (§4.14)
- Ambient voice: a room you leave running, not a call you join
- DMs and group DMs (§4.13)
- Search (§4.12)
- Knock (§4.9)
- Mobile client

### V3 or never

- Opt-in public directory (must never be load-bearing)
- Sandboxed client scripting (the real mIRC nostalgia answer; also a real security
  surface)
- Custom emoji
- **Custom themes** — a person's own colour scheme for the whole app, shared as a file
  (Matt, 2026-08-31). It is the personalization thesis one size up from a styled name.
  Three things bound it and none of them is settled: a theme is **a list of values, not
  a stylesheet**, because the tokens in §5.3 are already that shape and a stylesheet is
  the client-scripting security surface above wearing a different hat; §5.1's hard
  visual rules are **not themeable**, because a design system a theme can switch off is
  advice rather than a product; and if a theme can repaint the 16 name colours, the
  4.5:1 contrast guarantee has to move with it, live, in front of whoever is making it.
  A gallery inside the app is out — that is a store without prices, and §2 rules out
  every payment surface. See `TASKS.md` M14.

---

## 7. The honesty section

Read this before building and again at month three.

**Novelty features do not retain people.** Everything in §4 gets tried once. What keeps
a friend group on this app is that it opens in 400ms, does not nag them, and does not
lose their photos. The differentiators buy the first week. The absence of friction buys
the next two years.

**The scope discipline is the product.** The moment a role editor appears, the rebuild
of the thing you left has begun. When someone requests a feature, the question is not
"is this good?" but "does this belong at a dinner party?"

**The hardest parts are not chat.** Code-signed multi-platform distribution was one,
and it took M7 plus a decision to ship two operating systems instead of three. Voice
is the other and it is still ahead. Neither is interesting; both consume more time
than the entire message pipeline.

*(This used to name cross-platform activity detection as the other one. It was cut
on 2026-08-28 rather than built — §4.3.)*

**Do not claim end-to-end encryption.** The threat model is stated plainly in
`ARCHITECTURE.md` §7 and must be stated plainly to users too. Half-implemented E2EE is
worse than none, because it launders a false promise.

**Prior art to read before writing code.** Stoat (formerly Revolt, AGPL-3.0, GitHub org
`stoatchat`) is the closest existing project — a self-hostable Discord-alike with a Rust
backend. Read their schema and gateway protocol before designing yours. What they do not
have is the presence model, the AIM-style personalization, or a Tauri-weight client;
that is the differentiation. Do not fork them, but do not re-derive solved problems.
