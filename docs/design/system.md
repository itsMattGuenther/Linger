# The design system for the Buddy list client

This is the design system of the new client being built toward the Buddy list
design (#198). The design itself is in [`buddy-list.md`](buddy-list.md). This
page covers the parts it is built from, the values they use, and the rules that
keep them consistent.

It applies to code under `client/src/next/`. The current client still follows
SPEC §5 ("Console") until the switch.

## Where it lives

| What | Where |
|---|---|
| Tokens (every color, size, radius, shadow and duration) | `client/src/next/styles/tokens.css` |
| Reset, focus ring, reduced motion | `client/src/next/styles/base.css` |
| What an entry point loads | `client/src/next/styles/app.css` (fonts, palette, tokens, base) |
| The components | `client/src/next/kit/` (one `.tsx` and one `.css` each; `index.ts` exports them) |
| The gallery | `client/tests/fixtures/kit.html` + `kit.tsx` |
| Geometry tests | `client/tests/browser/kit.spec.ts` |
| The chat window's views | `client/src/next/app/chat/`, its rules in `client/src/next/core/chat/`, its page `client/tests/fixtures/next-chat.html` and its spec `client/tests/browser/next-chat.spec.ts` |
| Source-discipline tests | `client/src/next/kit/discipline.test.ts` |
| Contrast tests | `client/src/next/styles/contrast.test.ts` |

To see every component in every state, run this from `client/`:

```sh
pnpm exec vite --port 1431
```

Then open <http://localhost:1431/tests/fixtures/kit.html>.

## Principles

1. **Screens are built from the kit, not from CSS.** A screen composes `Row`,
   `Button`, `Marker` and the rest. It does not style its own button, row or
   dot. Most of the old client's polish bugs came from each screen sizing its
   own controls: #88, #146, #144, #164, #172, #181.
2. **Tokens, never values.** Only `tokens.css` may contain a color or a pixel
   value. Everything else refers to a token by its role (`--text-muted`, not
   `#8d96a9`).
3. **Sizes are intrinsic.** A kit component decides its own size from a typed
   prop (`size="sm"`), never from a caller's `className` or `style`. There is no
   way to make a 31px button.
4. **Lists have fixed geometry.** Every row has the same lead column, a fixed
   height, and fixed line boxes. Names line up and gaps are even whatever face,
   marker or text a row holds.
5. **Text never hard-clips.** Anything that can run long ends in "…".
6. **One way to draw each state.** Presence has exactly one marker per state,
   and new activity is shown by weight, never by a count or a dot.
7. **Accessible by default.** Every control has a name and a visible focus
   ring. Text meets 4.5:1 contrast, and icons meet 3:1.
8. **Check it where it runs.** The desktop app draws with WebKitGTK on Linux,
   not Chromium. A piece is not done until it has been seen there (see the end
   of this page).

## Tokens

Tokens come in three layers. **Primitives** are named colors with no meaning;
only `tokens.css` uses them. **Semantic roles** say what a color is *for*;
components use only these. **Scales** set spacing, sizes, type and motion.

A light theme is an open decision (#198). When it comes, it will be one
`[data-theme="light"]` block that redefines the semantic roles and nothing
else.

### Colors

Values are from the approved prototype, except where the contrast test
required a change (marked ▲).

| Role | Value | Used for |
|---|---|---|
| `--surface-backdrop` | `#0a101d` | behind windows (gallery only; the real app has your desktop there) |
| `--surface-sunken` | `#0f1522` | text fields, sidebars, footers |
| `--surface-window` | `#131a28` | a window |
| `--surface-popover` | `#182135` | popovers, menus, notices, tooltips |
| `--surface-raised` | `#1b2436` | cards |
| `--surface-hover` | `#1f2a40` | a hovered or selected row |
| `--surface-titlebar` → `-end` | `#1b2438` → `#161e2f` | the title bar's gradient |
| `--surface-control` / `-hover` / `-edge` | `#2a3550` / `#364465` / `#364465` | filled icon buttons, a switch's track |
| `--text-primary` | `#f1ebe0` | names of things, messages |
| `--text-secondary` | `#c0c6d2` | row text, button labels |
| `--text-muted` | `#8d96a9` | second lines, notes, labels, placeholders, and the dimmest text allowed |
| `--text-away` | `#e9dcc4` | away messages |
| `--text-accent` / `--accent` | `#f3b55c` | the lamp: primary action, selected choice, your voice |
| `--text-on-accent` | `#1c1206` | text on the lamp |
| `--text-danger` / `--danger` | `#f06e6e` | destructive actions, errors |
| `--text-success` / `--success` | `#7cc98f` | confirmations |
| `--icon-default` | `#c0c6d2` | icons on filled controls |
| `--icon-muted` | `#8d96a9` | icons at rest |
| `--icon-faint` ▲ | `#69738a` (was `#667087`) | carets, a room's `#`, idle voice glyphs; **never text** |
| `--hairline` / `--hairline-strong` / `--edge-hover` | `#222d44` / `#2e3b54` / `#43527a` | separators and control edges |
| `--focus` | the lamp, 2px, offset 2px | every focus ring |
| `--window-focus-edge` | cyan at 38% | the focused window's edge |

**The change.** The prototype drew its faintest metadata (notes like "in
#general") in `#667087`, which is 3.5:1 on a window and 2.9:1 on a hovered row.
That fails the 4.5:1 floor for text. Raising it far enough to pass lands almost
exactly on `--text-muted`, so the fourth text tier was dropped. Faint *text* is
now `--text-muted`, and the faint grey (nudged to `#69738a` for 3:1) is kept
only for marks that are not text.

Names are never colored by a token. A person's color is a palette key on the
wire (AGENTS rules 8 and 12). It becomes a color only in the generated
`palette.generated.css`, and all 16 keys pass 4.5:1 on every surface.

### Scales

| Scale | Values |
|---|---|
| Spacing | `--space-0-5` 2 · `-1` 4 · `-1-5` 6 · `-2` 8 · `-2-5` 10 · `-3` 12 · `-3-5` 14 · `-4` 16 · `-5` 20 · `-6` 24 · `-7` 28 · `-8` 32 |
| Control heights | `--control-sm` **24** · `--control-md` **32** · `--control-lg` **40** |
| Icon boxes | `--icon-sm` 12 · `--icon-md` 16 · `--icon-lg` 20 |
| Markers | `--marker-slot` 14 (the lead column) · `--marker-gap` 8 · `--marker-md` 8 · `--marker-sm` 6 |
| Rows | `--row-1` 32 · `--row-2` 48 · `--line-name` 20 · `--line-meta` 16 · `--line-display` 28 |
| Chrome | `--titlebar` 40 · `--tab` 32 · `--tab-min` 136 · `--tab-max` 232 · switch 36×20 with a 14 thumb · `--swatch` 24 · `--menu-w` 200 · `--rule-strong` 2 (a quote's rule, a tab's server stripe) |
| Conversation | `--line-body` 20 (a message line) · `--pane-head` 40 · `--voice-strip` 40 · `--measure` 80ch · `--name-inline-max` 14em · `--media-max-w` 320 · `--media-max-h` 400 · `--linkcard-w` 360 · `--composer-max` 200 · `--emoji-grid` 8 columns |
| Settings | `--settings-nav` 196 (the sidebar) · `--settings-label` 104 (the label column beside rows of choices) · `--status-image-w` 400 · `--status-image-h` 200 (a status picture) |
| Search and media | `--media-tile` 152 (the narrowest a media tile gets; the grid fits as many as it can) |
| Radii | `--radius-xs` 4 · `-sm` 6 · `-md` 8 · `-lg` 10 · `-xl` 12 · `-pill` 999 |
| Shadows | `--shadow-window`, `--shadow-window-focused`, `--shadow-popover`, `--shadow-notice`; never on a row or a control |
| Type | `--text-label` 11 (Departure Mono, uppercase) · `-meta` 12.5 · `-control` 13.5 · `-body` 14.5 · `-name` 15.5 · `-title` 20 · `-display` 22 |
| Faces | `--font-ui` Geist Sans · `--font-mono` Geist Mono · `--font-label` Departure Mono · `--font-pixel` Silkscreen · `--font-<key>` for each of the twelve name faces (a contract with `lib/fonts.ts`) |
| Motion | `--duration-fast` 120ms · `-base` 160ms · `-slow` 260ms · `--ease-out`; all 1ms under reduced motion · `--nudge` 2px, how far a knocked row shakes · a repeating animation repeats `--loop` times (forever; once under reduced motion) and its length is times `--motion` (1; 0 under reduced motion) |
| Layers | `--z-raised` 10 · `-sticky` 20 · `-popover` 100 · `-notice` 200 · `-tooltip` 300 |

All sizes are in pixels.

### Why only three control heights

Every clickable control is 24, 32 or 40px tall:

- **24** is the smallest target people can hit reliably, and the size inside
  dense places: a tab's close button, a section's "new message" button, a
  chip, a switch's hit box, a swatch.
- **32** is the default: most buttons, text fields, tabs, one-line rows, and
  row actions.
- **40** is for a lone important action, like a large send button.

With three heights, any two controls side by side either match or differ by a
clear step. That is what fixes the "Send is 2px taller than the box" class of
bug (#88) for good: there is no fourth height to drift to. The geometry test
fails on any other height.

## Components

Each component takes typed props for its states, sizes itself, and exposes a
`data-kit="…"` attribute the tests find it by.

### Icon

One glyph (46 of them, typed as `IconName`) in a fixed square box of 12, 16 or
20px, centered, in `currentColor`. Icons are decoration (`aria-hidden`); the
control around them carries the name. **Don't** size an icon by hand; pick a
box.

### Button

A pill with a visible label.

- **Sizes:** `sm`, `md` or `lg` (24, 32 or 40px), with a 12, 16 or 20px icon to
  match.
- **Variants:**
  - `primary`: the lamp; one per surface.
  - `secondary`: an outline, the default.
  - `quiet`: no edge until hovered.
  - `danger`: red text, a red wash on hover.
- **States:**
  - `pressed`: a toggle, with `aria-pressed`.
  - `busy`: keeps its width, shows a spinner and refuses clicks.
  - `disabled`.
  - `fill`: the column's width, or what's left of a row.
- **The label** ends in "…" if it can't fit.

**Don't** put two primary buttons side by side.

### IconButton

A square with one icon, exactly centered by the grid.

- **Sizes:** 24, 32 or 40.
- **Tones:**
  - `plain`: shows on hover.
  - `filled`: row actions.
  - `accent`: send.
  - `danger`: window close.
- **`label` is required.** It is the accessible name and the tooltip. The
  tooltip is drawn in a portal, so a window's edge can't clip it, and it can
  show a keyboard shortcut.
- **`skipTab`** takes the button out of the tab order, for something the
  keyboard reaches another way, like a tab's close (Delete).
- **`expanded`** is for a button that opens something. While it is open the
  tooltip stays hidden, since it would sit over what the button opened.

### Marker, MarkerSlot, GroupMarker, HashMark, MarkerCluster

Presence, in the person's palette color:

| State | Drawn as |
|---|---|
| here (in a room) | a plain solid dot |
| around | the same plain dot; the words beside it ("in #general", "around") tell them apart |
| idle | the dot, dimmed a little |
| away | a crescent moon |
| offline | a dot, dimmed |

`typing` makes a marker breathe. There are no rings or halos at any size: a
ring that shows at one size and not another makes one person's presence look
two ways.

- **One mapping.** `markerStateOf(PresenceState)` is the only translation from
  the wire's five presence states, and `Marker` is the only way presence is
  drawn anywhere.
- **Sizes:** 8px (`md`) or 6px (`sm`). Both are even numbers, so they center
  on whole pixels inside the 14px slot.
- **`MarkerSlot`** is the lead column every row shares.
- **`GroupMarker`** arranges a group DM's people inside that one slot: two on a
  diagonal, three in a triangle, four in a square.
- **`HashMark`** is a room's `#`, the same color for every room (Matt,
  2026-09-25).
- **`MarkerCluster`** is a short run of small markers for who's in a room.

**Don't** draw a presence dot with anything else.

### Name

A person's name in their own style: face, weight, slant, color or a two-color
gradient at 92°, and shimmer or glow.

- **Styling:** it goes through `lib/names.ts`, the same engine as the current
  client. "Plain names" (`data-normalize` on `<html>`) and reduced motion work
  exactly as they do there.
- **New here:** the name sits in a **fixed line box** for its size (20px in
  lists, 28px for display, 16px for meta), so no face can change a row's
  height.
- **Long names** end in "…".
- **`raw`** draws the person's own style even with plain names on, for the
  style picker's preview.
- **`size="inline"`** is the one size without a box: the name flows inside a
  sentence ("Replying to Jules:", "Eli and Sam are typing", a message's
  author) at the sentence's own size and line height, so it never makes its
  line taller. A caller that needs it cut short sets the width it may have.

### Row and RowList

The list row for rooms, DMs, people and pickers:

```
margin 6 | padding 10 | lead slot 14 | gap 8 | text column … | actions
```

- **Heights:** `lines="one"` is 32px; `lines="two"` is 48px (a 20px name line
  and a 16px second line).
- **Parts:**
  - `title` on the first line;
  - `trailing` marks right after it (a voice glyph beside a name);
  - `note`, a faint end-of-line note ("in #general");
  - `end` marks at the end ("who's in a room");
  - `detail`, the second line, set `away` for the warm away color.
- **States:**
  - `fresh` draws the title bold. Weight only, never a count.
  - `selected` means its card or window is open.
  - `knocked` means you just knocked on this person's door: the row gives one
    small shake (two slow durations long, so none under reduced motion).
- **Actions:** up to three md `IconButton`s, shown on hover and keyboard focus.
  While they show, the text column gives up exactly their width, so they never
  cover text, and the note steps aside.
- **The row is a button:** Enter or a click activates, and a double-click opens
  (a DM).
- **`RowList`** is the `<ul>` with an accessible name.

### SectionLabel

A small uppercase label over part of a list.

- **Alignment:** it mirrors the row's geometry, so its caret sits in the lead
  column over the markers and its text starts where names start.
- **Levels:** `section` ("Rooms") or `group` ("Away"). Same look, less space
  above a group.
- **Folding:** with `open` and `onToggle` it is a 24px toggle
  (`aria-expanded`). It says "show" while folded and "hide" on hover while
  open.
- **`action`** holds one small `IconButton` at the end, like "New message".

### TabStrip

A browser-like row of 32px tabs on the title bar's bottom edge.

- **Tabs:**
  - A tab is 136–232px wide, and its title ends in "…".
  - `fresh` makes a tab bold when something arrives while it isn't showing.
  - `voice` adds the voice glyph: `mine` in the lamp, `others` dim.
  - A close button shows on hover, focus and the active tab.
- **`lead`:** a room's tab leads with its `#`, in the same faint ink as
  everywhere and set against the name; a one-to-one DM's tab leads with the
  person's small marker. A group DM has no lead.
- **`stripe`:** with several servers, a server's palette key (never a color
  value) draws a 2px stripe along the tab's top, dim until the tab shows.
- **Keyboard:** only the showing tab is in the tab order. Arrow keys move and
  show, Home and End jump, and Delete closes.
- **`onMove`:** a tab can be dragged along the row. It follows the pointer and
  the tabs it passes slide aside (transforms only, so nothing reflows); a
  press that travels under 4px is still a click. The chat window adds the
  keyboard way, Ctrl+Shift+PageUp and PageDown (`core/keys.ts`).
- **Overflow:** more tabs than fit scroll sideways, the showing tab stays in
  view, and the edge with more beyond it fades.

### TitleBar

The top of every Linger window, drawn by Linger (decided 2026-09-25), 40px.

- **Parts:** `leading` (a mark), the title or a `TabStrip`, `actions`, and an
  optional close button.
- **Drag region:** the bar is `data-tauri-drag-region`; its buttons stay
  clickable.
- **Focus:** `focused={false}` dims it.
- **Long titles:** plain-text titles end in "…".

### Menu

A short list of actions that floats by the button that opened it: a
message's Reply, Edit and Delete.

- **Placement:** drawn in a portal, below the trigger with its right edge on
  the trigger's, or above when there is no room below; always inside the
  window. It is measured before it is shown, so it never flashes in the wrong
  place.
- **Items** are 32px, with an optional icon, and `tone="danger"` for a
  destructive one. A step that needs confirming (delete) swaps the items for
  the confirm pair rather than opening a second menu.
- **Keyboard:** it opens with its first item focused. Arrows, Home and End
  move and wrap, Enter chooses, Escape and Tab close. A click anywhere else
  closes it. The caller puts focus back on the trigger, since only it knows
  what the trigger was.
- **Width** is `--menu-w`; a long label ends in "…".
- **`checked`** makes an item an on/off choice (`menuitemcheckbox`), like a
  server's Quiet: a tick in the lamp at its end when it's on.

### TextField

A label (visually hideable, never missing), a box of 24, 32 or 40px, and help
or an error in words underneath.

- **Options:** a leading icon; `italic` for statuses; `mono` for codes;
  `readOnly` (dashed); `error`, which marks the field invalid and says why.
- **`type="date"`** is the system's own day picker, with `min` and `max`. It
  gives back `YYYY-MM-DD`, or nothing. Empty, its format (mm/dd/yyyy) is drawn
  in the placeholder's color, so it doesn't read as a date that's been set.
- **Focus:** the whole box is the target and draws the focus: the lamp edge
  plus a soft ring.
- **`onEnter`** submits on Enter.

### Select

One choice from a longer list, like an interface size or a microphone: the
system's own drop-down in a box of 24, 32 or 40px, labelled like a
`TextField`, with optional help underneath that is linked to it for screen
readers.

- **The box draws the focus**, as a field's does; the select inside never
  draws a second ring.
- **A caret** sits over the box's end and lets clicks through.
- **Short lists** of two or three belong in pressed `Button`s or `ChoiceCards`
  instead, where every choice is in view.

### Switch and SettingRow

- **`Switch`** is a `role="switch"` with a required name: a 36×20 track in a
  36×24 hit box, the lamp when on.
- **`SettingRow`** is one setting: its name, one line saying what it does, and
  its control at the end. It is the building block for Settings.
- **`Checkbox`** is one of several choices that are each on or off together,
  like the servers an away message shows on: a real checkbox in a 32px row,
  a 16px box in the lamp when ticked, and its words beside it as its name.
  The row draws the focus ring, as a field's box does.

### ChoiceCards

A few big one-of choices as radio cards, like "As tabs in one window" or "Each
in its own window".

- It is a real `fieldset`, so arrows move between choices and screen readers
  hear a group.
- The selected card takes the lamp's wash and edge, and keyboard focus rings
  the whole card.
- **`compact`** puts the art over the words, for short choices that should sit
  three or four across, like the color theme. A card's contents always start
  at its top, so titles line up across a row whatever the descriptions' length.

### NavList

A column of places to go, like Settings' sections: an icon and a word per
place, in groups, the showing one lit by the lamp with a bar along its edge.

- It is a vertical tab list: the arrows move between items and show them,
  Home and End jump to the ends, and only the showing item is in the tab
  order. Group headings are passed over.
- Items are 32px tall. A group can carry a second line, like the name of the
  server you host; that group starts a new part of the list, with a rule
  above it.
- A long label or second line ends in "…".

### High contrast

Windows' high-contrast mode (forced colors) repaints backgrounds and borders
in the system's colors, so a state shown only by a color would vanish. Each
part that has one keeps it with a system color, in its own stylesheet:
presence dots are drawn in the text color; the selected row, the showing tab
and the showing Settings section are outlined in `Highlight`; a switch that's
on, a ticked box and whoever's talking are filled with it. `kit.spec.ts`
checks each with high contrast emulated.

### Chip

A 24px pill for a picked person or thing. With `onRemove` the whole chip is
the remove button ("Remove Eli"), so there is no tiny target inside a tiny
chip. The text ends in "…".

- `active` lights it in the lamp: that person is talking.
- `state` draws a control's own glyph after the name, like muted or
  deafened, with the word for screen readers. It comes after the name, so it
  never moves it.
- `note` is a faint word or two at the end: "connecting…", "can't reach".

### Card and Popover

- **`Card`** is a raised block with a hairline edge. `tint` washes it faintly
  in a person's palette color.
- **`Popover`** floats: a person's card, a menu, a picker.
  - It is a named `dialog`, with a close button and Escape.
  - It can point left or right at what opened it.
  - `at` places it; its size is its own.

### Notice, VoiceGlyph, Swatch, Spinner

- **`Notice`** is a card that comes and goes on its own: "Callie came into
  #general". It is `role="status"`, and the text ends in "…".
- **`VoiceGlyph`** is a speaker, or three bars while somebody talks. It is
  always a 12px box, and the bars scale rather than change height, so nothing
  beside them moves.
- **`Swatch`** is one of the 16 palette colors as a 24px choice. The ring
  around a chosen one is drawn in its own color.
- **`Spinner`** is the busy mark inside a `Button`, and the mark on a
  connection line at the list's foot.

### The list's foot

Under the list, above the voice bar, the list says what today's status bar
said, but only while it's true (decision 1, `core/notes.ts`,
`app/list/ListNotes.tsx`). Each is one 12.5px line in `--text-secondary`, a
16px mark in `--text-muted`, and words that wrap rather than cut off:

- a server still not connected five seconds on: "Can't reach Pinecone. Still
  trying.", with the reason on hover, and a `Spinner` for its mark;
- a keyring that can't keep sign-ins, with the key icon;
- a new version, with the download icon and a small quiet "Update…" that opens
  Settings → Account & App.

With nothing to say, nothing is drawn: no bar, no hairline. Protocol words
("tls ok…", "ready (28ms)") are never shown. The storage figure lives in the
Media window, beside how long the server keeps files.

## The conversation

The chat window's conversation is a screen, not a kit component, but its
geometry is part of the system and its spec (`next-chat.spec.ts`) measures it.

**Inline names (decision 9).** A message is one grid row:

```
padding 8 | name: | gap 8 | words (to --measure) | gap 8 | time | gap 8 | actions 24 | padding 4
```

- **The name sits on the words' line**, in the person's style at body size,
  followed by a muted colon. The name cell, the words and the time share the
  20px line box, so they sit on one line in any face.
- **Wrapped lines hang under the words**, not under the name.
- **A continuation** (same author, within 10 minutes, same session) draws the
  same name and colon *invisibly*. Its words therefore start exactly where the
  head's do, in any face, with nothing measured. Its time shows on hover and
  focus only.
- **Heights:** a one-line continuation is 24px (its 20px line plus 2px above
  and below, which is also the 24px action target). A group's first row has
  8px more above it. Nothing else adds space between messages.

**Grouping** follows SPEC §4.7 (same author, a gap under 10 minutes, the same
session; sessions break after 3 hours with a divider in words: "tonight",
"yesterday evening"), with one change for inline names: **a reply always opens
a group.** Its quote sits above its own line, and a quote over a line with no
name would read as a quote of the message above. So a reply names its author
and gets a group's space above it, which also keeps it off the message before
(#181).

**Quotes.** A reply's quote is part of the reply: a 24px line above it, from
the row's left edge, with a 2px rule, the quoted person's name and an excerpt.
It is a button that jumps to the quoted message and marks it for a moment.
When the quoted message isn't loaded it says "an earlier message".

**What else a message holds.** Pictures are sized from their stored width and
height before they load (at most 320 by 400), so a row is measured once. A
message that is nothing but one link shows only its link card. Files that
aren't pictures, video or sound are a card with a Download button. Mono type
appears only in metadata (times, a link card's domain), never in words.

**Lines between messages.** Session dividers and "you left off here" use the
label face. The left-off line is in the lamp and is the whole of what
replaces an unread count.

**Around the conversation:**

- **Pane header**, 40px: a room's `#name`, who's in it (markers) and its
  topic; a DM's people, a 1:1's status, and Knock.
- **Voice strip**, 40px in every state, so voice changing never moves the
  conversation: who's in voice as chips (lit while talking) and one way in
  (Join, Move voice here, Start talking, Talk here instead), or "You're in
  voice here" with no buttons. Mute, deafen and leave are only in the list's
  voice bar.
- **Typing line**, 24px, always there, so the box never jumps.
- **The box**, 40px for one line: a `›` prompt by the first line, the text,
  then add-a-file, emoji and send (32px each). It grows with its text to
  `--composer-max`, measuring a hidden copy so typing never lays out the
  conversation (L-12).

**It never moves a reader.** A short conversation hangs from the bottom,
above the box. At the end, new messages follow, and anything that grows
(an edit box, the reply line, a card arriving) keeps the end in view. Read
further up, and arrivals and older history loading above leave what you're
reading exactly where it is.

## Settings

Settings is its own window (`app/settings/`): the `NavList` sidebar on the
left, and the showing section on the right, with its title and one sentence
saying what it's for.

- **A section is made of blocks.** Each has a heading (the label face, in the
  lamp's color, like a `ChoiceCards` legend), an optional sentence, and its
  controls, with a hairline between blocks.
- **Words come from one place.** Headings and navigation labels are in title
  case and sentences in sentence case (SPEC §5.6, #90); they live in
  `core/settings.ts`, whose test checks the casing and SPEC §1's vocabulary.
- **A save says how it went on its own line.** The end of a form carries
  "Saved", "Saving…" or the server's words, to the left of its buttons, so a
  save never moves what's below it. Every save is a callback resolving to the
  problem in words, or null.
- **Rows of small choices** (a font, a weight, an invite's lifetime) are
  pressed `Button`s beside a label in a column of its own, so every row's
  choices start on one edge. In a narrow window the label moves above them.
- **Escape backs out** of an inline edit or a question ("Archive #general for
  everyone?") and puts focus back on the button that opened it. A question
  opens on its safe answer.
- **The window** is 720 by 640, and works down to 560 wide; fields sit side by
  side while they fit.

## The list with several servers

Each server is a section of the list (`ServerSection`, `core/servers.ts`),
built on the rows' own grid so nothing new lines up by eye:

- **The header** is a 32px row. Its fold caret sits in the row's left
  padding; the server's color is a short bar in the lead column, where a
  person's marker sits; its name starts on the same edge as every other name
  in the list, bold only when something inside is new and never while the
  server is Quiet. The dots of who's on end the row. The menu button (Quiet,
  Move up, Move down) shows over the end of the dots on hover or focus, on a
  patch of whatever is behind it.
- **The line under it** is 16px on the same grid: an icon in the lead column
  when voice is on, then one plain sentence that ends in "…". Folded, it says
  what's happening there; open, who you are there and your status there,
  which you can change from it. It never holds a digit: a nearly full voice
  room says "room for one more".
- **Pinned:** the header and its line stay at the top while you scroll
  through a long server, and what slides under them fades over 10px rather
  than being cut mid-letter.
- **The top card** keeps only what's true everywhere: you, whether you're
  away (and where), and Away, whose editor ticks a `Checkbox` per server.
- **One server** draws the list exactly as before, with no section header.

## What the tests enforce

| Rule | Test |
|---|---|
| Every control is exactly 24, 32 or 40px tall | `kit.spec.ts` › every control is 24, 32 or 40px tall |
| Icons are centered in icon buttons (within ½px), icons are vertically centered in buttons, and markers are centered in their slot | `kit.spec.ts` › icons and markers sit exactly in the middle |
| One-line rows are 32px and two-line rows 48px, in all twelve faces; every name line is 20px | `kit.spec.ts` › rows of a kind are one height |
| In a list, text starts at one x whether the lead is a marker, a group, a `#` or empty, and section labels start there too | `kit.spec.ts` › names in a list start at one x |
| Overflowing text ends in a drawn ellipsis (not on a flex or grid box, where it never draws) and never runs under an edge | `kit.spec.ts` › text that does not fit ends in an ellipsis |
| Hit targets are at least 24×24 | `kit.spec.ts` › every hit target is at least 24px |
| Every interactive element has an accessible name | `kit.spec.ts` › every interactive element has an accessible name |
| Everything the keyboard reaches shows the focus ring | `kit.spec.ts` › the focus ring shows on everything the keyboard reaches |
| Tabs: arrows, Home, End, Delete; one tab in the tab order | `kit.spec.ts` › tabs move with the arrow keys |
| Tabs lead with a `#` or a marker; server stripes are 2px in the server's palette color | `kit.spec.ts` › tabs lead with a room's # or a person's marker |
| A dragged tab lands where it's dropped, the others slide aside, and a small wobble is a click | `kit.spec.ts` › a tab dragged along the row |
| Menus open on their first item, move and wrap with the arrows, confirm in place, and close on Escape, Tab or a click elsewhere; items are 32px | `kit.spec.ts` › a menu opens on its first item |
| An inline name never makes its line taller | `kit.spec.ts` › a name inside a sentence sits on the sentence's own lines |
| The conversation: names on one edge, wrapped lines and continuations on another; rows edge to edge; groups 8px apart; a one-line continuation 24px; title bar, header, voice strip and box 40px; nothing clipped without "…" | `next-chat.spec.ts` › built on the system |
| The conversation never moves a reader: arrivals and older history leave the view still; at the end it follows; the reply line and edit box keep the end in view | `next-chat.spec.ts` › reading and arriving, the row menu, the keyboard |
| 5,000 messages draw fewer than 80 rows | `next-chat.spec.ts` › 5,000 messages draw only what is near the view |
| A `NavList` moves with the arrows, Home and End, with one item in the tab order | `kit.spec.ts` › a list of places moves with the arrow keys |
| A `Select` is named by its label, keeps the choice, links its help, and a disabled one refuses | `kit.spec.ts` › a drop-down is named by its label |
| Compact `ChoiceCards` sit side by side with their titles on one line | `kit.spec.ts` › compact choice cards sit side by side |
| Settings: sections per scope (Hosting only for the host, Servers only with several), the sidebar's keyboard, every save saying how it went, Escape backing out to its button, and at 720 and 560 wide every control 24/32/40, nothing clipped or past the edge, labels and choices on one edge | `next-settings.spec.ts` |
| Settings copy: title-case headings and labels, SPEC §1's words | `core/settings.test.ts` |
| Several servers: headers and lines on the rows' grid (names on one edge, the mark where markers sit, 32px headers, 16px lines), pinned while scrolled through, no digit in any header or line, bold only when new and never while Quiet, the menu and folding by keyboard, nothing clipped at 340px | `next-servers.spec.ts` |
| What a server's header and line say, from its store | `core/servers.test.ts` |
| No color literal outside `tokens.css` | `discipline.test.ts` › writes no color outside styles/tokens.css |
| No pixel value but `0` and `1px` outside `tokens.css` | `discipline.test.ts` › writes no pixel value but 0 and 1px |
| No `!important` | `discipline.test.ts` › never uses !important |
| `src/next` imports only `src/lib` logic (`.ts`), `src/generated` and `src/fonts` from the old client, never its screens, styles or UI components | `discipline.test.ts` › imports nothing from the old client's UI |
| Kit components take no `className` or `style` prop | `discipline.test.ts` › takes no className or style prop |
| Text roles reach 4.5:1 and icons, accent and focus 3:1 on every surface; all 16 name colors reach 4.5:1; text on the accent and washes, and switch parts, pass | `contrast.test.ts` |

Every rule was proven by planting the bug it forbids and watching it fail. The
geometry spec also saves a review sheet of each gallery section to
`client/test-results/kit/`, for a person to look at; nothing asserts on
pixels.

To run them, from `client/`:

```sh
pnpm test                                                     # discipline + contrast (and everything else)
pnpm exec playwright test tests/browser/kit.spec.ts --project=chromium
```

CI also runs the spec in WebKit.

## Adding a component

1. **Write it** in `client/src/next/kit/<Name>.tsx` with `<Name>.css` beside
   it:
   - typed props for each state and size, and no `className` or `style`;
   - `data-kit="<Name>"` on its root, and `data-kit-control` on the element
     whose height is a control height;
   - an accessible role and name;
   - CSS that uses only semantic tokens and the scales.

   If no token fits, add one to `tokens.css` with a comment saying what it is
   for.
2. **Export it** from `kit/index.ts`.
3. **Add it to the gallery** (`tests/fixtures/kit.tsx`) in every state and
   size, including a case where its text is too long to fit.
4. **Add assertions** to `kit.spec.ts` for anything the general tests don't
   already cover.
5. **Run the checks:** `pnpm check`, `pnpm test` and the kit spec. Look at the
   review sheet at 2× zoom. Fix what you see before you commit.

## Check it in the real Linux app

Chromium is not what Linux users run. The desktop app draws with WebKitGTK
(2.52 with the Arch package; older inside the AppImage). Fonts, blur,
`color-mix()` and masks can all differ there. Before calling a screen done,
look at it in WebKitGTK:

- **The gallery in WebKitGTK's own browser:**
  `/usr/lib/webkit2gtk-4.1/MiniBrowser http://localhost:1431/tests/fixtures/kit.html`,
  on a machine where opening a window is fine.
- **Headless, without anyone's screen:** use the desktop-check setup in
  [`../desktop-checks.md`](../desktop-checks.md), with Xvfb,
  `dbus-run-session` and the native WebKit driver. It needs
  `xorg-server-xvfb` installed.

Keep effects cheap so WebKitGTK stays fast: animate only `transform`,
`opacity` and colors, and add no backdrop blur behind text.
