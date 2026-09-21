# Approved UI QA corrections — 2026-09-21

These captures show the current production React components in the local
Console fixture, with synthetic people and messages. They are browser evidence,
not packaged-desktop or multi-network voice acceptance.

The approved scope is five corrections: message actions no longer cover text;
message bodies stay sans-serif; destination headings and Close controls match;
sound switches align; the absolute recording claim is removed. The existing
Console palette, layout and name styling remain in place.

| Capture | Evidence |
| --- | --- |
| [Dark chat](dark-chat.png) | Hover actions beside the author, above the body |
| [Light chat](light-chat.png) | The same action geometry in the light theme |
| [Search](dark-search.png) | Shared destination heading and Close control |
| [Media](dark-media.png) | Shared destination heading and Close control |
| [Sound settings](dark-sound-settings.png) | Shared header and aligned switches, including rows without Preview |
| [Voice settings](dark-voice-settings.png) | Join instructions without a guarantee about other people recording |
| [Grouped message at 760 px](dark-grouped-760.png) | Actions remain clear of a continuation, reply and inline code |
| [Legacy font choices](dark-legacy-fonts.png) | Saved non-sans body choices fall back to sans; name fonts stay selected |

## Reproduce

Run the client Vite development server and open
`/tests/fixtures/console.html`. Captures use a 1100×720 viewport, 100% interface
scale and reduced motion. Hover the last message for the chat captures. Use
the rail for Search and Media; use Settings → Sound & voice for the sound and
voice captures. Scroll to the Voice section for the latter.

The two edge-case captures use `/tests/fixtures/console.html?qa`, which adds a
long name, legacy message-font choices, a reply and a grouped continuation.
The grouped capture uses 760×480. Use the light color scheme for `light-chat`;
the other captures use the dark color scheme.

`client/tests/browser/ui-qa.spec.ts` checks action geometry at both viewport
sizes and 200% interface scale, keyboard access, saved-font rendering,
matching destination controls, and switch alignment and persistence.
