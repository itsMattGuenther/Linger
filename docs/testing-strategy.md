# Testing strategy

Keep fast, repeatable checks in CI. Use real packages for platform behavior,
and reserve human time for things automation cannot hear or reproduce. Catch
each kind of problem at the cheapest place that can catch it. Setting up the
tools is in [development.md](development.md#checks).

The short version: **run `scripts/check.sh` before you push.** It runs the
checks for what your branch changed, including the browser tests in
Chromium, and in WebKit where Docker works, when the client changed. It says
what CI adds on top.

## Where checks run

| Where | When | What | How long |
|---|---|---|---|
| Your machine | Before every push | `scripts/check.sh`: the checks for what the branch touched | Under a second for docs; about 3 minutes for a client change with WebKit, 1½ without, more when the branch edits browser tests (each runs ten times); a Rust change also rebuilds, which is slow in a fresh copy |
| A pull request | Every push | `ci.yml`: the same selection, plus S3 against MinIO, the relay and a real server update in Docker, the WebKit browser tests, and the browser tests the PR added or edited ten times in both engines; `package-check.yml` builds the desktop packages on Linux and Windows | About 5 minutes; the packages about 10 |
| `main` | Every merge | `ci.yml` for what the merge changed. A run still waiting is cancelled when a newer merge lands, since the newer run covers it | As a PR |
| `main`, nightly | 08:23 UTC | `nightly.yml`: every CI check, the package checks, the Windows and macOS shell builds, and every browser test three times with no retries. A failure opens an issue | About 40 minutes |
| A release | A `v*` tag | `release.yml` and `image.yml` each run every CI check on the tagged commit first and build nothing unless it passes; then the signed packages, their audio, the Buddy list starting on Linux, the Windows shortcuts, and the server image | About 25 minutes |
| Real computers | Before a release, when an area changes | The [release checks](tasks/release-checks.md): several computers, real networks, audio devices, installs | By hand |

## Layers

| Check | What it proves | What it does not prove |
| --- | --- | --- |
| Rust/TypeScript tests | Logic, real HTTP/temp SQLite, forced gateway reconnect, palette contrast, generated types | Desktop rendering or physical audio |
| Chromium + WebKit browser tests | Real components with synthetic people, keyboard/pointer behavior and geometry | Installed WebView2/WebKitGTK behavior |
| Linux/Windows package checks | Installation, icons, recorded chimes, Windows shortcut upgrades, the list window starting and drawing at every interface size, a minimized or tray-hidden Windows window stopping its drawing and coming back drawn, nothing the shipped CSP refuses, a shared screen's VP8 and H.264 playing in the packaged app on Ubuntu's WebKit and on Arch's current one (`scripts/linux-arch-check.sh`), and the app refusing to play one, without crashing, where WebKit draws on the CPU (#729); on Windows, the shell's own tests of the computer's sound in a share: Windows' process loopback started and read for a second, where the runner has an audio engine, and the 20 ms packets it makes (#736) | Signed-in use, every distro, physical speakers, real-network voice, a real GPU, the computer's sound heard with somebody talking |
| GPU check, before every release | The packaged app plays a shared screen on Arch's WebKit with a real computer's GPUs and their hardware decoders installed, and a chat's video shows its picture there, the page drawing on NVIDIA's own EGL too where the computer has it (`scripts/linux-arch-check.sh --gpu`, `docs/releasing.md` step 1, #730, #756) | GPUs that computer doesn't have, Windows' decoders, native Wayland (it runs X11 with GBM forced on, as Wayland has it) |
| Short two-person release check | Your installed clients, actual update path, listening and interaction | Exhaustive platform coverage |

The package audio harness injects a test-only bundle of the real sound player
into the installed app, signed in nowhere, and records what reaches a private
virtual speaker. Until 0.4.3 it also measured the previous client's layout in
the package; that part went with the previous client (#306). The Buddy list's
own start-up and layout in the package are `scripts/linux-next-check.mjs` and
`client/scripts/windows-next-check.mjs`. What a minimized or tray-hidden
window does on Windows is `client/scripts/windows-hidden-check.mjs` (#594,
`docs/windows-update-checks.md`), which drives the installed list window with
Win32 calls (`client/scripts/windows-window.ps1`) and reads its page over
WebView2's debugging port. Nobody building Linger has a Windows computer, so
Windows behavior is checked like this, on GitHub's Windows runners, not by
hand. None of these is a live-server test; a signed-in desktop check is
T-1820.

Run the existing `scripts/linux-audio-check.py` and Windows package scripts as
documented in [packaged audio checks](packaged-audio-checks.md). They require a
fresh isolated profile. Windows checks are restricted to disposable CI runners.
Release builds run these checks again against the signed updater artifacts.

## What a change sets off

`scripts/ci-scope.mjs` sorts the changed files, and both CI and `check.sh`
use it. It looks at the whole branch, not only its last commit, counts both
sides of a rename, and runs everything if Git can't compare revisions or a
path isn't one it knows. Nothing is skipped just because the latest commit
only changes documentation.

| You changed | `check.sh` runs | CI adds |
|---|---|---|
| Only docs: `docs/`, any `*.md`, `LICENSE` | The rules lint and version check | Nothing |
| The server, `crates/linger-server/` | fmt, clippy, the Rust tests, bindings drift | S3 against a real MinIO |
| The client, `client/` | Typecheck, unit tests, the browser tests in Chromium and (with Docker) WebKit, the production build's CSP check | The packages on Linux and Windows, and WebKit when `check.sh` couldn't run it |
| Only browser tests, `client/tests/browser/` | As the client | WebKit when `check.sh` couldn't run it (no packages) |
| The desktop shell, `client/src-tauri/` | Its clippy and tests, when the GUI libraries are installed | The packages |
| `deploy/` | The Rust checks and the update script's test | S3, the relay and a real server update in Docker |
| The startup measurement, `scripts/startup-time.mjs` | Its own tests (below); the measuring itself is run by hand ([performance.md](performance.md)) | Nothing more |
| Shared types (`crates/linger-core/`, `client/src/generated/`), CI, `scripts/`, anything else | Everything | Everything |

Every run, locally and in CI, also runs the rules lint (`scripts/lint-rules.sh`:
AI attribution, dropped vocabulary, file names only differing in case), the
version check, and the tests of these scripts themselves
(`node --test scripts/ci-scope.test.mjs`, `scripts/csp-assets.test.mjs`,
`scripts/package-deps.test.mjs`, `scripts/playwright-image.test.mjs`,
`scripts/issue-label.test.mjs`, `scripts/action-pins.test.mjs`,
`scripts/workflow-downloads.test.mjs`, `scripts/linux-next-env.test.mjs`,
`scripts/doc-paths.test.mjs`,
`scripts/startup-time.test.mjs`,
`python3 scripts/linux-audio-check.test.py`,
`scripts/android-signing-test.sh`, `scripts/tidy-branches-test.sh`,
`scripts/apt-mirrors-test.sh`, `scripts/apt-install-test.sh`, and
`scripts/appimage-fetch-test.sh`).

**One required check.** GitHub requires only `all green` before a merge. It
waits for every other `ci.yml` job and passes when each passed or was skipped
because the change didn't touch it. Anything else fails it: a job that failed,
was cancelled, or never ran because GitHub had no machine for it, which
GitHub reports as `abandoned` (#445). A new job joins by being listed in its `needs`, and
`scripts/ci-gate.test.mjs` fails if one isn't. The package checks run in their
own workflow and don't block a merge; the nightly run and every release run
them.

**Every action is pinned.** Each action a workflow takes from another
repository is named by a full commit SHA with its version in a comment
(`actions/checkout@<sha> # v4.4.0`), never by a tag or a branch. Whoever owns
an action can move its tag to new code, and the release job runs actions next
to the updater's signing key (#491).
`scripts/action-pins.test.mjs` fails on one that isn't pinned. To move to a
newer version, look up the commit its tag points at
(`gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`) and change the SHA and
the comment together. Dependabot does that once a month
(`.github/dependabot.yml`): one pull request moves every action that has a
release at least a week old, and it is merged like any other.
`dtolnay/rust-toolchain` has no version tags, so Dependabot leaves it alone:
move it by hand to a commit from its `master` branch, and pass
`toolchain: stable`. `tauri-apps/tauri-action` builds the release and writes
`latest.json`, and no pull request runs it, so a major version of it is worth
a practice draft release before it's merged, as 1.0 got (#597). Its 1.0 writes
`latest.json`'s links as GitHub API links; `release.yml`'s `updater-json` job
puts the normal download links back (`scripts/updater-urls.mjs`, tested in the
rules job).

`scripts/check.sh --all` runs everything whatever changed. So does a branch
with nothing to compare against. `scripts/check.sh <base>` compares against
something other than `origin/main`, such as `upstream/main` in a fork.
Superseded PR runs are cancelled.

## Which test to write

Test at the lowest level that can prove the rule. A unit test runs in
milliseconds and never fails at random; a browser test takes seconds and
depends on timing.

| What you're proving | Where the test goes |
|---|---|
| A rule in the client's logic: ordering, parsing, what the store keeps | A unit test beside the code (`client/src/lib/*.test.ts`, `client/src/next/**/*.test.ts`), run by Vitest |
| A rule the server keeps: limits, who may do what, what an endpoint returns | An integration test in `crates/linger-server/tests/`, driving real HTTP against a temporary SQLite file |
| What a screen looks like, or how it answers the keyboard and mouse | A browser test in `client/tests/browser/`, on a fixture page with the desktop shell and servers faked. The design system's rules (`docs/design/system.md`) are measured there |
| Gateway resume, sequence numbers, reconnects | A test that really drops the connection, not a mock (`AGENTS.md`) |
| The installed app: what it's allowed to load, its packages, native audio, shortcuts | The package checks: `scripts/csp-assets.mjs`, `scripts/linux-next-check.mjs`, `scripts/linux-audio-check.py`, `scripts/windows-*.ps1` |
| Several computers, real networks, audio devices, operating-system versions | The [release checks](tasks/release-checks.md). No automated test covers these |

## Fixes need regression evidence

For each bug, link the issue and PR and add a check for the reported behavior.
Where practical, run it against the old behavior first and record that it
fails. Assert the result a person needs, not just a class name or implementation
detail. Shared CSS fixes must cover both rendering engines and both desktop
platforms, including short windows, long names and the supported interface sizes.
Test the combined release candidate: separately green PRs can disagree.

**A setting that covers a whole process reaches everything that runs in it.**
0.5.3 ranked the hardware decoders out of WebKit's page process to fix
watching a shared screen on Linux (#730), and checked that a shared screen
played. The same ranks reached every video in a conversation, which went solid
green on NVIDIA (#756), and nothing checked a chat video. So a change to what
the Linux app's startup hands WebKit or GStreamer (`linux_startup.rs`:
decoder ranks, WebKit's media and drawing switches) is checked against every
media feature there, and the pull request says how. A check that can't fail where the bug was
proves nothing: the GPU check only showed #756's green once the container had
`/dev/udmabuf`, so run a new check against the release that had the bug first.

| Feature | Checked by |
|---|---|
| A video in a conversation (H.264 MP4, WebKit's player) | `linux-next-check.mjs`, every run: its picture read back; the GPU check on NVIDIA's EGL, with `/dev/udmabuf` |
| A voice message (Opus in WebM) and a sound file (MP3) in a conversation | `linux-next-check.mjs`, every run: each plays, its time moving on |
| A shared screen (VP8, H.264, WebCodecs) | `linux-next-check.mjs` with `--webkit-gpu`; the GPU check |
| Linger's own sounds | `scripts/linux-audio-check.py` |

A new rule gets the same: a test that proves it, named in the pull request
(the template asks). Most bugs that reached people after 0.4.0 were rules
nobody had tested yet, such as an invite for Anyone running out (#246), DMs out
of order (#248), line breaks dropped (#289), and video seeking (#222). Each
was cheap to test, and the tests only came after.

## What reviews have taught

Every real catch a reviewer makes is a gap in these checks, so each one comes
with a change that would have caught it first (`AGENTS.md`). The catches and
what they changed are in [review-catches.md](review-catches.md); these are the
rules that came out of them.

- **Anything that talks over a network is tested through the ways a network
  fails:** a refused connection, one dropped before any bytes, one cut off
  half way, an error status (a 503), one that never answers, and an answer
  that isn't what was asked for. Each with a stand-in server on this machine,
  as `scripts/appimage-fetch-test.sh` does. Its first version tested a drop
  before any bytes, not half way through (#758).
- **A check that reads code or commands** (a lint, a parser, a rule about
  which files a change touches) **starts from a table of tricky inputs**:
  quoted and unquoted, with and without spaces, several commands on a line,
  a command continued over lines, and every way to write what it looks for:
  every form the language has, not only the ones in use today (Markdown
  links come plain, in angle brackets, as references and as HTML; #771).
  `scripts/workflow-downloads.test.mjs` took three rounds of review to get
  there (#763).
- **State worked out from a room's history, or kept beside it, is tested with
  the history in every shape the app holds it:** older history only, the
  newest not loaded, trimmed, paged back in, replaced by a window around a
  message. The app never holds a whole conversation (#173), and two catches
  came from assuming it does (#751, #759; #766 for the store).
- **A check that proves the app does something starts where it isn't
  already done.** An environment, a file or a setting the check inherits can
  pass for what it's there to prove (#757; #765 for the packaged-app check).
- **Test what a script does, not what its source says.** A test that looks
  for a line in the source passes a change that keeps the line and defeats
  it. Run the script, with stand-ins on `PATH` for what it calls, and check
  what came out, as `scripts/linux-next-env.test.mjs` does with `xvfb-run`
  (#768). A test that reads files on purpose (a lint over the workflows, two
  lists kept equal) is the exception, and says so.
- **A card or popover that opens from one of several things** (a person's
  chip, a row) **is tested going straight from one to the next** while it's
  open: the second must be that one's own, with the keyboard and nothing
  left from the first. Every test that opened one card and closed it missed
  that the voice bar's card kept the last one's refusal (#774).
- **A card or popover is tested at its limits:** words taller than the
  window, the window resized while it's open, its opener pressed again, and
  what it shows changing under it. A topic's card failed all four, and a late
  font cutting words that fitted, the first time it was reviewed (#796).
- **A value shared between windows is tested changing in another window
  while it's showing**, after a change made here and before the owner's
  answer to it: a card that held its own level until it closed showed none
  of the changes made in the voice bar (#774).
- **A check that guards an action is made again right before the action**
  when anything slow sits between them (a network request, a download, a
  password prompt), and **tested with the state changing in between**: the
  list checked voice before asking the shell to update, the shell then
  fetched and downloaded for a minute, and a call joined in that minute was
  restarted (#794). The same for a date or a version approved earlier: an
  install with nobody pressing anything reads the feed again. And an answer
  that can come back after what it depends on has changed is tested arriving
  before the change and after it (#794).
- **A release job is safe to run again** after the release is published:
  re-running one once undated a published release's feed (#794).
- **What another window asks the list to do is tested failing**, from the
  list's side, and the asking window shows it: Settings' Restart now stayed
  pressed, saying Linger would restart, after the list's install failed
  (#794).
- **A phone screen is tried held sideways**, short and wide, as well as
  upright. Whatever rises from the bottom does so in the kit's `Sheet`,
  which is never taller than the screen; its own test covers every kind
  (`kit.spec.ts`, #776). One built outside it ran off a phone held
  sideways (#774).
- **Scripts that look for system files look where every distro keeps them:**
  `/usr/lib` (Arch), `/usr/lib64` (Fedora), `/usr/lib/x86_64-linux-gnu`
  (Debian, Ubuntu). And never bind-mount a path that might be missing: Docker
  makes an empty directory in its place (#757).
- **A fallback covers only the case it's for.** `a | b || echo none` also
  hides `a` failing. Run what has to work on its own line, and treat only
  the exit status that means "nothing found" (`grep`'s 1) as none. Then run
  the step once with each part failing, with stand-ins on `PATH`. The iPhone
  build's report of Apple's listed calls read a failed `nm` as none of
  them (#781).
- **Anything a person can stop or overtake while it waits** (reading files,
  a pick, an upload) **is tested interrupted:** turned down partway,
  overtaken by something newer, and partly failed. After each wait the code
  checks it's still wanted. Sharing to Linger was tested only going through,
  and a share turned down while it read was sent anyway (#792).
- **What the phone app writes outside its temporary and cache folders is
  kept out of backups** (SPEC §4.15): marked on the iPhone, where an App
  Group's folder is backed up by default (#792).

## A test that fails at random

Don't just re-run it and move on. Sometimes the test is at fault: it waits a
fixed time, or measures a frame that a busy machine draws late. Sometimes the
app is: #266 looked like a flaky test and was a real race in how history
loads, and #716, failing once in a nightly run, was a busy computer throwing
the reader a page up when older history went in. That is why there are no blanket retries ([L-31](design/lessons.md)):
a retry that passes hides both.

One check plays again, once, for one proven cause. When the packaged audio
check's recording is the right sound with pieces missing or held up, the runner stopped
for longer than the audio buffers hold, and the check plays its set again on a
fresh app (#384). A click, a changed level or anything else fails at once, so
does losing audio twice, and the first recording is kept
([packaged audio checks](packaged-audio-checks.md#lost-audio-on-a-paused-runner-384-2026-10-02)).

1. Re-run the failed job once, to be sure it is random and not your change.
2. Open an issue the same day with the test's name, the run, and the error.
3. Make it fail on purpose before changing anything, by squeezing it: the
   tests, the page server and the browser on two CPUs, several copies at once.
   `taskset -c 0,1 pnpm exec playwright test <file> -g <name>
   --repeat-each=8 --workers=4` in Chromium;
   `LINGER_WEBKIT_CPUS=0,1 taskset -c 0,1 scripts/webkit.sh <file> -g <name>
   --repeat-each=8 --workers=4` in WebKit, whose browser is in a container
   `taskset` can't reach. A fix that turns 8 failures in 8 into 8 passes is
   proof; a pass on an idle machine isn't.
4. Fix whichever is wrong. Fixtures deliver events explicitly and in order;
   a test waits for the thing itself, never for a fixed time. A test that
   takes over 15 seconds on CI (half the usual limit) is one busy runner away
   from failing: split it, or mark it `test.slow()` if it is long by design
   (#328).
5. If it can't be fixed that day and it is failing other people's pull
   requests, mark it `test.fixme` with the issue number, so it stops blocking
   them. The issue stays open until the test is back.

Two things catch these before they bite:

- **A browser test a branch adds or edits runs ten times before it lands**
  (L-31). `scripts/changed-tests.mjs` finds the tests from the lines the
  branch changed: an edit inside a test picks that test and the next one; an
  edit above every test in a file (imports, helpers) picks the whole file.
  `check.sh` runs them ten times in Chromium; CI's `new tests, repeated` jobs
  in both engines, with fewer repeats (never under two) when a PR touches many
  tests, to stay near 300 runs per engine.
- **Every night, every browser test runs three times** with no retries
  (`nightly.yml`). A test that fails there opens the nightly issue.

## Waiting in a browser test

Most of the random failures so far were a test acting a moment too soon. The
rules that came out of them:

- **Wait until it holds still before you click it or measure it.** Before a
  click, Playwright waits until the target is where it was one animation
  frame ago. In Linger that isn't enough: a conversation keeps moving after it
  first appears (a link card loads above and pushes the messages down, the log
  scrolls a new message into place), and so does a window making room for a
  side pane. A click aimed at where a name was lands beside it (#331, #361).
  `still(locator)` in `tests/browser/still.ts` waits until the thing's box is
  the same on two looks 100 ms apart. Call it before clicking anything in a
  conversation and before any `boundingBox()` whose numbers you compare.
- **Measure against the thing's own container, not the screen.** A position
  on the page moves whenever anything above it does; a video's place in its
  own row doesn't (#357).
- **Wait for the fixture to say it's ready.** The fixtures write what the page
  asked of the fake shell and servers into `document.body.dataset.did`, in
  order: a `ready` for each connection (React's development mode opens two,
  #355), and `answered:<event>` once the fake shell has handled a request.
  Wait for the line, then act. The list and side specs' `settled(page)` waits
  until every connection has had its `ready`.
- **A clock you mean to stop needs `pauseAt`.** `page.clock.install()` on its
  own swaps in a fake clock that still runs at real speed, so a timer the
  test means to hold back fires anyway, at a random moment (#367). Install
  it, open the page, `pauseAt` a time well ahead (opening can take a second
  of that clock), then move it on with `runFor` or `fastForward`.
- **A blank page with `net::ERR_NETWORK_CHANGED` in the trace is your machine,
  not the test.** Chromium drops every request in flight when a network
  interface comes or goes, and Docker adds one each time it starts a container
  on its own network (a VPN or Wi-Fi change does the same). Don't start
  containers while the Chromium tests run. `check.sh`'s own containers add
  nothing: actionlint runs with no network, and `webkit.sh`'s container shares
  the machine's. Until #528, actionlint ran on Docker's network, so every
  `check.sh` that started blanked pages in any other `check.sh` already
  running its browser tests: 4 of 96 sign-in tests failed beside one
  container a second, and none beside the same container with no network.
  The relay and server-image checks (`coturn-test.sh`,
  `image-start-test.sh`) need a network, so don't run them beside a browser
  run.

## Browser tests

- **Check what the person sees, at the speed a real server answers.** A
  sent message once landed below the bottom of the conversation, only its
  name showing, and every test passed: the test page's server answered in
  20 ms, and the tests looked for the message's words, not for them on
  screen (#750). Something that appears or changes in a conversation gets
  checked on screen (`toBeInViewport`, or its box against the
  conversation's), and the chat window's test page can answer as slowly as
  a real server: `?netms=N` for every request, `?sendms=N` more for a send.
  `next-newest-lands.spec.ts` does each thing that adds or changes the
  newest row while you're at the bottom (a message, long or short, a reply,
  three together between two frames, a photo with and without its size, a link card, an edit, a
  reaction, a poll, a join or share line) at 250 ms, and checks the row is
  on screen whole and read. A change to a row that's already there waits
  until the conversation is still first: changed while it was still being
  followed down, the follow carried it to the end and hid the slip (#760).
- The same tests run in Chromium, the engine of WebView2 on Windows, and in
  WebKit, the engine under WebKitGTK on Linux. WebKit is slower and finds
  timing problems Chromium doesn't.
- Locally, `check.sh` runs Chromium. Once, run
  `cd client && pnpm exec playwright install chromium`, or set
  `LINGER_CHROMIUM_PATH` to a Chromium you already have.
- On Linux, Playwright's WebKit only starts on Debian and Ubuntu, so
  **`scripts/webkit.sh`** runs it in Playwright's own Ubuntu image with
  Docker, on any Linux (#325). Only the browser is in the container; the tests
  and pages stay on your machine, and the container shares its network.
  `check.sh` runs it whenever Docker works, and says so when it doesn't. On
  macOS and Windows, Playwright's WebKit runs natively. Any arguments go to Playwright:
  `scripts/webkit.sh tests/browser/next-media.spec.ts --repeat-each=10`.
  The whole WebKit suite takes about 2 minutes this way, against about 8 on
  CI. The image is about 3.5 GB and downloads on first use.
- **WebKit gets 60 seconds a test, not 30, on CI and locally.** On CI a
  freshly started WebKit once took 25.5 seconds to open its first tab, before
  the test had done anything (#335); every other tab opens in well under a
  second. Locally, `webkit.sh` runs every worker's WebKit in one container,
  about 2.7 times slower than CI: a glow test that takes 9 seconds on CI took
  25 there, and ran out of 30 when the machine was busy (#368). The
  15-second rule above still applies, measured on CI.
- The tests run on UTC, as CI does (`webkit.sh` sets it; the container is on
  UTC). A test that works out a date in the machine's own time zone will
  expect the wrong day somewhere.
- **CI runs the browser tests inside Playwright's own image**
  (`mcr.microsoft.com/playwright`), which has both browsers and every library
  they need. Installing those from Ubuntu's mirror each run took the whole
  20-minute limit on slow days and cancelled jobs before a test ran. The
  image's version has to be the client's `@playwright/test` version;
  `scripts/playwright-image.test.mjs` checks it, so bump both together. It
  also checks those jobs say `shell: bash`: in a container GitHub runs steps
  with `sh` unless told otherwise, and their steps are bash.
- **The jobs that install Ubuntu packages** (ffmpeg for the server's tests,
  WebKitGTK for the shell, the Linux build tools for the packages and the
  release) install them through `.github/actions/apt-install`. GitHub's
  runners try Azure's Ubuntu mirror first and only move on when it fails, and
  on 2026-10-26 it crawled at a few KB/s instead of failing, three times that
  day (#717). So:
  - **The packages are kept between runs** in GitHub's cache, under the job's
    name and the Ubuntu release, and a later run installs from there without
    asking a mirror for them. A new copy is kept only when the packages
    changed. Main's copies are the ones a pull request and a release start
    from: the release's Linux build shares the package check's (`packages`),
    which the nightly run keeps on main.
  - **`scripts/apt-mirrors.sh` times each mirror first**, its index and one
    package it names, and puts any slower than 100 KB/s behind the first that
    isn't, for that job only. That night the index came at 57 MB/s and the
    packages at a few KB/s.
  - **`scripts/apt-install.sh` gives every fetch a time limit**: four minutes
    for the lists, eight for the packages. One that runs out of time sends the
    mirror it used to the back and is tried once more, from the next. Packages
    are fetched first and installed after, so the limit never stops an
    install half way.
  A healthy first mirror and a kept copy change nothing; the run's log says
  which mirror was used and whether the copy was.
- **The AppImage's two downloads**, FFmpeg's source from ffmpeg.org and
  linuxdeploy from GitHub, go through `scripts/appimage-fetch.sh`. One slow
  moment at ffmpeg.org failed a package build on 2026-10-29: curl waited
  133 s to connect and nothing tried again (#753). Each try now has 30 s to
  connect and five minutes to finish, and a failed one is tried again five
  times, the log saying so. Both files are pinned by checksum and kept in
  GitHub's cache, so most runs ask neither server, and a kept copy is checked
  against its checksum before it's used. `scripts/appimage-fetch-test.sh`
  has a stand-in server drop, turn away (503) or never answer the first
  request, and checks the file still arrives.
- **Every download in a workflow is tried again when it fails** (#761):
  `scripts/workflow-downloads.test.mjs`, in the rules job and `check.sh`,
  fails any `curl` in a workflow or one of the repository's own actions that
  keeps what it fetched (to a file, or piped on) without `--retry` and
  `--retry-all-errors`, naming the file and line. A `curl` that throws the
  answer away (`-o /dev/null`) is a check, retried by the loop it sits in;
  `wget` isn't used. The AppImage's downloads go through
  `scripts/appimage-fetch.sh` (above), which retries the same way.
- The page server runs on port 1421. `LINGER_TEST_PORT=1431` (any free port)
  moves it, so a second copy of the repository, such as a git worktree, can
  run its browser tests while the first runs its own.
- When a browser test fails in CI, look at its screenshot and trace before
  changing code. They are kept for seven days in the run's
  `browser-failures…` artifacts; `pnpm exec playwright show-trace` opens a
  trace.

## Release and human checks

Merge only after the combined candidate is green. Bump all four version files
and both Rust lockfiles together. Tag once, wait for signed packages and the
server image, inspect the draft and updater manifest, then publish. Never move a
published version tag to fix a failed release; use the next patch version.

Use [the 0.5.3 checklist](releases/0.5.3.md#checks-on-installed-clients) for this release. Record OS,
package type, previous/new version, interface size and reproduction steps when
reporting a failure. Do not capture private conversations in evidence.

The real-world checks in [release-checks.md](tasks/release-checks.md) are
closed only by people using the published app on real computers and networks.
Passing these automated checks does not close them.
