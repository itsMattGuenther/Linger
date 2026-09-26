# V1 polish — closed tasks

Archived from `TASKS.md` on 2026-09-25, with every landing note as it was
written. The tasks still open stay in `TASKS.md` under "V1 polish".

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
  published and HC-1 remains open. [Evidence and check](../windows-update-checks.md).

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
  workflows run these checks; see [method and limits](../packaged-audio-checks.md).
  No release or real-listener check is closed by this work alone.

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
  stable action geometry at 100%/200%. Comparison and screenshots (removed in 0.4.0).
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

- ✅ **T-909 · Make Console controls readable and reachable** — effort: **high** — Matt, 2026-09-17
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
  Console review and checks (removed in 0.4.0) and the root
  screenshots (removed in 0.4.0). The full local gate passes. Packaged
  Windows/Omarchy and the unaided-friend acceptance remain open; keep T-909
  in progress until those checks have evidence.
  **Review follow-through:** scale is only in Appearance, visible branding is
  Linger, ongoing voice controls remain reachable in other destinations, and
  Settings copy is shorter. Wide message lines are bounded; actions use label
  sizing instead of metadata sizing. See the review for research and evidence.
  **Local interaction review, 2026-09-17:** review 03 (removed in 0.4.0)
  proposes plain voice names with a collapse chevron, compact toolbar icons,
  bottom-anchored Media/Search, selected-server management and member popouts.
  That iteration used the README banner on welcome. See the
  control style guide (removed in 0.4.0). Review 04 supersedes this
  checkpoint; its visual direction was approved on 2026-09-17.
  **Quiet-delight pass, local, 2026-09-17:** review 04 (removed in 0.4.0)
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
  removed. See QA screenshots (removed in 0.4.0).
  Eight new browser cases cover layout, keyboard actions, legacy fonts and
  switch persistence. The full local gate, 126 Chromium browser cases and
  production build pass. This scoped repair does not close the remaining
  T-909 acceptance checks.

  **Superseded 2026-09-25:** the Buddy list client (M15) replaced the Console
  screens this task was polishing. Closed without further work.

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
  desktop-check-results.md (removed in 0.4.0).
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
