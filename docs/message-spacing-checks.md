# Message spacing correction (#93)

Checked 2026-09-22 on Linux. This is an existing conversation-layout fix during
M12, not a new density mode or a release-check sign-off.

## Packaged comparison

The released 0.3.1 DEB and a newly built unsigned debug-profile DEB ran their
embedded frontends in native Tauri/WebKitGTK windows. Both used disposable
profiles and an isolated X display. A test-only GTK module supplied synthetic
people, messages and server responses; no saved accounts or real conversations
were used. The package's HTML, CSS and application code were unchanged by the
probe. This verifies packaged rendering, not authentication or networking.

| Measurement | Released 0.3.1, 100% | Fixed package, 100% | Fixed package, 200% |
|---|---:|---:|---:|
| Consecutive one-line message height | 56px | 24px | 48px |
| Hidden row above continuation text | 36px | 0px | 0px |
| Colored message border | 3px | 0px | 0px |
| Gap before a different sender | 8px | 8px | 16px |

Rooms and DMs produced identical message heights at each scale. Typed line
breaks, separate paragraphs, quotes, lists and code blocks remained intact.
The action button fits inside the shortest message; opening the action menu
and its twelve reaction choices did not change message geometry. Dismissal
returned focus to the source button. Screenshots were visually inspected.

- [Released room](screenshots/2026-09-22-spacing/room-before.png)
- [Fixed room](screenshots/2026-09-22-spacing/room-after.png)
- [Fixed DM](screenshots/2026-09-22-spacing/dm-after.png)
- [Reaction menu at 200%](screenshots/2026-09-22-spacing/actions-200.png)

The package check caught a shared button minimum height overriding the new
compact target. An explicit 24px minimum fixes it; browser regression checks
now assert that every action target remains inside its message.

## Automated coverage

`scripts/check.sh origin/main` passes. The 136-test Chromium suite passes;
the focused spacing and action checks were rerun after the target-height fix.
The browser checks run against Chromium and WebKit in CI:

```bash
cd client
pnpm test:browser tests/browser/message-spacing.spec.ts tests/browser/ui-qa.spec.ts
```

They check complete virtual rows as well as paragraph spacing, room/DM parity,
100%/200% scale, narrow windows, long sender names, hover and keyboard geometry,
menu bounds, focus return, reaction choices, reply/edit focus, confirmation
reset and refused deletion. No new runtime dependencies were added.

Windows packaged rendering was not exercised by this Linux check. No release
was published and none of HC-1 through HC-9 is closed by this evidence.
