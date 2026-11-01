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

To add one, put it under the gap it belongs to, or start a new gap. Name the
pull request, the catch in a sentence, why we missed it, and what changed,
linking the commit, issue or rule.

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

- **#757: a workaround in the shell could pass for the fix.** The
  packaged-app check cleared the WebKit settings it knew of, not #756's own
  workaround (`WEBKIT_GST_DISABLE_GL_SINK`). Set in the caller's shell, the
  check passed on an app without the fix. *Missed because* the check started
  from whatever environment ran it. *Changed:* that setting is cleared; every
  inherited setting in those families is #765. Rule: a check that proves the
  app does something starts where it isn't already done
  (`docs/testing-strategy.md`, "What reviews have taught").

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

## A rule nothing checks

- **#794: the update files blocked the async workers.** AGENTS.md says never
  block the reactor, and `updates.rs` read and wrote tens of megabytes with
  `std::fs` inside async commands. *Missed because* no check reads that
  rule, and clippy can't tell which code runs on the reactor; a test of the
  source is the wrong fix (above). *Changed:* the code is shaped so the
  mistake is hard to make: every touch of the update folder from a command
  goes through `Store`, whose methods run off the workers
  (`spawn_blocking`), and installing does too.

## Tests written from the case in mind, not from the ways things fail

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
- **#771: the docs path check (#770) had three holes.** A directory deleted
  whole left its names unread, since the directories were read from what was
  there. A missing file name with spaces was reported cut at the first
  space. And links in angle brackets, which `docs/development.md` uses for
  the artwork, weren't read. *Missed because* the same gap as #763: its tests
  were the forms the docs used that day. *Changed:* the directories are
  written out, with a test that a new one is added; a spaced name is read
  whole; angle-bracket links are read. Closing it turned up two more forms
  nobody had flagged, reference links and the README's HTML tags, read now
  too. The rule now names a language's forms, not only its spacing.
  A second round found more of both: HTML attributes quoted with `'` or not
  at all, and a reference link's target on the next line, still unread; and
  the test that every top-level directory is listed counted a local server's
  `data/` and an editor's `.vscode/`, failing `check.sh` on a clean branch.
  *Changed:* every link form is read by one function from one table
  (`linkTargets`, 15 forms, a link's title among them, which nobody had
  flagged), and the directories compared are the ones git tracks. Adding
  forms one review at a time was the gap itself.
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
- **#784: keeping a refused choice in step across windows had three
  holes.** #782's first fix kept the Appearance choices storage refused in
  each window's memory and passed them between windows. A window reopened
  while storage refused grew again each time, since the size it was grown
  for went with the page; a window opened while Settings announced one
  choice dropped the list's others; and Settings opened as the list's answer
  came in showed the old choices. *Missed because* the tests opened each
  window once and had every answer arrive in one order. *Changed:* nothing
  keeps choices in step between windows. A choice storage refuses isn't
  made, and Settings says so (#782), so every window reads one place,
  storage.
- **#796: a card opened from a cut topic had five holes.** A topic taller
  than the window lost its end; the card stayed where it opened when the
  window narrowed; pressing the words again closed and reopened it; words a
  late font cut stayed plain, with no button; and words that changed under an
  open card were taken over by it. *Missed because* the tests used one window
  size, a topic that fitted in the card, one press, fonts already loaded, and
  nothing changing while it was open: the case in mind. *Changed:* a test for
  each, failing before its fix (`next-chat-window.spec.ts`). Rule: a card is
  tested with words taller than the window, the window resized while it's
  open, its opener pressed again, and what it shows changing under it
  (`docs/testing-strategy.md`).

## Comments that were wrong

- **#798: "folder creation breaks the I/O rule".** Greptile read AGENTS.md's
  "All I/O is async via tokio" as covering `phone_backup`'s
  `create_dir_all`. It runs once at the top of `run()`, before Tauri starts,
  so there's no async runtime yet and nothing to block; the rule is there so
  nothing blocks the reactor. Awaiting `tokio::fs` there would mean starting
  a runtime only to wait on it on the same thread, and the marking has to be
  done before the web view writes anything. Kept as it is.
