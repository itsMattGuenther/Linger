# Decisions — settled questions and why

Moved from `TASKS.md` on 2026-08-25. These are settled. Reopening one is
Matt's call, not a maintenance decision. Tasks that lean on a decision here
point at this file.

## Decided — the password stays, the friction goes

**Matt, 2026-08-21.** The question was whether a locally-run server needs a
password at all, since Ventrilo asked for a name and nothing else. Answer: keep
it, but stop making people think about it.

The password is not protecting the messages — it is protecting *being you*. The
roster is the product, and the documented deployment is a box on the open
internet (ARCHITECTURE §7), so name-only would mean anyone who ever received an
invite link can connect as anybody. What was actually annoying was the
**12-character floor**, which is friction paid on every fresh install and buys
very little when the client already keeps the password in the OS keyring.

**Done in the same pass:** the floor is now **8**, which with no composition
rules is the NIST SP 800-63B position. One constant,
`linger-core::limits::MIN_PASSWORD_CHARS`; the server's error message counts off
it instead of spelling the number out, and the two client forms mirror it the
same way `Stream.tsx` mirrors `MAX_MESSAGE_CHARS`. PROTOCOL §2 says 8 and says
why.

The two bigger options were considered and **not** taken: making the invite link
itself the credential (a real change to PROTOCOL §2 and the refresh-token family
logic), and a host-set no-auth LAN mode (honest for a LAN party, dangerous the
day the box gets a public IP). If the friction comes back, those are the next
two rungs, in that order.

---

## Decided — the host's side

**Matt, 2026-08-21.** Four questions came out of reading T-410 before starting it.
The server-admin story is otherwise unchanged and already built: the host deploys
the image, reads the one-time setup URL out of the logs, pastes it into the
client, and from then on is a normal user with `is_host = 1`. Rooms and server
settings are database rows edited from inside the app — never a config file.

**No host transfer.** `is_host` stays a boolean that nobody can hand to anybody
else. If the host goes quiet, the friends stand up a new server. That is a real
answer for a group of eight, and it keeps a second root from growing on a product
whose anti-goals include a permission matrix (AGENTS rule 10).
*Partly reversed on 2026-10-04:* the host can name co-hosts, who do what the
host does in the app while they're away. `is_host` itself still can't be
handed on. See *Decided — a co-host, for when the host is away*.

**Removal, not banning** — T-413. A ban needs something durable to ban *by*, an
address or a device id, and Linger does not store either and should not. It would
not work anyway: housemates share one address and phone networks reshuffle them.
A removal here is already ban-shaped — usernames are unique and immutable, the
account row stays, and registration is invite-only, so the host is the only door
back in. One action, plus the reverse, so a removal made in a bad moment is
fixable.

**The M5 storage knobs are environment variables.** The 50 GB pool and the
365-day file expiry (SPEC §7) go in the compose file with everything else, per
the position `config.rs` already takes. No config-file format to document,
version, and migrate. Built that way in T-505: `LINGER_POOL_BYTES` (a plain
byte count or a size like `250GB`) and `LINGER_FILE_EXPIRY_DAYS` (a number of
days, or `off`). T-501 had parked the pool in a `server_config` row against a
host-facing endpoint that this decision says will not exist, so that row is
gone — one source of truth, and it is the environment.

**The printed setup URL is https when a domain is set** — fixed 2026-08-21, not a
task. The client keeps whatever scheme it is handed, for the REST base URL and
the gateway socket both, so printing `http://` pinned the host's own session to
plaintext on the very first thing they ever do. It falls back to `http` only for
a bare bind address, which has no certificate and is honestly plaintext.


---

## Decided — v1 ships unsigned, and macOS does not ship at all yet

**Matt, 2026-08-27.** M7 assumed installers would be code-signed on Windows and
notarized on macOS. Both turn out to be blocked on money rather than on work: a
Windows OV certificate is a few hundred dollars a year, and notarization needs an
Apple Developer Program membership at $99 a year. For a server you hand to a
friend group, neither is obviously worth buying yet.

**A correction that shaped this:** notarizing does not need a Mac in the room.
`release.yml`'s `macos-latest` runner is a Mac and can sign and notarize on its
own. The membership is the blocker. Somebody's Mac is still wanted for *opening*
the installer once — that is the T-002/T-003 sign-off, a different errand.

**So, for v0.1.0:**

- **Linux and Windows ship, unsigned.** Windows shows SmartScreen's
  "unrecognized app" warning, which is clickable past via *More info → Run
  anyway*. The README says so plainly rather than letting a friend discover it
  and assume the download is broken.
- **macOS does not ship.** Not even unsigned. Two reasons, and the second is the
  real one. Gatekeeper on recent macOS no longer takes a right-click → Open; it
  sends the user into System Settings to click past a malware warning. And the
  eventual move from an ad-hoc signature to a Developer ID one is precisely the
  transition that breaks an app the updater has replaced in place — so an
  unsigned macOS build now is not a step towards a signed one later, it is a
  thing that has to be uninstalled by hand. **Shipping nothing orphans nobody.**

**None of this is expensive to reverse.** The minisign updater key is
OS-independent and does not change. Adding a `darwin-aarch64` entry to a later
`latest.json` is a pure addition. With no macOS installs in the world, there is
nobody to strand.

**What this does to the queue:** T-702 keeps the half that is not blocked — the
release CSP hardening, and documenting the warning honestly. The signing itself
becomes **T-705**, parked until there is a certificate and an account. Note that
M7's milestone check says *a signed installer per OS*, so M7 closes on two
operating systems and unsigned; that is the decision, not an oversight.

---

## Decided — activity detection is cut, and mobile waits

**Matt, 2026-08-28.** Two calls on the same day, both about not building things.

### Activity detection is gone

It was V1 item 8 and SPEC §4.3: the client would watch which application you had
in front of you, resolve it against a bundled registry of ~200 apps, and show
the room "playing Factorio" or "♪ Bill Evans". It was parked on 2026-08-23 as
off the critical path. Five days later it is **deleted**, not parked.

**The reason is that a status already does it, and does it better.** If you want
people to know what you are playing, you type it. That is one line of effort,
once, and it is always right — it says what you meant rather than what a process
name implies. A status cannot mislabel your work project as a game, cannot
announce something you would rather not announce, and cannot leak on a day the
hide-list has a gap in it.

**Against that, the cost was enormous.** Four operating-system backends (KWin
over D-Bus, X11, Win32, `NSWorkspace`), a poller with a debounce, a curated
registry that somebody has to maintain forever, a local override file, and five
separate privacy controls — a global off switch, a per-server off switch, a
per-app hide list, an idle-only mode, and a persistent indicator — every one of
which exists only to make the feature safe enough to ship. When a feature needs
five controls to be safe and a typed sentence does the same job, the sentence
wins.

**What was deleted:** `crates/linger-activity/`, `registry/apps.json`, the
`ActivityInfo` wire type, the `activity` field on `PresenceEntry` and on
`presence.update`, the server's registry resolution, the Tauri `activity_probe`
command, the roster's activity line, and tasks T-911…T-917. SPEC §4.3 is now
just presence. ARCHITECTURE §6 keeps a short note about why it was hard, because
the reason (Wayland has no cross-compositor way to ask what window is in front)
is still true of anything else that reaches into the desktop.

**The rule that outlives it:** never report or transmit window titles, or what
application anybody has open. There is no code left that could, and no type with
a field that could carry it. AGENTS rule 2 is the enforceable version. Building
any of this back is Matt's call, not a maintenance decision — and the answer is
currently no, "if ever".

### Mobile moves to the backburner

It was going to be M14, the last V2 milestone. It is now on the backburner with
no milestone at all.

**Desktop first.** V1 is built and has not been through a single human check —
nobody has installed a release, watched an update land, uploaded a real video,
or pressed the export button. A mobile client doubles the surface of every bug
still in the desktop app, and it is a second set of stores, signing accounts,
review processes and release paths to keep green.

The unanswered question in front of it has not gone away and is recorded in the
parking lot: **push notifications go through Apple and Google, or they do not
exist.** There is no third way to wake a phone app, and the README's privacy
section does not currently allow for it. That has to be answered before any
mobile code is written, not during.

This is a "when the desktop app is boring" item, not a "next quarter" item.

---

## Decided — no "no AI" line

**Matt, 2026-09-29.** Linger has no AI features and none are planned. What goes
is the line saying so. On 2026-08-28 the case had already been cut from a SPEC
section, a README section and a user-guide paragraph down to one anti-goal in
SPEC §2 and one AGENTS rule; today those go too, with the README's "never"
list entry and the mentions in the idea form, the agent skills and the design
notes.

**Why:** none of the apps Linger is compared with uses AI in a way that calls
for an answer, so the line read as a position the project was taking, and it
isn't one. The anti-goals are things a chat app would be expected to grow.

Nothing is opened up by this. An AI feature would be a feature outside the
spec, and AGENTS rule 10 already says to stop and ask before building one. Rule
1, no AI attribution in commits, pull requests or metadata, is a separate rule
and stays as it is.

Kept here so nobody restores the line thinking it was lost.

---

## Decided — reactions come out, as a trial

**Matt, 2026-09-24 (#168).** Emoji reactions on messages clutter the
conversation. The app no longer shows them or offers a way to add one. People
answer by replying or saying something, and the composer's emoji selector still
puts emoji into that text. This goes against the original design (SPEC §4.8,
V1 feature 11) on purpose. It is a trial to see how people take it.

**Taken out of the client only.** The server keeps the twelve keys, the
endpoints, the stored reactions, export and the `reaction.update` frame. So
bringing reactions back is a client change, nothing anybody already added is
lost, and an older client keeps working. The cost: somebody on 0.3.4 or earlier
can still add reactions and still sees them, and the new client does not.

If the trial sticks, removing the server side is a separate decision. It is a
protocol change that breaks older clients, and its migration deletes every
stored reaction.

---

## Decided — the client is rebuilt around the Buddy list design

**Matt, 2026-09-25 (#198).** Out of the #101 design exploration, Matt chose the
Buddy list:
- a tall list of friends as the app's own window;
- conversations as tabs in one chat window by default, or each in its own
  window as an opt-in setting;
- voice that belongs to the room, not the tab or window;
- several servers as folding sections.

The look comes from the logo: night blue, lamp amber, pixel labels. Linger
draws its own title bars, and there are no avatars.

**Rebuilt, not reskinned.** The first client grew by accretion. Its recurring
bugs were one-off sizes and alignments (#88, #144, #146, #164, #172) and
spacing (#92, #93, #181). The new client is built from a kit of parts whose
sizes are fixed by tokens and checked by geometry tests, so those bugs can't be
written. Matt asked for "intentionally crafted software": long-term stability,
maintenance and thorough tests.

**Next to the old one, not instead of it:**
- **Same repository.** A new repository would strand installed copies: they
  update from this repository's releases.
- **Not a long-lived branch.** It would drift from main and end in one risky
  merge.
- **Where it lives:** `client/src/next/`, reusing the tested core (REST client,
  sessions, gateway store, voice engine, updater), opened only behind a hidden
  switch until it passes `docs/design/parity.md`.

**One owner window.** The buddy list window alone:
- refreshes tokens;
- connects gateways;
- plays sounds and shows notifications (a voice control's sound plays in the
  window where it was pressed, once the owner has made the change: #241);
- drives voice.

Other windows keep their own copy of the state with the same pure `apply`, and
catch up from the owner's snapshot. `docs/design/architecture.md` has the
reasons: rotating refresh tokens, `gateway_connect` replacing connections,
and events reaching every window.

**Scope:** Linux and Windows. No macOS build (see the decision above).

## Decided — Omarchy and Arch get a package, from our own repository

**Matt, 2026-09-25 (#188).** The AppImage bundles an older WebKitGTK (2.50.4,
from the Ubuntu 22.04 build machine) so it runs on any Linux. On the Omarchy
machine that copy can't use the GPU display path at all (#187), and without it
typing and scrolling run a frame behind (#169). The system's WebKitGTK 2.52.6
has no such problem. Omarchy is popular in Matt's circle, so Omarchy and Arch
users get a package that uses the system's WebKit.

**How:** the program inside each release's `.deb` already runs on Arch against
the system's libraries, so the package repackages it (`packaging/arch/`); there
is no separate Arch build. It is served from a pacman repository on the `arch`
GitHub release, a pre-release so the in-app updater's `releases/latest` never
points at it. Omarchy's Update runs `pacman -Syu`, which checks every
repository, so new versions arrive with system updates. The repository only
changes when a release is **published**, keeping "publishing is a person's
click" true for pacman users.

**Signed.** A dedicated Linger packages OpenPGP key signs every package and the
database (fingerprint `A539799132574CE3EB51B01AB5FA9838135B10DF`). Its public
half is `packaging/arch/linger.asc`; the private half is the `ARCH_SIGNING_KEY`
secret, with an offline backup Matt keeps. Losing it means a new key that
everybody trusts again; leaking it means somebody could sign packages that
pacman installs as Linger.

**Not the AUR, yet.** AUR registration was closed on 2026-09-25. The same
recipe can be published there as `linger-bin` when it reopens.

## Decided — voice goes through a forwarding server built into Linger

**Matt, 2026-09-25 (#197); built on `feat/197-voice-forwarding`, not yet
shipped.** Every voice room goes through a forwarding server (an SFU) rather
than a full mesh, small rooms included: one install for every host, one voice
path to test, and room for a raid night of twenty. #197 left open whether that
server is LiveKit beside Linger or part of Linger itself.

**Part of Linger.** `crates/linger-sfu` forwards audio with `str0m`, a sans-IO
WebRTC library, inside `linger-server`:

- **Nothing new to run.** A host adds one UDP port (3479) and their public IP
  (`LINGER_VOICE_ADDRESS`); there is no second service with its own keys,
  config and upgrades. LiveKit would be a container that has to be kept in
  step with Linger, and a protocol the desktop engine would have to speak
  through LiveKit's own client library, which brings Google's C++ WebRTC.
- **Audio only is small.** No video, no simulcast, no bandwidth estimation
  worth the name: the server passes Opus packets on without decoding them.
  The desktop engine keeps `webrtc-rs`, its devices, Opus and speaking
  detection; only the mesh gives way to one connection to the server.
- **The server drives negotiation,** so the client only answers and two
  offers never cross.

**What it costs.** The server now carries voice, so a host could listen
(SPEC §4.14 says so; #200 is the layer that stops it), and the server image
grows by `str0m` and its pure-Rust crypto. Mesh stays for old clients and for
servers that don't set `LINGER_VOICE_ADDRESS`, until every client forwards.
(It went on 2026-09-28: see "the previous client and mesh voice are gone".)

**Before it ships:** the real-network check (four people, four networks, an
hour), a server restart mid-call, and a client that loses UDP and has to come
back through TURN.

---

## Decided — status pictures are gone

**Matt, 2026-09-27 (#269),** after a friend couldn't add one. A status had one
optional picture (SPEC §4.6, 512 KB, shown at 400×200). It is removed from both
clients and the server. A status is words: the line, the three short fields
and the away message.

Three reasons:

- **It was broken.** Settings uploaded the picture as soon as it was picked,
  and the form's clean-up for an unsaved upload fired every time the Settings
  window redrew, which is at least once a minute and on every change on the
  server. The upload was deleted before Save, and the server answered "That
  image isn't on this server." It was worst on a busy server.
- **Nobody would see it.** The Buddy list client, the app since 0.4.0, never
  drew one. The person card shows the line, the away message and the three
  fields. Only the previous client's status card drew the picture.
- **Rooms do it better.** A photo posted in a room is seen without opening
  anybody's card, can be replied to, and is kept in Media (SPEC §2, "keep the
  artifact"). A status picture was overwritten and gone.

**Compatible with older apps.** `image_id` and `image_url` stay in
`UserStatus` and are always null. `PATCH /me` accepts an `image_id` and
ignores it, so an older app saving a status with a picture gets no error. A
migration clears every picture a status held; the files are then uploads that
never became a message, and the sweeper takes them after the expiry window like
any other. It no longer spares files a status names. Taking the two fields off
the wire is a later protocol change, for when no older app is left.

---

## Decided — status fields get labels you choose

**Matt, 2026-09-27 (#270).** A status had three fixed fields: Listening to,
Reading and Working on. A friend who mostly plays games had no "Playing", and
a web address in a field was text you couldn't click.

- **Three fields at most, each a label and a value.** The label is picked
  from Listening to, Reading, Working on, Playing and Watching, or typed
  ("Your own…", about 24 characters). The value is 80 characters, as before.
  Still a small card, not a bio (SPEC §4.6): no icons or emoji per label.
- **Web addresses open.** A web address in a value opens in the browser with
  the same rules and safety as a link in a message. Nothing else in a value
  is a link. A bare name only counts with a path or `www.` (`github.com/you`,
  not `main.rs`), because a file name looks exactly like a web address.
- **Older apps keep working.** Statuses still carry `reading`, `listening` and
  `working_on`, filled from the fields with exactly those labels. A save from
  an older app changes only those three fields, in place, and keeps the
  others; a value that would make a fourth field is refused, since that app
  can't show the field it would push out (PROTOCOL §5). A migration turns the
  old three columns into fields, so nobody's status changed on update.

---

## Decided — dark only, no light theme

**Matt, 2026-09-28.** The Buddy list client shipped dark only, with a light
version left as an open question (parity decision 2, 2026-09-26). It's closed
now: "We can scrap the light theme from the spec. I think we're going to pass
on that." The app is dark only, and no light version is planned.

The previous client (`LINGER_CLASSIC=1`) had its dark, light and
follow-the-system choice, and `linger-core`'s palette carried the light
lightness it used. Both went when that client was deleted (#306). Evening
warmth is a separate question and still waits for an evening version of the
new colors.

---

## Decided — the previous client and mesh voice are gone

**Matt, 2026-09-28 (#306).** "The new UI is awesome, so I think we can get rid
of the old one now. And the old voice option that was a mesh network is no
longer needed since the new one is performing well." Two parts, two PRs.

**The previous client.** The Buddy list client has been the app since 0.4.0, and
the previous client had stayed behind `LINGER_CLASSIC=1` for three releases
as a way back. It's deleted, with everything only it used:

- **The window chooser.** The shell always opens the Buddy list;
  `LINGER_CLASSIC` does nothing. The list window's size and frame are in
  `tauri.conf.json`, not patched in at startup.
- **Its screens, styles, test pages and browser tests,** and the parts of
  `client/src/lib/` only its screens called. What the windows share stays in
  `lib/`, as logic only; `discipline.test.ts` keeps it that way.
- **The light palette** in `linger-core`, and the theme picker the new
  client's Settings could draw but never did.
- **Its checks.** The packaged audio checks keep testing sound inside the
  installed app, now on the Buddy list; their layout part measured the
  previous client's screens and went with it. The new client's start-up in
  the packaged app is `linux-next-check.py` and `windows-next-check.mjs`.
  `scripts/desktop-check.py`, the three-person walk-through that drove the
  previous client's screens, is retired; a Buddy list version is T-1820.

Before deleting its browser tests, each one was checked against the new
client's. Where a behavior had no test there, one was added: sending before
the server answers, push-to-talk letting go when a window loses focus, the
picture viewer, whole tooltips on the voice bar, the focus ring after a mouse
open, keeping your place through a resize, rows re-rendered while scrolling,
nothing moving when somebody talks, the 80-character line, and a few in the
message box, knocks and Settings.

**Mesh voice.** Voice through the server (#197) shipped in 0.4.1 with the mesh
kept as the way back, and has carried every call since. The mesh goes:

- **Voice needs forwarding.** A server without `LINGER_VOICE_ADDRESS` carries
  no voice. It refuses every join, says so at startup, and says `voice: false`
  in `GET /server`, so the app shows "Voice isn't set up on this server"
  rather than a call nobody could hear. The host guide makes forwarding part
  of the normal setup.
- **Apps before 0.4.1 can't join voice.** They spoke only the mesh. A join
  from one is refused, and the room carries on as it was. Apps 0.4.1 to 0.4.3
  keep working: they are forwarded even if their old switch said the old way,
  and the server keeps marking every seat `forwarded` because they read it.
- **Gone:** the mesh in the desktop engine, `voice.signal` on the wire, the
  server's fallback and its room-wide "go the old way" rule, and Settings'
  Voice through the server switch. A room holds 25, everywhere.
- **Kept:** the relay (TURN), which forwarding uses to reach people on
  networks that block UDP. The audio tests that ran two engines over the mesh
  now run them through the real forwarding server.
- **An older server** that still puts a room on the mesh leaves this app's
  seat unmarked; the app leaves voice and says the server needs an update.

---

## Decided — the server image is x86-64 only

**Matt, 2026-09-28.** The server image was built for x86-64 and ARM64, so a
Raspberry Pi or an ARM cloud server could host. The ARM64 half was built under
emulation on GitHub's x86-64 machines, which took 77–83 minutes of every
release, against about five for x86-64, and publishing waited on it. "I don't
think anyone I know is going to be running this on a Raspberry Pi... I think
we should consider not supporting that, especially if it speeds up our release
times because it's painfully slow."

- **From 0.4.5 the image is x86-64 only.** 0.4.4 and every image before it
  stay on ghcr for both. `image.yml` builds `linux/amd64` for tags, pull
  requests and manual runs alike, with no emulation step.
- **An ARM host** pulling `latest` after 0.4.5 gets "no matching manifest for
  linux/arm64" and keeps running what it has; pinning
  `ghcr.io/itsmattguenther/linger:0.4.4` in `compose.yaml` keeps it on the last
  image built for it. The 0.4.5 release notes say so.
- **The host guide** asks for an Intel or AMD machine, and `compose.yaml` says
  the same.
- **Not taken:** building ARM64 on GitHub's native ARM runners (free for public
  repositories), a second job pushing by digest and a manifest joining the two.
  It would have kept ARM in minutes, not an hour, but for hosts nobody has. If
  one turns up, that's the way back, not emulation.

## Decided — Linger is for people who know each other, not for eight

**Matt, 2026-09-30.** SPEC §2 said Linger was built for "a dinner party of
eight", and the README said the same. It read as a ceiling on who the product
is for, and that stopped being true: voice rooms go through the host's server
and hold 25, and groups like a game guild are bigger than eight. "Who am I to
be the arbiter of how many people you're allowed to put in your room? It's
yours. Maybe you want to use it for a hundred people, or maybe you just want
to use it for five people." And: "the dinner party of 8 language needs to go.
We're beyond that."

- **The thesis is who, not how many.** Discord is built for strangers; Linger
  is built for people who already know each other. The anti-goals stand as
  they were. No roles, no `@everyone`, no counts: they are about how people
  treat each other, not about a headcount.
- **How many people a server holds is the host's call.** There is no cap on
  members, and none is added.
- **A limit that remains is what the software carries today**, not a verdict
  on group size. A voice room holds 25 because the forwarding server sends
  every voice to every listener, all on one thread. Forwarding only the people
  talking is what would lift it. That, a load test for servers of 50–60 and
  hardware guidance for hosts are #197.
- **Group DMs stay at two to eight.** The ceiling no longer leans on §2: a DM
  has no host and fixed members, so a bigger group is a room.
- **Earlier entries here and the task archives** say "eight" in places. They
  are records of their time and stay as written; the decisions in them stand.
- Changed together: SPEC §2, §4.12, §4.13 and §7, the README, the buddy list
  design, the idea form, and code comments that argued from "eight friends".

## Decided — the list is the one window, and conversations unfold beside it

**Matt, 2026-09-30 (#337).** A friend asked for the chat window to dock onto
the buddy list, so the two would move as one. On 2026-09-29 that was planned
as a third choice in Settings → Windows. Starting it, Matt asked two
questions: whether a third way of opening conversations would be harder to
keep from breaking, and whether the list should simply become the core
window, with the rest of the app unfolding from it and folding back to just
the list, which would also look nothing like Discord. He looked at a mockup
of it at real size and decided:

- **The docked window is the design, not a third choice.** Conversations
  open as tabs beside the list, in the list's own window, and the separate
  chat window of tabs is gone. A third choice would have kept every branch
  between the two old ways and added a third to each: where a conversation
  opens, which room you count as in, when the chime keeps quiet, what closing
  does. Replacing the tabs window instead deletes its fiddliest code, the
  catch-up it needed when it opened and the ten-second queue of
  conversations the list kept for it (`next:opens`).
- **"Each in its own window" stays**, for tiling desktops and several
  monitors. Pop-out is the same kind of window, so it costs little.
- **Media and Search become tabs beside the list too**, in the same pull
  request.
- **The fold button is at the conversations' left edge**, not beside the
  gear as the first mockup drew it: folding shrinks the window, and a second
  click on a button beside the gear landed on the list's close button, which
  sends Linger to the tray. Folding takes the edge button away with the
  conversations. Unfolding is a button beside the gear, neutral rather than
  the lamp: in amber it read as a notification (Matt, trying it the same
  day), since amber is what a DM nobody has read is lit in.
- **The line between the list and the conversations drags** (Matt, the
  same day): the list's width, kept on this computer, with the window
  staying its size. The kit's `Splitter` draws it.
- **Not taken:** gluing two windows together (impossible on Wayland, wobbly
  on Windows) and two webviews in one window (Tauri still marks it unstable,
  and WebKitGTK is its weak spot). Both are in #337.
- **What it costs:** messages are now drawn in the window that holds the
  keyring and the connections. `docs/design/architecture.md` ("Windows and
  their roles") says why that's acceptable and what would change it.
- **On a tiling desktop** the desktop sizes the window, so it can't grow or
  shrink by itself. Too narrow for both, the conversation takes the window;
  a slim list there means floating the window, which is the desktop's
  setting, not Linger's (don't fight the desktop, #226).

## Decided — the AppImage brings its own decoders for shared videos, trimmed

**Matt, 2026-09-30 (#358).** A video shared in a room played without sound on
Omarchy. Linux plays media through GStreamer, and the sound in most videos
(AAC) and their picture (H.264) need its libav plugin, which Linger's packages
never asked for. #362 made the Arch, Debian/Ubuntu and Fedora packages ask the
system for it: about 100 KB on a computer that already has FFmpeg. The
AppImage couldn't be fixed that way. It carries its own GStreamer, copied from
the machine that builds it, and ignores the computer's, so its users had
nothing to install.

- **The AppImage carries the libav plugin**, over the 2 MB line AGENTS.md
  asks about first: shared media is half of what Linger is for.
- **On a trimmed FFmpeg, not Ubuntu's.** Ubuntu's FFmpeg is built with
  everything, and bundling it made the AppImage 45.3 MB bigger (109.0 to
  154.3 MB, in the package check's debug build): an H.265 encoder, a ham radio
  codec, speech synthesis voices and a maths library, none of which plays a
  shared video. Matt chose the trimmed build when he saw the number.
  `scripts/appimage-ffmpeg.sh` builds FFmpeg 4.4.2, the release Ubuntu 22.04's
  plugin was built against, with the H.264, H.265, AAC and MP3 decoders: 4 MB,
  and the AppImage grew 1.4 MB (to 110.4). The source is ffmpeg.org's tarball
  against a pinned checksum, and no GPL parts are enabled, so it's LGPL.
- **What the trimmed build doesn't play in the AppImage:** AV1, and older
  formats such as DivX. WebM (VP8, VP9, Opus, Vorbis) never needed libav. The
  other packages use the system's full FFmpeg.
- **Checked every build:** `linux-audio-check.py --video` plays an H.264 and
  AAC clip in the packaged AppImage and listens for its sound, and
  `appimage-ffmpeg-check.py` fails an AppImage carrying the build machine's
  FFmpeg instead of the trimmed one.
- **Worth knowing:** the AppImage now ships an H.264 decoder itself, where
  the other packages leave that to the system and Windows to Microsoft. H.264
  is still under patents in some countries; plenty of free apps' AppImages
  carry the same decoder.
- **The `.deb` recommends the plugin rather than requiring it** (#377, before
  0.4.5 shipped). Updating inside the app installs the new `.deb` with
  `dpkg -i`, which fetches nothing: a requirement the computer lacks leaves the
  package half-installed, the update failed, and apt refusing everything until
  `apt --fix-broken install`. A fresh `apt install` brings recommendations
  anyway, and an in-app update leaves it to the user guide's one command. The
  same holds for anything the `.deb` wants in future, and
  `scripts/package-deps.test.mjs` fails on a new requirement.

## Decided — the list is places and people: a DM lives on its person

**Matt, 2026-09-30 (#351).** The DMs and People sections felt fragmented, and
he couldn't put his finger on why. Put into words, it was that the list was
sorted by what Linger stores (rooms, DM conversations, members) rather than
how you think of your friends (places and people). So every friend was in it
twice: a DM row with a dot and a plain name, and a People row with their
styled name and status. The two looked different and did different things
when clicked. Mockups at real size compared three ways out; he chose the first
"as a great start to test this out", and settled its two details the same day.

- **One row per friend.** A one-to-one DM has no row of its own; it lives on
  its person, whose row is lit while they've written something you haven't
  read (#291). A lit person shows even in a folded group, with their name as
  they styled it: the light says it, not bold.
- **The people you're talking to come first** in each group: whoever wrote to
  you, then whoever you've talked with most recently, then everyone else.
  Matt: so you don't lose the people you're DMing in a sea of people you
  aren't, which matters more as servers grow (#197).
- **Clicking a friend opens them beside the list,** their card as the DM's
  header over your conversation. The tab is a preview until you type in it:
  the next person you open takes its place, so looking around doesn't pile up
  tabs. Hovering a row shows their whole status. The list marks what's
  showing beside it.
- **Group DMs sit with the rooms,** after the server's own: a group DM is a
  small private room. The + on Rooms starts one.
- **Their card on its own** still opens from a name in a conversation or the
  voice bar, and from a small card button on their row next to Knock, for a
  look at their fields without opening a tab. That button wasn't in the
  mockups; it replaced the row's Message button, which a click now does.
- **Not taken:** keeping DMs but only while something's live (every friend
  still twice, exactly when it matters, and rows coming and going under you),
  and DM rows showing the last line (still twice, and private words on the
  screen pull at you like an inbox).

---

## Decided — the phone app: text first, and nothing wakes it

**Matt, 2026-10-02 (T-1601, #253).** Mobile comes off the backburner, and the
question that blocked it since 2026-08-28 is answered: **no push.** He took
eGGnogSC's proposal on #253 over his own brainstorm of 2026-09-26, which had a
`mobile` presence state and generic notifications ("something new on
<server>"). SPEC §4.15 is the rule; this is why.

- **A real app on iPhone and Android,** from the same Tauri 2 code as desktop,
  so the gateway client in Rust carries over. Not a phone-friendly website.
- **No push, no relay, no notifications.** Waking a closed phone app takes
  Apple's or Google's push service. Linger has no single company behind it, so
  every server would need the push keys, and they can't be handed out. The
  usual fix is one central relay holding the keys, and that is a company in the
  middle of every message's existence. Matt: no relay keeps "no company in the
  middle" true for messages and voice. The README's privacy section stays as it
  is. The cost is that a phone never buzzes; the app catches up when opened.
- **No `mobile` presence.** A closed phone app is offline, which is the truth.
  Presence is where somebody is, not what they are holding (SPEC §4.3). It also
  avoids a protocol change: `PresenceState` has no catch-all, so an older
  desktop app can't read a value it doesn't know.
- **Uploads from phones: yes.** The server already strips location data from
  every image (SPEC §4.10).
- **Text first; voice only if asked for.** Matt had assumed phone voice would
  route through Apple or Google. It doesn't: it goes to the host's server like
  desktop voice, and only ringing a closed app would need push. It waits anyway.
  A phone on speaker needs echo cancelling the desktop app doesn't have, the
  work is weeks of real-phone testing (AGENTS "Where you will be wrong": audio
  devices), and of the rare times friends talk from a phone on Discord, Matt
  says "it sounds awful and it's not pleasant for anybody". It comes back if
  people using the phone app ask.
- **No mobile branch.** Phone work lands on `main` in ordinary short branches,
  with desktop-only code (tray, updater, keyring, voice) switched off for phone
  builds. Nothing ships to a phone until a phone build is added to the release
  workflow.

- **Phone backups leave Linger out.** Matt: the app's data stays out of
  iCloud and Google backups, the same reason as no push, applied to what the
  phone stores. He first wanted a setting to opt in, and dropped it on
  2026-10-03: building the Android side showed a backup would carry almost
  nothing. Sign-ins are encrypted to a key that never leaves the phone, so
  they can't move to a new one, and messages and pictures live on the server;
  what's left is a few preferences. A new phone signs in again.
- **Report and block, in both apps** (T-1605). Both stores require them in
  apps where people post things. Matt agreed to add them, and to the desktop
  app too if it made sense. It does: the server side is shared, and a report
  goes to the host, who reads it in whichever app they use. Matt sees them as
  an edge case among friends who trust each other, wanted only because the
  stores require them, so the rule is the least UI that does the job. He
  approved the shape from mockups on 2026-10-03: Report is the last item on a
  message's actions and behind a ··· on a person's card. The host sees who
  sent a report, since everyone knows everyone anyway. A blocked person's
  messages each become one grey line, "From Dex, who you blocked · Show",
  rather than vanishing, because in a small room a reply to a message that
  vanished reads as somebody talking to nobody. The host learns of a report
  from one lit row in the list, never a count.
- **On the phone, one screen at a time, like Discord** (Matt, 2026-10-03).
  Tabs on a phone were awkward. Phone chat apps have settled on a pattern
  people already know: the list is home, and a conversation, Media or Search
  opens over it, full screen, with ← Back. Matt picked that, with Media and
  Search staying at the foot of the list. Nothing on a phone may reach past
  the screen's edge or scroll sideways.
- **The phone identifier is `io.github.itsmattguenther.linger`.** Matt left
  the name to the session. A store never lets it change after the first upload,
  so it has to be one nobody else can already hold. Linger owns no domain, and
  by convention `com.linger.*` is for whoever owns linger.com. A name built
  from the GitHub address is the open-source convention for that case. Desktop keeps
  `com.linger.desktop`.
- **Android first, Apple after** (Matt, 2026-10-03). Matt has no iPhone, and
  Apple costs $99 a year to Google's $25 once. So the phone app goes out on
  Google Play first, with Matt paying the $25, and only once it has worked
  well there does it go to Apple. Until then the iPhone build only keeps
  compiling in CI, and the iPhone-only checks (swiping back, iPhone photos)
  wait with it. Getting the app to other people (T-1604) waits until report
  and block are done and Matt says go.
- **Friends first, from the release page** (Matt, 2026-10-03). Report and
  block were done and every Pixel check had passed, so Matt said go, for the
  quick path first: a signed `.apk` on each GitHub release, which an Android
  friend downloads and installs (Matt's wife is the first). No Google account,
  no review, no wait. It doesn't update itself; each release installs over the
  last because all of them are signed with the same key
  (`scripts/android-key.sh`, checked against a committed fingerprint before
  and after every build). Google Play stays the next step, and can take that
  same key, so a phone that installed from GitHub keeps updating from the
  store. Its slow part is a new account's 12 testers for 14 days.

A phone app updates on its store's schedule, not ours, so phones will often be
a version behind their server; how far back compatibility goes is #315.

## Decided — voice messages: a clip you record, hear back, and choose to send

**Matt, 2026-10-03 (#401).** Record a voice message in the message box and send
it, on the desktop and, later, the phone. Discord offers it only on phones.

- **A toggle, never press-and-hold, and Stop never sends.** A finger slips off
  a hold and sends half a thought, and apps that send on stop send accidents.
  You hear it back, then Send or Discard.
- **SPEC §4.14 says "Voice rooms are never recorded".** It used to say
  "Nothing is recorded, ever", meaning rooms. A voice message is a clip you
  record of yourself and choose to send, like a file: nobody else is in it.
  The promise about rooms is unchanged. Matt agreed to the wording
  (2026-10-03): "It's no different than if I recorded an audio clip of
  myself in Audacity and then uploaded it to the chat as an audio file."
- **Opus in WebM, made on the computer, never converted by the server.**
  Chromium and WebView2 play it, WebKitGTK does through the GStreamer plugins
  the packages already depend on, and Safari's WebKit does from Safari 15.
  The browser tests play a real recording in Chromium and WebKit. So there is
  no ffmpeg step on a small host. AAC wouldn't play on Linux without a decoder
  (#358).
- **The desktop app records in Rust**, from the microphone voice already opens
  in the device's own format (`src-tauri/src/clip.rs`, #398), and the page puts
  the packets in a WebM file (`client/src/lib/webm.ts`). WebKitGTK's own
  recording isn't something to lean on, and this way every desktop records
  the same file. The phone records in the page instead (`app/chat/recorders.ts`,
  Matt, 2026-10-03: "the plan was for it to be both"): the web view's own
  microphone, with the phone's echo cancelling and noise suppression, encoded
  by WebCodecs as Opus at the same 64 kbit/s, into the same file writer. The
  shell has no audio code on a phone, and the web view already asks Android
  for the microphone when a page wants it. The app asks for `RECORD_AUDIO`
  only then: the first time Record is pressed.
- **Five minutes at most**, about 2.4 MB at 64 kbit/s, Discord's default for
  a voice (Matt, 2026-10-03, up from 32: a message is heard again, so it gets
  more bits than a live call; voice rooms stay at the encoder's own rate). It
  stops by itself and says so, and the clip is kept to hear back and send.
- **On the server it's an ordinary audio file.** `audio/webm` joins the audio
  types; the sniffer calls every WebM a video, so one declared as sound is
  taken as sound. The app shows one named `Voice message.webm` as a voice
  message. Nothing on the wire changes.


## Decided — being in a room's voice is being in that room

**Matt, 2026-10-04 (#420).** A friend talking in #general's voice with a game in
front of him had Linger behind it, so the 90-second clock took him out of the room
and the ten-minute one made him idle: #general showed voice bars and no dot for him,
and People said "idle" while he talked. That's backwards; being in a room's voice is
the most present anybody is.

- **His dot shows on the room for as long as he's in its voice**, and People says
  "in #general". Idle doesn't apply while he's in a room's voice. An away he chose
  still shows, because he said so.
- **Reading another room while talking in one, he's in both** (Matt's call). Both are
  true. People names the room he's talking in.
- **It's drawn, not sent.** Every app already gets the server's voice lists, so the
  list counts them (`occupantsOf`, `shownState` in `lib/roster.ts`); no presence frame
  changes, nothing on the wire changes, and it works for people on older apps, since
  only the one looking needs the update.
- **A DM's voice isn't a room.** Being in a DM is being around (§4.13), so a DM call
  doesn't put anybody "in" anything.

## Decided — the host can take somebody out of voice

**Matt, 2026-10-04 (#423).** A friend walked away from his desk with his headset on
and unmuted; in a bigger room a blaring microphone like that takes the call over, and
all anybody could do was turn him down for themselves.

- **The host takes somebody out; nobody mutes anybody.** Matt chose taking out over a
  Discord-style server mute: it ends the problem, can't leave anybody stuck muted, and
  keeps "nobody can turn your microphone on". Their app leaves the call as if they'd
  pressed Leave and says the host took them out. Not a ban: they can join again.
- **From the voice bar or their card.** Their chip's volume card has **Take out of
  voice** for the host, and so does their card's **···**, which works when the host
  isn't in the call.
- **Older apps can't bounce back.** The server ends the person's seats and announces
  the room's `voice.state` without them; every app since 0.4.1 leaves on that, and a
  restart without a seat is ignored. The new `voice.removed` only says why.

## Decided — a co-host, for when the host is away

**Matt, 2026-10-04 (#424).** This reverses part of "No host transfer" (*the
host's side*, 2026-08-21). When the host is away, nobody else can handle a
report, take somebody out of voice (#423), or remove somebody who shouldn't
be there. "Stand up a new server" is too big an answer for a week's holiday.

- **One switch per person, `is_cohost`.** Only the host turns it on or off,
  from the person's card. Never on the host, never on yourself. The host
  stays the host: `is_host` still can't be handed to anybody.
- **A co-host can do everything the host does in the app:** rooms (make,
  edit, archive), the server's name and color, reports, removing and
  restoring members, deleting messages, revoking invites, and taking
  somebody out of voice.
- **Two exceptions, and only two.** A co-host can't make or clear co-hosts,
  and can't act on the host: remove them, take them out of voice, delete
  their messages or revoke their invites.
- **Reports go to the host and every co-host, except a report about a
  co-host, which that co-host never sees or closes.** The person reported
  isn't told, so they mustn't learn who reported them; the host sees every
  report, so none goes unread.
- **Running or updating the server machine** stays with whoever runs it.
  The app has nothing to do with that, so the server's version in Settings
  is the host's alone.
- **Taken out of voice, the strip says "You were taken out of voice."**
  rather than "The host took you out" (#423), since a co-host may have.
- **Removing a co-host ends it.** Letting them back in brings back a member,
  as a restore never undoes everything (*the host's side*, above), and only
  the host can make them a co-host again.

This is one switch with a fixed meaning, not roles. The anti-goal "a
role/permission matrix" (SPEC §2) still stands, and this must not grow
toward it: no other levels, no per-power switches, no second kind of
co-host. A request for any of those is the matrix in its first disguise.


## Decided — a voice room holds a raid: 60, and silence isn't sent

**Matt, 2026-10-04 (#197).** A WoW raid of 40, about 50 in one voice room, in a month,
on Matt's DigitalOcean droplet (1 vCPU, 2 GB, New York).

- **Silence isn't sent.** Every app used to send 50 packets a second of silence
  (muted and push-to-talk included), and the server copied each to everybody: at 50
  people about 120,000 packets a second through one thread. Discord's apps send only
  while you talk (five silence frames, then nothing), and now Linger's do too: Opus DTX
  on the live-voice encoder, and its "still here" frames left unsent as well. Listeners'
  talking lights go out after the usual 300 ms pause with nothing arriving.
- **60 a room**, and the answer to the server's offer may be 128 KB: it grows a few
  hundred bytes for every other person, and at 50 a stand-in's was 42 KB, past the old
  16 KB, which would have shut the last people into a raid out.
- **The forwarding loop takes every waiting packet in one turn** and gives the time only
  to connections that are due; it used to walk every connection for every packet.
- **A bug the load test found: a room filling at once could cut somebody off.** `str0m`
  names each new m-line with a random three-character mid and checks it against the
  agreed ones only, not the others in the same offer. A newcomer's first offer adds one
  for everybody there, so at raid size two sometimes matched, the app refused the offer
  as reordered, and that person heard nobody: about one 60-person join in ten. The
  server now throws such an offer away and draws again (`negotiate`); 40 joins of 60
  without one since, and `a_room_filling_at_once_never_names_an_m_line_twice` checks
  every offer.
- **Measured** (`crates/linger-sfu/tests/load.rs`, on a fast desktop core): 50 people
  with 3 talking went from 74% of a core and 68% heard to 24% and all heard with
  silence unsent, and 10% with the loop change; 60 with 5 talking, 17% and all heard. The droplet's shared core is slower: a test against it decides whether raid
  night wants a temporary second core.
- **Measured against a droplet** (2026-10-05, `crates/linger-server/examples/voice_load.rs`):
  a throwaway `s-1vcpu-2gb` in nyc1, the plan the raid's server is on, running the
  server in Docker, with 50 stand-ins on a home desktop reaching it over the internet
  through sign-up, the gateway and UDP. Its shared core is about eight times slower per
  packet than the desktop's: 50 people with 1 talking took 66% of it, 3 took 81%, 8 took
  97%, and packets ran late whenever a neighbour on the same host took CPU. `perf` put
  nearly all of it in `str0m`'s bookkeeping per m-line; each connection carries one
  m-line per other person, so every packet passed on is a walk over fifty.
- **Three changes to the forwarding loop**, each measured on that droplet (50 people,
  1 / 3 / 8 talking, share of the core):
  - Only connections something reached are asked what they have to send: 66 → ~50,
    81 → 76, 97 → 96.
  - A connection asking for a moment already past is given the time at once, in the
    same pass. Without bandwidth estimation `str0m` sends one packet and then asks for
    exactly that, and it turns voice handed to it into packets only when given the time,
    so it gets the time once before it is asked: → 37, 62, 88.
  - **Nothing is held back past a gap** (#438). By default `str0m` held a voice for up to 15
    packets (300 ms) after a missing one, waiting for it, so one packet lost on a
    talker's way in stopped them for the whole room and then arrived in a lump the apps
    could only throw away. At 60 people with 8 talking the server fell into it and
    stayed there: 78% heard, a steady 300 ms late, a sixth of what came in dropped.
    `set_reordering_size_audio(0)` makes that 99% heard and 80 ms (the trip from the
    desktop and back alone is 48 ms). Each app's own buffer covers gaps and reorders.
- **Where that leaves one shared core**: 50 people with 3 talking about 65%, with 8
  about 90%; 60 with 8 talking 96% and 5% of packets late. Ten people on an app from
  before 0.4.9, sending silence, take 50 with 3 talking to the limit (95% heard), so a
  raid wants everybody updated. Bigger droplets measured with the first two changes:
  the forwarding is one thread, so a second core only takes the kernel's share of the
  work; premium AMD (`s-1vcpu-2gb-amd`) ran it about 15% faster than the regular core.

## Decided — voice sounds better: 128 kbit/s up to twenty, 96 from twenty-one

**Matt, 2026-10-04 (#431, part of #197).** Friends asked for better-sounding voice. Live
voice let Opus choose its own rate, about 51 kbit/s; voice messages were already 64.

- **The forwarding server's work doesn't depend on quality**, only on how many packets
  it passes on, since it never opens them. Measured with 50 people and 8 talking at once
  (`load.rs`, a desktop core): 16% at 64k, 15% at 96k, 21% at 128k, everybody heard in
  full each time.
- **What quality costs is the host's upload**: talkers × listeners × rate, about 150
  kbit/s a stream on the wire at 128k and 120 at 96k. Twenty people with eight talking at
  128k is about 23 Mbps; fifty at 96k, about 46; fifty at 128k would be about 59.
- **So: 128 kbit/s up to twenty, 96 from twenty-one, back to 128 at sixteen.** Twenty
  covers every ordinary evening at the better quality; a raid gets more than Discord's
  default 64, at a cost a droplet carries. The gap between twenty-one and sixteen keeps a
  room filling before a raid from flipping with every arrival. Matt asked whether 96 was
  possible past twenty rather than 64; it was, since the server's CPU is the same either
  way and the bandwidth fits.
- **The server decides, per room, on the offer.** A room's size changes only when
  somebody joins or leaves, and both already send everybody a new `voice.offer`, so the
  rate rides on it. Nobody sets it, and nothing shows it. Opus changes rate between one
  packet and the next, so nobody hears a room change.
- **Old apps and old servers are unaffected**: an app before 0.4.9 ignores the field and
  sends at Opus's own rate; a new app on an old server gets no field and does the same.
  An app never sends above 128 kbit/s or below 16, whatever a server asks.
- **Silence still isn't sent at the higher rates**: Opus encodes them differently, so
  that was checked rather than assumed (`at_every_room_s_quality_talking_is_sent_and_silence_isn_t`).

## Decided — hosting from one settings file and a setup script

**Matt, 2026-10-05 (#440, part of #81).** Setting a server up meant editing
three files, typing the machine's IP in for voice, and running a `chown` whose
purpose nobody could guess: every one a place a first-time host went wrong.

- **Every setting lives in `.env`.** `compose.yaml` hands it to the server
  (`env_file`) and the Caddyfile builds its two names from `{$LINGER_DOMAIN}`,
  so a host never edits either, and a newer copy can replace the old one. An
  older `compose.yaml` with its settings inline keeps working; nothing makes a
  host move.
- **`deploy/setup.sh`** asks for the name and whether to run the relay, checks
  both names point at the machine before writing anything, writes `.env` with
  a fresh relay secret and a file pool that fits the disk, opens `ufw`, says
  which ports to forward when a router or a cloud network sits in front, starts
  the server and prints the setup link. It refuses a folder that already runs a
  server. It asks `api.ipify.org` for the public address, as the host guide
  already told hosts to do by hand; that is the one outside service it uses.
- **Voice's address comes from the domain.** Unset, the server looks
  `LINGER_DOMAIN` up once at startup and uses its first public address: the
  host already pointed the name at the machine. Private addresses are never
  chosen. The setting still wins, and `off` turns voice off on purpose. **This
  changes existing servers**: one with a domain and no voice address gets
  voice after updating to 0.4.9, which the release notes and `update.sh` say.
- **The image fixes its own data folder.** It starts as root only to give
  `/data` to `linger`, then runs the server as `linger` through `setpriv`;
  `reset-password` comes through the same door, so nothing is ever written as
  root. Starting as root at all was the cost, and dropping it straight away in
  a short, readable script is the usual way to pay it.
- **The deploy files on `main` still work with the image that's out.** The host
  guide downloads them from `main`, so they can't wait for a release:
  `setup.sh` writes the voice address and runs the old `chown` itself on a
  server image from before 0.4.9.

## Decided — every emoji, Discord's shortcodes, and a server's own emoji

**Matt, 2026-10-05 (#359).** "A lot of my favorite emojis are missing… look at
what Discord is doing", with `:smiley:` shorthand, and hosts able to upload
their own, "not too much friction where people will never use it." Custom emoji
were on SPEC §6's "V3 or never" list; this is Matt's go-ahead, and §4.8, §4.17
and §6 change with it.

- **Every Unicode emoji, drawn by the system's font.** 1,914 of them (330 with
  skin tones), from Emojibase by `client/scripts/emoji-data.mjs`: about 245 KB,
  60 KB compressed, loaded the first time the picker or a `:` wants it. Bundling
  Discord-style pictures (Twemoji) would draw them the same everywhere but costs
  several MB, past AGENTS' 2 MB line, so it's not done (Matt: emoji looking a
  little different on each computer is fine, and the pictures would be bloat);
  an emoji too new for this computer's font is left out of the picker instead
  (`lib/emoji/support.ts` draws one emoji of each Unicode version on a canvas to
  find out).
- **Discord's names.** Discord took EmojiOne's shortcodes, which Emojibase keeps
  as JoyPixels'; GitHub's and Slack's are aliases. A finished `:smiley:` becomes
  the emoji in the box, so a message holds the emoji; a `:name:` that reaches a
  message anyway (typed before the list loaded, from an older app) is drawn as
  the emoji too.
- **A server's own: the host or a co-host adds, everyone uses.** No new kind of
  person: the same two who run the server's other Hosting sections. Upload is
  the ordinary upload path, so the server sniffs and re-encodes the picture as it
  does every image (GIFs stay animated, frame by frame); `POST /emoji` makes a
  finished upload into an emoji. Limits: 200 a server, 256 KB and 512 px a
  picture, names `[a-z0-9_]{2,32}`. The app shrinks a still picture to 128 px
  first and names it from its file, so adding one is choosing a file.
- **The message keeps `:name:`.** Search, export and notifications see the
  name; a removed emoji reads as its name; another server's app never draws
  this server's pictures. A custom emoji with a built-in's name wins on its
  own server.
- **A few emoji and nothing else are drawn big** (up to 27, as Discord does),
  a quarter smaller than first built: 30px glyphs and 36px pictures (Matt).
- **On the phone the picker spans the message box**, its emoji a finger's
  44px as everything tapped there is, as many across as fit; and it leaves
  the keyboard down until Search is tapped, since the keyboard would cover
  half of it.
- **Both ways across versions (#315).** An app from before ignores
  `emoji.update` and the new `ready` field, and shows a server's `:name:` as
  the words. A new app on an older server finds no `emoji` in `ready`, and its
  host's Settings → Emoji says to update the server rather than offering an
  add that would fail.
- **Not reactions**, while #168's trial has them out, and **never for sale**.

## Decided — the voice bar and the list at raid size

**Matt, 2026-10-06 (#197).** Chosen from mockups at real size of a 63-person server with
48 in one voice room (a private canvas, linked from #197). Before this, a voice bar of 48
would have been 48 chips, about 500px of a 900px window, and People 52 two-line rows.

- **The voice bar: seats and a crowd** (option A of two). Up to six people, nothing
  changes. Past six, six seats: you, then whoever just talked (`core/seats.ts`). A seat
  changes hands only when somebody without one starts talking, and goes to whoever
  spoke longest ago and isn't talking, so a chip never moves while its person talks and
  a seat stays with whoever just finished until it's needed. Everybody is a 6px marker
  in the crowd under them, ringed in the lamp while they talk (`MarkerCrowd`), and the
  crowd opens everyone by name, alphabetical, with a search box; picking somebody opens
  their volume card. Option B, everyone in a fold inside the bar, was turned down: open,
  it pushes the list up.
- **The voice line in a conversation** uses the same seats in the room you're in, with
  the chips it has room for. In a room you're not in, who's talking isn't known (you hear
  only your own room), so it shows the people you talk to first (`talkingFirstIds`).
- **The list: your people, then everyone else** (option B of three). Past twelve people
  here or away (`PEOPLE_SHOWN`), People shows the people you talk to (anyone whose DM
  with you has anything in it), here then away, and everyone else folds under
  "Everyone else" (`splitPeople`). Matt's reason: on raid night the busy room's own row,
  its dots and its talking, is what should show a full room and pull people in, not a
  sub-group of names under People. Turned down: grouping People by place (the room's
  crowd as its own folded group), and one line each with nothing folded.
- **A room's row shows up to sixteen dots**, up from five, as a folded server's header
  already does, so a full raid looks full. Still no number.
- **One line per person** is a setting in Settings → Appearance, off to start (Matt:
  some people will want a more minimal view). This is SPEC §4.7's one exception to "no
  Density setting", for the list only: conversations keep one layout. A person's status
  shows in a tooltip and in their row's accessible name. The phone keeps two lines.
