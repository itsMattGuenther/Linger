# Console UI review — 2026-09-17

T-909, M12 polish. No milestone or release check is closed by this review.

## Changes

- One comfortable presentation. Removed Density, Compact and IRC, including
  their rendering branches and style overrides. Old preferences are ignored.
- Readable 16px body text, stronger label contrast, 100–200% interface scale
  before sign-in and in Appearance. Dark, light and system themes remain.
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
  by click, right-click or keyboard. No avatars. Audio/protocol behavior is
  unchanged. Short windows initially collapse participants, not call controls,
  unless the reader explicitly chose otherwise.

The responsive roster change and removal of density modes were approved during
review. SPEC and the current guides describe the new behavior. Historical
screenshots and earlier test records are not rewritten.

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
- Chromium browser suite: 65 tests. Coverage includes pointer/keyboard panel
  resizing, persistence, modal focus/Escape, all six scale choices at 1100×720
  and 760×480 in both themes, enabled label contrast, old density preferences,
  10,000-message history remaining virtualized, attachment fitting through 200%
  scale, downloads, composer input, knock feedback, voice controls and sounds.
- 4K coverage uses 3840×2160 at desktop 100%, plus 1920×1080 at device pixel
  ratio 2 (3840×2160 physical pixels). Both exercise app scale at 100%, 150%
  and 200%. This is browser high-DPI emulation, not a physical-monitor test.
- Normal enabled labels are checked against 4.5:1 contrast in dark, light and
  both evening-warm variants. This is not a claim of full WCAG conformance.
- No new runtime dependencies or changes to server authorization, voice state,
  notifications on the wire, or message fetching. The generated search binding
  changes only because its comment no longer refers to density modes.

CI must also pass Chromium and WebKit. Native acceptance remains separate:

1. Use the packaged Windows and Omarchy clients at ordinary and high-DPI sizes.
   Resize during chat, try 150–200% text, and use both side-panel boundaries.
2. Have a friend find Settings, send a file and join voice without instructions.
   Check labels with keyboard and screen reader, not just screenshots.
3. In real voice, open participant volume, hide/show names, mute, deafen and
   leave. Check device changes and push-to-talk on the actual desktop.

The previous two-person voice success does not complete M12's four-person,
separate-network check. HC-8/HC-9 and other open release checks remain open.
