# Console controls

Visual direction approved by Matt on 2026-09-17 for the v0.2.0 testing release.
This covers chat, Appearance, welcome and the quiet-delight pass, not a claim
that every screen has completed visual or native-device acceptance.

## Live reference

From `client`, run `pnpm dev`, then open
`http://localhost:1420/tests/fixtures/styleguide.html`.
The guide imports the same `Button`, `IconButton`, `PreferenceSwitch`, tokens and control CSS
as the app. Changing those sources changes the examples too. It is a developer
fixture, not a destination shipped in the app.

Capture the controls without replacing previous review images:

```bash
cd client
LINGER_CHROMIUM_PATH=/usr/bin/chromium node scripts/console-screenshots.mjs ../screenshots/review-04
```

## Roles

| Element | Treatment | Use |
|---|---|---|
| Primary action | Filled accent, contrasting label, optional supporting icon | Continue, Join Voice, send |
| Secondary action | Visible border and neutral fill at rest | Message, knock, attach |
| Familiar toolbar action | Icon-only, named on hover and keyboard focus, 36px minimum target | Add, Settings, mute, deafen, play, collapse |
| Navigation | Full-row target, distinct selected surface and active rule | Servers, rooms, destinations |
| Preference | Label + explanation + switch with On/Off text | Immediate settings |
| Mutually exclusive choice | Bordered preview and checked selected state | Color theme |
| Metadata | Smaller monospace, never mistaken for an action | Timestamps, connection data |

## Symbols first

Symbols are the shared language. Prefer a familiar icon with a hover/focus name
over an icon sitting next to the same word. Visible text is for actions that
have no well-known mark — Join Voice, Send, Continue — or that would be
ambiguous as a glyph. Do not invent a new mark when a universal one exists:
play to preview sound, plus to add (in the composer: Add file…), a smile for
emoji, a gear for settings.

Icon-only controls are 36px minimum, named for screen readers, and show that
name on hover and keyboard focus. Every "more options" control — the server row,
Who's Around cards and message actions — draws the one shared three-dot icon
(`ActionIcon name="more"`), never a `…` or `⋯` character, centered on the line of
text beside it. Keep control states visible at rest; hover
reinforces them. Keyboard focus has a separate, restrained 1px neutral ring,
never just a color shift and never the server accent. Pointer-opened contextual
panels focus the panel itself rather than their close button, so nothing inside
draws that ring or exposes an icon tooltip until the first keyboard navigation;
pointer-opened menus keep focus on their first item, drawn quietly. Whether a
panel was opened by pointer or keyboard comes from the last input, not from the
browser's `:focus-visible` guess about the opener. Keyboard-opened panels show
the ring immediately. Disabled controls remain recognizable but do not
compete with available actions.

Settings headings and navigation labels use title case. Use sentence case for
other visible labels. **Join Voice** is the requested title-case exception.

Search, Media and Settings share `DestinationHeader`: the same sans heading
and bordered Close control, with descriptions and category tabs as needed.
Sound settings reserve the preview column even on rows without a Play button.

Message actions use a compact ellipsis button in a reserved column beside the
text, never a hidden row above it. This dense-list target is 24px square at
default scale; other icon controls retain their 36px minimum. Hover and keyboard
focus reveal the button without covering text or changing row height. Activating
it opens a dismissible menu with full-size action targets and wrapping reaction
choices. Escape and outside click dismiss it and return focus to the button.
Message bodies offer the four bundled sans faces; saved non-sans keys fall back
to the default body face without restricting name styling.
Rooms and DMs use 1.3 message line height, 2px between prose blocks and 8px
before a sender group at default scale. Sender headings separate speakers;
typed line breaks remain intact. One-line continuations occupy 24px including
the action target, with no extra vertical padding. Text is indented beneath the
sender name; per-message colored bars are removed. Session dividers keep their
larger spacing.

Navigation text wraps to the rail's width; it is never truncated with an
ellipsis or a line clamp, no matter how long or unbreakable a server, room or
DM name is. The rail itself never scrolls sideways — rows grow taller
instead. Panel widths stay at the px values SPEC §5.5 sets; content inside a
panel sizes to fit it, not the other way around.

Voice participants are plain names, not pill-shaped selectors. A chevron beside
the voice heading collapses the names; Join Voice and call controls align right.
Click, right-click or keyboard activation opens a person's contextual panel.
Member panels keep Message and Knock side by side, outside the roster's flow.
Panels stay inside the viewport, support Escape and outside dismissal, trap
keyboard focus and return it to the source control on close.

Media and Search anchor above the personal footer. The Settings gear belongs
beside your own name; server management belongs in the selected server's **⋯**
menu. Member cards do not mix conversation and administrative actions.

The welcome screen reuses `assets/logo/Linger Pixel Porch Icon Set FINAL.png`,
centered at 160px in an ordinary window and smaller in a short one. Small static
versions accompany genuinely empty collections and a server without rooms.
Vite's development allowlist includes that exact file,
not the whole repository. No duplicate visible wordmark or tagline surrounds it.

Character comes from the chosen artwork, styled names, purposeful accent and
responsive control feedback. It does not come from counters, intrusive motion,
avatars, rounded panels, shadows or gradients on surfaces.

## Quiet delight

- **Reactions:** clear pressed state and a check on your own marks. One silent,
  160ms emphasis follows an accepted local addition, not loaded history or a
  remote event. A pending request cannot be double-submitted. Refusal restores
  the previous state and reports the error beside the message.
- **Controls:** brief press and panel-entry feedback, with no spring, loop or
  idle animation. Reduced motion removes it; state remains visible. Switching
  Settings categories resets that category's scroll position to its heading.
- **People:** name styling previews a sample message. Status has an expandable
  local preview, including the away-message override. Drafts do not publish
  until Save. Name choices can be reset without a server request.
- **Memories:** full-image thumbnails, readable filenames, person/room/date
  context and fitted full-image viewing. Star has a visible label and pending
  state; the confirmation only appears after the server accepts it.
- **Sounds:** a shared soft tonal palette with opposite contours for opposite
  actions. Peers are quieter than your own voice actions; knocks keep two wood
  taps. Cues are synthesized locally with zero new dependencies or sound
  downloads. Mute, categories, quiet hours and burst protection still gate
  live chimes. Settings play is a click and always sounds. Reactions, typing,
  saving and browsing remain silent. This is not personal entrance sounds,
  which remain deferred.

Open `screenshots/review-04/sounds/index.html` for listening samples. They are
offline renders of the production score, not proof of physical speaker volume,
audio-device behavior or subjective quality. The standalone player does not
read the app's preferences; playback always requires a click.

## Preview honesty

Screenshots use production React components and synthetic data in Chromium.
The welcome fixture represents a desktop with available secure storage.
The real browser fallback and native-storage failures remain visible and tested;
they are not hidden with screenshot CSS. No real sign-ins or voice calls are used.

## Basis and verification

Local checks for this iteration, 2026-09-17: frontend typecheck and production
build pass; 439 unit tests and 97 Chromium browser tests pass. Browser coverage
includes loaded welcome artwork, toolbar labels and targets, panel placement,
keyboard focus and dismissal, nested People/profile panels at 200% scale,
late DM replies, contrast in both themes, and the existing 4K scaling matrix.
The delight checks cover accepted/refused/pending reactions and stars, private
style/status previews, media at 200%, category scrolling, and all twelve
offline-rendered cues: distinct, below full scale, short and ending in silence.
Rules lint, version consistency and whitespace checks pass. The full
`scripts/check.sh origin/main` gate was rerun for release preparation and
passes, including workspace and desktop-shell Rust checks and binding drift.
Packaged Windows/Omarchy rendering,
real voice calls and the unaided-friend usability check still need their own evidence.

- [Fluent button guidance](https://fluent2.microsoft.design/components/web/react/core/button/usage):
  distinguish primary and secondary actions, use switches for settings and keep
  state understandable without color alone.
- [NN/g on flat design](https://www.nngroup.com/articles/flat-design/):
  removing signs of clickability makes interfaces harder to operate.
- [Discord's desktop refresh](https://discord.com/blog/player-release-q12025):
  adjustable navigation and grouped voice controls keep core actions within reach.
- [Discord profile popouts](https://support.discord.com/hc/en-us/articles/8063233404823-Connections-Linked-Roles-Community-Members):
  clicking a name opens a separate profile surface. Linger borrows that interaction,
  not avatars, roles, connections or the rest of Discord's feature set.
- [GNOME button guidance](https://developer.gnome.org/hig/patterns/controls/buttons.html):
  recognizable symbols, consistent targets and supporting tooltips; right-click
  is an alternative, never the only route to an action.

Visual approval is not a claim that citing guidance proves usability. Native
rendering, listening and a friend's unaided use still need their own evidence.
