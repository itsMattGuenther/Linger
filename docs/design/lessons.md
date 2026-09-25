# Lessons from the first client

**Status:** written 2026-09-25 for M15 (#198). Every lesson here came from a
real report, a fix, or a review of the first client. Each one ends in a
**rule** the Buddy list client follows and a **check** that enforces it, so
the lesson is kept by the build rather than by memory.

Where this says "discipline test" it means `client/src/next/kit/discipline.test.ts`:
a unit test that reads the new client's source and CSS and fails on forbidden
patterns (see [`architecture.md`](architecture.md)). "Geometry test" means
Playwright measuring real boxes on the kit gallery or a screen fixture, in
Chromium and WebKit. "Desktop check" means the real app under WebKitGTK via
`tauri-driver` (`docs/desktop-checks.md`), and WebView2 in Windows CI.

---

## Sizing and alignment

### L-01 · Controls were sized where they were used, so neighbors disagreed

- **What happened:**
  - #88: Send was about 7px shorter than the message input beside it.
  - #146: the `+` button sat low and off-center. `.composer-row` was defined
    twice in `app.css`, with the two rules fighting.
  - #144: the server's "⋯" was a text character; the roster's was an icon.
    They had different sizes and neither was centered.
- **Cause:** each surface drew and sized its own controls. There was no single
  source for "a button is this tall" or "the more-options icon is this".
- **Rule:**
  - Every control comes from one kit component per kind: button, icon button,
    field, switch, tab.
  - Heights come from one scale of three sizes (see `system.md`). Controls
    that sit together in a row share one height token.
  - Screens pass variants, never sizes.
  - A CSS selector is defined once.
- **Check:**
  - Geometry test: every control's outer height is on the scale, and controls
    in a row have equal heights and a shared center line, at 100% and 200%.
  - Discipline test: no duplicate selectors, no `height`, `padding` or
    `font-size` literals in screen CSS (tokens only), and no text-character
    icons.

### L-02 · Icons weren't centered in their own boxes

- **What happened:** #172.
  - The search glyph's circle was centered at (10, 10) of a 24-unit box, so
    even a centered icon drew up and to the left.
  - The media glyph's "sun" was a 0.01-unit dot, too small to draw.
  - Rows top-aligned for wrapping (#83), and single-line rows inherited it,
    putting icons 3.5px above their labels.
- **Cause:** icons were drawn ad hoc, and nothing measured the painted glyph
  against its box.
- **Rule:**
  - One icon set, each glyph drawn around the center of its view box, with no
    feature smaller than a pixel at the smallest size it's used.
  - Icons render in a fixed square box that is centered in its control or row.
- **Check:**
  - A unit test over the icon set: each glyph's bounding box is centered in
    its view box to within 0.5 units, and has a minimum feature size.
  - Geometry test: the icon box's center equals the control's center (or the
    label's first-line center) to within 0.5px.

### L-03 · Alignment was fixed by nudging with margins

- **What happened:** #164. Occupancy dots were pushed down with
  `margin-top: 0.35em` from the top of a top-aligned row. Their middle landed
  3.4px above the name's middle, and differently at other scales and faces.
- **Cause:** a nudge is tuned to one font, one size and one scale, and silently
  wrong for the rest.
- **Rule:**
  - No alignment by margin or `top` nudges.
  - The list row has a fixed marker column one name-line tall, with its
    content centered, so markers sit on the name's first line whatever the face
    or scale.
- **Check:**
  - Geometry test: the marker's center equals the name line's center, to within
    0.5px, for every one of the 12 faces at every interface scale.
  - Discipline test: no `margin-top` or `top` offsets on markers or icons.

### L-04 · A global element rule changed components it didn't know about

- **What happened:** #181. `base.css` gave every `button` a 2rem minimum
  height. The reply quote is a button, so its 22px of text sat in a 32px box
  with 10px of empty space. The quote then read as the tail of the message
  above.
- **Cause:** styling HTML elements globally reaches into every component that
  happens to use that element.
- **Rule:**
  - Base styles only reset: fonts, box sizing, colors.
  - Sizing lives on kit classes, never on element selectors.
- **Check:**
  - Discipline test: element selectors in CSS may set only an allow-list of
    properties (no `height`, `min-height`, `padding` or `margin`).
  - Geometry test for the reply quote: the gap to its own text is smaller than
    the gap to the message above.

### L-05 · Row heights changed with the name's face

- **What happened:** Matt's review of the prototype on 2026-09-25.
  - People and DM rows had uneven gaps, because a name in a tall serif made
    its row taller.
  - Group DM rows started their names further right than single DMs.
- **Cause:** a row's height came from its content, and the marker column's
  width from how many markers it held.
- **Rule:**
  - Rows have fixed heights per kind.
  - The name line is a fixed line box, and faces never change it.
  - The marker column has one width, and group DMs arrange inside it.
- **Check:** geometry test on the gallery. Every row kind is rendered with all
  12 faces, with one, two, three and four markers. Heights are identical and
  names start at the same x.

### L-06 · Things overflowed: scrollbars, clipped text, clipped tooltips

- **What happened:**
  - #83, then #100 (a regression): the left rail grew a horizontal scrollbar.
    The second time, a negative-margin scroll box caused it.
  - #140: voice tooltips were cut off by a collapsed bar that hid overflow.
  - Prototype review (2026-09-25): text was cut mid-word ("the real on")
    instead of ending in an ellipsis.
- **Cause:** containers with negative margins or hidden overflow, and text with
  no rule for what happens when it doesn't fit.
- **Rule:**
  - No negative margins on scroll containers.
  - Every single-line text either fits or ends in an ellipsis. Multi-line text
    wraps by design.
  - Tooltips, menus, cards and popovers render in a top layer (a portal), never
    inside a clipping ancestor.
- **Check:**
  - Geometry test: no container's `scrollWidth` exceeds its `clientWidth`
    (with long, unbroken names).
  - Geometry test: every single-line text node either fits or has
    `text-overflow: ellipsis`.
  - Geometry test: every tooltip and popover lies fully inside the window.
  - Discipline test: no negative margins in list or scroll CSS.

### L-07 · Changing state moved things

- **What happened:**
  - #137: going bold when talking widened a voice seat and pushed its
    neighbors, and the talking line grew the bar.
  - #139: hovering a message made it change size. A fading opacity put the
    action button on its own compositing layer inside a transformed row, and
    WebKitGTK at a fractional scale then drew the row's text a subpixel off.
  - #141: joining voice showed a half-built bar in three steps (57 → 116 →
    176 → 105px).
  - #142: the conversation blinked for a frame when the voice bar resized.
  - #129: "Sending…" appeared with no space of its own.
- **Cause:** a state that adds, removes or re-weights content changes the box
  unless space is reserved. And scroll corrections that wait a frame paint the
  wrong position once.
- **Rule:**
  - State changes never change a box's geometry. Reserve the widest state (a
    hidden bold copy), and swap content inside fixed boxes.
  - Hover shows the action button in one step, with no transitions on hover
    inside virtualized rows.
  - A component draws its final layout from the first frame of a state change.
  - Scroll corrections for resizes run inside the ResizeObserver callback
    (after layout, before paint).
- **Check:**
  - Geometry "nothing moves" tests: toggle hover, focus, talking, muted,
    pending, typing and knocked, and assert every bounding box is unchanged.
  - Frame-by-frame recording for voice join and leave (the #141/#142 technique
    already in the repo).
  - Discipline test: no `transition` on properties inside `.row` hover rules.

## Spacing and copy

### L-08 · Spacing grew by accretion

- **What happened:** it took three rounds to reach the density Matt wanted.
  - #92: line spacing.
  - #93: group gaps, hidden action rows that reserved space, and per-message
    color bars.
  - #181: the reply gap.
- **Cause:** margins stacked on margins in several places, and invisible rows
  reserved height.
- **Rule:**
  - Vertical rhythm comes from spacing tokens.
  - Containers space their children with `gap`; children carry no outer
    margins.
  - Nothing invisible reserves height.
  - One comfortable presentation, with no density modes. Compact and IRC
    multiplied the test matrix and were removed
    (`docs/console-ui-review.md`).
- **Check:** geometry tests measure the gaps between consecutive messages,
  groups and sessions against `system.md`'s values.

### L-09 · Copy and labels drifted

- **What happened:**
  - #90: settings headings in mixed case.
  - #97: "Join voice" vs "Join Voice".
  - #145: a header listed names nobody wanted.
  - #74: DMs showed as UUIDs in a search filter because one surface named them
    differently.
- **Cause:** strings and names were written where they were used.
- **Rule:**
  - Copy for each screen lives in one module.
  - Headings and navigation labels use title case; sentences use sentence
    case.
  - Rooms and DMs are named by one function (`lib/dm.ts`) on every surface.
- **Check:**
  - A unit test over the copy modules checks casing and the vocabulary (SPEC
    §1).
  - A unit test that every surface's room or DM label comes from the naming
    function.

## Focus and overlays

### L-10 · Mouse-opened panels looked keyboard-opened

- **What happened:**
  - #96: bright outlines, and the Close tooltip showing on open.
  - #143, a regression of #96: the X was focused with its tooltip again, on
    server options and profiles.
- **Cause:** the panel asked whether its opener matched `:focus-visible`. After
  Escape returns focus by script, the next click still "matches", and engines
  disagree on the heuristic.
- **Rule:**
  - Open mode comes from the last real input, captured on `window` (the
    existing `lib/ContextPanel.tsx` approach).
  - A pointer-opened panel focuses itself; a keyboard-opened one focuses its
    close button with the ring.
  - Tooltips show only on hover or keyboard focus.
  - Every overlay in the kit uses one shared primitive.
- **Check:** a Playwright test for every overlay kind (menu, card, popover,
  picker, preview), opened by mouse and by keyboard, in both engines. It checks
  the focus target, the ring, the tooltip, Escape, an outside click and focus
  return.

### L-11 · Menus weren't anchored to their trigger

- **What happened:** #89. The attachment menu floated left of the composer, over
  other controls.
- **Rule:**
  - Overlays anchor to their trigger through one positioning function, which
    keeps them inside the window.
  - Escape, an outside click or the trigger dismisses them.
- **Check:** geometry test: the menu's edge is within a token distance of its
  trigger and fully on screen, at every scale.

## Performance on WebKitGTK

### L-12 · Typing ran ahead of the letters

- **What happened:**
  - #127: the composer measured itself on every keystroke by collapsing to
    `height: auto`. That laid out the whole window, and WebKit clamped the
    stream off its edge. #132 fixed it with a hidden measuring copy.
  - #169: after that, the remaining lag was the GPU path being off.
- **Cause:** layout work on every keystroke, and a drawing path that copies each
  frame through memory.
- **Rule:**
  - Nothing measures or lays out the page on a keystroke. Growing text boxes
    measure a detached copy (reuse `lib/autoGrow.ts`).
  - Typing latency has a budget in `system.md`, measured in real WebKitGTK.
- **Check:** desktop check. The key-to-next-frame probe from #169 runs in the
  real app, and fails over the budget.

### L-13 · The GPU display path (GBM) crashes some machines and is needed on others

- **What happened:**
  - #114: aborts at launch on NVIDIA + Wayland.
  - #169: lag with GBM off.
  - #187: the AppImage's bundled WebKit 2.50.4 crashes with GBM on.
  - #135: a Wayland protocol error with NVIDIA explicit sync.
- **Cause:** WebKitGTK's GPU path depends on the driver and the WebKit version.
  Only trying it tells.
- **Rule:**
  - The shell's startup plumbing stays as it is (`linux_startup.rs`,
    `graphics.rs`).
  - **The new client's page must call `graphics_started` after its first two
    frames**, exactly as `main.tsx` does, or a good launch is recorded as a
    crash and the next launch turns the GPU path off.
  - Performance is judged on the system WebKit (the .deb, .rpm and Arch
    packages), not the AppImage.
- **Check:**
  - A desktop check that asserts the probe file is removed after launch.
  - The existing Rust unit tests in `linux_startup.rs`.

### L-14 · Scrolling re-rendered every row

- **What happened:** #170. Each scroll frame re-rendered about 40 rows (150 on
  a scroll-bar jump), and each row built two new `Intl.DateTimeFormat`s. Script
  time for a wheel scroll dropped from 12.1s to 4.0s once rows were memoized
  and formatters cached.
- **Rule:**
  - Rows and the composer are memoized, and the props they take are stable.
  - Formatters are built once.
  - Lists are virtualized (AGENTS).
- **Check:**
  - The CPU-throttled Chromium scroll measurement becomes a budgeted test.
  - A desktop scroll check in WebKitGTK.
  - A unit test that formatters are cached.

### L-15 · History grew without bound

- **What happened:** #173. Every loaded message stayed in memory until restart.
- **Rule:** reuse the store's windowing. Only the conversation on screen keeps
  scrollback, and rooms you've left keep their newest page. With several
  windows, each window holds only what it shows.
- **Check:**
  - The existing `history-memory.spec` behavior, ported to the new screens.
  - Memory recorded per window in a desktop check.

## Messaging semantics

### L-16 · Sending held the composer and could strand Enter

- **What happened:**
  - #117: letters typed after Enter joined the message just sent.
  - #128: the message waited for the server before it appeared.
  - #118: Enter silently stopped sending after a knock stuck on "Knocking…".
    The composer ignored Enter while it thought a send was open, and nothing
    had a deadline.
- **Rule:**
  - Sends are optimistic and several can be in flight. The composer never
    waits and never silently ignores Enter.
  - Every request has a deadline. When it runs out, it says so in words and
    re-enables its control.
  - A failed send keeps its text without touching a newer draft.
- **Check:**
  - A unit test of the send queue: deadlines, retries, and preserving the
    draft.
  - A fixture test with a server that never answers: Enter still sends the
    next message, and the stuck one shows a timeout.

### L-17 · Replies drew in the wrong place

- **What happened:**
  - #116: a reply's quote sat above the sender's name.
  - #115: deleting a reply left its quote behind.
  - #181: the quote hugged the message above.
- **Rule:**
  - A reply's quote is part of the reply: under the name, right above its own
    text, and gone when the reply is deleted.
  - With inline names (decision 9 in `parity.md`), the quote still attaches to
    its own message.
- **Check:** port `replies.spec` (placement, deletion, spacing) to the new
  conversation view.

### L-18 · Catching up was a button and a band

- **What happened:** #123. The "since you were gone" header control and band
  took space and needed clicks.
- **Rule:**
  - Opening a conversation with something new lands on "you left off here".
    A caught-up one opens at the newest.
  - Live arrivals never move a reader. There's no catch-up band.
- **Check:** port the `console.spec` landing tests to tabs, including a tab
  opened in the background.

### L-19 · A fresh connection didn't know who was already in voice

- **What happened:** #119. The voice list only arrived when someone changed
  something, so friends already in voice were invisible until you joined.
- **Cause:** a missing snapshot. It was fixed with `ready.voice`.
- **Rule:**
  - Everything a window draws must be derivable from a snapshot plus frames.
  - Viewer windows catch up from the owner's snapshot (`core/catchup.ts`),
    never by waiting for a change.
- **Check:** a property test that a viewer opened at any point matches the
  owner, and a fixture test with a voice room occupied before connect.

## Voice UI

### L-20 · Voice seats had extra words and wrapping states

- **What happened:**
  - #121: "you" under your own name knocked the speaking line out of line.
  - #124: "can't reach" wrapped, half under the next seat, and the failed line
    through a name was too thin.
  - #138: bold-and-underline read like a link.
- **Rule:**
  - No words that position already says ("you").
  - A seat's state line is one line, centered on its person, and never wraps
    outside it.
  - The speaking mark must not look like a link and must not change geometry
    (see L-07). Which mark is decision 7 in `parity.md`.
- **Check:** geometry tests on the voice bar in every state: talking, muted,
  deafened, connecting, can't reach, no controls, and a long name.

### L-21 · Moving voice looked like joining

- **What happened:** Matt, 2026-09-25. He remembered switching rooms as
  dropping voice. In fact, clicking Join in another room moves you on purpose,
  and both buttons said "Join".
- **Rule:** join, "Move voice here" and "Talk here instead" are different
  labels. Nothing but Leave, moving or quitting ends voice.
- **Check:** a fixture test covering reading another tab, closing the voice
  room's tab, and closing its window. Voice stays in each case, and each label
  matches its effect.

## Sound

### L-22 · The package didn't play what the browser played

- **What happened:**
  - 0.3.0: the AppImage lacked GStreamer playback plugins, so chimes were
    silent.
  - #94: a crackle at the start of chimes.
  - #95: the knock was clipped to one tap. The attack was lost as output
    started; the fix was 50ms of leading silence.
  - #186: quiet hours also silenced mute and deafen sounds.
- **Cause:** browser tests and offline rendering never exercised the packaged
  audio path, and the category rules were implicit.
- **Rule:**
  - Reuse `lib/sound.ts` and `lib/chimes.ts` unchanged: rendered buffers with
    leading silence, and explicit categories.
  - Quiet hours cover only notification categories.
  - Only the owner window plays sounds.
- **Check:**
  - The existing unit tests of the gates.
  - The packaged audio check (`scripts/linux-audio-check.py` and the Windows
    scripts) in CI.
  - A fixture test that two windows produce one chime.

## Desktop and packaging

### L-23 · Native Wayland brought a title bar nobody asked for

- **What happened:** #130/#131. Moving to native Wayland made GTK draw its own
  title bar under Hyprland, which draws none.
- **Rule:**
  - New-client windows are frameless and draw the kit's title bar.
  - Each desktop's behavior (Hyprland, GNOME, Windows 11 snap and shadows) is
    checked before a window kind ships.
- **Check:**
  - The Rust unit test of the decoration choice.
  - A desktop check per window kind on Hyprland, GNOME and Windows.

### L-24 · Dictation broke under X11

- **What happened:** #122. Voxtype's simulated keystrokes arrived as numbers
  under XWayland; native Wayland works (T-928).
- **Rule:** never regress the native-Wayland default. Text inputs are standard
  `input` and `textarea` elements, with no key interception that could eat
  synthetic input.
- **Check:** the `wtype` input check from `docs/linux-input-checks.md`, run
  against the new composer.

### L-25 · Installers and icons surprised us

- **What happened:**
  - #108: an MSI upgrade created a duplicate desktop shortcut.
  - The published 0.1.0 packages carried stale icons, and Tauri used the first
    (32px) PNG as the Linux window icon.
  - #188: the in-app updater had to stand down for the Arch package.
- **Rule:**
  - Installer identity and icon generation stay as they are.
  - The new client honors the `managed` update state, and never offers to
    replace a system-managed install.
- **Check:** the existing Windows update checks, `scripts/app-icons.py --check`,
  and a unit test for the `managed` state in the new update screen.

### L-26 · Local paths resolved against the wrong origin

- **What happened:** T-920. Images and export links asked the webview's origin
  instead of the server's, and a root-relative link was silently refused by the
  native opener.
- **Rule:**
  - Every server-supplied path resolves against the server that sent it.
  - Every link leaves through `lib/external.ts`.
- **Check:** the existing unit tests, plus a desktop check that a local
  server's image and export open.

## Sessions and resilience

### L-27 · An outage looked like losing your account

- **What happened:**
  - T-906: any token-renewal error ended the sign-in and deleted the saved
    token.
  - T-907 (still open): one slow server delays the whole app at startup.
- **Rule:**
  - Only an authentication rejection ends a sign-in.
  - Servers restore independently, each with a deadline, and a failed one keeps
    its entry and offers a retry.
- **Check:** the existing `api.test.ts`, plus a unit test that one hung server
  doesn't delay the others.

### L-28 · A refresh token spent twice signs you out

- **What happened:** React's StrictMode double-mount would have restored twice
  and revoked the token family. Module-scope promises prevented it. Several
  windows make this risk permanent.
- **Rule:** only the owner window refreshes. Viewers borrow the current access
  token and ask the owner to refresh (`architecture.md`).
- **Check:** unit tests: one refresh in flight, viewers never call refresh, and
  the old client's behavior is unchanged.

## How we worked

### L-29 · Fixes regressed because checks tested the wrong thing

- **What happened:**
  - #83 came back as #100.
  - #96 came back as #143.
  - The first spacing fix (#92) didn't meet the ask, and #93 followed.
- **Cause:** checks asserted class names or one engine, not the result a person
  sees. Or there was no check.
- **Rule:**
  - Every fix gets a regression test that asserts the visible outcome, in both
    engines.
  - Run it against the old behavior first, and record that it fails
    (`docs/testing-strategy.md`).
- **Check:** manual. The PR checklist requires the failing-first test, and
  review enforces it.

### L-30 · Browser tests passed while the app didn't

- **What happened:** silent packaged audio (0.3.0), GBM crashes, stale icons,
  the Hyprland title bar, local media origins. Each passed Chromium and WebKit
  fixtures and failed in the real app.
- **Rule:** every window kind and every new surface gets a real-app check under
  WebKitGTK before merge. A fixture is not the app.
- **Check:** the desktop checks (`tauri-driver` under Xvfb) run before each
  merge to `feat/198-buddy-list`, with results recorded in the PR.

### L-31 · Timing-based tests were flaky

- **What happened:** the #137/#138 "alone" voice tests failed about half the
  time in WebKit when run side by side, and a #142 test failed one run in
  thirty. The fixture let events race.
- **Rule:**
  - Fixtures deliver events explicitly and in order: no sleeps, no "wait and
    hope".
  - A new spec is run repeatedly before it lands.
- **Check:** CI runs new and changed specs with `--repeat-each` (for example
  10), and blanket retries stay off (`docs/testing-strategy.md`).

### L-32 · Unfinished work was shown as finished

- **What happened:** Matt's review, 2026-09-25. He saw:
  - an unfinished Settings screen;
  - uneven spacing under names;
  - a styled marker next to an unstyled one;
  - text cut off mid-word.

  Part of it was a live preview mid-edit.
- **Rule:**
  - Screens are built only from kit parts, so one state always looks one way.
  - Nothing is shown to Matt as done until it has passed the geometry tests
    and been looked at, at actual size, in the real Linux app.
  - Say so when a preview is still changing.
- **Check:** the discipline test (screens import only the kit, and no one-off
  markers), the gallery review, and the desktop check before any PR is marked
  ready.

### L-33 · Spec and code drifted

- **What happened:**
  - #145: the room header followed SPEC §4.1 and Matt didn't want it.
  - #93: the per-message color bar was removed.
  - #123: the catch-up band was removed.

  Each needed the spec changed with the code.
- **Rule:** a behavior change updates `system.md`, `buddy-list.md` or
  `parity.md` in the same commit. After the switch, it updates SPEC.
- **Check:** manual. Review requires the doc change in the diff.

---

## Also found (not client UI)

- **#151:** exports had no server-wide concurrency cap.
- **#152:** ffmpeg and ffprobe ran on uploads with no time or resource limit.

Both are server fixes, already landed. They're recorded here because the new
client shows export progress and upload results, and must keep saying plainly
when the server refuses.

---

## Rules at a glance

1. **Sizes:** every control comes from a kit component. Heights come from one
   three-step scale, and controls in a row share a height and a center line.
2. **Icons:** one set, drawn centered in their boxes, in fixed square boxes
   centered in their controls.
3. **Alignment:** no margin nudges. Rows have one marker column, one name-line
   tall.
4. **Global styles:** base styles reset only; sizing never goes on element
   selectors.
5. **Rows:** fixed heights, whatever the face. Names line up down the whole
   list.
6. **Overflow:** single-line text fits or ends in "…". Overlays render in a top
   layer. No negative margins on scroll boxes.
7. **State changes:** they never move anything. Reserve space; no hover
   transitions in rows; the final layout from the first frame.
8. **Spacing:** tokens and container `gap`, with no invisible reserved rows and
   one presentation.
9. **Copy:** one module per screen, title-case headings, one naming function
   for rooms and DMs, and SPEC §1's vocabulary.
10. **Overlays:** they open by last real input: a pointer focuses the panel, a
    keyboard focuses the close button. One shared primitive.
11. **Performance:** no layout on keystrokes. Memoized rows and cached
    formatters. Budgets for typing, scrolling, memory and window-open time,
    measured in real WebKitGTK.
12. **`graphics_started`:** the page calls it after its first frames, every
    launch.
13. **Sending:** optimistic, never blocks Enter. Every request has a deadline
    and says when it times out.
14. **Windows:** everything is derivable from a snapshot plus frames. Viewers
    catch up from the owner, and only the owner refreshes tokens, connects,
    plays sounds, notifies and drives voice.
15. **Voice labels:** join, move and "talk here" are distinct. Only Leave,
    moving or quitting ends voice.
16. **Sounds:** reuse the tested player. Quiet hours cover notifications only.
    One chime per event, however many windows are open.
17. **Desktop:** frameless windows with the kit's title bar, checked on
    Hyprland, GNOME and Windows. The native-Wayland default is never regressed.
18. **Paths:** every server path resolves against its server, and links leave
    through the system browser.
19. **Tests:** every fix gets a test of the visible outcome, failing first, in
    both engines. New specs run repeatedly, and there are no blanket retries.
20. **Real app:** every surface gets a real-app check before merge, and nothing
    is shown as done before it passes.
