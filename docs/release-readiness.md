# Release readiness review — 2026-09-08

Linger has enough implemented functionality for a friend-group pilot. It does
not yet have the evidence needed to call it a dependable Discord replacement.
The next work should close the existing end-to-end flows and run the release
checks, before starting ambient voice or another platform.

This review covers the checked-out source, product documents, release workflows,
automated checks and saved UI screenshots. It is not a completed security audit
or a usability study. No new test across separate computers was performed.
Windows and Linux are the working release scope, following the existing
[distribution decision](decisions.md); macOS and mobile remain deferred.

## Keep the architecture and the product's identity

The current structure fits a small group: one Rust server, SQLite with a single
writer, a Tauri client, and generated shared types. Audio lives outside the
WebView. Message history is virtualized, so the page draws only the visible
rows. These are useful foundations; this review found no reason for a rewrite,
another service, or another frontend state library.

Keep Console's hairlines, styled names, sans-serif messages and permanent
roster. The visual opportunity is clearer hierarchy and more readable controls
within that system. Its identity should come from the people and their shared
things. Empty rooms, ordinary names, and quiet evenings need as much attention
as the styled-name demo.

## Priorities and evidence

### 1. Prove installation and voice before asking friends to switch

M12's implementation is present. Its acceptance check is still four people on
four networks for an hour. Earlier milestones also have outstanding manual
checks. Passing unit and integration tests does not close those checks.

Use [HC-1 through HC-9](../TASKS.md#human-checks--things-only-you-can-do) as the
release checklist, and record the version, operating systems, date, outcome and
failures for each. For the Windows/Linux pilot, leave HC-2's macOS portion
explicitly deferred, not passed. Start with installing and updating on a machine that did not
build the app. Then verify voice on one network before testing the relay using
a phone hotspot. Listen for echo, quiet microphones, clipping and increasing
delay, as well as whether a connection exists. Do not start M13 before M12
passes.

For a voice-dependent group, an hour of reliable conversation is part of the
first usable release. If the group elects to move only text and files first,
label voice experimental and keep that narrower release promise explicit.

### 2. A temporary outage must not look like losing an account

**Confirmed and fixed in T-906:** `AuthedApi` treated every error from token
renewal as the end of a sign-in. `useSessions` then removed the server and
deleted its saved token. A temporary server error could therefore make a friend
enter their credentials again. Only an explicit authentication rejection now
ends the sign-in. Tests reproduce the old behavior and verify later recovery.

**Still open, T-907:** startup waits for all saved servers using `Promise.all`,
and the HTTP client supplies no request deadline of its own. One server taking
a long time to answer can delay the whole app. A failed server is omitted for
that launch, with no retry control for restoring it. Preserve its entry, let
healthy servers open independently, and make recovery possible without
restarting or pasting the address again. This does not require an offline
message database.

Sources: [api.ts](../client/src/lib/api.ts),
[session.ts](../client/src/lib/session.ts).

### 3. Finish the promise to keep shared things

**Confirmed, T-908:** the server implements pin and unpin, and media can filter
pinned messages, but the conversation has no pin action. That leaves a shipped
filter unreachable through normal use. Add the action to the existing message
controls, show the current state, and verify it across clients and in a DM.
Reuse the endpoint and existing membership checks.

Before relying on Linger as the group's archive, restore a backup onto a spare
server and check messages, accounts and files. An export is a readable copy;
it does not replace the host's backup. The
[host guide](host-guide.md#backups) already documents backup and restore, so
this needs a rehearsal, not a new backup feature.

Sources: [message endpoints](../crates/linger-server/src/routes/messages.rs),
[message controls](../client/src/stream/Stream.tsx),
[media](../client/src/media/MediaPanel.tsx).

### 4. Make minimal controls easy to see and use

**Confirmed in styles, T-909:** message actions use `--text-muted`; density
options and several hints still use `--text-faint`. The recent T-905 pass
improved the rail, but did not cover every interactive surface. Passing the
name-palette contrast test does not prove controls are readable. Message
actions do have a keyboard focus path; test its usability rather than adding
a second action system.

Review the current app in both themes and all densities at 1100×720 and its
760×480 minimum. Cover keyboard-only navigation, larger text, long names,
reduced motion, empty rooms and failed requests. Improve control contrast,
focus visibility, spacing and wording using the existing tokens. Keep the
roster visible at narrow widths. Do not add more permanent controls above a
conversation to solve a discoverability problem elsewhere.

The saved screenshots establish the design direction, but some predate T-905.
Capture current before/after images during this task and have one friend find
settings, send a file and join voice without instructions.

Sources: [tokens](../client/src/styles/tokens.css),
[frame styles](../client/src/app.css),
[message styles](../client/src/stream/stream.css),
[saved voice screenshot](t1404-voice-line.png).

### 5. Measure what “lightweight” means, T-910

The production frontend built during this review contains approximately
374.33 kB of JavaScript (115.35 kB gzip), 60.88 kB of CSS (16.06 kB gzip), and
1.18 MB of output overall including bundled fonts. No dependency was added.
These figures describe web assets, not the installed application or its RAM.

The architecture's bundle/RAM estimates and SPEC's 400 ms opening goal are not
measurements of this release. Record installer size, cold launch time, process
memory and idle CPU on Windows and Linux, including WebView processes. Repeat
after a long session with several rooms and during four-person voice.

Virtualization limits drawn rows, not retained history: `mergePage` keeps
adding fetched messages to arrays. Measure that growth before designing a
cache limit. Any limit must preserve scroll position, search jumps and gap-free
reconnection. Read [M10's notes](tasks/m10.md) before changing history loading.
Set explicit regression budgets from the recorded baseline; do not advertise
unmeasured native size or startup numbers as achieved.

### 6. Keep the release description truthful

This review corrects two kinds of drift: milestone summaries that still said
DMs or the audio path were unstarted, and the README's unconditional claim of
disk encryption. The server opens ordinary SQLite and stores ordinary files;
disk or bucket encryption is the host's responsibility. The host guide already
said this correctly.

There is another wording gap to track: `tauri.conf.json` permits HTTPS and WSS
origins generally, while some comments describe the content security policy as
restricted to the signed-in server. A content security policy controls which
network destinations the page may use. Scheme restrictions and server-specific
restrictions are different guarantees. The architecture now describes the
actual policy; narrowing it further would need a design covering multiple
servers and media URLs.

## Order for the next sessions

1. Land T-906 and the documentation corrections. Keep all existing checks green.
2. Run HC-1 with one friend; run HC-8 and HC-9 with the group. Fix observed
   installation or voice failures before adding features.
3. Complete T-907, then T-908 and T-909. Measure T-910 before calling a build
   lightweight. Finish the remaining human checks and rehearse backup restore.
4. Use the resulting build for a week of ordinary conversation. Keep a short
   manually written list of friction and failures, without message contents
   or automatic reporting. Release when the promised flows work without the
   developer guiding each step.

## Validation of this contribution

`scripts/check.sh` passes locally, including workspace and desktop-shell tests,
formatting, clippy, generated-type drift, and all 408 frontend tests. The eight
new sign-in tests include three that failed against the original code.
`pnpm build` also passes. Hardware/keyring tests remain ignored by the automated
gate, and the local gate does not exercise S3 against a real object store.
All five [CI jobs](https://github.com/itsMattGuenther/Linger/actions/runs/34282614359)
passed for the implementation, including S3 against MinIO.
None of these results closes a human release check.
