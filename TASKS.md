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

**0.3.6 release — ⏳ Matt, 2026-09-25.** #147, #169 and #185–#188 are fixed and
merged (PRs #189–#195), with each issue linked and closed. New: the Omarchy/Arch
package and its pacman repository (`packaging/arch/`, published on release by
`arch-repo.yml`), and the agent skills (`agents/`). A client-only release: no
server change since 0.3.5. Version bumped in all four files; notes in
`docs/releases/0.3.6.md`. Tag, check the signed packages, server image and
updater manifest, publish, then check the `arch` repository got the package.
#81 and #101 remain deferred (#101 has an R&D branch, `feat/101-design-lab`).
M12 remains current.

**0.3.5 release — ✅ Matt, 2026-09-25.** Issues #168–#174 and #181 are fixed and
merged (PRs #175–#180, #182, #183). Notes in `docs/releases/0.3.5.md`. Tagged,
packages and server image built, and the release published; the updater served
0.3.5.

**0.3.4 release — ✅ Matt, 2026-09-24.** Bugs #127–#130, #135, #137–#146,
#151–#153 and #164 are fixed and merged (PRs #132–#165), with each issue linked
and closed. Notes in `docs/releases/0.3.4.md`. Tagged, packages and server image
built, and the release published; the updater served 0.3.4.

**0.3.3 issue fixes — ✅ Matt, 2026-09-23.** PR #125 fixed bugs #114–#119,
#121, #122 and #124 and completed enhancements #120 and #123, with all eleven
issues linked and closed. #81 and #101 remain deferred. The full local gate,
462 frontend unit tests, 340 browser cases, CI, and all five unsigned and signed
package checks passed. Signed packages and all seven updater entries were
verified against the existing key. The amd64/arm64 server image and desktop
release are published; the public updater endpoint serves 0.3.3. Matt authorized
the existing PR-only administrator override; protection settings were unchanged.
Merged branches were cleaned up. PR #126 records the audit in
`docs/releases/0.3.3.md`. M12 remains current; physical-device, spoken-dictation
and separate-machine/network evidence limits remain open.

**0.3.2 release hardening — ✅ Matt, 2026-09-22.** Combine the issue-linked
fixes in PRs #102, #103, #105, #106, #107, #109, #110 and #111; test the combined
candidate, add native cross-platform navigation coverage and scoped CI, then
build and publish 0.3.2. M12 remains current; no physical-device or real-network
release check is closed by automation. See `docs/testing-strategy.md` and
`docs/releases/0.3.2-testing.md`.

**Completed 2026-09-22 (PR #112, v0.3.2).** All eight original fix PRs were
merged with their ancestry preserved, closing nine linked bug issues. The full
local gate, 458 frontend unit tests, 318 Chromium/WebKit cases, 13 CI-selection
tests and all five package-format checks passed. Signed release packages passed
the native layout/audio checks and all ten Windows shortcut scenarios again.
All five downloaded package signatures were verified against the existing
updater key; all seven manifest entries point to the correct 0.3.2 packages.
The amd64/arm64 server image is published, and the public in-app updater endpoint
serves 0.3.2. Branch protection was not changed; Matt authorized the one-time
administrator merge. Evidence is linked in `docs/releases/0.3.2.md`. Physical
listening and separate-machine/network checks remain open.

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
**M15, the Buddy list client (#198), is in progress** on `feat/198-buddy-list`;
see [M15](#m15--the-buddy-list-client-198). M13 (ambient voice) is planned and
not started, and larger groups are #197. The [release readiness review](docs/release-readiness.md)
records the 2026-09-08 audit.

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

- ✅ **Issue #108 · Preserve Windows shortcuts during in-app updates** — Matt,
  2026-09-22. Reported after updating from 0.3.0 inside the client. Investigate
  the published Windows packages and test updates on a disposable Windows
  runner before changing installer behavior. Existing shortcut and installation
  identity must survive the update without a second desktop entry.

  **Completed 2026-09-22** ([PR #111](https://github.com/itsMattGuenther/Linger/pull/111)):
  the published MSI's signed in-app 0.3.0 → 0.3.1
  update recreates a renamed desktop shortcut; NSIS preserves it. The MSI
  fix limits desktop creation on upgrades to an existing canonical shortcut.
  All ten built-package Windows scenarios pass: original, renamed, moved,
  deleted and fresh in both formats, including uninstall checks. Packaged
  icons/audio, the full local gate and regular CI also pass. The reporter's
  original installer and shortcut names are unconfirmed; no release was
  published and HC-1 remains open. [Evidence and check](docs/windows-update-checks.md).

Not a milestone and not a backburner: one-off changes to V1 surfaces that came
out of using the app. Each one is small enough that it lands in a single session
with its note written here rather than in an archive.

**Next, alongside the human checks:** T-907 → T-908 → T-909.
Measure T-910 before describing a release as lightweight. These close existing
flows and do not start a new milestone. Evidence and rationale are in the
[release readiness review](docs/release-readiness.md).

- ✅ **T-922 · Make first-time VPS hosting a complete path** — effort:
  **medium** — Matt, 2026-09-17. Make Docker installation a numbered action,
  show SSH-key copying without assuming macOS, explain provider firewall
  rules and dynamic home IPs, and group all Compose edits in one visit.
  *Accept:* a fresh Ubuntu 24.04 VPS path has copyable commands, explicit
  local/server context and verification stops; setup, invites and relay
  instructions remain accurate. Keep private field notes out of the commit.

  **Completed 2026-09-17** (PR #67, merged). Docker install
  and checks are step 1; the linked VPS guide covers public-key copying,
  key-only SSH with a changing IP, and provider firewall rules. Domain,
  storage and optional realm edits are grouped before the Caddyfile edit.
  Local docs checks (rules, versions, links and Bash syntax) and docs-only CI
  passed. Package/provider guidance was checked against primary sources.
  No VPS was created or changed; the next fresh-host walkthrough remains
  human validation. No release checks were closed.

- ✅ **T-923 · Make installing and joining unambiguous** — effort: **medium** —
  Matt, 2026-09-17. Give each desktop download a clear install/launch path,
  distinguish invite registration from sign-in and host setup, and explain
  updates without promising an unverified end-to-end upgrade.
  *Accept:* package choices match published assets, commands and labels match
  the app, Linux reopening/troubleshooting is copyable, and a new member is
  told to obtain an invite before trying a username and password.

  **Completed 2026-09-17** (PR #68, merged). Download and
  launch paths now match the published x64 assets. Invite registration,
  existing-account sign-in and private host setup are separate instructions;
  updates name the actual settings tab and buttons, with a manual fallback.
  Rules, versions, local links, Bash syntax and docs-only CI passed. Omarchy
  package guidance uses the existing command and the graphics workaround is
  per launch. No new installation or real-machine upgrade was performed;
  HC-1 and all other open release checks remain open.

- ✅ **T-924 · Fit expanded images to the window** — effort: **medium** —
  Matt, 2026-09-17. Reproduce the clipped preview inside a transformed message
  row, then keep expansion centered in the viewport with the image's aspect
  ratio intact. Do not change message loading or virtualization.
  *Accept:* real browser regression coverage fails before the fix and passes
  after it; portrait, landscape, small images and long filenames fit large
  and small windows, including resizing while open. Escape/click dismissal
  and keyboard focus remain usable. No new runtime dependencies or wire types.

  **Completed 2026-09-17** (PR #69, merged). The browser
  regression reproduced a preview positioned inside the transformed message
  row instead of the viewport. Expansion now uses a body portal, preserves
  aspect ratio, fits both dimensions on resize and contains long filenames.
  A visible close control, keyboard focus containment and focus return cover
  keyboard use. The regression fails before the fix and passes after it;
  all 50 Chromium/WebKit cases pass across both themes, three densities and
  three window sizes. All 413 existing client tests, typecheck, production
  build, the complete local `scripts/check.sh` gate and CI pass. The browser
  tooling is development-only. Packaged Omarchy/Windows checks remain human
  validation; no release checks were closed. T-925 records the separate icon
  report without adding it to this implementation.

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

- ✅ **T-926 · Make file downloads clear and report failures** — effort:
  **medium** — Matt, 2026-09-17. Reproduce the silent browser-handoff failure
  behind attachment saving. Make the action explicit, show a useful failure
  with a recovery path, and cover both chat and the media collection. Keep
  untrusted downloads outside the app WebView and preserve opaque media URLs.
  *Accept:* a failed handoff is visible and retryable; success does not claim
  the browser has finished saving; regression tests cover both surfaces and
  URL handling. Record what still needs installed Windows/Linux validation.

  **Completed 2026-09-17** (PR #70, merged). A refused native
  browser handoff reproduces the silent failure in a real browser regression.
  The fix labels the action
  `download in browser`, reports refusal, permits retry and offers a selectable
  link without claiming a completed save. Chat and media tests cover relative
  and signed URLs. All 420 client tests, 29 Chromium cases, typecheck,
  production build, the full local gate and CI pass, including all 58
  Chromium/WebKit cases. Installed Windows/Omarchy validation remains; the
  original desktop's refusal is not diagnosed. No release check was closed.

- ✅ **T-927 · Clear temporary knock feedback** — effort: **medium** —
  Matt, 2026-09-17.
  Reproduce the persistent sender-side `knocked` label separately from the
  recipient card. Restore the action after brief feedback without weakening
  server rate limits or retaining knock history. Cover timeout, failures and
  component lifecycle; keep the real two-machine check distinct.

  **Completed 2026-09-17** (PR #71, merged). The sender
  regression fails before the change.
  Success now resets after three seconds; pending requests remain disabled,
  errors remain retryable, and old responses/timers cannot affect another
  card. All 37 Chromium cases, 420 client tests, typecheck, production build
  and the full local gate pass. Recipient cards, sound and server limits are
  unchanged. CI passes, including all 74 Chromium/WebKit cases. The two-machine
  HC-6 check remains open; no release check was closed.

- ✅ **T-928 · Diagnose and fix corrupted dictation input** — effort: **high** —
  Matt, 2026-09-17.
  Reproduce Voxtype output through the actual Linux input path, compare plain
  text input and clipboard insertion, and fix the responsible layer. Do not
  add transcription, capture audio, collect window titles, or change global
  desktop settings. Record an evidence-based limitation if the cause is an
  external component rather than claiming a speculative composer fix.

  **Completed diagnosis/workaround 2026-09-17** (PR #72, merged).
  The AppImage hook forces X11. The native comparison
  reproduces corrupted wtype input under XWayland in GTK, plain WebKit and
  Linger's real composer, but not native Wayland. Clipboard/native paste
  succeeds on both display paths; slowing typing does not fix XWayland.
  `docs/linux-input-checks.md` records the method and limitations, and the
  user guide supplies a per-recording clipboard workaround. No composer
  behavior or global desktop setting was changed. Spoken dictation, physical
  paste and a packaged Wayland solution remain distinct checks; T-929 owns
  the packaging follow-up. This is a diagnosed external limitation with a
  tested input workaround, not a claim that AppImage typing is repaired.
  All 18 native comparison results are recorded; all Wayland and clipboard
  controls match, and all six XWayland typing cases reproduce corruption.
  The full local gate, 420 client tests, 38 Chromium cases, typecheck,
  production build, rules, version, shell syntax and doc checks pass. CI also
  passes, including all 76 Chromium/WebKit cases. Disposable build tools,
  caches and isolated-desktop files were removed; no system packages were
  installed and the private onboarding notes remain untracked. No release
  check was closed.

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

- ✅ **T-930 · Quiet, controllable notification chimes** — effort: **high** —
  Matt, 2026-09-17. Extend the existing sound player. Voice-session joins,
  leaves and moves, mic/deafen controls and DMs default on; ordinary room
  messages default off. Join/leave refers to the listener's voice session,
  not entering text rooms. Add category switches and one master silence
  control; preserve quiet hours. No sound on replay/history, duplicate frames,
  own messages or messages already being read. Never chime on PTT edges.
  *Accept:* test routing, gating, persistence, reconnect suppression and
  accessible settings; audition remains a real-listener check. This does not
  implement personal entrance sounds (T-901…T-903) or redesign the Console UI.

  **Implemented 2026-09-17.** One synthesized sound player owns all chimes;
  desktop banners explicitly request silence. Categories preserve existing
  master/quiet-hour preferences and remain effective if storage refuses a
  write. Voice membership cues are limited to the listener's session, control
  cues wait for a successful change, and PTT stays quiet. Native gateway replay
  metadata suppresses reconnect chimes without changing the wire protocol or
  existing mention-banner batching. **PR #76 merged 2026-09-17:** all CI
  checks pass, including 88 Chromium/WebKit cases. A temporary combined tree
  with T-1407, T-925 and T-929 also passes the full local gate, all 438 client
  tests, 44 Chromium cases and production build. Real Linux/
  Windows listening, sound-device behavior and banner silence still need an
  installed-client check; these are not HC-8/HC-9 evidence.

  **Packaging follow-up implemented 2026-09-21 (Matt, PR #87):** v0.3.0's AppImage ships
  GStreamer libraries without any playback plugins and points its plugin
  search path at an absent directory. The fix bundles the media runtime,
  requires the corresponding DEB/RPM plugins, and makes Windows WebView2
  installation explicit. Matt approved the additional runtime size. The
  published AppImage fails the new runtime check; rebuilt AppImage, DEB and
  RPM executables produce nonzero virtual-speaker recordings locally. Both
  Windows EXE/MSI runtime checks pass in CI. The Linux test now keeps audio
  open until its recording is checked; a controlled delayed-output comparison
  reproduced the previous test's premature-close failure. Package and release
  workflows run these checks; see [method and limits](docs/packaged-audio-checks.md).
  No release or real-listener check is closed by this work alone.

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

- ✅ **T-931 · Fix reported conversation and settings inconsistencies** — effort:
  **medium** — Matt, 2026-09-21. GitHub #88, #89, #90 and #92: match the
  Send button to the single-line input height, anchor the attachment menu to
  Add with predictable focus/dismissal, and use title case for headings and
  navigation across settings, and tighten text spacing in rooms and DMs.
  Preserve Console styling and existing behavior.
  *Accept:* verify composer geometry at supported scales, attachment keyboard
  and pointer flows, file-picker/draft preservation, and settings headings.
  Intended for the 0.3.1 patch alongside the separate audio fix in PR #87.
  GitHub #81 remains deferred.

  **Implemented 2026-09-21.** The composer shares one control height, and its
  attachment menu opens above Add without a close button or tooltip. Capturing
  the trigger before scheduling the state update also fixes failed openings
  after typing a draft. Menu keyboard navigation, Escape/outside/trigger
  dismissal and file-picker draft preservation pass browser checks. Headings
  and tabs use title case in every personal and server settings view; the
  README and user guide follow the visible labels. Full local gate and all
  135 Chromium checks pass, including all six supported interface scales.
  Rendered production components were inspected with synthetic fixture data.
  **#92 added at Matt's request:** message line height is 1.3, prose block
  spacing is 2px and sender-group spacing is 8px at default scale. Session
  dividers and action controls keep their clearance. Room/DM checks verify
  equal spacing, preserved line breaks, quotes, lists and code at 100%/200%.
  No release or real-device check is closed by this work.

- ✅ **T-932 · Collapse message gaps and remove colored bars** — effort:
  **medium** — Matt, 2026-09-22. GitHub #93 follows #92: remove the hidden
  action rows between messages and the per-message colored gutter. Styled
  sender headings and indented text define groups, with one layout for rooms
  and DMs. Update SPEC §4.7 and the style guide with the implementation.
  *Accept:* compare consecutive short messages, multiline text and sender
  changes in a packaged client. Preserve typed line breaks and keyboard
  access to actions without hover overlap or layout jumps.

  **Implemented 2026-09-22.** Replaced each hidden toolbar row with a 24px
  action target beside the text and an explicitly opened menu. Consecutive
  one-line messages occupy 24px at default scale. Sender headings and a 14px
  text indent replace the colored bars. Reply, edit, reactions and confirmed
  deletion retain keyboard access; hovering and opening actions do not resize
  messages. SPEC, style guide, README and user guide describe the new layout.
  The full local gate and all 136 Chromium checks pass, with the focused
  checks rerun after correcting the action target's inherited minimum height.
  CI also passes the WebKit suite. Packaged Linux checks confirm 56px → 24px
  one-line continuations, room/DM parity, preserved multiline content and
  stable action geometry at 100%/200%. [Comparison and screenshots](docs/message-spacing-checks.md).
  Windows packaged rendering was not exercised; no release check is closed.

- ✅ **T-934 · Use restrained focus without pointer-open noise** — effort:
  **medium** — Matt, 2026-09-22. GitHub #96 follows the attachment-menu
  correction in T-931: the server accent currently paints every focus ring,
  and native dialog autofocus makes pointer-opened menus look keyboard-selected.
  Separate keyboard location from the host's accent and keep automatic panel
  focus quiet until somebody navigates with the keyboard. Preserve real focus,
  keyboard navigation, Escape/outside dismissal and focus return.
  *Accept:* Add file, server options and shared controls have no bright accent
  outline; keyboard focus remains clearly visible with the Console palette;
  pointer-opened server options does not expose the Close tooltip; browser
  regressions cover pointer and keyboard opening, navigation and dismissal;
  SPEC §5.3 and the control guide describe the implemented treatment.

  **Completed 2026-09-22 (PR #105).** Keyboard location now uses one neutral
  1px ring instead of inheriting the server's accent, so a lime accent no
  longer paints controls bright green. Context panels still move real focus
  inside for accessibility. Pointer opening keeps the automatic first focus
  visually quiet, including the Close tooltip, until Tab or arrow navigation;
  keyboard opening shows the ring immediately. Add file, server options and
  shared controls are covered with a lime accent, Escape, outside dismissal
  and focus return. All 136 local Chromium cases, the production build, all
  453 client tests and every local gate step pass. CI passes the full Chromium
  and WebKit suites plus rules, Rust, S3, coturn and the desktop shell. No
  release check was closed.

- ⬜ **T-907 · Open healthy servers while another is unavailable** — effort:
  **high**
  `useSessions` waits for all saved servers, and the HTTP client has no request
  deadline. Failed servers disappear for that launch. Restore each server
  independently, retain an unavailable entry with a retry action, and keep its
  saved sign-in unless explicitly rejected. Do not add an offline database.
  *Accept:* with two saved servers and one stalled response, the healthy one
  becomes usable within a bounded time. The other can recover without restart
  or re-entering credentials. Test token rotation and React StrictMode so no
  saved token is spent twice.

- ⬜ **T-908 · Pin a message from the conversation** — effort: **medium**
  Use the existing pin/unpin endpoints and message action strip; indicate the
  saved state and report failures without losing it. No new wire fields.
  *Accept:* pinning in one client appears in another and in media's pinned
  filter; unpin removes it. A DM's pin remains invisible to non-members, and
  pinned attachments retain the existing expiry protection. Read M10 and M11
  notes before touching history or visibility.

- ⏳ **T-909 · Make Console controls readable and reachable** — effort: **high** — Matt, 2026-09-17
  **Console overhaul:** larger readable defaults, persistent interface scale,
  draggable and keyboard-resizable side panels, a single server identity,
  discoverable personal settings, `DMs` with an `empty` state, and a clearer
  voice strip with participant controls on demand. Review the whole frame,
  first-run forms, settings, contrast and responsive behavior together. Keep
  styled names, no avatars, existing privacy boundaries and virtualized history.
  Review remaining muted/faint interactive text, focus states, empty/error
  states and the minimum desktop window. Use the existing tokens and layout.
  **Member-menu follow-up, 2026-09-17:** the first click on a member should
  present the same ordinary actions for hosts and members. Group removal and
  other host-only operations behind an explicit admin-actions area, with
  confirmation for removal. Keep administration discoverable without exposing
  destructive actions in the initial popover. No new roles or permission
  matrix; implement with the deferred Console UI/UX review, not this batch.
  *Accept:* current screenshots in both themes at 1100×720 and 760×480; all
  supported interface scales checked; keyboard-only use and reduced motion
  checked; a friend finds settings, sends a file and joins voice unaided.
  Record contrast for enabled control labels, not just styled names.
  **Design revision, 2026-09-17:** remove Density and the Compact/IRC modes.
  Keep one comfortable presentation and make the frame adapt automatically.
  On narrow windows, People may collapse behind a labelled button (approved
  2026-09-17). Restore the column automatically when space allows.
  **Implementation ready for review, 2026-09-17:** see
  [Console review and checks](docs/console-ui-review.md) and the root
  [screenshots](screenshots/README.md). The full local gate passes. Packaged
  Windows/Omarchy and the unaided-friend acceptance remain open; keep T-909
  in progress until those checks have evidence.
  **Review follow-through:** scale is only in Appearance, visible branding is
  Linger, ongoing voice controls remain reachable in other destinations, and
  Settings copy is shorter. Wide message lines are bounded; actions use label
  sizing instead of metadata sizing. See the review for research and evidence.
  **Local interaction review, 2026-09-17:** [review 03](screenshots/review-03/README.md)
  proposes plain voice names with a collapse chevron, compact toolbar icons,
  bottom-anchored Media/Search, selected-server management and member popouts.
  That iteration used the README banner on welcome. See the
  [control style guide](docs/style-guide.md). Review 04 supersedes this
  checkpoint; its visual direction was approved on 2026-09-17.
  **Quiet-delight pass, local, 2026-09-17:** [review 04](screenshots/review-04/README.md)
  restores the final porch icon on welcome; adds accepted-reaction feedback,
  short control feedback, local name/status previews, full-image media tiles
  and honest Star confirmations. Existing chimes share a soft sound family;
  listener preferences and quiet defaults are unchanged. Offline listening
  samples accompany the screenshots. Frontend typecheck/build, 439 unit tests,
  97 Chromium browser cases, rules/version/whitespace checks pass. Matt approved
  the direction for v0.2.0 on 2026-09-17. The full local gate was rerun during
  release preparation and passes. No protocol change or new dependency.
  Native acceptance, listening
  and the existing multi-network voice checks remain open.
  **Approved QA corrections, 2026-09-21:** message actions reserve space clear
  of text; message bodies use the bundled sans faces, with a fallback for older
  non-sans choices; Search, Media and Settings share their heading and Close
  control; sound switches share one column; the absolute recording claim is
  removed. See [QA screenshots](screenshots/qa-2026-09-21/README.md).
  Eight new browser cases cover layout, keyboard actions, legacy fonts and
  switch persistence. The full local gate, 126 Chromium browser cases and
  production build pass. This scoped repair does not close the remaining
  T-909 acceptance checks.

- ⬜ **T-910 · Measure the release's size and running cost** — effort: **medium**
  Record installer size, cold launch time, total process memory and idle CPU
  on Windows and Linux; include WebView processes. Repeat after an extended
  session with several rooms and during four-person voice. Check how retained
  message history grows; virtualization alone does not bound it.
  *Accept:* versioned measurements with hardware and method, explicit future
  regression budgets, and any observed growth recorded as a focused follow-up.
  Do not change history storage without first reading M10's notes.

- ✅ **T-918 · Exercise the desktop release checks** — effort: **high** — Matt,
  2026-09-08
  Drive real, isolated desktop clients through export, live name styling and
  DM visibility. Record reproducible steps and observed results, including the
  limits of several clients on one machine. Update the human-check wording:
  desktop automation can own technical checks; separate computers, networks,
  physical audio devices and listening still need their stated evidence.
  *Accept:* a reusable native desktop harness, a dated evidence record, and
  truthful check statuses. Report any defect as a focused follow-up.

  **Completed 2026-09-08** ([PR #62](https://github.com/itsMattGuenther/Linger/pull/62)).
  `scripts/desktop-check.py` passed twice from fresh server data and empty
  profiles with three native clients. HC-5 is closed; HC-4 and HC-7 have local
  desktop evidence, with separate-machine checks still open. T-920 fixed the
  broken local media URLs it exposed; T-921 records the remaining presence
  wording. Screenshots, outcomes and setup are in
  [desktop-check-results.md](docs/desktop-check-results.md).
  The full local gate (413 frontend tests), package build and all five
  [CI jobs](https://github.com/itsMattGuenther/Linger/actions/runs/34287834499) passed.

- ✅ **T-919 · Package the selected porch icon** — effort: **low** — Matt,
  2026-09-08
  Use `assets/logo/Linger Pixel Porch Icon Set FINAL.png`, selected by the
  friend group, for the existing desktop icon formats. Preserve the artwork
  and its proportions; document regeneration and verify the packaged result.

  **Completed 2026-09-08** (PR #62). Six desktop icon files now come from the
  selected PNG via `scripts/app-icons.py`. Transparent padding preserves the
  slightly rectangular artwork. A built Debian package's three installed
  PNGs match the generated assets byte for byte. README documents regeneration.
  No new release was published; native Windows/macOS appearance remains untested.

- ✅ **T-920 · Resolve local media addresses against their server** — effort:
  **medium** — Matt, 2026-09-08
  T-918 reproduced a silent export-download failure and broken inline images
  in real desktop clients against a server without `LINGER_DOMAIN`. Upload
  parts already resolve root-relative URLs; rendering and export do not.
  Apply the same resolution to attachments, posters, media tiles, status
  images and export links. Preserve absolute media-domain URLs.
  *Accept:* a local upload renders in another client and its media collection;
  export downloads through the native browser handoff. Regression checks
  cover both relative and absolute URLs without changing the wire contract.

  **Completed 2026-09-08** (PR #62). Rendering and export use the same URL
  resolution as upload parts, with the owning server passed explicitly through
  the relevant components. Five new regressions cover two server origins,
  posters, absolute URLs and export polling; four fail before the fix.
  Two native desktop runs confirm image display, media visibility and browser
  downloads. The local gate and CI validation are recorded under T-918.

- ⬜ **T-921 · Show a private room's occupants as around to outsiders** — effort:
  **medium**
  T-918's third native client receives the documented `in_room` presence with
  `room_id: null`, but renders “in a room” instead of HC-7's “around”. The
  conversation's contents and identity remain hidden. Review the M11 notes
  and PROTOCOL §8 before changing this; keep initial presence and live updates
  consistent, including accessible labels and name popovers. Any protocol
  clarification must preserve compatibility with existing clients.
  *Accept:* an outsider sees the same ordinary around presentation while two
  people use a DM; its members still see their conversation normally.

- ✅ **T-906 · Keep a sign-in through a temporary server failure** — effort:
  **medium** — Matt, 2026-09-08
  During normal use, `AuthedApi` treats every error response from token renewal
  as an expired sign-in. A temporary `INTERNAL` or `RATE_LIMITED` response then
  removes the server from the rail and deletes its saved token. Startup already
  distinguishes those failures from `UNAUTHENTICATED` / `FORBIDDEN`.
  Apply the same distinction during normal use, without retrying forever or
  weakening rejection of an expired or revoked token.
  *Accept:* temporary errors preserve the sign-in and a later request succeeds;
  actual token rejection still signs out; requests renewing together share one
  renewal. Exercise the real HTTP client with controlled responses.

  **Completed 2026-09-08** ([PR #61](https://github.com/itsMattGuenther/Linger/pull/61)).
  Renewal now uses the same rejection
  distinction as startup. Eight new HTTP-client regression tests cover temporary
  failures, later recovery, actual rejection, shared renewal and the retry
  bound. Three failed against the original code. `scripts/check.sh` and
  `pnpm build` pass locally, and all five CI jobs passed, including the real
  S3 backend check. No dependencies or wire shapes changed. Human release
  checks remain open; this fix does not restore an unavailable server during
  startup (T-907).

- ✅ **T-904 · Density belongs in settings, not over every conversation** —
  effort: **low** — Matt, 2026-08-31
  `comfortable` / `compact` / `irc` sat in the room header *and* in settings.
  The header copy is gone; settings is the only home. **Nothing about the
  feature changed** — the same component, the same three modes, still one
  attribute on `<html>` and still remembered in `localStorage`.

  The reasoning is Matt's and worth keeping: a density is chosen once and then
  kept. A control for a decision somebody makes in their first week does not
  earn a permanent place above every conversation — it is chrome paid for on
  every screen, forever, for a choice nobody is making today. The room header is
  now the room's name, who is in it, the topic, and the two things that appear
  only when they apply (`back to the newest`, `since you were gone`).

  Two leftovers went with it: `.density`'s `margin-left: auto`, which existed to
  pin the control to the right of the room name, and the settings rule that
  undid it. `Stream` no longer takes `onDensityChange` at all — it reads
  `density` to decide grouping and nothing else.

  **SPEC did not have to change.** §5.6 lists the three modes; it never said
  where the control lives.

- ✅ **T-905 · Settings has a name, a cog, and four tabs** — effort: **low** —
  Matt, 2026-09-04
  From the first-time walkthrough: the panel was headed *you*, nothing on
  screen said *settings*, and it was one column of about sixty controls.
  Now: the heading is **settings**; the status bar shows your name as text
  with a **cog** beside it (the one icon every application agrees on, drawn
  inline in `currentColor` — no icon square, SPEC §5.1); the rail's `you`
  says `settings`; and the panel has four tabs, the same control the host
  panel uses — *you*, *reading*, *sound & voice*, *this computer*. "Update
  ready" in the status bar opens straight to the last one.

  Two legibility fixes went with it, both from staring at screenshots: the
  rail's `+ add` / `manage` / `+ room` / `settings`, the roster's `notify`,
  and the composer's `+ file` were `--text-faint` — about 2.3:1 against the
  rail, the least visible text in the window and also the way into most of
  the app. They are `--text-secondary` now, brightening to primary on hover.
  `+ file` no longer takes the accent on hover; SPEC §5.3 spends that on four
  things and this is not one. Native form controls follow the theme
  (`color-scheme`), so the device pickers and filters stopped rendering white.

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
- 🟡 **T-1802 · The switch and the owner window** — `LINGER_NEXT=1` opens
  `next.html` as `main`. It signs in with the existing sessions and shows real
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
  Window positions and sizes are remembered. The tray isn't built (decisions
  4 and 5).
- 🟡 **T-1809 · Several servers** — folding sections, the time there, quiet,
  and a server in its own window. Folding sections, your order and Quiet are
  built, with the list window connecting to every server; "the time there"
  waits on decision 3, and a server in its own window isn't built.
- ⬜ **T-1811 · Frames on a private channel** — the Rust core hands the list
  window its gateway frames on a Tauri `Channel` rather than a broadcast
  event, so no other window can make one up (architecture.md, "Still open").
  The app's own commands are already limited per window (`build.rs`,
  `capabilities/`, `src-tauri/src/acl.rs`).
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

*Milestone check: four people talk to each other, on four different networks,
for an hour, without anybody dropping.*

**The riskiest thing in the project.** AGENTS.md §"Where you will be wrong"
names two of these areas explicitly: WebRTC generated from memory works on
localhost and dies behind real NAT, and audio device handling breaks on hotplug
and sample-rate mismatch. Both warnings are load-bearing here.

**The architecture is already decided** (ARCHITECTURE §2): audio lives in
**Rust, not the WebView** — `webrtc-rs` for transport, `cpal` for devices. This
is not a preference. WebKitGTK's WebRTC is the weakest of the three engines, and
keeping audio out of the page removes it from the critical path entirely.

**Do not test this on one machine.** Two processes on one laptop connect over
loopback and prove nothing at all.

**The signalling landed 2026-09-01 (T-1401)** and it is the one piece of M12
that a single machine *can* prove, because there is no audio in it: the frames
are exercised by two real WebSocket clients in-process. **T-1402's transport
half landed the same day, and its microphone half on 2026-09-04** — real peer
connections, real ICE, and now a real microphone, Opus, and real speakers. A
tone put into one engine comes out of the other in the test suite, and the
device code has run against a real sound card. Everything past that needs
real networks. **SPEC §4.14 is written** — read it before the rest of this
milestone, because the decision it records ("voice happens in a room, not in a
call") is what the other four tasks assume.

**Building the desktop shell now needs two more things on the box**: ALSA's
headers (`libasound2-dev` on Debian, `alsa-lib` on Arch) for the microphone,
and `cmake`, which builds the vendored Opus. CI and the release workflow have
them; the README says so. Neither needs root on a machine that already has
them, and cmake installs fine in user space.

- ✅ **T-1401 · Signalling over the gateway** — effort: **high** — Matt, 2026-09-01
  Three client frames (`voice.join`, `voice.leave`, `voice.signal`) and two
  server ones (`voice.state`, `voice.signal`), all in `gateway/`. **No audio
  anywhere** — the payloads are opaque strings and nothing in this server parses
  one. **SPEC §4.14 and PROTOCOL §8's voice section were written in the same
  commit**; voice had a one-line scope entry and nothing else.

  **Voice happens *in a room*, not in a call.** You are already in the room, and
  joining voice is turning your microphone on where you are. That is the
  decision the rest follows from: no call object, nothing to be invited to, no
  ringing — and M13's "a room you leave running" becomes a small step rather
  than a rewrite, because a room you leave running is what this already is.

  ### A peer is a session, not a person

  A peer connection is between two *clients*, and somebody signed in on a laptop
  and a desktop is two of them. So the seat is keyed by session id, and
  `voice.signal` is addressed to a session — which needed `publish_to_session`,
  narrower than the `publish_to` a knock uses. `visible_to` grew a rule 0 for
  it.

  **Who offers is decided by the ids, not by who arrived first.** Of any pair,
  the lower `session_id` sends the offer. Both ends read the same `voice.state`
  and reach the same answer, so no pair ever sends two offers at each other.
  "Whoever joined later offers" needs an order both sides agree on, and a
  reconnect is exactly when they stop agreeing. `voice.state` is sorted by
  session id so a client can read the answer off the list rather than derive it.

  ### The half-connected state, which is what the criterion is about

  Two ways to get there, opposite directions, and each has a test.

  **A dropped socket must keep its seat.** A blip is two seconds of bad wifi,
  and tearing down every peer connection over it is worse than waiting. So the
  seat is released when the *session* ends, not when the socket does — which is
  also why a resumed session finds its peers still there and replays the
  signals sent while it was away.

  **A closed socket must lose its seat**, and this is the part that was wrong
  first. Saying goodbye and being cut off are different things, and the code did
  not distinguish them: closing the app held a seat for the full 120-second
  resume window, so everybody else was talking to somebody who had left. The
  reader loop now notices a WebSocket close frame and releases the seat there.
  The *session* still survives either way — a client that says goodbye and then
  resumes is resumed, it simply has to join voice again, which is what leaving
  means.

  ### Three rules that keep the frame from being something else

  - **Both ends must be in voice, in the same room.** Without that check
    `voice.signal` is a way to hand an arbitrary string to any session on the
    server — a side channel nothing else here has.
  - **A signal to a session that is gone is dropped, not refused.** Somebody's
    client closing mid-exchange is the ordinary end of a call; an error frame
    would be noise about a thing that is not wrong.
  - **`voice.state` names a room, so it is filtered like every other frame that
    does.** Voice in a DM is as private as the DM (SPEC §4.13) — and `room_of`
    having no wildcard arm is what forced that decision rather than leaving it
    to be remembered. It did not compile until both new frames were classified.

  ### Tests

  `crates/linger-server/tests/voice.rs` — eleven, over real WebSockets, with
  the acceptance criterion as one of them: a full offer→answer→candidate
  exchange that survives a forced disconnect, including a signal sent into the
  gap and replayed on resume.

  **Checked by breaking the code.** Removing the same-room check fails the
  cross-room test; releasing the seat on every socket close fails the resume
  test; removing the DM check on `voice.join` fails the outsider test.

  **One test was passing for the wrong reason and one mutation was aimed at the
  wrong line.** The DM-outsider test wrapped its assertion in `if let Some(state)
  = …`, so it passed by never running; it now asserts whether or not a frame
  arrives, because "no frame" is the right answer and "a frame naming Dave" is
  the wrong one. And the mutation meant for `voice.join`'s visibility check hit
  `typing.start`'s identical block first — the test only proved itself once the
  mutation was aimed properly.

  ### What this does not do

  No audio, by design — that is T-1402, and it is the treacherous one.
  **Nothing was tested across two machines**, because there is nothing to hear
  yet; the frames are what this task delivers and they are exercised by two real
  WebSocket clients in-process. The moment audio exists, AGENTS §"Where you will
  be wrong" applies in full: WebRTC generated from memory works on localhost and
  dies behind real NAT.

- ⏳ **T-1402 · The audio path** — effort: **treacherous** — Matt, 2026-09-01
  **The whole path is built** — transport on 2026-09-01, the microphone half
  on 2026-09-04 — **and it has only ever run on one machine.** It stays ⏳
  because its acceptance criterion is four networks, and that is HC-8 now.
  Read this whole entry before picking anything up around it.

  ### The microphone half (2026-09-04)

  Three files, and the seam `audio.rs` promised is filled without moving:

  - **`voice/device.rs`** — `Microphone` (an `audio::Source`) and `Speaker`
    (an `audio::Sink`) over `cpal`. Each owns one thread that opens the default
    device, starts the stream, and sleeps until dropped, so the stream is
    built and torn down on the same thread and the callbacks never block.
    The speaker keeps one queue per peer and sums them in the output callback,
    clamped, with a 200 ms ceiling per queue past which old audio is thrown
    away — a queue that grows is delay on every word from then on. The
    microphone prefers 48 kHz mono and either `i16` or `f32`; a device that
    will not do 48 kHz gets a linear resampler at the edge, which is good
    enough for a voice and small enough for T-1405 to replace whole.
  - **`voice/codec.rs`** — Opus in both directions, VoIP mode with in-band FEC
    on. A lost packet is *concealed* (libopus guesses from what came before)
    rather than zeroed, so it is a smear and not a click — and it keeps the
    far end's timeline the right length, which a zero-filled gap does not.
  - **`voice/mod.rs`** — the loop that was missing. One encoder for the whole
    mesh: a frame from the source is encoded once and written to every peer's
    track, because eight peers hear the same voice and encoding it eight
    times is eight times the CPU for the same bytes. `on_track` spawns a
    reader per inbound track that decodes and hands frames to the sink, and
    watches sequence numbers so a gap of one to four packets is concealed. The
    sender's RTCP is now drained too, which the interceptors need for NACK to
    do anything.

  **Joining opens the devices, or fails in words.** `Engine::join` takes a
  `Devices` pair and `voice_join` opens the defaults off the reactor; a machine
  with no microphone gets an error string back rather than a seat in voice it
  cannot use. Leaving drops the devices, which closes them. `Watcher` grew
  `audio_state` — `sending`, then `stopped` if the microphone goes away — and
  the shell forwards it as a `voice:audio` event for T-1404 to draw.

  **Opus is built from vendored source, not linked from the system.** That is
  what puts `cmake` on the build box list, and it is deliberate: a shipped
  Windows binary has no system libopus to find, and one copy compiled the
  same way everywhere is one fewer thing to be different between machines.
  `cpal` is the other new build dependency (ALSA headers on Linux, nothing on
  Windows or macOS).

  ### What was tested, and how

  - `tests/voice.rs::a_tone_crosses_a_peer_connection` is the one to know
    about: A's source is a 440 Hz tone and B's sink records. What B records
    has been Opus-encoded, packetised, encrypted, sent over a real peer
    connection, decrypted, depacketised and decoded — and the test checks it
    is loud and at 440 Hz. This is the closest one process gets to "somebody
    heard somebody".
  - The codec round-trips a tone and conceals a gap at full length; the
    resampler, the downmix, the framer and the mixer each have a unit test.
  - **Two tests need a real sound card and are `#[ignore]`d**
    (`cargo test --lib -- --ignored voice::device`): the microphone delivers
    25 frames in roughly half a second of wall time, and the speaker plays half
    a second of tone and closes. **Both passed on 2026-09-04 on a real
    machine** (PipeWire, a USB interface as default). CI cannot run them and a
    test that skips itself quietly is not one that passed, so they stay
    ignored rather than gated.

  ### The transport half (2026-09-01)

  `client/src-tauri/src/voice/` — real `RTCPeerConnection`s, a full mesh, real
  DTLS, real ICE, real RTP, driven by T-1401's frames. Three Tauri commands
  (`voice_join`, `voice_leave`, `voice_frame`) and a `voice:peer` event; the
  frontend forwards the two voice frames to the core and does nothing else with
  them, because audio lives in Rust (ARCHITECTURE §2).

  **`webrtc` needs nothing installed.** That was the open question and the
  answer is good: it is pure Rust down to the crypto, builds in about thirty
  seconds, and adds no system package to anybody's build.

  `mesh.rs` is the part worth reading. It is pure — a peer list in, a plan out —
  because that is where the bugs live that only show up on a bad network: a peer
  dropped and never rebuilt, two clients that both offer, a reconnect that
  leaves one side waiting for an answer nobody will send.

  **The lower session id offers.** Both ends read the same `voice.state` and run
  the same comparison, so no pair sends two offers at each other — that is
  *glare*, and it leaves both sides waiting on an offer the other discarded.
  "Whoever joined later offers" needs an order both sides agree on, and a
  reconnect is exactly when they stop agreeing.

  **Candidates that arrive before the answer are held, not dropped.** ICE
  trickles, so the far end starts sending them before its answer has been
  applied here. Adding one to a connection with no remote description is an
  error and dropping it is a call that takes the long way round or never
  connects — and on a good network you never notice, which is what makes it
  exactly the kind of bug AGENTS warns about.

  ### What none of this proves

  **Nothing here has been across two machines.** Both ends of every test are on
  loopback with no NAT between them, which AGENTS §"Where you will be wrong"
  names as the arrangement that works right up until somebody is behind
  carrier-grade NAT — and TASKS says it in fewer words: *do not test this on one
  machine*. `Engine::new` takes an ICE server list and it is **empty**, so today
  there is not even STUN: host candidates reach another machine on the same
  network and nothing beyond it. T-1403 filled that in the same day; whether
  it works against a real NAT is HC-9.

  **Three things are known to be missing and are not bugs:**

  - **No jitter buffer beyond the speaker's queue.** Frames are played as they
    arrive; a burst of late packets is absorbed up to 200 ms and then the
    oldest are dropped. Fine on a LAN, and the first thing to revisit when
    real networks are in play.
  - **Nothing pushes a frame to the WebView but state.** The surface (T-1404,
    landed the same day) reads three small events — a peer's connection
    state, our microphone's state, who is talking — and nothing else crosses.
  - **A microphone that goes away is reopened** for about twenty seconds
    before the sending half gives up and says so (`voice:audio` → `stopped`)
    — T-1405, landed the same day.

  *Accept:* four people, four networks, one hour, no drops. Anything less than
  that is not evidence. **Unchanged, and not met** — see HC-8 for the first
  half of it, which can be done today on one network.

- ✅ **T-1403 · A TURN server in the deploy** — effort: **high** — Matt, 2026-09-04
  coturn in `deploy/`, credentials that are not shared secrets in a compose
  file, and the host guide updated. Without this, anybody behind a phone network
  or a corporate router cannot connect at all — and it will look like a bug in
  the app rather than missing infrastructure.
  *Accept:* two clients connect where at least one is behind carrier-grade NAT.
  **Built; the acceptance is HC-9.** Nothing here has met a real NAT — the
  relay itself could not even be started on the dev box (no usable Docker), so
  what is proven is everything up to the relay's door.

  ### The shape

  Three pieces and one rule between them: **the server stores nothing and the
  relay looks nothing up.** coturn and `linger-server` share one secret; a
  member who joins voice asks `GET /voice/ice` and gets the relay's addresses
  with a password computed for them on the spot — coturn's time-limited
  scheme, `username = <expiry>:<user id>`, `credential = base64(HMAC-SHA1(
  secret, username))` — which coturn recomputes and checks against its clock.
  A day's TTL: longer than a call, short enough that a leaked one is a day of
  bandwidth and not a key. The client fetches it on every join, before its
  peer connections exist, because ICE needs its servers at the start.

  **No relay is an empty list, not an error.** A host who runs none has voice
  that works within one network, the server says so at startup, and the
  client joins anyway. `LINGER_TURN_SECRET` alone (with a domain) means
  `stun:`/`turn:<domain>:3478` over UDP and TCP; `LINGER_TURN_URLS` overrides.
  Half a relay is refused at startup: URIs without a secret, a secret with
  nowhere to point, or a secret under 16 characters.

  **"Not shared secrets in a compose file."** The one secret lives in `.env`
  (`deploy/.env.example`), which compose reads and nobody commits; the compose
  file references it and holds nothing. Per-member passwords are derived, so
  there is no list of them anywhere.

  **Behind a profile.** coturn is `profiles: ["voice"]`, so a plain `docker
  compose up -d` still works with no `.env` and runs no relay — the
  fifteen-minute host has not been made to generate a secret for a feature
  they may not want. `--profile voice` starts it. It runs `network_mode:
  host` because a relay's whole job is being reachable at its real address on
  a range of UDP ports, which container NAT gets in the way of. Ports: 3478
  TCP+UDP and UDP 49160–49200, in the host guide with the `--external-ip`
  note for a box behind a home router.

  ### Where it lands in the code

  - `linger-core::wire::{IceServer, IceServers}` — the shape `RTCIceServer`
    has and nothing more; exported to TS like every wire type.
  - `linger-server::turn` — `username`, `password`, `ice_servers`, pure and
    tested against a **known answer computed independently** (python's
    `hmac`), because if this HMAC ever disagrees with coturn's, every call
    fails and nothing in Rust would notice.
  - `config::TurnConfig`, redacted in `Debug` like `S3Config`, with the
    startup checks in `turn_config` and its own unit tests.
  - `routes/voice.rs` — one authed GET. `tests/voice_ice.rs`: no relay is an
    empty list; a relay hands out a dated password for *this* member that
    verifies against the secret; two members never share one; a stranger gets
    401.
  - Client: `joinVoice` fetches `/voice/ice` and passes `servers` to
    `voice_join`; a server that cannot answer means an empty list, not a
    failed join. The shell turns them into `RTCIceServer`s and `Engine::join`
    now takes them per call (the constructor's list is the fallback), so the
    same engine can join with a fresh password every time.

  ### What none of this proves

  The acceptance criterion is a real NAT and this box has no way to put one
  in the path. The whole chain from "member asks" to "peer connection is
  configured with a dated password" is tested; the chain from there through
  a real coturn to a machine on a phone network is HC-9, and it is the thing
  AGENTS §"Where you will be wrong" was written about.

- ✅ **T-1404 · The voice surface** — effort: **medium** — Matt, 2026-09-04
  Join and leave, who is speaking, per-person volume, push-to-talk, a device
  picker, mute. Console design system: no bubbles, no glow, no animated rings.
  *Accept:* usable by somebody who has not read anything. **Built; the
  "somebody" has not tried it yet** — that is HC-8, which no longer needs the
  devtools.

  ### Where it lives

  **One line under the room's header** (`client/src/voice/VoiceBar.tsx`),
  because voice happens in a room (SPEC §4.14) and a panel of its own would
  say otherwise. Empty of everybody, it is one small control: `Join Voice`.
  With anybody in, it is the word *voice*, the names, and — while you are in —
  `mute` and `leave voice`. Somebody talking is their name at full weight
  against everybody else at rest; no ring, no glow, no bar that bounces.

  **A word on the roster card**, not a badge: `in #garage · voice`, at the
  same weight as "in a room", because it is the same kind of fact.

  **Settings → voice** holds the two things chosen once: the microphone and
  speakers (by name, from the core's list, with the system default named as
  such), and push-to-talk. A device you picked that is not plugged in today
  shows as such and the default is used — the join is never refused over it.

  ### What the store holds now

  `GatewayState` grew three fields. `sessionId` from `ready`, because a seat
  is a session and the join needs to say which. `voice`, room id → the
  server's whole peer list, folded from `voice.state` (an empty list is no
  entry). And `myVoice`, which is **local state and nothing else**: mute,
  each peer's connection state, who is talking, our own volumes for people.
  None of that is on the wire and none of it should be.

  **The server's list is the truth about the seat.** A `voice.state` for our
  room without our session in it drops `myVoice` *and* tells the core to
  leave, so a microphone is never left open after the server has said we are
  gone (a lapsed resume window, say). A fresh `ready` clears all three fields
  for the same reason: it is a new session.

  **One seat, anywhere.** `joinVoice` leaves any seat held on any server
  first; the server sees a leave before the join.

  ### What the core grew

  - **Mute** is a flag the sending loop reads every frame; muted, it encodes a
    frame of zeros — silence rather than nothing, so the far end's decoder
    keeps its clock. `voice_mute` sets it. Push-to-talk is the same flag on a
    key: `Control` held opens the microphone, released closes it, and losing
    window focus closes it too, so an alt-tab mid-word does not leave it open.
  - **Who is talking** is decided in Rust with the samples in hand
    (`voice/level.rs`): RMS against a threshold with a 300 ms hangover, so a
    breath between words does not flicker. Fired *on change only* as a
    `voice:speaking` event (`peer: null` is you, after mute), so a quiet room
    sends the window nothing.
  - **Per-person volume** is a gain on the speaker's lane for that peer,
    clamped at twice as sent. `voice_volume` sets it; it never crosses the
    wire.
  - **Devices by name**: `voice_devices` lists inputs, outputs and the two
    defaults; `voice_join` takes an input and output name and falls back to
    the default for a name that is gone.

  ### Tested

  - `tests/voice.rs::muting_sends_silence_and_the_mark_follows` — over a real
    peer connection: the tone arrives, mute makes the frames quiet without
    stopping them, unmute brings the tone back on the same connection, and
    B's watcher saw A marked talking → quiet → talking, each change once, while
    B's own silent microphone was never marked.
  - `level.rs` unit tests for the gate: on once, no flicker inside a word,
    off once after a real pause, nothing from silence.
  - `gateway.voice.test.ts` (nine): the fold, the join order (mute before
    join for push-to-talk, with the session id and the device names), leaving
    another server's seat first, a refused join leaving nothing behind, the
    server's list dropping our seat and the core being told, the three core
    events folding in and being ignored without a seat, and a fresh `ready`
    clearing everything.
  - `voice.test.ts` for the pure parts: seat order (you first, then by name,
    two sessions of one person as two seats), the microphone line, volume
    labels and clamping, preferences round-tripping.
  - The device listing test ran on real hardware and named the defaults.
  - **Pressed in a running app, on one machine** (2026-09-04): a local
    server, the desktop app signed in as the host, one room. `Join Voice`
    opened the real microphone and speakers through the core, the server
    answered, and the line read `VOICE  Matt you  mute  leave voice` with
    `in #garage · voice` on the roster card; `mute` flipped to `muted`;
    `leave voice` put the line back to `Join Voice` and the roster word went.
    The picture is [`docs/t1404-voice-line.png`](docs/t1404-voice-line.png).
    Nothing crossed a network and nobody was on the other end — HC-8 is
    still the check that matters.

  **A dev-box note that will bite the next person**: on Hyprland with an
  Nvidia card the app dies at launch with a Wayland protocol error from
  WebKitGTK; `WEBKIT_DISABLE_DMABUF_RENDERER=1 pnpm tauri dev` fixes it.
  That is a machine quirk, not a Linger bug, so it lives in a home-directory
  note and not in the README.

  ### Not done, on purpose

  A device change mid-call is "leave and join again", said in words in
  settings; switching live is T-1405's territory. The push-to-talk key is not
  configurable. The speaking mark is a light, not voice activity detection
  that gates the encoder — that is M13's, where it has to save CPU rather
  than draw a name.

- ✅ **T-1405 · Devices that change under you** — effort: **high** — Matt, 2026-09-04
  Its own task because AGENTS says so: headphones unplugged mid-call, the OS
  default device changing, a device that wants a different sample rate.
  *Accept:* unplug and replug headphones during a call; audio continues on the
  new device without a restart. **Built; the unplugging is HC-8 step 7.**

  ### How it works

  Each device already had a thread of its own that opened it and held the
  stream. That thread is now a **supervisor** (`Worker` in `voice/device.rs`):
  the stream's error callback rings an `Alarm` the worker is waiting on, the
  worker drops the dead stream and calls the same opener again — the
  *default* device if that is what was asked for, which is how "the OS moved
  to the headphones" becomes "audio continues on the headphones". Every half
  second, forty times, then it gives up: about twenty seconds, long enough to
  swap a plug and short enough that a room is not left wondering.

  **Giving up is said out loud.** The microphone's give-up sends the sentinel
  its `Source` already understood, so the engine's loop ends and the surface
  shows `stopped` — the same as before, only twenty seconds later and only
  when it is true. The speaker's give-up is silence. While the worker is still
  trying, frames simply pause and resume; nothing above the seam sees it.

  **The sample rate can change with the device.** The speaker's rate is an
  atomic the worker rewrites on reopen, and every lane is *retuned* first —
  queue emptied (it was for the old device), resampler rebuilt for the new
  rate, your volume for that person kept. The microphone's framer is built
  fresh per open, so it always resamples from whatever the new device runs at.

  **The first open is not retried.** Somebody pressing `Join Voice` on a
  machine with no microphone gets the error in words, now, not twenty
  seconds of nothing.

  ### Tested

  The supervisor is generic over the stream and the opener, so the schedule
  is proven with a stand-in and no device anywhere near it: a death is one
  rebuild and a second ring for the same death is not another; a first-open
  failure is the caller's answer and is not retried; a device that never comes
  back is given up on exactly once after `attempts` failures; a run of
  failures that recovers resets the count; a stop ends everything and a late
  ring builds nothing. Lane retuning has a unit test. The three hardware tests
  still pass on a real sound card.

  ### What none of this proves

  Nothing has been unplugged. Whether cpal on each OS actually reports a
  vanished device through the error callback — rather than going quiet and
  reporting nothing — is exactly the kind of fact AGENTS says only a real
  machine can supply, and it is HC-8 step 7. If a platform goes quiet
  instead, the fix is a watchdog on frame arrival, and it has a place to go.

---

- ✅ **T-1406 · Keep the shipped voice relay starting** — effort: **medium** —
  Matt, 2026-09-17. The onboarding test found that `coturn/coturn:4` rejects
  the shipped `--no-dtls` flag and repeatedly exits. Remove the obsolete flag,
  test the actual Compose command against the image, and make the host guide
  distinguish a running relay from a restarting or missing one. Keep the
  README's server instructions accurate.
  *Accept:* the shipped relay stays running with a test secret, refuses an
  empty secret, and CI exercises that startup path. No client or protocol
  changes. HC-8 and HC-9 remain open; a startup test is not a voice-call test.

  **2026-09-17 progress:** the new CI smoke check reproduced the exact
  `unrecognized option '--no-dtls'` failure against the shipped image before
  removing the flag. The check runs the Compose command with no published
  ports and a disposable secret, then checks the missing-secret refusal.
  The host guide now checks for a stable `Up` state, diagnoses missing or
  restarting relays, and keeps the voice profile when updating. Local rules,
  version, shell syntax and Compose validation pass; the full local gate is
  unavailable because Cargo is not installed. CI results belong to PR #66.

  **Completed 2026-09-17** (PR #66, merged). CI passed, including the actual
  relay startup/missing-secret smoke check and server image build. The full
  local gate also passed on the subsequent onboarding branches containing
  this fix, using a temporary toolchain. HC-8 and HC-9 remain open; merging
  the startup fix does not close the real-network voice checks.

- ✅ **T-1407 · Shared mute state and deafen** — effort: **high** — Matt,
  2026-09-17. Show each voice session's self-reported mute/deafen state.
  Deafen silences incoming voice and mutes the microphone together; undeafen
  restores the previous mic choice (push-to-talk stays closed until pressed).
  Nobody can change another person's controls. Keep room/DM membership
  filtering and old-client compatibility; unknown legacy state is not “live”.
  *Accept:* real gateway tests cover isolation, resume and legacy joins;
  native audio tests cover both directions, queued playback and restoration;
  client tests cover controls and visible states. Record real-device checks
  separately; do not close HC-8/HC-9 from local automation.

  **2026-09-17 implementation:** additive controls on `voice.join` and
  `voice.state`; old clients remain usable and their state is shown as unknown.
  The native encoder and speaker gate enforce deafen before reporting it;
  queued and newly arriving audio is discarded without losing peer volumes.
  Undeafen restores the prior mic choice, with push-to-talk closed until a new
  press. Controls survive moves and disappear on leave. Gateway tests cover
  same-person session isolation, normalization, legacy joins, DM privacy and
  replay across a forced disconnect. Native tests cover tone/silence, playback
  queues and restoration; browser tests exercise the real controls. The full
  local gate, 425 client tests, 42 Chromium cases, typecheck and production
  build pass. **PR #75 merged 2026-09-17:** all CI checks pass, including
  84 Chromium/WebKit browser cases and the server image build. Installed Linux/
  Windows listening and the existing real-network checks remain open.

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
