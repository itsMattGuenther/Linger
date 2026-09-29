# Testing strategy

Keep fast, repeatable checks in CI. Use real packages for platform behavior,
and reserve human time for things automation cannot hear or reproduce. Catch
each kind of problem at the cheapest place that can catch it. Setting up the
tools is in [development.md](development.md#checks).

The short version: **run `scripts/check.sh` before you push.** It runs the
checks for what your branch changed, including the Chromium browser tests
when the client changed, and says what CI adds on top.

## Where checks run

| Where | When | What | How long |
|---|---|---|---|
| Your machine | Before every push | `scripts/check.sh`: the checks for what the branch touched | Under a second for docs; about 1½ minutes for a client change; a Rust change also rebuilds, which is slow in a fresh copy |
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
| Linux/Windows package checks | Installation, icons, recorded chimes, Windows shortcut upgrades, the list window starting and drawing at every interface size, nothing the shipped CSP refuses | Signed-in use, every distro, physical speakers, real-network voice |
| Short two-person release check | Your installed clients, actual update path, listening and interaction | Exhaustive platform coverage |

The package audio harness injects a test-only bundle of the real sound player
into the installed app, signed in nowhere, and records what reaches a private
virtual speaker. Until 0.4.3 it also measured the previous client's layout in
the package; that part went with the previous client (#306). The Buddy list's
own start-up and layout in the package are `scripts/linux-next-check.py` and
`client/scripts/windows-next-check.mjs`. None of these is a live-server test;
a signed-in desktop check is T-1820.

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
| The client, `client/` | Typecheck, unit tests, the Chromium browser tests, the production build's CSP check | The WebKit browser tests; the packages on Linux and Windows |
| Only browser tests, `client/tests/browser/` | As the client | WebKit (no packages) |
| The desktop shell, `client/src-tauri/` | Its clippy and tests, when the GUI libraries are installed | The packages |
| `deploy/` | The Rust checks and the update script's test | S3, the relay and a real server update in Docker |
| Shared types (`crates/linger-core/`, `client/src/generated/`), CI, `scripts/`, anything else | Everything | Everything |

Every run, locally and in CI, also runs the rules lint (`scripts/lint-rules.sh`:
AI attribution, dropped vocabulary, file names only differing in case), the
version check, and the tests of these scripts themselves
(`node --test scripts/ci-scope.test.mjs`, `scripts/csp-assets.test.mjs`).

**One required check.** GitHub requires only `all green` before a merge. It
waits for every other `ci.yml` job and passes when each passed or was skipped
because the change didn't touch it, and fails when any failed or was
cancelled. A new job joins by being listed in its `needs`, and
`scripts/ci-gate.test.mjs` fails if one isn't. The package checks run in their
own workflow and don't block a merge; the nightly run and every release run
them.

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
| The installed app: what it's allowed to load, its packages, native audio, shortcuts | The package checks: `scripts/csp-assets.mjs`, `scripts/linux-next-check.py`, `scripts/linux-audio-check.py`, `scripts/windows-*.ps1` |
| Several computers, real networks, audio devices, operating-system versions | The [release checks](tasks/release-checks.md). No automated test covers these |

## Fixes need regression evidence

For each bug, link the issue and PR and add a check for the reported behavior.
Where practical, run it against the old behavior first and record that it
fails. Assert the result a person needs, not just a class name or implementation
detail. Shared CSS fixes must cover both rendering engines and both desktop
platforms, including short windows, long names and the supported interface sizes.
Test the combined release candidate: separately green PRs can disagree.

A new rule gets the same: a test that proves it, named in the pull request
(the template asks). Most bugs that reached people after 0.4.0 were rules
nobody had tested yet, such as an invite for Anyone running out (#246), DMs out
of order (#248), line breaks dropped (#289), and video seeking (#222). Each
was cheap to test, and the tests only came after.

## A test that fails at random

Don't just re-run it and move on. Sometimes the test is at fault: it waits a
fixed time, or measures a frame that a busy machine draws late. Sometimes the
app is: #266 looked like a flaky test and was a real race in how history
loads. That is why there are no blanket retries ([L-31](design/lessons.md)):
a retry that passes hides both.

1. Re-run the failed job once, to be sure it is random and not your change.
2. Open an issue the same day with the test's name, the run, and the error.
3. Fix whichever is wrong. Fixtures deliver events explicitly and in order;
   a test waits for the thing itself, never for a fixed time.
4. If it can't be fixed that day and it is failing other people's pull
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

## Browser tests

- The same tests run in Chromium, the engine of WebView2 on Windows, and in
  WebKit, the engine under WebKitGTK on Linux. WebKit is slower and finds
  timing problems Chromium doesn't.
- Locally, `check.sh` runs Chromium. Once, run
  `cd client && pnpm exec playwright install chromium`, or set
  `LINGER_CHROMIUM_PATH` to a Chromium you already have.
- Playwright's WebKit only runs on the Linux systems Playwright supports
  (Debian and Ubuntu), so on other systems WebKit failures show up in CI.
- When a browser test fails in CI, look at its screenshot and trace before
  changing code. They are kept for seven days in the run's
  `browser-failures…` artifacts; `pnpm exec playwright show-trace` opens a
  trace.

## Release and human checks

Merge only after the combined candidate is green. Bump all four version files
and both Rust lockfiles together. Tag once, wait for signed packages and the
server image, inspect the draft and updater manifest, then publish. Never move a
published version tag to fix a failed release; use the next patch version.

Use [the 0.4.4 checklist](releases/0.4.4.md#checks-on-installed-clients) for this release. Record OS,
package type, previous/new version, interface size and reproduction steps when
reporting a failure. Do not capture private conversations in evidence.

The real-world checks in [release-checks.md](tasks/release-checks.md) are
closed only by people using the published app on real computers and networks.
Passing these automated checks does not close them.
