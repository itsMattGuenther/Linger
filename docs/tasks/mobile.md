# Mobile: the phone app (T-16xx)

Archived from `TASKS.md` on 2026-11-27, when the work queue moved to GitHub's
issues (`docs/decisions.md`, "GitHub's issues are the work queue"). Matt, that
day: the real-world checks still marked owed here were ones nobody could run by
hand, and the app in daily use since has settled them. The marks are left as
they stood. What was never built is listed in `TASKS.md`, "Written down, not
planned".

*Off the backburner on 2026-10-02 (Matt, #253).* It was parked on 2026-08-28
until the desktop app was finished and lived with; the release checks closed on
2026-09-25 and friends have used it since. **T-1601 is decided and written into
SPEC §4.15:** a phone app for iPhone and Android from the same Tauri 2 code, no
push and no notifications, no `mobile` presence, uploads yes, and text only at
first: voice rooms came on 2026-10-19 (T-1606, #429), and notifications chosen
by kind on 2026-11-11 (#830, T-1608 below). The reasons are in
[`docs/decisions.md`](../decisions.md).

*Check: sign in, read a room, send a message and a photo, from a phone.*

**No mobile branch.** Phone work lands on `main` in ordinary short branches
(`feat/t-1602-…`). Desktop-only code is switched off for phone builds
(`#[cfg(desktop)]`), and nothing ships to a phone until a phone build is added
to the release workflow. Android builds and runs on Linux, in Android Studio's
emulator or on a phone over USB or wifi. iPhone builds need macOS: GitHub's
macOS runners, or a friend's Mac.

- ✅ **T-1601 · Decide what mobile means** — *a decision, not a task.* Matt,
  2026-10-02. No push (so no relay, and nothing new leaves the server), no
  `mobile` presence state, uploads from phones, iPhone and Android both, and no
  voice in the first version: it comes back only if people using the phone app
  ask. Phone backups leave Linger out (the opt-in was dropped 2026-10-03), and
  report and block come before any store listing (T-1605). SPEC §4.15.
  *Push reversed 2026-11-11 (#830, T-1608).*

- 🟡 **T-1602 · The mobile shell** — effort: **high**
  *Android: accepted on Matt's Pixel (2026-10-03). iPhone: on friends'
  iPhones through TestFlight since 0.5.1 (2026-10-20, `ios.yml`, #685), and
  in the App Store since 0.5.5 (2026-11-25).
  Matt has no iPhone, so friends and contributors with iPhones do its
  checks.*
  *Started 2026-10-02 on `feat/t-1602-mobile-shell`.* **Done:** the crate
  builds for Android with the desktop-only code switched off (`phone_app` in
  `src/lib.rs`, `capabilities/phone.json`, voice moved to
  `src/voice_commands.rs`, `src/acl.rs` checking the phone's grants); the
  Android project in `gen/android`, with cloud backup off; and in the Android
  emulator the app opens, sets up a server, signs in, and its live connection
  comes up. Thirty seconds in the background closes the connections (offline,
  as SPEC §4.15 says) and coming back opens them; losing the network closes
  them and getting it back reopens them at once (checked with airplane mode in
  the emulator). Android keeps sign-ins in its Keystore-backed store
  (ARCHITECTURE §7, item 3): signed in, the app force-closed and opened again
  comes back signed in, with its tabs. The iPhone uses the Keychain through
  the keyring crate; friends have signed in with it on their iPhones since
  0.5.1, and nobody has been signed out by it.
  **On a real phone** (Matt's Pixel 11 Pro, Android 17, against his own
  server, 2026-10-03): signed in, sent and got messages, and switched networks
  both ways. Wi-Fi off: the connection closed and was back on mobile data
  within a second. Wi-Fi back on: the connection riding mobile data dropped,
  and the app resumed on Wi-Fi within a second, with nothing missed. Android
  17 blocks an app's network about five seconds after it leaves the screen
  (`dumpsys netpolicy` shows `APP_BACKGROUND`), so the connection drops then,
  not at the thirty seconds the app allows, and it retries into the block
  until then. Coming back after a short time it was live in two seconds, but
  the retries back off up to thirty, so now the app tries again at once when
  it comes back to the screen (`gateway_retry`). **The iPhone** builds on
  GitHub's Macs (`ios.yml`) and goes to friends through TestFlight, since
  0.5.1 (2026-10-20). Their first reports (2026-10-21 to 23: #686–#689,
  #697, #698, #703, #704) have fixes in TestFlight from 0.5.3, for them to
  confirm. Not reported on yet: the iPhone switching between Wi-Fi and
  mobile data. The launcher icon is the door, with five more looks a person
  picks in Settings (#961, `scripts/app-icons.mjs`, checked in CI with the
  desktop icons). Setup is in `docs/development.md`.
  Tauri 2 builds for iOS and Android from the same crate. What does not carry
  over: the OS keyring (phones have their own secure storage), the tray, the
  in-app updater (a phone app updates through its store), and, at first,
  voice, which came to phones on 2026-10-19 (T-1606, #429). Expect the gateway to need
  reconnect behaviour for a network that changes every time somebody walks out
  of a building, and for a phone that stops the app as soon as it is in the
  background. **The phone identifier is `io.github.itsmattguenther.linger`**
  (Matt, 2026-10-02), set in `tauri.android.conf.json` and
  `tauri.ios.conf.json` so desktop keeps `com.linger.desktop`. It is built
  from the GitHub address, which nobody else can claim, and neither store lets
  it change after the first upload. **Phone backups leave Linger out**
  (SPEC §4.15; the opt-in was dropped 2026-10-03): Android's
  `allowBackup="false"` does it there, and on the iPhone the app marks its
  folders "don't back up" and keeps its sign-ins to that phone (#790,
  T-1604), for TestFlight testers to confirm. **It targets Android 17 (API
  37)** since #842 (2026-11-14; Play requires it from August 2027). What that
  changed for Linger: Android 17 holds back a connection to a server on the
  phone's own Wi-Fi without a word, so the app asks for Nearby devices for
  such a server, and only then (`phone_network.rs`, `LocalNetwork.kt`,
  `lib/localNetwork.ts`, SPEC §4.15); and sound in the background needs a
  foreground service started while the app is on screen, which the call bar
  is. In the emulator on Android 17: voice kept sending and playing with the
  phone locked (a tone played with no call was silenced, so the check
  works), notifications arrived and opened their conversation, a photo sent,
  and "Open in Linger" filled the box. Joining voice before the microphone
  was allowed closed the app: the call bar's service started while Android
  was still asking, which Android refuses from target 34, so 0.5.4 did it
  too. The bar now waits for the microphone. Owed: the same checks on Matt's
  Pixel through Play's internal test.
  *Release notes, 0.5.5:* the Android app targets Android 17; a server at a
  home address asks once for Nearby devices; and joining voice on an Android
  phone that hadn't allowed the microphone no longer closes the app.
  *Accept:* the app opens on a real phone, signs in, and stays connected across
  a wifi-to-mobile-data switch.

- 🟡 **T-1603 · The layout at phone width** — effort: **medium**
  *Android: accepted on Matt's Pixel (2026-10-03). iPhone: used by friends
  through TestFlight since 0.5.1 (2026-10-20); what they found at phone
  width (#686, #688, #689, #697, #698, #704) has fixes in TestFlight from
  0.5.3, for them to confirm.*
  *Started 2026-10-02 on `feat/t-1602-mobile-shell`.* **Done:** the phone's
  one window (`docs/design/architecture.md`, "The phone's one window"): the
  page keeps clear of the phone's bars, the ✕, pop-out and voice line are
  gone, conversations open over the list, and Settings opens over it as its
  sections, then one section. In the emulator: set up a server, made a room
  from Settings, read and sent messages, and got Sam's reply live.
  The message box sits on the keyboard, with the header still showing
  (`followKeyboard`, checked with the emulator's on-screen keyboard).
  Opening a conversation leaves the keyboard down until the box is tapped.
  Checked in the emulator: Media, Search (a hit opens its room at the
  message), a DM, a photo sent from Android's file picker (it arrived and
  shows), and a link, which opened in the browser with Linger left as it
  was. **One screen at a time** (Matt, 2026-10-03, docs/decisions.md): no
  tabs on the phone. A conversation, Media or Search opens over the list,
  full screen, with ← Back, and they stack: a search hit opens over Search,
  and Back returns to Search as it was left. Settings goes back with ← too.
  Rows and the title bar are 44 and 48 px tall, so a thumb hits them, and
  `next-phone.spec.ts` checks that no screen reaches past the phone's edge.
  Checked in the emulator with Android's own Back. **On Matt's Pixel
  (2026-10-03):** one-handed use, Android's largest Font size, and sending a
  picture all worked. The one thing he saw: in a room with a long name the
  box's hint wrapped, "Say something in #screenshots and" with a sliver of
  a second line, since Android's engine doesn't cut a text box's hint with a
  "…"; the box now says just "Say something" when the long hint won't fit.
  **Voice messages record on the phone too** (#401, 2026-10-03), in the page
  (`app/chat/recorders.ts`), into the same file as the desktop's; Android asks
  for the microphone the first time Record is pressed. **On the Pixel
  (2026-10-03):** Android asked for the microphone the first time; recorded,
  sent and played back on the phone and on the desktop, cancelled one, and
  recorded with the ringer on silent. All worked.
  **On the iPhone:** a swipe in from the left edge goes back, since the
  iPhone has no Back of its own (#697, in 0.5.3). Camera photos and
  screenshots go up through the + button, as a friend does on their iPhone
  (#785).
  Seen on the first run in the emulator (2026-10-02): the list's title bar
  draws under the phone's clock and icons, its ✕ means nothing on a phone, the
  sign-in note says "this computer", and everything that opens another window
  (Settings, "Make the first room", a conversation, Media, Search) does
  nothing. A phone has one window and `phone.json` grants none of the window
  commands, so all of those have to open inside the list's window instead.
  *Accept:* usable one-handed on a phone somebody actually owns.

- 🟡 **T-1604 · Getting it onto a phone that is not yours** — effort: **treacherous**
  *Started (Matt, 2026-10-03): friends first.* Each release carries a signed
  `Linger_<version>_android-arm64.apk` (release.yml's `android` job;
  `scripts/android-key.sh` makes the key, `scripts/android-signing.sh` checks
  it against `client/src-tauri/android-release-cert.sha256` before and after
  the build; docs/development.md, "The release key"). A release build signed
  with a throwaway key opened in the emulator and reached Matt's server.
  The real key and its two secrets are set, and 0.4.8 and 0.4.9 each carry
  the `.apk`. Next is Google Play, when Matt says go.
  **Play must keep our key** (2026-10-08). Play signs what it ships with an
  app signing key of its own, and makes a new one unless it's given ours.
  Android updates an app only with a copy signed by the same key, so with a
  new key everyone who installed the `.apk` from GitHub gets "App not
  installed" when Play's copy arrives, and has to uninstall once, which signs
  them out. Matt's Pixel did exactly that on 2026-10-08, with a test build
  left on it. So when setting up Play App Signing, upload the existing
  release key (`android-release.jks`, its fingerprint in
  `android-release-cert.sha256`) as the app signing key. Follow Play's
  current steps; the choice can't be undone for people who already have the
  app. **No separate upload key** (2026-10-20): the bundles are signed with
  the release key too. The GitHub `.apk` keeps that key in the `release`
  environment anyway, so an upload key beside it would guard nothing. Play
  can still add one later.
  **Started 2026-10-20 (#253):** Matt's Play developer account is verified
  (developer name Matt Guenther) and the app is created, package
  `io.github.itsmattguenther.linger`. `.github/workflows/play.yml` builds a
  release's signed bundle from its tag, and once wraps the key for Play App
  Signing with Google's `pepk` inside the run (docs/releasing.md, "Google
  Play"). Next: the first bundle on internal testing to set the key, the
  store listing and App content forms, then a closed test with 12 testers for
  14 days, then "Apply for production".
  **The iPhone, in the App Store since 2026-11-25** (0.5.5, the TestFlight
  build the testers had; #779 listed what Apple asked for first).
  **Started 2026-10-20 (#253):** Matt's Apple Developer Program
  membership is active, and the App Store Connect API key (Admin) is in the
  `release` environment. `gen/apple` is `tauri ios init`'s, from GitHub's
  Mac, iPhone only. `ios.yml` builds on `main`, signs automatically through
  the key, and uploads to TestFlight (docs/releasing.md, "The iPhone").
  `Info.ios.plist` has the microphone and camera wording and the encryption
  answer. **Before the App Store, not before a first TestFlight build:**
  keeping the app out of iCloud backups, as the privacy page says. **Built,
  for TestFlight testers to confirm (#790):** each start marks the folders
  the web view, the phone's networking and Tauri keep things in "don't back
  up" (`src/phone_backup.rs`), and each sign-in is written to the Keychain
  as `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so a backup can't
  carry it to another phone; an older build's entries move over in place the
  first time, so nobody is signed out (`src/secrets.rs`). The testers check
  that they're still signed in after updating, and that Linger shows next to
  nothing under the iPhone's iCloud backups; then #779's "Backups and the
  Keychain" is ticked. **Voice with the phone locked** came with the
  background audio mode (#851).
  **A privacy policy link inside the app**, which Apple's guideline 5.1.1(i)
  wants as well as the one in App Store Connect: built 2026-10-31 (#779),
  **Privacy** under Settings → Account & App → This Phone (This Computer on
  a desktop), opening linger.im/privacy.
  The App Store came first, with 0.5.5 (Matt, 2026-11-19, `docs/decisions.md`,
  "Android first, Apple after"): Play's closed test waits until Matt has 12
  Android testers. The listing's privacy answers ("Data safety") must
  say the app uses the microphone only to record a voice message the person
  chooses to send.
  Friends first, then the stores. Android: a signed APK on the GitHub release
  (Google requires registered developers even outside its store, worldwide
  from 2027). iPhone: TestFlight, which needs the Apple Developer Program
  ($99/year); a TestFlight build stops working after 90 days. Then Google Play
  ($25 once; 12 testers for 14 days before a new account can publish) and the
  App Store, review, and store listings. **Needs T-1605 first:** both stores
  require report and block. Apple's guideline 1.2 also asks for a way to
  filter objectionable material and for published contact details, and both
  stores want terms of use. For contact details, **Report a problem** sits
  beside Privacy and opens GitHub's issue forms, as the website's link does
  (#779); whether App Review accepts that is Matt's call. **Both require
  deleting your account in the app, too:** built 2026-10-17 (#650, SPEC
  §4.19), with a page on the website for Google's form; what those mean for
  a self-hosted app among friends is settled here, with Matt. Follow current
  vendor docs, not memory — this changes every year.
  *Accept:* somebody who has never met you installs it from a store.

- ✅ **T-1605 · Report and block** — effort: **medium**
  *Built 2026-10-03 on `feat/t-1602-mobile-shell`; it reaches `main` with
  that branch.* The server (PROTOCOL §5, "Report and block"): `/me/blocks`,
  `/reports`, the `block.update` and `reports.changed` frames, a blocked
  person's knock dropped, and `tests/report_block.rs` for who hears what.
  The apps, as the mockups Matt approved: Report and Block behind a ··· on a
  person's card, Report to host… last in a message's actions (held for, on
  the phone, in a sheet from the bottom), each blocked message one grey line
  you can open, nothing of theirs lit, chimed, in Media or in Search,
  Settings › Account listing who you've blocked, and the host's one lit row,
  "A report to look at", opening Settings › People with each report and
  Delete message, Remove… and Let it go. `next-report-block.spec.ts` and
  `next-phone.spec.ts` prove it in Chromium and WebKit. Found on the way: a
  host's open reports were asked for before the server said who you are, so
  the lit row waited for the next report; they now load on every `ready`.
  **Still to try:** reporting and blocking on Matt's Pixel against his
  server.
  SPEC §4.15. Matt, 2026-10-02: both stores require them (Apple guideline
  1.2, Google Play's user-generated content policy), so they come before any
  store listing, and they go in the desktop app too. **The shape is
  confirmed** (Matt, 2026-10-03, from mockups; docs/decisions.md): as below,
  with the least UI that does it. On the phone, holding a message opens its
  actions from the bottom (Reply, Copy text, Pin, then Report to host… under
  a line); on a computer, Report is the last item in the ··· menu. A person's
  card gets a ··· beside Knock with Report and Block. The host sees who sent
  each report. A blocked person's messages each become one grey line, "From
  Dex, who you blocked · Show", and Settings › Account lists who you've
  blocked, to unblock. The host learns of a report from one lit row in the
  list, "A report to look at", which opens Settings › People. The shape:
  **Report** is in a message's menu and on a person's card. It sends the
  message (or the person) to the host of that server with an optional note,
  because a self-hosted server has nobody else to send it to; the host already
  can delete a message or remove a member (T-413). The host sees reports in
  their host controls, with **no count anywhere** (AGENTS rule 3).
  **Block** is on a person's card and is private: they aren't told. It hides
  their messages from you and stops their DMs and knocks reaching you. Which
  surfaces filter it (stream, media, search, presence) is the bulk of the work,
  the same kind of filtering M11 folded into every query for DMs
  ([`m11.md`](m11.md)).
  *Accept:* a report reaches the host and only the host; a blocked person's
  messages, DMs and knocks never reach the person who blocked them, on either
  app.

- 🟡 **T-1606 · Voice rooms on the phone** — effort: **high** (#429)
  *Decided by Matt 2026-10-19 (`docs/decisions.md`, "Voice rooms on the
  phone, and the call bar"); SPEC §4.15.* Anybody on a phone joins voice
  with any microphone. **Built on `feat/429-phone-voice`:** voice runs in the
  page on the phone (`lib/pageVoice.ts`), on the web engine's WebRTC with the
  phone's echo cancelling; `ipc.ts` sends the same voice calls there when
  `voiceInThePage` has put it in place (main.tsx, on the phone), and it
  raises the same events, so the store and screens are the computer's. It
  follows the desktop engine's rules: the server's offer answered on one
  connection, the microphone's m-line the one `tracks` doesn't name, a new
  username fragment answered on a new connection, the same restart rules
  (`lib/voiceRestarts.ts`, the desktop's tests ported), the same talking
  level, and Opus asked not to send silence (`usedtx`). The screens: the
  room's voice line and the list's voice bar with thumb-sized controls, and
  `InVoiceLine` on every other screen. The call bar (`phone_call.rs`,
  `VoiceCallService.kt`): a microphone foreground service with one silent
  notification while in voice, whose Mute and Leave reach the page
  (`linger:callbar`); the list keeps the voice server's connection open in
  the background. `next-phone-voice-room.spec.ts` proves the call against a
  real WebRTC connection standing in for the server (join, hear, be heard,
  mute, silence, a dropped connection started afresh, leave), and
  `next-phone.spec.ts` the screens. **Still to do:** the emulator against a
  real server; then **Matt's Pixel** on his server, with a computer in the
  room: speaker and earpiece, a Bluetooth headset, locked for ten minutes,
  Wi-Fi to mobile data mid-call, and how it sounds to the people on
  computers. Then the iPhone, with the rest of the iPhone app (WebKit runs
  the same page engine). Google Play asks for a foreground-service
  declaration for the call bar, with a short video of it.
  *Accept:* on a real phone, in a room with people on computers, both ways
  sound right, and the call survives the phone locked and a network change.

- 🟡 **T-1607 · Share to Linger from the phone's share sheet** — effort: **high** (#785, #820)
  *2026-11-02: on an iPhone it's now a window of its own in the share sheet
  that posts there and then (#820, `docs/decisions.md`, "The iPhone shares
  inside the share sheet"); what follows is the Android half, and the first
  iPhone version it replaced.*
  *Decided by Matt, 2026-10-31 (`docs/decisions.md`, "Sharing to Linger from
  the phone's share sheet"); SPEC §4.15.* Pictures, videos and files shared from
  another app land in a conversation's message box, unsent. **Built on
  `feat/t-1607-share-to-linger`:** the shell's inbox (`shared.rs`, and
  `linger://shared` in `deep_link.rs`), the page's sheet asking which
  conversation (`core/shareInbox.ts`, `app/list/ShareSheet.tsx`) and the box
  taking the files (`useFileDrafts`); Android's intent filter and
  `SharedInbox.kt`; the iPhone's share extension and App Group. **Still to
  do:** review; an Android build on a phone; an `ios.yml` build, which is the
  first time the extension and the App Group are signed (it builds from
  `main` with the release key, so how to build this branch is Matt's call);
  then the iPhone itself, on TestFlight.
  *Accept:* on a real phone, share a screenshot from the photo library to Linger,
  pick a room, see it in that room's message box, send it, and see it arrive
  on a computer.

- 🟡 **T-1608 · Phone notifications, chosen by kind** — effort: **high** (#830)
  *Decided by Matt, 2026-11-11 (`docs/decisions.md`, "Phones get
  notifications, through a relay that can't read them"); SPEC §4.15, PROTOCOL
  §5.* #830 is the parent; each job is a sub-issue. ✅ The Apple, Google and
  Cloudflare accounts (#885, 2026-11-12). ✅ The server's side and the docs
  (#886, PR #890): who hears about what, RFC 8291 encryption, the phone's
  endpoints and the host's off switch. ✅ The relay at `push.linger.im` (#887,
  PR #891). ✅ Android (#888, PR #894): Firebase messaging, Settings →
  Notifications and a held room's choices on the phone, the phone idle as
  soon as it's put away; its check on Matt's Pixel is owed. 🟡 The iPhone
  (#889): the notification extension that opens each notification and shows
  the server's words, grouped by conversation (`gen/apple/NotificationService`),
  iOS's permission question, Apple's push address, the keys in the App
  Group's Keychain group, and a tap opening the conversation
  (`phone_push/ios.rs`). Built and its tests run on GitHub's Mac; owed the
  TestFlight testers' check after the next build.
  *Release notes, 0.5.5:* phone notifications on Android and, through the
  next TestFlight build, the iPhone, which need the server on 0.5.5 too (an
  older one says it needs an update); and update Play's Data safety form
  first (docs/releasing.md, "Google Play"), and the App Store's privacy
  answers before the iPhone app is submitted for review ("The iPhone"). The
  first `ios.yml` build with notifications is the first time the extension
  is signed and the app is signed for Apple's push service: it fails, before
  TestFlight, if either is wrong. The
  site's privacy and delete-account pages say Linger "runs no servers" and
  the phone shows no notifications: both change at 0.5.5's site update.
  *Accept:* with Linger closed and the phone locked, each kind arrives on a
  real Android phone and, through the TestFlight testers, an iPhone; a switch
  turned off stops it; "only mentions" lets only mentions through; Do Not
  Disturb holds them; a tap opens the right conversation; signing out stops
  them; and there's never a badge.

- 🟡 **#901 · The iPhone app kept a processor busy for as long as it was
  open** — Matt, 2026-11-16. Found from the nightly simulator runs failing
  one night in three. Since Tauri 2.12 (#836, 2026-11-03) the app asked
  for its windows on every event its main loop had, and on the iPhone a
  copy of a window wakes that loop, so it never slept: the main thread
  used a whole processor, in the simulator and on a phone, where it's heat
  and battery. No release has it; the TestFlight builds since 2026-11-03
  do. **Fixed:** the windows are asked for only when iOS brings a scene
  back (`phone_scene.rs`), and the simulator check now measures the app at
  rest (`scripts/app-at-rest.mjs`). **Left:** the TestFlight testers' word, after
  the next build, that the phone stays cool with Linger open.
  *Release notes, 0.5.5 (testers only, nobody else had it):* Linger on the
  iPhone no longer keeps the phone busy while it's open, which warmed it
  and used battery in the TestFlight builds since early November.
