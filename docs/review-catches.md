# What reviews caught that we didn't

A reviewer's real catch is a problem our own tests and checks missed. Fixing it
fixes that pull request; the gap that let it through is still there for the
next one. So each catch gets a second question, **why didn't we find it?**,
and an answer that changes the project: a test or check that would have
caught it, code shaped so the mistake is hard to make, or a rule in the docs
(`AGENTS.md`, "Pull requests and issues").

This is the record: what was caught, why we missed it, and what changed.
Greptile reviews every pull request (since 2026-10-29); a catch from a person
goes here too. A comment that was wrong goes here as well, with why, so it's
known how often a reviewer is right.

Nobody reads this before a pull request. The kinds of mistake in it are asked
as questions in [pr-questions.md](pr-questions.md), and
`node scripts/pr-questions.mjs` prints the ones for what a branch changed.

To add one, put it under the gap it belongs to, or start a new gap. Name the
pull request the mistake was made in (not the issue it was reported as), the
catch in a sentence, why we missed it, and what changed, linking the commit,
issue or rule. One catch is one entry; an entry that holds several says how
many after the pull request, as in `#796 (5 catches):`. Then close the gap
with a check if one can find that kind of mistake. If none can, and no
question in [pr-questions.md](pr-questions.md) asks about it, add one there
(`AGENTS.md`). `node scripts/review-catches.mjs` counts the catches per pull
request, week by week, so we can see whether they fall.

## State worked out from the history that's loaded, not all of it

The app holds a window of each room's history that pages in, is let go of,
and is replaced (#173, M10). State worked out from it, or kept beside it, has
to be right for every shape that window takes.

- **#751: an old share line looked live.** Which of a person's "shared their
  screen" lines is live was worked out from the newest one *loaded*: opened
  further back in history while that person shared again, an old line offered
  Watch. *Missed because* the tests loaded the whole conversation. *Changed:*
  a line is live only if it's the person's newest line and the room holds its
  newest messages, with a test for older history (`rows.ts`
  `shareLineState`).
- **#759: sent-message ids weren't trimmed with the history.** `sentAs`
  (#750) kept an entry for every send while `trimHistory` and
  `releaseOtherRooms` let the messages go, so it grew for as long as the
  connection lasted. *Missed because* nothing walks a new piece of side state
  through every place history changes. *Changed:* `sentAsHeld` in the three
  places, with tests; making it one place for any such state is #766.
- **#759: paging dropped them.** `fetchWindow` built the room afresh and lost
  `sentAs` while keeping the messages. *Missed because* as above. *Changed:*
  as above.

## A rule the code doesn't check

- **#792: shared files could reach iCloud backups.** SPEC §4.15 keeps the
  phone app out of them; Android's `allowBackup="false"` covers its files,
  but an iPhone backs up an App Group's folder unless it's marked. *Missed
  because* nothing builds the iPhone's half here, and the promise wasn't
  written where phone code is written. *Changed:* the share extension marks
  its folder before writing, and `docs/development.md` and
  `docs/testing-strategy.md` say anything the phone app writes outside its
  temporary and cache folders is marked. The app's own folders were already
  #790, fixed by `phone_backup.rs` (#798).
- **#792: file checks ran on the async runtime**, in `shared_file`, which
  AGENTS.md says never happens. *Missed because* no check enforces it, and
  `shared.rs` copied `dropped.rs`, which does the same. *Changed:* the share
  commands do their file work through `off_thread`. `dropped.rs` is left as
  it was; it's older than this pull request.

## A check its surroundings can fool

- **#858: the warm-up's test would pass a wait that waited for nothing.**
  The run's own check from the Mac finishes a handshake at the front before
  Safari's request, so a wait for more than none finished at once, and the
  test, which read only the start of the wait, passed it. Caught by Greptile.
  *Missed because* I broke the step the ways I thought of (moved, no request,
  no wait) and not against what else writes the same log. *Changed:* the
  test checks the count is taken just before Safari's request and the wait
  is for one more than it; six breakages of the step each fail it.
- **#864: the sheet's test would pass with nothing closing the sheet.** It
  checked where the share flow looks for Photos' "What's New" sheet, not
  that it presses Continue there, so taking out both presses and leaving
  the looks still passed. Caught by Greptile. *Missed because* the test was
  written from the change (where the looks went), and not broken the way a
  later edit would break it. *Changed:* a look counts only if its block
  presses Continue until the sheet's gone; taking out either press, or
  both, fails the test.
- **#865: the typing check's test would pass with its first wait gone.**
  It checked the typing, the retype and the last wait, but not the wait
  between them that gives late keys time to land, so without it the subflow
  would erase and retype at once. Caught by Greptile. *Missed because* the
  test picked out the parts I thought mattered, by searching for them,
  rather than reading the whole subflow. *Changed:* the test reads it
  command by command; removing the first wait, making either wait the other
  kind, dropping the erase, flipping the condition or adding a third typing
  each fail it.

- **#757: a workaround in the shell could pass for the fix.** The
  packaged-app check cleared the WebKit settings it knew of, not #756's own
  workaround (`WEBKIT_GST_DISABLE_GL_SINK`). Set in the caller's shell, the
  check passed on an app without the fix. *Missed because* the check started
  from whatever environment ran it. *Changed:* that setting is cleared; every
  inherited setting in those families is #765. Rule: a check that proves the
  app does something starts where it isn't already done
  (`docs/testing-strategy.md`, "What reviews have taught").
- **#809: a test's queue was roomier than the real one.** The test that a
  resume replays 2,000 frames gave its socket room for 4,096, so the replay
  never waited for the socket, as it does over a real one, whose queue holds
  256, while what arrives meanwhile waits on the bus. *Missed because* each
  test chose its own queue size, and chose one that never fills. *Changed:*
  the size is `SOCKET_QUEUE_FRAMES`, shared by the socket and the tests'
  helper, which no longer takes one; the replay test fills it seven times
  with frames arriving meanwhile, and a second test has the bus lap the
  session mid-replay. Rule: a test of code that waits on a queue uses the
  real queue (`docs/testing-strategy.md`, "What reviews have taught").

## A script that assumes one machine's layout

- **#757: NVIDIA's libraries were looked for where Arch keeps them.** On
  Fedora or Ubuntu the GPU check's NVIDIA run would have skipped itself.
  *Missed because* it was written and run on one Arch machine. *Changed:* it
  looks in `/usr/lib`, `/usr/lib64` and `/usr/lib/x86_64-linux-gnu`, and never
  mounts a file that isn't there (Docker makes an empty directory in its
  place). Rule in `docs/testing-strategy.md`.

## A test of the source, not of what it does

- **#768: the packaged-app check's launch went unchecked.** #765's test
  looked for `cleanEnvironment(process.env)` in the check's source, so a
  launch that ignored it (`{ env: process.env }`) would still pass. *Missed
  because* reading the source was quicker than running the script. *Changed:*
  the test runs the check with stand-ins for what it calls, and the stand-in
  `xvfb-run` writes down the environment the app would have had. Rule: test
  what a script does, not what its source says (`docs/testing-strategy.md`).

## Docs naming a file that isn't there

- **#767: the testing strategy named a test that only #768 adds.** Merged
  first, the docs would have pointed at a file that didn't exist yet.
  *Missed because* nothing checks that a file the docs name exists, so a
  rename or a delete leaves every doc naming it stale too. *Changed:* #768
  merges first; #770 is a check that every file the living docs name exists.
  Its first run found five more: a deleted walk-through script named twice,
  the previous client's search folder, and a prototype on a deleted branch,
  named twice. Each is now in `commit:path` form, which says where it is.

## A fallback wider than the case it's for

- **#781: a failed `nm` read as "none of them".** The iPhone build's report
  of the calls Apple asks a reason for ran `nm -u … | grep … || echo "none
  of them"`, and the `||` covered the whole line: an app `nm` couldn't read
  left the step green, saying nothing was found. *Missed because* the step
  was only checked for its syntax (`bash -n`), and never run with `nm`
  failing. *Changed:* `nm` runs on its own, so its failure fails the step,
  and only `grep`'s "nothing matched" (status 1) reads as none; tried with
  stand-ins for `nm` and `grep` that fail, find nothing and find some. Rule
  in `docs/testing-strategy.md`.

## Checked when asked, not when it happens

A check that guards an action passes when the action is asked for, then
something slow runs (a request, a download, a prompt), and the action happens
on a world that has changed.

- **#794: an update could restart somebody out of a call.** The list checked
  voice before asking the shell to install, but the shell then asked the feed
  and maybe downloaded for a minute, and nothing checked again. *Missed
  because* the tests pressed Restart now in voice and out of it, never joining
  voice in between. *Changed:* the shell reads the list's last word on voice
  right before it installs (`Busy` in `client/src-tauri/src/updates.rs`) and
  answers busy, and the list installs once you've left; a test joins voice
  after the press (`next-list-window.spec.ts`). Rule: a guard is checked again
  right before the action, and tested with the state changing in between
  (`docs/testing-strategy.md`).
- **#794: a restart nobody pressed could install a release that hadn't had
  its day.** The list approved the downloaded version, then the shell
  installed whatever the feed called newest. *Missed because* the same gap:
  approved at one moment, acted on at another. *Changed:* an install nobody
  pressed takes only the kept update, while it's still the newest and a day
  old by the feed now (`may_install_unattended`, with tests).
- **#794: publishing a release built days before skipped its day.** The feed
  carried the build's date until `updater-date.yml` dated it, and a copy that
  looked in that minute found it a day old. *Missed because* the tests used a
  date that never changed after a copy had read it. *Changed:* the release
  build says it isn't published (a date in 2999, `updater-urls.mjs`) until
  publishing dates it, and installs nobody pressed read the date again.
- **#794: a "busy" answer that came back after you'd left voice left the
  update waiting.** The list queued it for when you left, but you already
  had, and the queue was only looked at when voice ended. *Missed because*
  the test answered busy while still in voice, never after leaving. Second
  round of the same gap as the call. *Changed:* the queue is looked at again
  when an install comes back too, and tests answer in both orders
  (`next-list-window.spec.ts`). Rule: an answer that can arrive after what
  it depends on has changed is tested arriving before and after
  (`docs/testing-strategy.md`).
- **#794: re-running the release's feed job after publishing undated the
  release.** The fix for the publishing gap had the job date the feed "not
  published" every time it ran, and only publishing dated it again. *Missed
  because* the job was written for its first run, before publishing.
  *Changed:* it dates the feed by the release's own state, a draft or when it
  was published, with tests of both (`datedFor` in `updater-urls.mjs`).
- **#797: a server updated before it was ever reached said "Can't reach"
  for good.** The app asked whether a server needs a newer app when its
  connection came back or a retry failed, but only once it had been up:
  one updated between signing in and connecting failed every try unasked.
  *Missed because* the same gap again: the tests raised the server's
  minimum only after it had connected. Caught by Greptile after #797 was
  merged, which was mine: the watch I'd set read Greptile's one comment as
  already seen. *Changed:* only the first time it's up is skipped, with a
  test whose server never comes up (`next-list-window.spec.ts`).
- **#794: Settings couldn't try again after a failed update.** Its Restart now
  asked the list window, which did the install and kept a failure to itself,
  so Settings stayed pressed, saying Linger would restart. *Missed because*
  the test checked the press reached the list, not what came back.
  *Changed:* the list says how it went (`UPDATE_SAID`), and a test fails it
  from the list's side (`next-settings-window.spec.ts`). Rule: what another
  window asks the list to do is tested failing (`docs/testing-strategy.md`).
- **#890: a phone signed out while its notification waited still got it.**
  Who a notification was for was worked out once, then it waited for a turn
  at the relay, and went whatever had changed meanwhile: a sign-out, a
  switch turned off, a block. Caught by Greptile. *Missed because* I
  answered "Is each guard checked right before what it guards?" with "it's
  milliseconds", picturing a relay that answers at once, and no test changed
  anything while a notification waited. *Changed:* right before each one
  goes, the server asks again that the phone is registered at that address
  with that key, its sign-in live, the switch on, no block, and its owner
  not using Linger (`repo::push::still_wanted`), with a test that signs out
  while one waits for a turn (`crates/linger-server/tests/push.rs`).
- **#890: a late "gone" for a phone's old address deleted it at its new
  one.** The server forgot a phone by its id when the relay said an address
  was gone, so a phone that registered a new address while a notification
  to the old one was out lost both. Caught by Greptile. *Missed because* the
  same gap: the answer is about the address as it was, and the test of
  "gone" changed nothing before it came. *Changed:* the phone is forgotten
  only while that's still its address, with a test that changes it while
  the relay holds the answer.

## A check nobody could run before it mattered

- **#812: the iPhone build's App Group check could never pass.** The new
  step in `ios.yml` read `com.apple.security.application-groups` with
  `plutil -extract`, whose key paths split on dots, so it found nothing in a
  correct signature and would have stopped every build before TestFlight.
  *Missed because* it runs only on a Mac, after the build, and nothing here
  could run it first. *Changed:* the reading is `scripts/ios-app-group.mjs`,
  and `ios-app-group.test.mjs` runs it in CI on the real signatures of build
  0.5.3 (5.1) and every other way the list can be written; what it can't
  read fails. Rule: a step that only runs on another machine keeps its logic
  where a test can run it here (`docs/testing-strategy.md`, "What reviews
  have taught").

## A rule nothing checks

- **#794: the update files blocked the async workers.** AGENTS.md says never
  block the reactor, and `updates.rs` read and wrote tens of megabytes with
  `std::fs` inside async commands. *Missed because* no check reads that
  rule, and clippy can't tell which code runs on the reactor; a test of the
  source is the wrong fix (above). *Changed:* the code is shaped so the
  mistake is hard to make: every touch of the update folder from a command
  goes through `Store`, whose methods run off the workers
  (`spawn_blocking`), and installing does too.
- **#792: the share extension was signed without its App Group (#811).**
  Caught by @eGGnogSC on TestFlight after #792 merged, not in review: every
  share to Linger from an iPhone failed. The App Group was in the extension's
  entitlements file and in its provisioning profile, but not in its signature,
  because `tauri ios build` signs only the app's own binary with entitlements
  and the export keeps only what each part was signed with. *Missed because*
  `ios.yml` checked that the extension was in the app, with the app's version,
  but not what it was allowed to do, and nothing could run it before a phone
  did. *Changed:* the extension signs itself with its entitlements when the
  build doesn't (its last build phase), and `ios.yml` stops before TestFlight
  unless both the app and the extension are signed with the App Group. The
  share's alert now says a failure apart from something it can't take, which
  had pointed the tester at photo types.

## Tests written from the case in mind, not from the ways things fail

- **#870: the log meant to show the blocked download started after it.**
  `nsurlsessiond`'s lines were added to `trustd.log` so each run would show
  the revocation list download failing, but the log starts after the server
  and app builds, and the phone boots before them, when that download is
  first tried. Caught by Greptile. *Missed because* I checked the log
  against the order of the steps as written, not against when the phone
  starts doing things, which is at boot. *Changed:* the lines kept since
  boot (`log show`) go into `trustd.log` first, and the stream adds to
  them; `scripts/ios-flows.test.mjs` fails without either.

- **#856: the shell's voice.leave, when iOS let go of the window, could be
  lost.** A connection between sockets drops what it's sent (`Handle::send`
  says so: the page re-states what matters once it's back), and then
  resumes the same session, voice seat and all, with no page left to leave
  it. Caught by Greptile. *Missed because* the tests and my answer to the
  partway question assumed a connection that's up; I wrote that a server
  without one would end the session anyway, and it resumes. *Changed:*
  `Handle::leave_voice` keeps the leave until the session is back, and an
  integration test asks for it on a fresh socket the server hasn't taken
  yet and hears it right after `resumed`.

- **#862: the certificate service's log started too late to explain a
  stall before the flows.** Its lines went into `app.log`, which starts
  with the flows, so a stall in the warm-up (the step before, where #848 had
  shown up) left no log, and "skipping update" from its restart could be
  missed. Caught by Greptile. *Missed because* the log was added for the
  stall that had happened, in the flows, not for every step that checks a
  certificate. *Changed:* `trustd.log` is kept from before the setting and
  the restart to the end of the run, and `scripts/ios-flows.test.mjs` fails
  if it starts after them.

- **#859: the check for fakes on `navigator.mediaDevices` read one line at
  a time.** A call split over lines, which is how a formatter writes
  `Object.defineProperty(...)` with an object in it, passed. Caught by
  Greptile. *Missed because* the table of forms had every way of writing
  it on one line, and none spread over several. *Changed:* it reads the
  whole file and reports the line each match starts on, with the split
  forms in its table.

- **#860 (2 catches): the simulator's "driver died" step cleared Linger
  when it couldn't.** It said "re-run once" when the app in front wasn't
  known, and when Photos was in front, though Linger's share window runs
  inside Photos' screen. Caught by Greptile. *Missed because* the cases
  tried were the one that happened (Photos, share window not open) and
  Linger in front, not what the step couldn't see. *Changed:* it reads
  `app.log` for the share window too, and says to re-run only with Linger
  ruled out on both; unknown either way asks for a look.

- **#849: the simulator's https front named a request only once it ended.**
  A request still waiting for the server when the run stopped looked like a
  connection that never sent one, the very case the log was added to tell
  apart (#848). Caught by Greptile. *Missed because* the tests followed
  requests to an end (answered, refused, given up on), never one still
  going. *Changed:* each request is logged as it arrives too, and the test
  of a request the app gives up on checks it was named before anything
  ended it.

- **#802: a test of stopping a wait stopped it before the wait began.** The
  upload test aborted inside `onWaiting`, which runs before `pause` has a
  timer or a listener, so only the "already stopped" check ran, and it would
  have passed with stopping a running wait broken. *Missed because* the
  quickest place to stop the file was the callback that announces the wait.
  *Changed:* a second test stops it two seconds into a running wait and
  checks it isn't asked again, the slot is given back and the timer is
  cleared; it fails with the wait's listener removed. The rule from #792 now
  says partway means while the wait is running.

- **#792: a share turned down while its files were read was sent anyway.**
  The pick went on to the conversation once the read finished. *Missed
  because* every test went straight through. *Changed:* the list keeps the
  share its sheet shows, and a pick that finishes reading checks it's still
  that one; a browser test closes the sheet partway. Rule: anything a person
  can stop or overtake while it waits is tested interrupted
  (`docs/testing-strategy.md`).
- **#792: a second share while the first was read could mix with it.** The
  shell looked the inbox up afresh for every file, so the second share's
  bytes could go under the first's names, and "done" deleted the second.
  *Missed because* as above. *Changed:* asking takes the share, moving it
  aside under an id that reading and deleting name, with a shell test of a
  share arriving mid-read and a browser test of the sheet it brings
  (`shared.rs`).
- **#792: a copy the phone stopped partway stayed.** Start-up cleaned the
  inbox but not `shared-incoming`. *Missed because* the sweep test had only
  an inbox in it. *Changed:* the sweep deletes a stopped copy and old taken
  shares, tested with all three.
- **#792: a file left out of a share went without a word.** *Missed
  because* the tests read all of a share or none of it. *Changed:* why goes
  with the files and the box says it, with a browser test where one of two
  can't be read.

- **#758: a download cut off half way.** The retry test dropped a
  connection before any bytes went, never part way through. *Missed because*
  the cases were the failure that happened (a slow connect) and a few like
  it. *Changed:* a cut-off case in `scripts/appimage-fetch-test.sh`. Rule: the
  ways a network fails, each tested (`docs/testing-strategy.md`).
- **#763: only the first `curl` on a line was checked**, and a pipe needed
  spaces around it to count.
- **#763: a health check writing to a quoted `"/dev/null"` failed the
  check.**
- **#763: an attached output name (`-otool.jar`) and a `1>` redirect
  slipped past.** Three rounds on one check: *missed because* its tests were
  the commands it was written for, not every way to write one. *Changed:*
  the line is split as the shell splits it, and the table of tricky commands
  in `scripts/workflow-downloads.test.mjs` grew with each. Rule: a check that
  reads code or commands starts from that table (`docs/testing-strategy.md`).
- **#771 (6 catches): the docs path check (#770) had three holes, then three
  more.** A directory deleted whole left its names unread, since the
  directories were read from what was there. A missing file name with spaces
  was reported cut at the first space. And links in angle brackets, which
  `docs/development.md` uses for the artwork, weren't read. *Missed because*
  the same gap as #763: its tests were the forms the docs used that day.
  *Changed:* the directories are written out, with a test that a new one is
  added; a spaced name is read whole; angle-bracket links are read. Closing it
  turned up two more forms nobody had flagged, reference links and the
  README's HTML tags, read now too. The rule now names a language's forms, not
  only its spacing. A second round found more of both: HTML attributes quoted
  with `'` or not at all, and a reference link's target on the next line,
  still unread; and the test that every top-level directory is listed counted
  a local server's `data/` and an editor's `.vscode/`, failing `check.sh` on a
  clean branch. *Changed:* every link form is read by one function from one
  table (`linkTargets`, 15 forms, a link's title among them, which nobody had
  flagged), and the directories compared are the ones git tracks. Adding forms
  one review at a time was the gap itself.
- **#807: the overview docs check passed over SQL it couldn't read.** Its
  schema reader matched bare table names only, so a migration making
  `"quoted"` (or `main.x`, or a `TEMP` table) would have added a table the
  check said nothing about; an `ALTER TABLE` on a table it hadn't seen was
  skipped the same way. *Missed because* the same gap as #763 and #771: its
  tests were the forms our migrations use today, though the rule already
  said every form. *Changed:* quoted names are read, and any statement that
  changes the tables in a way the reader can't follow fails the check,
  naming it. A reader that can only fail loudly can't hide a form nobody
  listed, so the rule now says so too.
- **#807: dot-directories escaped the layout check.** It said every
  top-level directory and left out `.github/` and `.cargo/`, which the
  README didn't list. *Missed because* the exception was written into the
  code and not into its tests or its promise. *Changed:* they're checked
  like the others, with a test that `.github` is among them, and both
  layouts list them.
- **#831 (3 catches): the release check (#828) passed over three ways to reach
  a release.** A script's JavaScript calling `gh api …/releases -f …` wasn't
  counted, though gh sends a POST once it's given a field, and the shell form
  was. A repository action that used another of ours wasn't followed into it.
  And a script named through a folder variable
  (`"$GITHUB_WORKSPACE/scripts/apt-install.sh"`, in our own apt-install
  action) wasn't read at all, and said nothing. Caught by Greptile. *Missed
  because* the table of tricky inputs listed how each command is written, not
  how the code running it is reached: one level of calls, and paths written
  plainly. *Changed:* gh's words from JavaScript are read by what they send,
  as the shell's are; actions are followed however deep; a path through
  `$GITHUB_WORKSPACE`, `$PWD` or `$GITHUB_ACTION_PATH` is read, and through
  any other variable it fails, naming it. Tables for each in
  `scripts/release-draft.test.mjs`, and the rule in `docs/testing-strategy.md`
  now names how code is reached as a form too.
- **#833: the record's reader passed over entries two or three spaces in.**
  It took any list item indented two spaces or more for a point under the
  entry above, but Markdown starts a list up to three spaces in, so
  `  - **#796: …**` would have gone uncounted, and an indented check in
  `pr-questions.md` unread. Caught by Greptile. *Missed because* the table of
  forms listed every list marker but not where a line can start, and the
  reader had a quiet path: an item it took for a point was skipped. The fifth
  round of this gap (#763, #771, #807, #831), in the pull request that added
  the questions: its own question asked for every form, and the answer
  listed the forms thought of. *Changed:* both docs read their lists through
  one `listReader` (`scripts/pr-questions.mjs`), where every list item is an
  entry, part of the one above, or a failure naming its line; an indented
  item that looks like an entry fails rather than being guessed at, with a
  table of line sequences in its test. The question, and the rule in
  `docs/testing-strategy.md`, now say to leave a reader no quiet path.
- **#850 (2 catches): the pin readers each had a form they passed over.**
  `patches` (`scripts/tauri-versions.mjs`) read `[patch.crates-io]` only as
  written, so the same section written `[patch."crates-io"]`, which Cargo
  reads alike, gave no pins, and nothing checked them. The nightly release
  finder (`scripts/upstream-fixes.mjs`) read the first page of tags only,
  and stopped at the newest release without the fix, so a release on the
  second page, or from an older line, was missed. Caught by Greptile.
  *Missed because* the readers were tried with the forms in Linger's own
  file and the order GitHub happens to list tao's tags in today, not with a
  table of what TOML and GitHub allow. *Changed:* the section is read in
  every TOML spelling, and any other patch form fails; every page of tags is
  read and every release asked, oldest first, with tests of each.
- **#846: the keep-rule reader counted any `-keep` as keeping a class
  whole.** `-keepclassmembers` and `-keep,allowobfuscation` let the class
  be renamed, and Rust finds it by name, so a weakened rule passed the check
  that every crossing is kept. Caught by Greptile. *Missed because* the
  forms tried were the ones in the file, not the ones that look the same
  and mean less. *Changed:* only `-keep class <name> { *; }` counts; a
  table of weaker rules doesn't.
- **#841 (2 catches): two readers in the Tauri 2.12 checks still had quiet
  paths.** The lockfile reader (`scripts/tauri-versions.mjs`) passed over a
  section it didn't know and an entry with no version, so a misspelled
  `dependencies:` dropped every plugin in it and passed. The iPhone flows'
  order reader (`scripts/ios-flows.test.mjs`) took a `flowsOrder` under any
  key, not only `executionOrder`. Caught by Greptile. *Missed because* the
  question for this kind was asked before the pull request opened, and the
  answer checked the lines inside the sections it read, not the sections
  and fields it skipped: the next pull request after #833's catch, with the
  lesson written down. *Changed:* both read only what they know and fail on
  the rest, with tests of each case; the question now asks for every skip
  to be listed and justified.
- **#774: an open volume card held its own level until it closed.** A change
  made in the voice bar or another window didn't show on it, and its next
  step undid that change. *Missed because* the tests only ever changed a
  level from the card itself. *Changed:* once the list window answers its
  step, the card follows the shared level again, and an answer to an older
  step doesn't count; a test answers late and changes the level elsewhere
  (`next-chat.spec.ts`). Rule (#776): a value shared between windows is
  tested changing in another window while it's showing
  (`docs/testing-strategy.md`).
- **#774: a second chip's card kept the first one's state**, in the voice
  bar since #423 as well as the new strip. Its slider didn't get the
  keyboard, and a refusal to take somebody out stayed on it. *Missed
  because* every test opened one card and closed it. *Changed:* each
  person's card is its own (`key`), with a test in the strip and in the bar
  going straight from one chip to the next. The person cards were already
  keyed; these two were the only ones that weren't. Rule (#776): a card that
  opens from one of several things is tested going straight from one to the
  next.
- **#774: the phone's sheet ran off a phone held sideways.** Everyone,
  nine and a half rows and a search box, was taller than the screen, so the
  search box and Close went off its top. *Missed because* every phone test
  uses one upright screen. *Changed:* a sheet is never taller than the screen
  and its names scroll, with a test held sideways
  (`next-phone-voice-room.spec.ts`). The gap was a second copy: the phone
  had three ways of rising from the bottom (a menu, the report form and this
  one), each setting its own height, and the new one forgot. *Changed*
  (#776): every sheet rises in the kit's one `Sheet`, which sets the height
  for all of them, and one kit test opens a menu, a card and a plain sheet on
  a short screen. Rule: a phone screen is tried held sideways.
- **#780: a Text size chosen while storage refused showed but didn't
  apply.** `saveTextSize` promised the session would still get the choice,
  but `followTextSize` reads it back with `loadTextSize`, from storage, which
  still held the old size or nothing. *Missed because* every test saved with
  storage working. *Changed:* the phone keeps its choice in memory too, read
  before storage, with a test where storage is full and one where it's gone
  (`appearance.test.ts`). Interface size and the other Appearance choices
  make the same promise on a computer, where the windows that apply them
  read storage too; keeping it there needs Settings' announcement to carry
  the choice to them.
- **#784 (3 catches): keeping a refused choice in step across windows had
  three holes.** #782's first fix kept the Appearance choices storage refused
  in each window's memory and passed them between windows. A window reopened
  while storage refused grew again each time, since the size it was grown for
  went with the page; a window opened while Settings announced one choice
  dropped the list's others; and Settings opened as the list's answer came in
  showed the old choices. *Missed because* the tests opened each window once
  and had every answer arrive in one order. *Changed:* nothing keeps choices
  in step between windows. A choice storage refuses isn't made, and Settings
  says so (#782), so every window reads one place, storage.
- **#796 (5 catches): a card opened from a cut topic had five holes.** A topic
  taller than the window lost its end; the card stayed where it opened when
  the window narrowed; pressing the words again closed and reopened it; words
  a late font cut stayed plain, with no button; and words that changed under
  an open card were taken over by it. *Missed because* the tests used one
  window size, a topic that fitted in the card, one press, fonts already
  loaded, and nothing changing while it was open: the case in mind. *Changed:*
  a test for each, failing before its fix (`next-chat-window.spec.ts`). Rule:
  a card is tested with words taller than the window, the window resized while
  it's open, its opener pressed again, and what it shows changing under it
  (`docs/testing-strategy.md`).
- **#814: a wait for the app's page didn't check that the app was still
  running.** The Windows checks' wait for WebView2's port failed at once on
  an app that exited; the wait for its page after it never had, so a crash
  then would have read, 90 seconds on, as a page that never came. *Missed
  because* each wait was handed its own checks, and the page's was written
  from the case of a page that's slow, not an app that's gone. *Changed:*
  `whileRunning` in `client/scripts/webview2-wait.mjs` makes one wait per
  app that always checks it first, and every wait in the four checks is
  that one; `webview2-wait.test.mjs` has an app quit during a page wait.
- **#819 (2 catches): a card with its one control taken away left the keyboard
  behind it, and a list of names stayed buttons.** On an iPhone, which lost
  its per-person volume, the host's card had no slider, and its focus still
  looked only for one; and the names in everyone's list kept the kit row's
  button though nothing happened to them. *Missed because* the tests were
  written from what the iPhone shows, not from what a keyboard or a screen
  reader meets there, and the kit's Row had no form without a button.
  *Changed:* the card focuses its first control, whichever it is; a Row with
  nothing to do is text, not a button (`docs/design/system.md`, Row), which
  mends the people card's names too; the iPhone tests check the focus and that
  no name is a button.
- **#877: a Docker command with the word in quotes passed the new rule.** The
  check that a workflow runs no Docker directly (#874) needed a space right
  after `docker`, so `"docker" run` and `'docker' pull` went through. Caught
  by Greptile. *Missed because* the table of forms had a whole command in
  quotes, not the one word, the same gap as #763. *Changed:* the forms are in
  the table in `scripts/workflow-downloads.test.mjs`, with a path, a
  substitution and a variable for the command.
- **#877: a test's own wait had no end.** The Ctrl-C test polled for the first
  download, so a script that exited before one would have kept it, and the
  `rules` job, waiting until the job's limit. Caught by Greptile. *Missed
  because* each way the script was broken on purpose still reached the
  download. *Changed:* the wait ends when the script does, broken on purpose
  to prove it, and "Would each new test fail with the code wrong?" asks about
  it in `docs/pr-questions.md`.
- **#880: a comment after `commands:` hid the waits under it.** The new
  check that a wait after another has time of its own (#878) found a nested
  list by comparing its line exactly, so `commands: # each time` skipped the
  list and its waits. Caught by Greptile. *Missed because* the table of
  tricky inputs had braces, a list at the wrong depth and a missing timeout,
  but not a comment after a property, which YAML allows on any line.
  *Changed:* `scripts/ios-flows.test.mjs` reads a property with a comment
  after it, tested on `commands:` and `timeout:`, and question 8 in
  `docs/pr-questions.md` asks what may follow a thing on its line.
- **#880: the wait check started each nested list afresh.** It checked the
  waits inside a `runFlow` or `repeat` only among themselves, so a wait
  inside a `runFlow` with `when:` and one after it, on the same clock,
  passed. Caught by Greptile. *Missed because* each nested list I tested
  started with a tap, which hid the boundary. *Changed:* the clock carries
  into and out of what a `runFlow` or `repeat` runs, a `runFlow` with
  `when:` is followed both ways, and a repeat's second time round starts on
  its first's clock, each with a test across the boundary. Question 8 asks
  where a reader forgets what it knew.
- **#883: Done went from every screen, and what replaced it came to one.**
  Hiding iOS's bar over the keyboard took its Done from every field, but the
  finger that puts the keyboard away instead was wired into the
  conversation alone. Search opens with its box typing and had no way left
  to put the keyboard away. Caught by Greptile. *Missed because* the change
  was built and tested from #881's case, the message box, and nobody listed
  the other screens with a field. *Changed:* it's on the whole page
  (`main.tsx`), so no screen can be left out, and a tap on a control is left
  to the control. "Is each screen tried at its limits?" in
  `docs/pr-questions.md` asks about every screen a change reaches.
- **#890 (2 catches): a slow relay could pile notifications up, and a relay
  address with a query sent them to the wrong path.** Each hand-off to the
  relay had ten seconds, but the wait for one of its eight turns had no
  limit, so behind a slow relay every later notification waited, to arrive
  late. And `LINGER_PUSH_RELAY` took a query or a fragment, which the
  `/send` added after it landed inside. Caught by Greptile. *Missed because*
  the relay tests were one that answers, errs, isn't there or hangs one
  request, never one too slow for everybody behind it; and the setting's
  tests tried bad schemes, not the other parts of an address. *Changed:* a
  message's notifications are handed over within 30 seconds, waiting
  included (`PUSH_SEND_WITHIN_MS`), or dropped, with a test of a relay that
  holds everything; the setting refuses a query, a fragment or a password,
  and `/send` goes on through the address's own path, each with a test.

## A copy in another language, tested where the two agree

- **#890: the server's copy of the app's message reader saw some mentions
  differently.** JavaScript holds a character outside the Basic
  Multilingual Plane (`𝐀`, `𝟙`, most emoji) as two halves, and a mention's
  boundary looks at one half, which is never a letter, so `@jo𝟙` mentions jo
  in the app. The Rust copy looked at the whole character and didn't.
  Caught by Greptile. *Missed because* the shared examples were written from
  the syntax (code spans, links, escapes), not from where the two languages
  differ, and the copy's own comment said such characters couldn't matter.
  *Changed:* the copy treats them as JavaScript does (`word_char` in
  `crates/linger-server/src/markdown.rs`), the shared examples have ten with
  them beside every kind of boundary, and `docs/pr-questions.md` asks where
  the two languages of a copy differ.

## Comments that were wrong

- **#798: "folder creation breaks the I/O rule".** Greptile read AGENTS.md's
  "All I/O is async via tokio" as covering `phone_backup`'s
  `create_dir_all`. It runs once at the top of `run()`, before Tauri starts,
  so there's no async runtime yet and nothing to block; the rule is there so
  nothing blocks the reactor. Awaiting `tokio::fs` there would mean starting
  a runtime only to wait on it on the same thread, and the marking has to be
  done before the web view writes anything. Kept as it is.

## Said of one platform from another's design

- **#850: a comment said a call carries on when the phone's page loads
  again.** On a computer voice lives in Rust; on a phone it runs in the page
  (`pageVoice.ts`), so the page loading again ends it. Caught by Greptile.
  *Missed because* the comment was written from how the computer app is
  built, and not checked against the phone's code. *Changed:* the comment
  and `docs/decisions.md` say voice ends, and staying in voice in the
  background is #851; the platform question asks that what's said of one
  platform holds there.

## Code only one platform compiles

Code behind `#[cfg(target_os = "ios")]` (or Android's) is compiled only when
the app is built for that phone, and the checks a pull request runs build the
shell for Linux.

- **#822: the share window's Keychain half didn't compile for the iPhone.** It
  imported `kSecMatchLimitOne` from `security-framework-sys`, which names the
  key but not that value, so no iPhone build could be made from the branch.
  Caught by the iPhone Simulator check on a branch stacked on it (#821), not
  by a reviewer. *Missed because* the Rust iPhone build (`desktop.yml`) runs
  by hand and nightly, never on a pull request, and `share-window.yml` built
  only the Swift extension. *Changed:* the value is declared beside
  `kSecAttrAccessible`, and `share-window.yml` builds the app's Rust for the
  iPhone on every pull request that changes it.

## Two at once

Something that's right when it runs alone, and wrong when a second copy of
it, or another program, runs at the same time.

- **#822: two share sign-ins asked at once could sign the app out.** The
  renewal waited only for the newest ask, so with two out, it could spend
  the token the older one still carried, which the server then took for a
  replay. *Missed because* the tests had one ask on its way at a time.
  *Changed:* asks go one at a time, so the newest settles after every one
  still out, with a test of two at once (`api.test.ts`).
- **#822: a sign-out could leave the share window's sign-in kept.** A run
  still asking for one saved it after the sign-out's run had already found
  nothing to end. *Missed because* the tests ran one keeping at a time.
  *Changed:* runs queue (`oneAtATime`, `core/shareWindow.ts`), so the
  sign-out's comes after and ends it, with a test of a sign-out mid-ask.
- **#822: the app and the share window could write over each other's
  sign-ins.** Both read the whole table from the Keychain, change one server
  and write it all back, so a write could undo the other program's renewal.
  *Missed because* each side's tests have one program. *Changed:* both
  change it only holding a lock on `share-window/sign-ins.lock`
  (`while_locked` in `share_window.rs`, `whileLocked` in `ShareList.swift`),
  each with a test that holds the lock as the other program would. Rule: a
  file or entry two programs change is changed under a lock they share.

## Counted after the work it limits

- **#822: a share sign-in over the limit still stored a new family.** The
  limit was checked after the row went in, then the row was revoked, so a
  client looping one token grew the table. *Missed because* the test checked
  the answer (429), not what was stored. *Changed:* `share_family` asks the
  limiter once the person is known and before writing, and the test counts
  the rows.

## A retry key kept after what it keys changed

- **#822: a retry with edited words said Sent and posted nothing new.** The
  share window used one nonce for the whole share, so after a failure whose
  answer was lost, sending edited words (or to another conversation) got the
  first message back. *Missed because* the retry test sent the same words.
  *Changed:* a new nonce when the words or the conversation change
  (`ShareNonces`, `ShareSender.swift`), with a test.

## Files left behind

- **#822: every share left its copies in the extension's temporary folder**,
  up to 5 GB, until iOS cleared it. *Missed because* nothing looked at what a
  finished share leaves. *Changed:* `ShareCopies` owns the folder and the
  window removes it when it closes, sent, cancelled or swiped away, with a
  test that closing removes it. The controller's wiring runs only inside the
  share sheet, so it's checked by reading, and by the TestFlight check.
- **#846: a failed release-build check left the app's extracted code
  behind.** `scripts/android-jni.mjs` called `process.exit(1)` inside a
  `try`, and Node exits without running the `finally` that removes the
  temporary folder. Caught by Greptile. *Missed because* the question for
  this kind was asked, and answered by the path that passes. *Changed:* it
  sets `process.exitCode`, and the test runs it in a temporary folder of
  its own and checks nothing is left there, failing or passing; the
  question now names this trap.

## A doc step nobody tried

- **#841: the check of updating from the release before was written for a
  draft, which no installed copy can see.** An installed copy reads only the
  published release's `latest.json`. `docs/releasing.md` step 4 already
  had the way that works: the day after publishing, before any copy
  updates on its own. Caught by Greptile. *Missed because* the step was
  written from how it should go, not tried or checked against the updater
  and the release doc. *Changed:* `docs/testing-strategy.md` points at that
  day, and a question asks whether each step a doc tells somebody to take
  works as written.
- **#873: the guide's way to run the iPhone flows on your own Mac would have
  stopped at the share flow.** The flow came to ask a new helper when the
  share window is up (`WINDOW_READY`), added to `config.yaml` and the
  workflow, but the guide's command passed the old four settings and started
  no helper. Caught by Greptile. *Missed because* the flows' settings are
  listed in three places and nothing compared them; the guide's command runs
  only on a Mac, never in CI. *Changed:* the guide's command is a code block
  that starts the helper, and `scripts/ios-flows.test.mjs` fails unless every
  setting a flow reads is in `config.yaml`, the workflow's command and the
  guide's.

## Written from what's connected right now

- **#822: sharing a minute after leaving Linger said to sign in (#825).** The
  app lets go of a server's rooms 30 seconds into the background, and the
  share window's list was written from what it held, so it was written empty.
  Caught by the iPhone Simulator share flow (#821) after #822 merged, not by a
  reviewer. *Missed because* the tests gave the list connected servers only,
  and nothing ran the app into the background before sharing. *Changed:* a
  server not connected right now is written as it last was, read back from the
  file when the app starts, and only signing out takes one off
  (`shareWindowServers`, with tests); the simulator flow shares with Linger in
  the background.
- **#826 (3 catches): the first fix for it held back too much, and dropped too
  much.** It wrote nothing until every server had connected, so signing out of
  one while another was down left the signed-out server's conversations in the
  list, and it left out servers still being reached or waiting for a newer
  app. Caught by Greptile. *Missed because* the tests had servers that were
  either connected or not, never one down while another changed. *Changed:*
  the list is always written, from the last one written for any server not
  connected, with tests of a server down while another connects and while one
  is signed out of.
- **#826 (2 catches): the second fix kept its own copy of the list in the
  page.** The first launch after updating had no copy yet, so a server down
  then was dropped, and signing out of the last server left the copy behind,
  where another account on the same server could see the first one's
  conversations. Caught by Greptile. *Missed because* a second copy of state
  has its own life, and the tests only had the one. *Changed:* no copy: the
  page reads back the file the window reads (`share_window_list_read`), which
  signing out of every server empties.
