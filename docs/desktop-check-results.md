# Desktop release evidence — 2026-09-08

**HC-5 export passed. HC-4 and HC-7 have local native desktop evidence; their
separate-machine checks remain open.** M12 remains the current milestone.

Environment: Linux x86-64, WebKitGTK 2.52.6, tauri-driver 2.0.6, Chromium
152.0.7977.82. App version 0.1.0, debug binaries built from the working source
with T-920 (`ca60c7d`). Three clients used separate Xvfb displays and private
D-Bus/XDG directories on one development machine. Each signed into a new local
server as a different member. No saved accounts or deployed server were used.

The [repeatable harness](desktop-checks.md) passed from a fresh server and
three empty profiles. [Raw check results](screenshots/2026-09-08-desktop/results.json)
contain assertions and fixture archive entries. Screenshots capture the real
application WebViews; native commands, uploads and gateway traffic were not
mocked. Evening warmth alone used a controlled hour inside the test WebView.

## Outcomes

| Check | Evidence obtained | Status / still needed |
|---|---|---|
| HC-1 release/update | Published v0.1.0 Linux/Windows assets and update metadata exist. The four source versions agree. Anonymous registry retrieval confirmed both amd64 and arm64 image manifests | Open: install on a machine that did not build it, then complete a real update |
| HC-2 window opens | Downloaded published v0.1.0 AppImage opened and rendered its sign-in screen on an isolated Linux display | Open: clean target installation and Windows execution. macOS remains deferred |
| HC-3 large upload | Small PNG uploads crossed native clients and appeared in media and downloaded archives | Open: 400 MB video, interrupted connection/resume, poster, production HTTPS/media domains and second-machine playback |
| HC-4 styling | Live gradient, Newsreader face and shimmer; normalization; compact/IRC effects off; light/dark and controlled evening warmth | Local desktop portion passed. Separate machine/VM and real evening observation still open |
| HC-5 export | Real export/download controls → native opener → real Chromium download → independent ZIP reader; readable room Markdown and PNG; friendly second-request cooldown | **Passed** for the desktop flow on the local development server |
| HC-6 knock | No additional sound test in this run | Open: two machines and listening |
| HC-7 DMs | A↔B live conversation and image; C could not find either in rail, media, search or exported Markdown/files; B's archive included both | Local content isolation passed. T-921 presence wording, separate computers and usability assessment still open |
| HC-8 local voice | No additional audio test in this run | Open: two devices, listening, controls and physical hotplug |
| HC-9 network voice | No independent-network test in this run | Open: relay/hotspot exercise and four people on four networks for an hour |

The published image workflow's [multi-architecture release run](https://github.com/itsMattGuenther/Linger/actions/runs/33994106056)
passed. The public release used for the launch check was
[v0.1.0](https://github.com/itsMattGuenther/Linger/releases/tag/v0.1.0).
No release was published or update installed by this verification.

## Export and the defect it exposed

Before T-920, a server without `LINGER_DOMAIN` returned `/objects/...` URLs as
documented. Inline images requested that path from the WebView's Vite origin
and failed. The native opener refused the relative export URL silently, so
“download it” appeared to do nothing. Uploading the bytes had succeeded.

The fix resolves local paths against the server supplying the content. It also
covers video posters, media tiles, status images and ordinary file downloads.
Absolute media-domain and signed URLs keep their original value. Four new
regressions fail on the old implementation; all pass after the fix.

The final run observed “Building your archive…” followed by “Your archive is
ready.” These small archives finished before the first poll, so no intermediate
percentage was observed. Clicking download launched Chromium through the native
opener. The app stayed at its own URL. Python's independent ZIP reader verified
all archive CRCs, read the public room text, and read a 128×128 PNG from `media/`.
The extracted [image](screenshots/2026-09-08-desktop/exported-image.png) was also
opened for visual inspection.

Bob's archive contained `direct/alice.md` with “Lanternsecret: this conversation
is just for us.” and `media/lanternsecret.png`. Carol's archive contained neither
the direct folder nor the private file or phrase. Both had `rooms/porch.md` and
`media/porch-lamp.png`. Asking again produced “You already asked for one recently.
You can ask again in about an hour.”

[Export ready](screenshots/2026-09-08-desktop/bob-export.png) ·
[Cooldown](screenshots/2026-09-08-desktop/bob-export-cooldown.png) ·
[Private conversation](screenshots/2026-09-08-desktop/private-conversation.png) ·
[Outsider search](screenshots/2026-09-08-desktop/outsider-search.png)

## Styling and remaining presence mismatch

Alice selected amber → violet, Newsreader and shimmer in settings, then sent a
message. Bob received the style through the native gateway. The rendered name
used Newsreader, two gradient colors and the `name-shimmer` animation. Both
themes were visually inspected. Normalization removed gradient/font overrides
and animation immediately; compact and IRC retained the name colors while
turning animation off, as specified.

[Dark](screenshots/2026-09-08-desktop/styled-dark.png) ·
[Light](screenshots/2026-09-08-desktop/styled-light.png) ·
[Normalized](screenshots/2026-09-08-desktop/normalized-dark.png) ·
[Compact](screenshots/2026-09-08-desktop/compact-dark.png) ·
[IRC](screenshots/2026-09-08-desktop/irc-dark.png) ·
[Evening](screenshots/2026-09-08-desktop/evening-dark.png)

The outsider's roster says “in a room” for Alice and Bob during their DM. The
room's identity is hidden, and this matches the existing wire rule (`in_room`
with `room_id: null`), but HC-7 expects ordinary “around” presentation. **T-921
is open.** This is not recorded as a fully passing HC-7.

## Selected app icon and validation

The friend group's selected porch PNG is now the desktop icon source.
`scripts/app-icons.py` preserves its proportions with transparent padding and
uses the pinned Tauri CLI to produce the existing PNG, ICO and ICNS formats.
A local debug Debian package was built and inspected: its 32, 128 and 256 pixel
installed PNGs match the new icon files byte for byte. This is package-content
verification, not a clean-machine install or a signed release. Windows/macOS
icon appearance has not been checked on those systems.

`scripts/check.sh origin/main` passed, including Rust workspace and desktop
tests, clippy, formatting, binding drift, and **413 frontend tests**. The package
build also ran `pnpm build` successfully. Hardware/keyring tests remain ignored
by the automated gate; real S3 validation is a separate CI job.

All five [CI jobs](https://github.com/itsMattGuenther/Linger/actions/runs/34287834499)
passed for the implementation, including the real S3/MinIO job. A second clean
desktop run passed the same assertions. Review: [PR #62](https://github.com/itsMattGuenther/Linger/pull/62).
