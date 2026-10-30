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

## Tests written from the case in mind, not from the ways things fail

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
