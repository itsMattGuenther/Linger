# Before you open a pull request

Opening a pull request says the change is ready. Whatever is found after
that, by Greptile, a person, CI, the iPhone simulator or a tester, is
something we could have found first. [review-catches.md](review-catches.md)
records each one. This is the short version: one question for each kind of
mistake we've made, and the parts of the project it's for.

Nobody reads this whole list. Before opening a pull request, run

```bash
node scripts/pr-questions.mjs
```

It prints only the questions for the parts your branch changed. Answer each
one for your change, test what needs a test, and say what you checked in the
pull request's Tests section, in a line or two.

## Automate first

A question costs every pull request a read. A check in CI costs nobody
anything. So when a catch is recorded, ask first whether a test or a lint can
find that kind of mistake. Write a question only when no check can. When a
check comes to cover a question, move its kind to the checks at the end and
take the question off; its history stays in the record. This list should get
shorter over time, not longer.

Every gap in the record has a question here or a check at the end, and
`scripts/pr-questions.test.mjs` fails when one has neither. Whether the
questions work shows in the count of catches per pull request,
`node scripts/review-catches.mjs`: if it doesn't fall, they don't.

## Parts

The script sorts each changed file into parts (`partsOf` in
`scripts/pr-questions.mjs`), and each question names the parts it's for:

- `page`: what every window shows, on a computer and a phone: `client/src/`,
  its browser tests and its build.
- `shell`: the app around the page, in Rust: `client/src-tauri/`.
- `phone`: what only the phones run: the Xcode and Android projects, the
  share extension and share window, files named for the phone, and the
  iPhone flows.
- `server`: the server, and the types that cross the wire: `crates/`.
- `ci`: the checks, the workflows, packaging and the release: `scripts/`,
  `.github/`, `packaging/`.
- `deploy`: running a server: `deploy/`.
- `tests`: a test anywhere, as well as its own part.

Docs, pictures and fonts are in no part and get no questions. A file the
script doesn't know is in every part, and a test fails until it's added.

## Questions

### Can two copies of this run at once, one run twice, or two programs change the same thing?

For: page, shell, phone, server, ci
Gaps: Two at once

Two share sign-ins at once signed the app out, and the app and the share
window wrote over each other's sign-ins (#822). A release job run again
undated a published release (#794). Make them take turns or share a lock,
and test two at once, and one run twice.

### What happens offline, in the background, or just restarted?

For: page, shell, phone
Gaps: Written from what's connected right now

The share window's list was written from the servers connected that moment,
so a minute in the background emptied it (#825), and a server down while
another changed dropped it (#826). Test with a server down, one still
connecting, the app in the background, and the app started fresh.

### Is there a second copy of this state, or something kept beside it?

For: page, shell, phone
Gaps: Written from what's connected right now; A retry key kept after what it keys changed; State worked out from the history that's loaded, not all of it

A copy of the share list kept in the page outlived signing out (#826). Ids
kept beside the history weren't trimmed with it (#759). A retry key outlived
the words it stood for (#822). Read from one place. Where a copy has to
exist, it changes and goes everywhere the original does.

### Is anything worked out from a room's history, or kept beside it?

For: page
Gaps: State worked out from the history that's loaded, not all of it

The app holds a window of each room's history, never all of it (#173). Test
with older history only, the newest not loaded, trimmed, paged back in, and
replaced by a window around a message. An old share line looked live in
older history (#751).

### Does it compile, and work, on every platform it runs on?

For: shell, phone
Gaps: Code only one platform compiles

Code behind `#[cfg(target_os = …)]` is built only for that platform, and
most of a pull request's checks build Linux. The iPhone half of #822 didn't
compile. Build every platform the change touches, or say in the pull request
which you couldn't.

### Is each guard checked right before what it guards?

For: page, shell, server, ci
Gaps: Checked when asked, not when it happens; Counted after the work it limits

A check made before something slow (a request, a download, a prompt) can be
stale after it: an update restarted somebody out of a call they'd joined
meanwhile (#794). A limit counted after the work let a table grow (#822).
Check again right before acting, and test the state changing in between.

### Is it tested going wrong partway, not only going through?

For: page, shell, phone, server, ci, deploy
Gaps: Tests written from the case in mind, not from the ways things fail

Stopped or overtaken while it waits, part of it failing, and a network that
refuses, drops, cuts off half way or never answers. A share turned down
while its files were read was sent anyway (#792). The cases are in
`docs/testing-strategy.md`, "What reviews have taught".

### Is each screen tried at its limits?

For: page
Gaps: Tests written from the case in mind, not from the ways things fail

A phone held sideways, words taller than the window, the window resized
while a card is open, the card's opener pressed again, straight from one
card to the next, and only a keyboard or a screen reader. A topic's card
failed five ways (#796).

### Is a value shared between windows, or kept in storage, tested changing somewhere else?

For: page
Gaps: Tests written from the case in mind, not from the ways things fail

An open volume card kept its own level while the voice bar changed it
(#774). A text size chosen while storage refused showed but didn't apply
(#780). Test it changing in another window while it's showing, and with
storage full or gone.

### Would each new test fail with the code wrong?

For: tests
Gaps: A check its surroundings can fool; A test of the source, not of what it does

Break the code and watch the test fail. A test that reads the source
(#768), inherits the setting it's there to prove (#757), uses a queue
roomier than the real one (#809), or stops a wait before it starts (#802)
passes broken code.

### Does a check that reads code, commands or docs take every form, and fail on what it can't read?

For: ci
Gaps: Tests written from the case in mind, not from the ways things fail

Every form the language has, not only the ones in use today, and every way
the code is reached: through a variable, or from code it calls. Three checks
took several reviews each, a form a round (#763, #771, #831). Start from a
table of tricky inputs, and fail loudly on anything else (#807).

### Does it assume this machine, or run only on another one?

For: ci, deploy, phone
Gaps: A script that assumes one machine's layout; A check nobody could run before it mattered

The GPU check looked for libraries where Arch keeps them, not Fedora or
Ubuntu (#757). A step that runs only on a Mac, a phone or in a release keeps
its logic in a script a test runs here; one read every signature wrong
(#812).

### Does each fallback cover only the case it's for?

For: ci, deploy
Gaps: A fallback wider than the case it's for

`a | b || echo none` also hides `a` failing: a broken `nm` read as "none
found" (#781). Run what has to work on its own line, and treat only the
status that means nothing was found as none.

### Which written rule applies here that no check enforces?

For: shell, phone, server
Gaps: A rule the code doesn't check; A rule nothing checks

Read for them by hand: no blocking file work on the async runtime (#792,
#794), and what the phone app writes stays out of backups (#792). Better,
shape the code so the mistake can't be made, as `Store` did for the update
files (#794).

### What does it leave behind when it ends, fails or is cancelled?

For: page, shell, phone
Gaps: Files left behind

Every share left its copies in a temporary folder until iOS cleared it
(#822), and a copy the phone stopped partway stayed (#792). Look for the
files, timers, listeners and entries it makes, after it succeeds, fails and
is cancelled.

## Kinds a check covers

These kinds of mistake have a check in CI, so nobody is asked about them:

- **Docs naming a file that isn't there**: `scripts/doc-paths.test.mjs`
  fails on a file a living doc names that isn't there (#770).
