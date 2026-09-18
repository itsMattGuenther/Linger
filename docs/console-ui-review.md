# Console UI review — 2026-09-17

T-909, M12 polish. No milestone or release check is closed by this review.

This records the earlier implementation checkpoint and its checks. The newer,
approved [control style guide](style-guide.md) and
[review 04 screenshots](../screenshots/review-04/README.md) supersede its visual
placement choices, including Host tools and voice-control alignment. The gate
results below describe the earlier checkpoint; the style guide records the
later iteration's verification. Matt approved that direction for the v0.2.0
testing release on 2026-09-17. Native acceptance remains open.

## Changes

- One comfortable presentation. Removed Density, Compact and IRC, including
  their rendering branches and style overrides. Old preferences are ignored.
- Readable 16px body text, stronger label contrast, 100–200% interface scale
  in Settings → Appearance. The sign-in screen uses the saved scale but has no
  size control. Dark, light and system themes remain.
- Adjustable navigation and people columns with pointer and keyboard controls.
  Saved widths survive resizing. Below 960 effective pixels, People opens the
  roster on demand; below 640, Navigation opens the rail. Effective width
  accounts for interface scale. Widening restores the columns automatically.
- One server identity, `DMs` / `empty`, personal Settings beside your name.
  Host tools contains member removal with confirmation; ordinary member cards
  have the same actions for hosts and members.
- Profile, Appearance, Sound & voice, Account & app. Desktop notification rules
  moved out of the roster into Sound & voice, separate from chime preferences.
- Prominent voice names, optional participant hiding, local volume on demand
  by click, right-click or keyboard. No avatars. Wire and audio-engine behavior is
  unchanged. Short windows initially collapse participants, not call controls,
  unless the reader explicitly chose otherwise.
- Ongoing voice controls remain visible when browsing another room/server,
  Settings, Media or Search. Return to the room without leaving voice. The
  same controls handle push-to-talk in both views; changing away from the
  room releases a held key, and losing window focus always releases it.
- Shorter Settings copy, “Use plain names and message fonts” instead of
  “normalize everyone,” and an accurate export description (public rooms and
  your DMs, not every private conversation on the server).
- Message bodies stop at 80ch on wide screens. Voice actions sit near the
  participant heading instead of at the distant right edge of a 4K window.
- Capitalized Linger in the welcome screen, browser/window titles, notification
  sender and installer metadata. Kept the app identifier and original MSI
  upgrade code stable.
- Preserve unsaved status drafts as the People panel changes between a column
  and a drawer. Chat keeps the live edge pinned through resize measurements,
  but does not pull someone reading older messages back to the bottom.

The responsive roster change and removal of density modes were approved during
review. SPEC and the current guides describe the new behavior. Historical
screenshots and earlier test records are not rewritten.

## Design review after feedback

The first implementation emphasized readable sizing and mechanical layout
checks. That was not a substitute for a task-focused design review. Removing
the first-run size control is a correction, not another customization feature.

The following primary guidance informs this review. The applications to Linger
are design judgments, not claims that a checklist proves usability:

- [NN/g: progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/):
  keep the initial task focused and secondary choices predictably reachable.
  For Linger, connecting should ask for a link, not an appearance preference.
- [Discord: Appearance settings](https://support.discord.com/hc/en-us/articles/207260127-How-to-Change-Discord-Color-Themes-and-Customize-Appearance-Settings):
  desktop zoom lives in Appearance. Adopt that familiar location, not Discord's
  unrelated density modes, avatars, paid themes or other product features.
- [Fluent: layout](https://fluent2.microsoft.design/layout) and
  [typography](https://fluent2.microsoft.design/typography): use spacing,
  alignment and text hierarchy to establish relationships. Reflow or collapse
  secondary regions when space is limited; shrinking all text is not a layout.
- [NN/g: usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/):
  expose current state and familiar actions, provide escape routes, and avoid
  making people remember hidden controls. Host actions belong in Host tools.
- [W3C: resize text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html):
  enlarged text must not remove content or functionality. Continue testing 200%
  app scale, including saved scale on sign-in; this is not a conformance claim.

Current screen review, in priority order:

1. **Connection:** remove Interface size here. Keep it in Settings → Appearance.
   Keep readable initial typography and respect a previously saved scale. Done.
2. **Call continuity:** a compact bottom strip names the ongoing room and
   preserves mute, deafen, leave and return when its stream is not visible.
   Automated navigation and control-failure checks pass; real audio acceptance remains.
3. **Settings language:** shortened routine descriptions and changed the plain
   styling label to describe its effect. A friend still needs to try these labels.
4. **Visual hierarchy at large sizes:** bounded message line length and brought
   voice actions beside the participant heading. Reviewed the 4K captures;
   physical-display comfort still needs Matt's judgment. Overflow checks alone
   do not settle this.

No analytics or instrumentation are added. Evaluate these flows through direct
observation and a friend attempting ordinary tasks without coaching.

## Screenshots

See the root [screenshots index](../screenshots/README.md). These are production
React components with synthetic people, API responses and desktop events in
Chromium. No saved accounts, live servers or private test tokens are used.
They are not native desktop evidence or an audio test.

From `client`, reproduce with:

```bash
LINGER_CHROMIUM_PATH=/usr/bin/chromium node scripts/console-screenshots.mjs
```

Omit the environment variable when using Playwright's installed Chromium.
The script owns its local preview process and closes it afterward.

## Verification

- Full local `scripts/check.sh origin/main` passed, including workspace and
  desktop-shell Rust checks, generated bindings, frontend typecheck and tests.
- 439 frontend unit tests passed. Removed three tests specific to the deleted
  IRC mode and added four interface-preference/layout tests.
- Chromium and WebKit browser suites: 76 tests each. Coverage includes pointer/keyboard panel
  resizing, persistence, modal focus/Escape, all six scale choices at 1100×720
  and 760×480 in both themes, enabled label contrast, old density preferences,
  ongoing voice while navigating, push-to-talk release and control failures,
  paged history remaining virtualized during resizing, attachment fitting through 200%
  scale, downloads, composer input, knock feedback, voice controls and sounds.
- 4K coverage uses 3840×2160 at desktop 100%, 3072×1728 at device pixel ratio
  1.25 (Matt's desktop setting), and 1920×1080 at device pixel ratio 2. All
  represent 3840×2160 physical pixels and exercise app scale at 100%, 150%
  and 200%. This is browser high-DPI emulation, not a physical-monitor test.
- The history fixture has 10,000 available messages but serves 100 per page,
  like the API. The checks do not claim 10,000 simultaneously loaded messages.
  They cover early resizing, settled resizing and keeping an older message
  visible. Fixture responses arrive on a later task, like network responses.
- Normal enabled labels are checked against 4.5:1 contrast in dark, light and
  both evening-warm variants. This is not a claim of full WCAG conformance.
- No new runtime dependencies or changes to server authorization, voice state,
  notifications on the wire, or message fetching. The generated search binding
  changes only because its comment no longer refers to density modes.

CI must pass before merge. Native acceptance remains separate:

1. Use the packaged Windows and Omarchy clients at ordinary and high-DPI sizes.
   Resize during chat, try 150–200% text, and use both side-panel boundaries.
2. Have a friend find Settings, send a file and join voice without instructions.
   Check labels with keyboard and screen reader, not just screenshots.
3. In real voice, open participant volume, hide/show names, mute, deafen and
   leave. Check device changes and push-to-talk on the actual desktop.

The previous two-person voice success does not complete M12's four-person,
separate-network check. HC-8/HC-9 and other open release checks remain open.
