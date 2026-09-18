# Quiet delight — review 04

Captured 2026-09-17. Matt approved this visual direction for the v0.2.0 testing
release. Packaged desktop and real-world acceptance remain separate checks.

Start here:

- [Welcome with the final porch icon](welcome.png)
- [Chat and reactions](chat.png)
- [Your name and sample-message preview](your-style.png)
- [Your private status preview](your-status.png)
- [Shared memories — dark](dark-memories.png) · [light](light-memories.png)
- [Expanded image](dark-photo.png)
- [Sound preferences](sound-settings.png)
- [Listen to the 12 chimes](sounds/index.html) — open in your browser, then press play

## Other sizes and controls

- [Small window](dark-760.png) · [small window at 200%](dark-760-200.png)
- [4K, desktop 125%, app 100%](dark-4k-desktop125-app100.png)
- [4K, desktop 125%, app 150%](dark-4k-desktop125-app150.png)
- [4K, desktop 125%, app 200%](dark-4k-desktop125-app200.png)
- [Member popout](member.png) · [voice controls](dark-voice.png)
- [Appearance](appearance.png) · [shared control guide](styleguide.png)

Reaction motion and press feedback do not show in a still image. In the running
app, a successful local reaction gets one short emphasis. Your reactions have
a check; there are no visible counts. Remote reactions do not animate. Reduced
motion removes movement, not feedback.

The sound samples are rendered from the same synthesizer the app uses. Nothing
autoplays. They do not read in-app mute or quiet-hour settings; they are separate
listening samples. Start at a low speaker volume. Files can also be played
directly from `sounds/`.

These are production components in Chromium, populated with fictional people
and local test illustrations, not private photos or a live server. Evening
warmth follows the clock in these captures. The full 4K images are best viewed
at actual size. Browser HiDPI simulation is not a native Windows/Omarchy test.

Verified locally: typecheck and production build; 439 unit tests; 97 Chromium
browser cases, including reduced motion, failures and 4K scaling. Rules,
versions and whitespace are clean. The full local `scripts/check.sh origin/main`
gate also passed during release preparation. Physical audio-device listening and packaged
desktop acceptance remain open; no voice release check is closed by this pass.

Previous versions: [review 03](../review-03/README.md), [review 02](../review-02/README.md).
