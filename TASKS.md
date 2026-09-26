# TASKS.md — the running work queue

This file is the handoff surface between the architect session (which maintains
structure and this file) and implementation sessions — run by any contributor,
with any coding agent. It is a live document: claim tasks, check them off, add
discoveries, and keep it truthful.

Tasks are marked **⬜ not started**, **⏳ claimed** (name + date), or **✅ done**
— emoji, not markdown `- [ ]` checkboxes, so the state of the queue is visible
at a glance while scrolling. Use the same characters when you add or move a task.

Task numbers match the milestone: T-5xx is M5, T-6xx is M6, and so on. Work that
is still V1 but not on the critical path lives at the end as T-9xx (sounds) and
T-90x (entrance sounds). A 2026-08-23 renumber moved old M6–M9 to M5–M8 and
entrance sounds T-403/404/408 to T-901/902/903. The T-911…T-917 band was
activity detection; it was cut on 2026-08-28 and those numbers are retired
rather than reused.

**This file stays small on purpose.** Every fresh session reads it, so finished
history does not live here: when a milestone passes its check, the architect
moves its section — landing notes and all — to `docs/tasks/`. Those notes are
the project's memory; read an archive when a task below points at it, not by
default.

## How to run a task

**0.4.0 release — ⏳ Matt, 2026-09-26.** The Buddy list client (M15, #198)
becomes the app; today's client stays one release behind `LINGER_CLASSIC=1`.
Notes in `docs/releases/0.4.0.md`. Earlier releases' notes, with what each
closed, are in `docs/releases/`.

Any coding agent (or human) can run a task — the repo is tool-agnostic. Every
agent's contract is `AGENTS.md`; tools that insist on their own filename get a
pointer (`CLAUDE.md`, `QWEN.md`, `GEMINI.md`), and tools that read `AGENTS.md`
natively need nothing. **One task per fresh session** — a clean context follows
the task spec better and costs less than a long-running one. The prompt that
works in every tool:

> Read AGENTS.md and TASKS.md, then do task T-xxx. State the current milestone
> first.

1. **Check for existing work, then claim the task**: for a GitHub issue, inspect
   its linked PRs before starting another fix. Push a branch named
   `feat/t-xxx-short-slug`, and in
   your first commit flip the task here from ⬜ to ⏳ with your name and the
   date. That is how two people avoid building the same thing. If a task has
   been ⏳ for over a week with no branch activity, ask in the PR or ping Matt
   before taking it over.
   When opening a PR, formally link each issue it proposes to resolve and verify
   the links, as required by `AGENTS.md` §"Pull requests and issues".
2. Pick your model and effort from the task's label using the table below.
3. Read `AGENTS.md` in full, then the spec sections the task references. State
   the current milestone before writing code.
4. Do not start a milestone until the previous one passes its check
   (`ARCHITECTURE.md` §10). Do not pull work from a later milestone "while
   you're in there."
5. When done: all listed acceptance criteria pass, `scripts/check.sh` is green
   locally, CI is green after push, the task is flipped ⏳ → ✅ here with a
   dated landing note, and any surprises are recorded under the task. The
   landing note is not optional — it is what makes the next fresh session work.
6. **Never add AI attribution anywhere — no exceptions, ever.** Not in commits,
   not in comments, not in metadata, not in the PR. The author of a commit is
   the person who ran the session, under their own git identity. A model is a
   tool, and tools do not sign work. Whatever agent you use, turn off its
   attribution trailers and PR footers; CI rejects what slips through.

**Effort mapping (task label → what to run it with):**

| Task label | What it needs |
|---|---|
| **low** | Any capable model at its default setting. Mechanical and tightly specified — a frontier model at max effort just burns money re-deriving what the task text already decides. |
| **medium** | A frontier model at its normal setting. Real features with judgment in the details. |
| **high** | A frontier model at a high-reasoning setting. Cross-cutting, but the architecture docs carry a lot of the load. |
| **treacherous** | The strongest model and highest reasoning setting available to you, and coordinate with Matt before claiming. AGENTS.md §"Where you will be wrong" territory: T-705 (signing,
blocked on certificates), T-1402 (real-time audio) and T-1604 (app stores). |

**If you are running Claude specifically**, this is the mapping. The label on
the task is still the source of truth — it is vendor-neutral so that any agent
can run this queue — and this table is just how to read it with today's Claude
models:

| Task label | Claude model | Thinking effort |
|---|---|---|
| **low** | Haiku 4.5 | default |
| **medium** | Sonnet 5 | normal |
| **high** | Opus 5 | high |
| **treacherous** | Opus 5 | maximum |

Two ways to waste money here, and they cost about the same. Running a **low**
task on Opus at maximum effort burns tokens re-deriving decisions the task text
already made. Running a **high** task on Haiku produces something that compiles,
passes the tests it was told to write, and is wrong in the way that only shows
up with four clients on three networks. Match the label.

Running everything at maximum is not better — it is slower, pricier, and prone
to overbuilding simple tasks. Match the effort to the label and escalate only if
a task fails its acceptance criteria twice.

---

## Status

**M12 (voice) is built, and every release check closed on 2026-09-25.**
**M15, the Buddy list client (#198), is the app from 0.4.0**; what's left of it
is under [M15](#m15--the-buddy-list-client-198). M13 (ambient voice) is planned
and not started, and larger groups and the voice rework are #197.

Closed milestones are archived in `docs/tasks/` with every landing note and
surprise intact. Tasks T-001…T-604 live there. Decisions that shaped the queue
(the password floor, no host transfer, removal not banning, storage knobs as
environment variables) are in [`docs/decisions.md`](docs/decisions.md).

| Milestone | Closed | What stands | Archive |
|---|---|---|---|
| SPIKE + M0 — scaffold | 2026-08-19 | Workspace + CI; shell opens on all three OSes; both activity spikes retired with zero title exposure; `oklch()` gate answered yes | [m0.md](docs/tasks/m0.md) |
| T-006 — vocabulary | 2026-08-19 | The coined words are gone from code, UI, and docs | [t-006-vocabulary.md](docs/tasks/t-006-vocabulary.md) |
| M1 — server REST | 2026-08-19 | Auth, setup, invites, rooms, messages, styling, statuses; every endpoint integration-tested over real HTTP | [m1.md](docs/tasks/m1.md) |
| M2 — gateway | 2026-08-19 | WS with heartbeat, presence, typing; forced-disconnect resume with no gaps and no duplicates | [m2.md](docs/tasks/m2.md) |
| M3 — client: message stream | 2026-08-21 | Sign-in that sticks, live stream across two clients, 10k-message scrollback virtualized, composer, catch-up | [m3.md](docs/tasks/m3.md) |
| M4 — presence, roster, statuses | 2026-08-21 | The roster moves live; in-room/away/idle mechanics; the status card | [m4.md](docs/tasks/m4.md) |
| M4.5 — the shell's missing surfaces | 2026-08-25 | Host controls, invites, member settings, server list, remove + re-admit, password reset, live member announce | [m4-5.md](docs/tasks/m4-5.md) |
| M5 — uploads, media, the grid | 2026-08-26 | Resumable uploads on local or S3, files served from their own origin, the media grid with stars and link cards, expiry + a storage ceiling, the status image | [m5.md](docs/tasks/m5.md) |
| M6 — styling, themes, fonts | 2026-08-27 | Names drawn from custom properties, the two-click style picker, dark/light/system + evening warmth, twelve faces vendored — contrast ≥4.5:1 guarded in CI against four backgrounds | [m6.md](docs/tasks/m6.md) |
| M7 — packaging and updates | tasks 2026-08-27 | Signed updater behind two Rust commands, tag → draft release with Linux and Windows installers, the shipped CSP permits HTTPS/WSS and blocks remote scripts and fonts, the server image publishes to ghcr for x86-64 and ARM64. **Its check passed in real use on 2026-09-25** (HC-1) | [m7.md](docs/tasks/m7.md) |
| M8 — export | tasks 2026-08-28; HC-5 passed 2026-09-08 | Real desktop controls handed the archive to a browser; the downloaded room, image and DM filtering were verified independently | [m8.md](docs/tasks/m8.md) |
| M9 — knock | tasks 2026-08-29 | `POST /knock` addressed to one person's sessions, a card that fades on its own, the sound player the entrance sounds will extend. **Its check passed in real use on 2026-09-25** (HC-6) | [m9.md](docs/tasks/m9.md) |
| M10 — search | 2026-08-31 | An FTS5 index kept by triggers, `GET /search` with no query language to trip over, and a destination in the rail that lands you on a hit six months back — `around=` on the messages endpoint, and a room that knows when it is behind its own newest message | [m10.md](docs/tasks/m10.md) |
| M11 — DMs and group DMs | 2026-08-31 | A DM is a room with members: create-or-find on a canonical member key, a gateway fan-out that filters every frame naming a room, and a membership condition folded into every query that lists messages, files or search results. **Its two-machine half passed in real use on 2026-09-25** (HC-7) | [m11.md](docs/tasks/m11.md) |

**Release evidence:
[Release checks](#release-checks--desktop-and-real-world-evidence), at the
bottom of this file.** All nine closed on 2026-09-25, from real use of the
published app. Two parts were not tried and are named there: HC-3's 400 MB
video, and HC-9's phone hotspot and four-person hour, which move to #197. The
full steps are in [`docs/tasks/release-checks.md`](docs/tasks/release-checks.md)
for re-running.

**The one thing that bit us in T-301:** a webview page is a cross-origin caller,
so the server had to start sending CORS headers before the client could read a
single response. The allowed origins are a fixed list in
`crates/linger-server/src/routes/mod.rs`. The gateway WebSocket is *not* subject
to CORS and T-302 confirmed that — but if a future browser-side call mysteriously
"can't reach the server", that list is the first place to look.

One decision styling no longer has to make: **use `oklch()` directly** —
WebKitGTK 2.52.3 supports it (T-002).

What already exists (do not rebuild): workspace + CI; `linger-core` with typed
UUIDv7 ids, the full REST + gateway wire contract, palette/fonts/reactions/limits,
ts-rs export to `client/src/generated/` (committed, drift-checked in CI);
`linger-server` with config/env, WAL SQLite with **single-writer pool discipline**
(`db.write` is a 1-connection pool — keep it that way), migrations (full §5 schema),
error envelope, health route, integration-test harness pattern
(`crates/linger-server/tests/health.rs` — copy its `spawn_server` shape);
Tauri 2 shell with the Console-token M0 frame; deploy files.
M5 adds the whole of uploads (see [m5.md](docs/tasks/m5.md)): the `ObjectStore`
trait with a local and an S3 backend, resumable part uploads, the complete step
that re-encodes and sniffs, `GET /media` with keyset paging, link cards behind
an SSRF guard, the expiry sweeper, and the status image.
M6 adds the whole of styling (see [m6.md](docs/tasks/m6.md)): `palette.generated.css`
written out of `linger-core` by a unit test and drift-checked like the bindings,
names painted from `--person-*` custom properties in `styles/names.css`, the
style picker, theme + evening warmth as attributes on `<html>`, and the twelve
faces vendored under `client/src/fonts/` — **never write a hex or `oklch()`
literal into the frontend, and never add a remote font URL.**
M8 adds the export (see [m8.md](docs/tasks/m8.md)): `POST /export` and `GET /export/:job_id`,
the archive written on a blocking thread and served from the media origin like
any other object, and `repo::messages::batch_ascending` for walking a room
forwards. The settings surface's HC-5 passed on 2026-09-08.
M7 adds the release path (see [m7.md](docs/tasks/m7.md)): the signed updater
behind two narrow Rust commands, `release.yml`, `image.yml` publishing the
server to ghcr on a tag, the four-file version check and `signing-preflight`,
and a shipped CSP that requires HTTPS/WSS for remote connections — which is
why **a server needs a name; a bare `IP:port` is unreachable from anything
anybody installed**, and says so at startup. **Updates are signed; installers
are not** — that is a decision, not a gap
([`docs/decisions.md`](docs/decisions.md)), and macOS is deliberately not built
at all until T-705.
M9 adds knock (see [m9.md](docs/tasks/m9.md)): `POST /knock` addressed to one
person's sessions, the fading cards, and `lib/sound.ts` — the player entrance
sounds will extend.
M10 adds the whole of search (see [m10.md](docs/tasks/m10.md)): the `message_fts`
index kept by triggers in `0004_search.sql` (**nothing in Rust writes to it**),
`GET /search` over `repo::search` with the query rebuilt rather than forwarded,
and `client/src/search/` — the rail destination, `Ctrl`/`Cmd`+`K`, and landing on
a hit. Two pieces of it belong to the stream rather than to search and are worth
knowing before touching either: **`around=` on `GET /rooms/:id/messages`**
(PROTOCOL §4), which fetches a window centred on one message, and
**`RoomStream.atEnd`**, which is false while a room is showing one of those
windows — live message frames for such a room are *dropped*, because folding
today's message into a February window makes a gap nothing can see. If you are
changing how history loads, read `openAround`, `loadNewer` and `leaveWindow` in
`lib/gateway.ts` first.
M11 adds DMs (see [m11.md](docs/tasks/m11.md)), and it is the one that changed
rules the rest of the server had been relying on. **Every frame naming a room is
filtered by that room's membership**, and `room_of` in `gateway/mod.rs` has no
wildcard arm so a new frame type will not compile until somebody says whether it
names one — do not add a `_ => None` to make it build. **Every query that lists
messages, files or search results folds in
`repo::rooms::visible_rooms(alias)`**, in the `WHERE` rather than as a check
afterwards; `media::Query` and `search::Query` both require a `viewer` for the
same reason. A DM is a room with members — same tables, same endpoints, same
everything downstream of `room_id` — so **do not build a parallel structure for
it**, and do not add a way to change who is in one: a different set of people is
a different DM.

---


## V1 polish — small changes after the milestones closed

Not a milestone and not a backburner: one-off changes to V1 surfaces that came
out of using the app. Each one is small enough that it lands in a single session
with its note written here. The closed ones are archived in
[`v1-polish.md`](docs/tasks/v1-polish.md).

Since 0.4.0 the Buddy list client is the app, and today's client gets bug fixes
only. A task below that names the old client's screens applies to the new one
where it still makes sense, and is otherwise closed with a note.

- ⏳ **T-925 · Use the selected app icon on every desktop surface** — effort:
  **medium** — Matt, 2026-09-17. The running Windows app was reported without the chosen icon;
  the affected surface and cause have not been reproduced yet. Audit the
  existing porch artwork through bundle configuration, packaged assets and
  installed behavior. Check the app window, taskbar/dock, launcher/Start menu
  and installer for each supported package; do not design a replacement icon.
  *Accept:* record Windows and Linux results, including the Omarchy AppImage,
  with package/version and the surface checked. Distinguish incorrect assets
  or app identity from stale OS icon caches. Check macOS when a distributable
  build is available; do not claim a platform passed from source inspection.

  **PR #77 merged 2026-09-17; installed-surface acceptance open.**
  Published v0.1.0 predates the porch artwork;
  its AppImage and Windows application still contain the old icons. Explicit
  NSIS installer/uninstaller icons were also missing, and the Linux window
  selected only the 32-pixel PNG. The configuration now uses the porch ICO for
  both installer surfaces and a 256-pixel Linux window icon. All six source
  formats regenerate correctly; Debian/RPM/AppImage resources and Windows
  NSIS/MSI application, installer/uninstaller resources pass. Installed
  Windows shortcuts target the correct executable. Its running caption icon
  matches the approved 32-pixel PNG exactly; the actual Linux AppImage window
  matches the 256-pixel PNG on both backends. CI runs and remaining real
  launcher/taskbar/cache checks are recorded in
  [app-icon-checks.md](docs/app-icon-checks.md); no release has been published.

- ⏳ **T-929 · Evaluate native Wayland for packaged Linux input** — effort:
  **high** — Matt, 2026-09-17. T-928 isolates wtype corruption to XWayland; the current AppImage
  startup hook forces X11 as a graphics compatibility fallback. Evaluate a
  supported per-launch native Wayland option before changing that default.
  *Accept:* test actual packaged startup, typing, paste, graphics and updates
  on Wayland and X11, including a machine that needs the GBM workaround.
  Preserve a working fallback. Do not claim system-WebKit fixture results
  prove an AppImage works; see `docs/linux-input-checks.md`.

  **Implementation ready; field acceptance open, 2026-09-17 (PR #78).**
  `LINGER_LINUX_BACKEND=wayland|x11` applies after the AppImage launcher and
  preserves the default X11 fallback. An actual CI-built AppImage preserves
  synthetic typing and Unicode paste on Wayland; explicit/default X11 still
  reproduces the typing defect and preserves paste. Both render under the
  isolated software compositor; invalid options fail before GTK starts.
  Package hash, method and remaining checks are in
  [linux-input-checks.md](docs/linux-input-checks.md). Spoken input, physical
  paste, hardware graphics and a signed update remain unclaimed. No system
  packages or global desktop settings were changed; no release was published.

- ⏳ **T-933 · Clean notification onset and complete knock playback** — effort: **high** — Matt,
  2026-09-22. GitHub #94 and #95: investigate the short crackle and clipped
  two-tap knock reported in 0.3.1,
  comparing Preview and live playback with the clean reference clips. Check
  startup/resume, repeated playback and scheduling before changing the score.
  *Accept:* capture the onset, add a regression check for the confirmed fault,
  run the shared player on Linux and Windows, and confirm by listening on the
  affected installation. Verify both knock taps, spacing and complete decay.
  Matt requested one combined fix/build for both reports. Package output alone
  does not prove listening quality.

  **Correction implemented 2026-09-22.** The existing score renders into cached
  buffers with 50 ms of silent leading samples. This preserves the attack when
  the output starts; buffering alone did not fix the reproduced onset loss.
  First/repeated Preview, delayed setup, received-event playback and Preview
  after idle pass the Linux virtual-speaker checks for DMs and knocks. Both
  knock taps retain their decay and 140 ms spacing. The full local gate passes; Chromium
  checks preserve all twelve scores at 44.1/48 kHz. Linux/Windows package CI and
  affected-installation listening remain required before closing #94/#95. See
  [capture method and limits](docs/packaged-audio-checks.md).

- ✅ **T-907 · Open healthy servers while another is unavailable** — effort:
  **high**
  `useSessions` waits for all saved servers, and the HTTP client has no request
  deadline. Failed servers disappear for that launch. Restore each server
  independently, retain an unavailable entry with a retry action, and keep its
  saved sign-in unless explicitly rejected. Do not add an offline database.
  *Accept:* with two saved servers and one stalled response, the healthy one
  becomes usable within a bounded time. The other can recover without restart
  or re-entering credentials. Test token rotation and React StrictMode so no
  saved token is spent twice. **Decided 2026-09-26 (parity decision 21):**
  fix it, in the Buddy list client's list window. **Done:** every request
  already had a 30-second deadline (#118); the wait was `Promise.all`. Each
  server now restores on its own, the list opens when the first is in (5 s at
  most), and one that can't be reached stays as a line with Try now and
  retries on its own (5, 15, 30, then every 60 s).

- ✅ **T-908 · Pin a message from the conversation** — effort: **medium**
  Use the existing pin/unpin endpoints and message action strip; indicate the
  saved state and report failures without losing it. No new wire fields.
  *Accept:* pinning in one client appears in another and in media's pinned
  filter; unpin removes it. A DM's pin remains invisible to non-members, and
  pinned attachments retain the existing expiry protection. Read M10 and M11
  notes before touching history or visibility. **Decided 2026-09-26 (parity
  decision 21):** build it in the Buddy list client, as Pin in the message menu.

- ⬜ **T-910 · Measure the release's size and running cost** — effort: **medium**
  Record installer size, cold launch time, total process memory and idle CPU
  on Windows and Linux; include WebView processes. Repeat after an extended
  session with several rooms and during four-person voice. Check how retained
  message history grows; virtualization alone does not bound it.
  *Accept:* versioned measurements with hardware and method, explicit future
  regression budgets, and any observed growth recorded as a focused follow-up.
  Do not change history storage without first reading M10's notes.

- ✅ **T-921 · Show a private room's occupants as around to outsiders** — effort:
  **medium**
  T-918's third native client receives the documented `in_room` presence with
  `room_id: null`, but renders “in a room” instead of HC-7's “around”. The
  conversation's contents and identity remain hidden. Review the M11 notes
  and PROTOCOL §8 before changing this; keep initial presence and live updates
  consistent, including accessible labels and name popovers. Any protocol
  clarification must preserve compatibility with existing clients.
  *Accept:* an outsider sees the same ordinary around presentation while two
  people use a DM; its members still see their conversation normally.
  **Decided 2026-09-26 (parity decision 21), wider than first written:** being
  in a DM shows as "around" to **everybody**, the DM's own people included, so
  nobody sees that you're DMing, let alone with whom (the old client named
  them). Your own card can still say where you are.
  **Done 2026-09-26:** the server rewrites presence for anybody in a DM to
  `around` with no room, for every receiver, and sends no enter, leave or
  occupancy for DMs; the list shows an older server's in-a-DM entry as around
  too.

---

## M15 — the Buddy list client (#198)

**In progress on `feat/198-buddy-list`, started 2026-09-25.** Matt chose the
Buddy list design and asked for the client to be rebuilt around it as
intentionally crafted software: long-term stability, easy maintenance and
thorough tests. It is built next to today's client, in `client/src/next/`, and
opens only behind a hidden switch until it can do everything the old one does.
The released app keeps shipping from the old client until the switch.

Read these before touching it, in this order:
1. [`docs/design/buddy-list.md`](docs/design/buddy-list.md): the design.
2. [`docs/design/architecture.md`](docs/design/architecture.md): code layout,
   window roles, shared state, tokens, tests and build order.
3. [`docs/design/system.md`](docs/design/system.md): tokens, the kit and the
   rules the tests enforce.
4. [`docs/design/lessons.md`](docs/design/lessons.md): what the first client
   taught us, each lesson a rule with a check.
5. [`docs/design/parity.md`](docs/design/parity.md): the gate for switching.

Rules for this milestone:
- **New-client code lives in `client/src/next/`.** It reuses the shared core
  in `client/src/lib/`, `client/src/generated/` and `client/src/fonts/`. It
  never imports the old client's UI (`discipline.test.ts`).
- **Screens are built only from the kit.** A size, color or spacing that the
  tokens don't have is a change to the tokens and `system.md` first.
- **The old client is frozen:** bug fixes only, no features.
- **SPEC §3 and §5 still describe the shipping client.** They are rewritten
  from `system.md` at the switch (T-1810), not before.

- 🟡 **T-1801 · Foundations** — the design docs, tokens, the kit, the gallery
  (`tests/fixtures/kit.html`), and the discipline, contrast and geometry tests.
- 🟡 **T-1802 · The switch and the owner window** — the shell opens
  `next.html` as `main` (`LINGER_CLASSIC=1` for today's client, one release). It signs in with the existing sessions and shows real
  rooms, DMs and people from the kit. Signed in nowhere, it opens on its own
  sign-in screen (paste box, sign in, join from an invite, first-run setup;
  decision 16's default). "Add a server" in Settings shows the same screen in
  the list window. Tested against faked servers; not yet tried in the
  desktop app.
- 🟡 **T-1803 · The chat window** — the `chat` window with tabs, the catch-up
  protocol, borrowed tokens, and reading, sending and history in a tab. Built
  and tested against a faked owner and server; not yet tried in the desktop
  app against a real server.
- ⬜ **T-1804 · Voice** — the voice bar, the room strips, and "move voice here"
  as an intent. Tabs and windows never leave voice.
- 🟡 **T-1805 · People and DMs** — the person card (Message, Knock), the
  new-message picker, away and away messages, and knocks on your door (a card
  above the voice bar). Built in the list window and tested on its fixture
  pages; not yet tried against a real server in the desktop app.
- 🟡 **T-1806 · Settings** — every setting in `parity.md`, in the Settings
  window. Built and wired (Ctrl+, opens it) and tested against a faked owner
  and server; not yet tried in the desktop app. Evening warmth waits for an
  evening version of the new colors; a light theme waits on decision 2.
- ✅ **T-1807 · Media, search and uploads.** Search and Media are windows of
  their own (decision 15), opened from the foot of the list; a hit or a tile
  opens its conversation at that message.
- 🟡 **T-1808 · Windows mode** — separate windows, pop-out and back, positions
  remembered, and the tray. Pop-out and back are built (with the draft going
  along), and so is switching between tabs and windows (Settings → Windows).
  Window positions and sizes are remembered. Closing the list keeps Linger in
  the tray (Show, Mute, Leave voice, Quit), or quits if Settings says so
  (decisions 4 and 5).
- 🟡 **T-1809 · Several servers** — folding sections, the time there, quiet,
  and a server in its own window. Folding sections, your order and Quiet are
  built, with the list window connecting to every server; "the time there"
  waits on decision 3, and a server in its own window isn't built.
- ⬜ **T-1811 · Frames on a private channel** — the Rust core hands the list
  window its gateway frames on a Tauri `Channel` rather than a broadcast
  event, so no other window can make one up (architecture.md, "Still open").
  The app's own commands are already limited per window (`build.rs`,
  `capabilities/`, `src-tauri/src/acl.rs`).
- 🟡 **T-1812 · A packaged layout check for the Buddy list** — the package
  checks (`scripts/linux-audio-check.py`, `client/scripts/windows-audio-check.mjs`)
  inject a layout probe into the installed app and measure today's client
  against its own stylesheet, so since 0.4.0 they run with
  `LINGER_CLASSIC=1`. A first check is in: `client/scripts/next-smoke-probe.js`,
  run by `scripts/linux-next-check.py` and `client/scripts/windows-next-check.mjs`,
  proves the list window starts in the packaged WebKitGTK and WebView2 with its
  stylesheet, fonts and mark, at every interface size, and keeps a Windows
  screenshot. Still to do before today's client is deleted: the list, chat and
  Settings windows signed in, against a throwaway server.
- ✅ **T-1813 · Choose the push-to-talk key** — parity decision 6. A "press a
  key" picker in Settings → Sound & Voice, Right Ctrl by default, so the Ctrl
  shortcuts never open the microphone. Push-to-talk stays off by default.
- ✅ **T-1814 · Drafts that last** — decision 11. A conversation's half-typed
  line is kept on this computer across closing its tab and restarting Linger,
  and cleared when sent.
- ✅ **T-1815 · A banner opens its conversation** — decision 20. Clicking a
  desktop notification opens that room or DM in the chat window, at the message.
  Built and tested up to the desktop; clicking a real banner on Linux and
  Windows is still to be checked by hand.
- ✅ **T-1816 · Empty places say so** — decision 17. One quiet sentence each for
  no rooms (with "Make the first room" for the host), nobody else here, an
  empty search and an empty media collection.
- ✅ **T-1817 · Arrival cards** — decision 13. "Callie came into #general", on by
  default: never takes focus, held in quiet hours and on a Quiet server,
  announced politely to screen readers, fades on its own.
- ✅ **T-1818 · The door chime** — decision 12. One shared soft chime when
  somebody arrives, off by default, at most once per 5 minutes per listener and
  quiet in quiet hours: the first step toward personal entrance sounds
  (T-901…T-903), which later replace it.
- ✅ **T-1819 · Many rooms fold** — decision 22. Past eight rooms on a server,
  the ones with nobody in them and nothing new fold under "More rooms", in the
  host's order, with no number.
- ⬜ **T-1810 · Parity and the switch** — every `parity.md` item is proved. The
  new client becomes the default, the old one stays one release as a fallback,
  then is deleted. SPEC §3/§5 are rewritten from `system.md`.

---

## Backburner — later, not the next thing

Three things live here: one V1 feature that is still in the spec, one release
errand blocked on money, and the mobile client. None of them is on the path to a
usable desktop product. Do not pull any of them "while you're in there".

**Activity detection used to be here and is gone** (Matt, 2026-08-28 —
[`docs/decisions.md`](docs/decisions.md)). T-911…T-917 are deleted, along with
the `linger-activity` crate, the bundled app registry, and the `activity` field
on presence. A status is where somebody says what they are doing, because they
typed it. Do not build it back.

### Signing and notarization

*Moved here 2026-08-27 by Matt, from M7. Nothing in the milestone waits on it:
M7 closes on Linux and Windows, unsigned, by decision
([`docs/decisions.md`](docs/decisions.md)). It comes off the backburner the day
somebody buys the certificates, not before.*

- ⬜ **T-705 · Windows signing + macOS notarization** — effort: **treacherous**
  **Blocked on money, not on effort** — a Windows OV certificate (a few hundred
  a year) and an Apple Developer Program membership ($99/year). Do not start
  without both; there is nothing to test against.
  Windows: certificate into a repository secret, signing wired into the bundler,
  the workflow refusing to publish an unsigned installer. macOS: Developer ID
  signing plus `notarytool` and a stapled ticket, then uncomment the two macOS
  entries in `release.yml` — **in the same pass, never before**. Follow current
  vendor docs, not memory; this is the version-sensitive slog AGENTS.md warns
  about.
  *Accept:* a downloaded installer raises no warning on either OS, and a macOS
  copy installed from it takes an auto-update without being killed for a
  signature mismatch.

### Entrance sounds

*Moved here 2026-08-21 by Matt. These three are still V1 (SPEC §6, item 4) and the
server already fans out `room.enter` to exactly the right people (T-203). They are
simply the lowest-value thing left of M4, so they go after M8 rather than in the
middle of it. Anything that lands before them must not break the frames they rely on.*

- ⬜ **T-901 · Entrance sound playback** — effort: **medium**
  SPEC §4.1. Play on `room.enter` for those in the room; per-user cooldown
  5min/listener;
  global + per-user mute; quiet hours 22:00–08:00 listener-local, off until they opt in;
  picker UI for bundled sounds.
  **The player already exists — extend it, do not write a second one.**
  `client/src/lib/sound.ts` landed with T-1102 and already owns the global mute
  and the quiet-hours rule, with both switches in settings under `sound`. What
  is missing there is bundled `.opus` playback (the knock is synthesized), the
  5-minute-per-listener cooldown, and per-user mute.
- ⬜ **T-902 · Custom sound upload** — effort: **medium**
  Server: accept ≤2s/≤200KB, transcode to Opus + loudness-normalize (−16 LUFS),
  **reject long files, never truncate**. Needs ffmpeg in the Docker image — add it.
- ⬜ **T-903 · Curate the bundled sounds** — effort: **low** *(Matt-assisted, taste required)*
  12–16 sounds per `assets/sounds/README.md` rules; `ffmpeg -af loudnorm=I=-16`
  for normalization; fill the source/license table.



### Mobile

*Moved here 2026-08-28 by Matt, out of V2.* **Desktop first.** The app has to be
finished, installed by real people, and lived with for a while before a second
platform is worth starting. A mobile client doubles the surface of every bug
still in the desktop one, and V1 has not been through a single human check yet.
This is not a "next quarter" item, it is a "when the desktop app is boring"
item.

*Check, when it comes back: sign in, read a room, send a message and a photo,
from a phone.*

**Start with the decision, not the code.** Mobile has one question in it that is
Matt's and is not a technical one:

> **Push notifications go through Apple and Google.** There is no other way to
> wake a phone app. That means a message's *existence* — and whatever the
> notification says — passes through a third party, which is a different promise
> from the one the README makes today.

Three honest answers, and one has to be picked before T-1602: ship without push
and let the app only notify while open; ship with push and **change the README
to say exactly what leaves the server**; or run a self-hosted push relay, which
is a second piece of infrastructure for every host and probably kills it.
Recorded in the *Parking lot* too.

- ⬜ **T-1601 · Decide what mobile means** — *not a task; a decision.* Matt.
  The push question above, plus: does mobile get uploads, does it get voice, and
  is it iOS-and-Android or one of them. Write the answers into SPEC before
  anything else starts.

- ⬜ **T-1602 · The mobile shell** — effort: **high**
  Tauri 2 builds for iOS and Android from the same crate. What does not carry
  over: the OS keyring (mobile has its own secure storage) and the tray. Expect
  the gateway to
  need reconnect behaviour for a network that changes every time somebody walks
  out of a building.
  *Accept:* the app opens on a real phone, signs in, and stays connected across
  a wifi-to-mobile-data switch.

- ⬜ **T-1603 · The layout at phone width** — effort: **medium**
  The roster already collapses under 880px (`client/src/lib/layout.ts`), which
  is a head start. What is missing is one-hand reach, a composer above a
  software keyboard, and the rail as something other than a fixed column.
  *Accept:* usable one-handed on a phone somebody actually owns.

- ⬜ **T-1604 · Getting it onto a phone that is not yours** — effort: **treacherous**
  Apple Developer Program, Google Play, review, and store listings. This is the
  same money-and-paperwork wall as T-705, doubled. **Do not start without both
  accounts.** Follow current vendor docs, not memory — this changes every year.
  *Accept:* somebody who has never met you installs it from a store.

---

## V2 — M9, M10 and M11 built; voice is started

**Three of the five are built and archived** — knock on 2026-08-29
([`m9.md`](docs/tasks/m9.md)), search and DMs on 2026-08-31
([`m10.md`](docs/tasks/m10.md), [`m11.md`](docs/tasks/m11.md)). Everything
in M12 is implemented but awaits its human checks. M13 remains unstarted. V1 is
done except the things in *Human checks*, and those come first — a release
nobody has installed is not a finished V1, and four of the nine checks now
belong to V2 features that have only ever run on one computer.

**Read `m11.md` before touching the gateway fan-out, or anything that lists
messages, files or search results.** DMs put a membership check in every one of
those, and three of the mechanisms are load-bearing in ways the code does not
say out loud.

**Read this before touching any of it:** SPEC §6 lists what V2 is; anything not
on that list is not V2, it is scope creep. Voice is the one left that adds a
whole category of thing this product does not have, and **T-1402 says to
coordinate with Matt before starting** — that is where audio, real networks and
`webrtc-rs` all arrive at once.

**Numbering.** V1 used `T-1xx`–`T-8xx` for milestones M1–M8, plus `T-9xx` for
the V1 work that came off the critical path — and for small V1 changes that land
after the milestones closed (`T-904`). V2 starts a new band at **`T-1xxx`, where
the hundreds digit is the area** — `T-11xx` knock, `T-12xx` search, `T-13xx`
DMs, `T-14xx` voice, `T-15xx` ambient voice — and `T-16xx` mobile, which is on
the backburner rather than in V2, and `T-17xx` themes, which is V3. It does not
continue the milestone-matches-number rule, because `T-9xx` is already spoken
for.

**The order is not SPEC §6's order, on purpose.** SPEC lists voice first because
it is the headline. It is sequenced last here because it is the largest and
riskiest thing in the project, and because knock and search are small,
self-contained, and make the app better next week rather than next quarter.
Build order, cheapest and safest first:

```
M9 knock (built) → M10 search (built) → M11 DMs (built)
  → M12 voice (built; its four-network check is HC-9) → M13 ambient voice
```

**Mobile is not in this sequence** (Matt, 2026-08-28). It was going to be M14;
it is on the *Backburner* instead. Desktop has to be finished and used by real
people first.

---


---

### M12 — voice rooms

Built, and archived with every landing note in [`m12.md`](docs/tasks/m12.md).
**Read it before touching voice**: the signalling, the audio path in Rust, the
relay and the device handling all have notes there that the code does not say
out loud.

- ⏳ **T-1402 · The audio path** — effort: **treacherous** — Matt, 2026-09-01.
  Built and in daily use. It stays open until four people have talked for an
  hour on four different networks, which moved to #197 with the voice rework
  (a forwarding server). Its notes are in `m12.md`.

### M13 — ambient voice

*Milestone check: leave a room running for a working day; it costs almost no
CPU and nobody had to "join" anything.*

The differentiator, and it only makes sense on top of M12. "A room you leave
running, not a call you join" — no ringing, no joining ceremony, no call that
somebody has to end.

**The privacy shape matters more than the code.** An always-on microphone is
exactly the thing this product's whole pitch is against, so it needs the same
treatment activity sharing got in SPEC §4.3: **off by default, a persistent
visible indicator whenever it is on, and one obvious way to kill it.**

- ⬜ **T-1501 · Ambient mode** — effort: **high**
  Open mic with voice detection so silence costs nothing, no join step, idle
  cost low enough to leave on all day.
  *Accept:* eight hours in a room, CPU and battery measured, and a number
  written down in the landing note.

- ⬜ **T-1502 · The controls that make it safe** — effort: **medium**
  Default off. A persistent indicator, visible without opening anything, any
  time the mic is live. One-click kill from the roster. Quiet hours.
  *Accept:* somebody who did not set it up can tell at a glance whether their
  microphone is on.

---

## V3 — further out than V2, and not all of it will happen

SPEC §6's *V3 or never* list, plus the one Matt added on 2026-08-31. **Nothing
here is next**, and nothing here starts before V2 is done and V1 has been lived
with. This section exists so the ideas are written down with their problems
attached, which is the only useful form to keep an idea in.

**Numbering** continues the V2 rule — the hundreds digit is the area. `T-17xx`
is themes. The rest of the V3 list (an opt-in directory, sandboxed client
scripting, custom emoji) has no numbers yet because nobody has thought about it
hard enough to write a task.

### M14 — custom themes

*Matt, 2026-08-31: "I would like for us to support themes where people can
create custom color schemes and themes for the application, which will allow for
some great flexibility and maybe even a themes-community."*

**Why it fits.** Personalization is not a bolt-on here, it is the thesis — SPEC
§2 names AIM-era self-expression as half of what this product is for, and the
styled name is already the one expressive element. A person choosing how their
whole app looks is the same idea one size up. Nothing on the anti-goals list
forbids it.

**Why it is not simply "let people write CSS", and why this is three tasks and
not one.** Four things in this repo are load-bearing and a theme walks straight
into all of them:

1. **The 16-colour palette is a contract, not a preference.** It is defined once
   in `linger-core::PALETTE`, validated *server-side* (AGENTS rule 8), and a
   property test in CI asserts every one of the 16 keys clears 4.5:1 contrast
   against both theme backgrounds. It is what makes "there is no way to pick a
   colour nobody can read" true. A theme that repaints those keys deletes that
   guarantee unless it is checked the same way — so the check has to move to
   wherever the theme is applied, and a theme that fails it has to be refused
   or corrected, in front of the person who made it.
2. **Colours are palette keys everywhere** — on the wire and in the database
   (AGENTS rule 12) — so a theme cannot be stored as somebody's name colour. It
   is a different kind of thing: the reader's own view of *their* app, closer to
   density and dark/light than to a styled name. That points at it being a local
   preference, not a server object, which is a much smaller feature.
3. **The Console rules are the product, not a default skin** (SPEC §5.1): no
   chat bubbles, no shadows, no gradients on surfaces, no rounded panels,
   monospace for metadata only. If a theme can turn those off, the design system
   is advisory and the answer to "why does this look like Discord" becomes "you
   installed a theme". A theme almost certainly gets colours and maybe warmth,
   and does *not* get geometry, spacing or typography.
4. **"A themes-community" is a distribution problem wearing a cosmetics hat.**
   Rule 14 forbids a payment surface of any kind, and SPEC §6 already puts an
   opt-in directory at V3 with "must never be load-bearing" attached. A theme
   that is a file somebody sends a friend is nothing to build. A gallery inside
   the app is a store without prices, and it is also a moderation surface. If
   themes are CSS rather than a list of colours, sharing them is
   **arbitrary-code-shaped**, and SPEC §6 already flags sandboxed client
   scripting as "a real security surface".

**Three decisions are Matt's and none of the tasks below can start without
them.** They are repeated in the *Parking lot*.

- ⬜ **T-1701 · What a theme is allowed to change** — *not a task; a decision.*
  Matt. Colours only, or colours plus warmth, or something wider? Does a theme
  repaint the 16 name colours, or only the surfaces and text around them? The
  contrast guarantee follows the answer, and so does whether this is a weekend
  or a month.
- ⬜ **T-1702 · The theme format and the editor** — effort: **high**
  *Blocked on T-1701.* Whatever a theme turns out to be, it is a **list of
  values, not a stylesheet** — the tokens in `styles/tokens.css` are already
  exactly this shape, which is why density and evening warmth are one variable
  swap. Applying one is then the same move: set custom properties on `<html>`.
  A theme lives on the reader's machine beside density and theme preference, not
  on the server, unless T-1701 says otherwise.
  **The contrast check comes with it, in the app, live** — the CI property test
  in `linger-core` is the model, and the editor should refuse to let somebody
  build something they cannot read rather than warning them afterwards.
  *Accept:* somebody makes a theme, restarts the app, and it is still there —
  and cannot save one that fails contrast.
- ⬜ **T-1703 · Sharing a theme** — effort: **medium**
  *Blocked on T-1701, and on Matt saying how far this goes.* The cheap version
  is the whole feature: a theme exports as one small file, and importing one
  shows what it will look like before it applies. That is a themes-community
  with no infrastructure, no gallery, no moderation and no store — people send
  each other files, the way they always have.
  **Anything beyond that is a scope decision, not an implementation detail.**
  *Accept:* a theme made on one computer is applied on another, with nothing in
  between but a file.

---

<a id="human-checks--things-only-you-can-do"></a>

## Release checks — desktop and real-world evidence

**All nine closed on 2026-09-25** (Matt, from real use of the published app).
The full steps and results are archived in
[`docs/tasks/release-checks.md`](docs/tasks/release-checks.md), so each can be
run again when its area changes.

| Check | Result |
|---|---|
| HC-1 · an installed copy updates itself | ✅ Passed in real use. Installed copies updated themselves from the app and stayed signed in: Matt's Linux AppImage (0.3.4 → 0.3.5) and friends' Windows installs. |
| HC-2 · a window opens on all three operating systems | ✅ Linux and Windows, in real use. The macOS part is not done: there is no Mac build, on purpose ([decisions](docs/decisions.md)); it belongs to T-705. |
| HC-3 · a 400 MB video, for real | ✅ Closed by Matt's decision **without the 400 MB step**. Ordinary uploads work in real use; a 400 MB video surviving a dropped connection was not tried, and Matt judged it unnecessary for now. |
| HC-4 · a styled name in a room | ✅ Passed in real use (and locally, 2026-09-08). |
| HC-5 · the export button | ✅ Passed 2026-09-08 in real desktop clients. |
| HC-6 · a knock on a second computer | ✅ Passed in real use. |
| HC-7 · a DM on two computers, a third watching | ✅ Passed in real use (and locally, 2026-09-08). T-921, the outsider's "in a room" wording, is its own task and still open. |
| HC-8 · voice from a second computer | ✅ Passed in real use. |
| HC-9 · voice across two networks, through the relay | ✅ Passed in real use for two people on separate networks through the host's relay (first reported 2026-09-17; in daily use since). Not tried: a phone hotspot, the relay switched off, and four people on four networks for an hour. Those move to #197's re-test, which reruns every voice check when voice is rebuilt for large rooms. |

---


## Parking lot (decisions needed, not tasks yet)

- **What is a custom theme allowed to change, and how far does sharing go?**
  Raised by Matt on 2026-08-31 and written up as M14 (T-1701…T-1703). Three
  answers are needed before any of it starts. *What a theme touches:* colours
  only, or colours plus the evening warmth, or more — and in particular whether
  it repaints the 16 name colours, because those are validated server-side and
  their 4.5:1 contrast is guaranteed by a test in CI. *Whether the Console rules
  are themeable at all:* if a theme can turn off the no-bubbles, no-shadows,
  no-rounded-panels rules, the design system is advice rather than the product
  (SPEC §5.1). *How far sharing goes:* a theme as a file people send each other
  costs nothing and is probably the whole feature; a gallery inside the app is a
  store without prices and a moderation surface, and rule 14 plus SPEC §6's
  "must never be load-bearing" both point at it.
- Bundle identifier is `com.linger.desktop` — fine? Changing after M7 is painful.
- **Mobile push goes through Apple and Google, or it does not exist.** There is
  no third way to wake a phone app. Whatever a notification says, and the fact
  that it happened, passes through a company that is not you. The README's
  privacy section does not currently allow for that. Three answers: no push
  (the app only notifies while it is open), push with the README changed to say
  exactly what leaves the server, or a self-hosted relay — which is a second
  piece of infrastructure for every host and probably ends the idea. **This
  blocks mobile** and nothing else. Raised 2026-08-28 while planning V2.
- ~~**Where does search live, and what does it cover?**~~ **Answered by Matt,
  2026-08-30**, and written into SPEC §4.12: a destination in the rail next to
  `media`, opening in place of the stream, with `Ctrl`/`Cmd`+`K` as a shortcut
  into it rather than a second surface; and it covers what people typed plus the
  names of files, not link titles. Raised 2026-08-28.
- **Pinning from the client** moved to T-908 on 2026-09-08. It closes an
  existing V1 flow using the existing endpoints; it needs no new scope decision.
- Link-preview fetching is host-side (privacy: the host's IP fetches, not each
  member's). **Built that way in T-504** — the favicon is inlined as a `data:`
  URI so a reader's machine never touches the linked site either. Matt has not
  confirmed the trade-off; the cost is that the server's IP appears in the logs
  of every site anybody links, and turning it off means either no cards or
  every reader fetching for themselves.
