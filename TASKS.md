# TASKS.md

**The work queue is GitHub's issues.** Pick an open issue, check its linked
pull requests and who is assigned, and claim it (`AGENTS.md`, "Pull requests
and issues"). An issue labelled `tracking` groups others: pick one of its
sub-issues.

This file keeps only what isn't an issue: the lines the next release's notes
owe, and work that is written down but not planned. Milestone status is
`ARCHITECTURE.md` §10 and *Build order* in `AGENTS.md`. Finished work, with
every landing note, is archived in `docs/tasks/` (the list is at the end):
read an archive when your change touches its area, not by default.

## The next release's notes

A merged change that needs a line in the next release's notes adds it here.
The release pull request moves these into `docs/releases/<version>.md` and
empties the list (`docs/releasing.md`).

- **The door is the app icon, and phones pick one of six looks** (#961, SPEC
  §4.15). The icon is the door everywhere now, Settings › Appearance › App
  icon picks a look, and on Android the first change closes Linger once (an
  icon on the home screen takes the new look). Google Play's listing icon
  goes up in Play Console.
- **Six themes** (#964, #965, #970, SPEC §5.3). Settings › Appearance ›
  Theme picks one on each computer and phone: The door (the default), After
  dark, Porch light, Dusk and The original are dark, and Daylight is light.
  Linger opens on The door's navy, then draws the theme.

## Written down, not planned

Known work with no issue yet. Starting one begins with an issue, and anything
from V2, V3 or the anti-goals needs Matt's word first (AGENTS hard rule 10).
The full text of each is in its archive.

- **A macOS build** (T-705's other half; Windows signing is #372). Developer
  ID signing, `notarytool` and a stapled ticket, then the two macOS entries in
  `release.yml` uncommented, in the same pass and never before. Not built on
  purpose until then (`docs/decisions.md`). Follow Apple's current docs, not
  memory.
- **Themes people make themselves** (M14, SPEC §6 "V3 or never"). Six built-in
  themes shipped (#964, #965): only color tokens change, and the contrast test
  checks each. Making your own and sharing it as a file waits on three of
  Matt's decisions, written up in `docs/tasks/queue-2026-11-27.md`, "M14".
- **Gateway frames on a private channel** (T-1811). Any window can send any
  event, so the list window can't tell a frame the Rust core sent from one a
  viewer made up. The fix is a Tauri `Channel` in place of the broadcast
  event (`docs/design/architecture.md`, "Still open").
- **A signed-in desktop check** (T-1820). Isolated Linux clients against a
  throwaway server, each with its own virtual display, D-Bus session and
  profile, driven through `tauri-driver`: a message and a picture cross, a
  styled name draws, a DM reaches only its people, and the export holds the
  DM only for them. The old client's walk-through is
  `218cc2b:scripts/desktop-check.py`. `docs/tasks/m15.md`.
- **A server in its own window** (MULTI-7 in `docs/design/parity.md`).
- **Evening warmth** (SPEC §5, LOOK-2 in `docs/design/parity.md`): colors that
  warm after local sunset wait for an evening version of the palette. Porch
  light (#964) is the warm look, chosen by hand.
- **Screen sharing, later** (`docs/tasks/m16.md`): the computer's sound from
  Linux (the portal gives none, and a PipeWire capture must leave Linger's
  own output out, T-1916); asking the portal for only the share's frame rate,
  and shrinking a 4K picture on the graphics card (T-1914); sharing from
  macOS (T-1907); streaming a game (T-1909).
- **Measuring on Windows, a long session, four-person voice and how history
  grows** (T-910). Linux is measured in `docs/performance.md`.
- **Link previews are fetched by the server**, so the server's address shows
  in the logs of every site anybody links. Matt hasn't confirmed that trade;
  the other choices are no cards, or every reader fetching for themselves.

## Archives

In `docs/tasks/`: `m0.md` (with the spikes), `t-006-vocabulary.md`, `m1.md`
to `m12.md` (`m4-5.md` is M4.5), `m13.md` (cut), `m15.md` (the Buddy list
client), `m16.md` (screen sharing), `mobile.md` (the phone app),
`v1-polish.md`, `release-checks.md` (the steps, for re-running), and
`queue-2026-11-27.md` (the rest of this file as it stood that day: how tasks
were run, the release summaries, the backburner, V2 and V3, and the parking
lot). Decisions are in `docs/decisions.md`, and each release's notes in
`docs/releases/`.
