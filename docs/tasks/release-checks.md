# Release checks HC-1…HC-9 (closed 2026-09-25)

These nine checks covered what automated tests could not prove: separate
computers, real networks, real installs and listening. **Matt closed all nine
on 2026-09-25** from real use of the published app with friends on Linux and
Windows. This file keeps the results and every original step, so a check can
be run again when its area changes. Voice will be rebuilt for large rooms in
#197, and that issue reruns HC-8 and HC-9 in full.

## Results

| Check | Result |
|---|---|
| HC-1 · an installed copy updates itself | ✅ Passed in real use. Installed copies updated themselves from the app and stayed signed in: Matt's Linux AppImage (0.3.4 → 0.3.5) and friends' Windows installs. |
| HC-2 · a window opens on all three operating systems | ✅ Linux and Windows, in real use. The macOS part is not done: there is no Mac build, on purpose ([decisions](../decisions.md)); it belongs to T-705. |
| HC-3 · a 400 MB video, for real | ✅ Closed by Matt's decision **without the 400 MB step**. Ordinary uploads work in real use; a 400 MB video surviving a dropped connection was not tried, and Matt judged it unnecessary for now. |
| HC-4 · a styled name in a room | ✅ Passed in real use (and locally, 2026-09-08). |
| HC-5 · the export button | ✅ Passed 2026-09-08 in real desktop clients. |
| HC-6 · a knock on a second computer | ✅ Passed in real use. |
| HC-7 · a DM on two computers, a third watching | ✅ Passed in real use (and locally, 2026-09-08). T-921, the outsider's "in a room" wording, is its own task and still open. |
| HC-8 · voice from a second computer | ✅ Passed in real use. |
| HC-9 · voice across two networks, through the relay | ✅ Passed in real use for two people on separate networks through the host's relay (first reported 2026-09-17; in daily use since). Not tried: a phone hotspot, the relay switched off, and four people on four networks for an hour. Those move to #197's re-test, which reruns every voice check when voice is rebuilt for large rooms. |

"Passed in real use" means Matt saw it work while using the published app with
friends. Unlike HC-5, the individual steps were not written down one by one.

## The original checks

Nine checks cover the promises that unit and server integration tests alone
do not establish. Desktop automation can open real windows, operate controls,
exchange messages and inspect browser downloads. Those parts can be taken on
as implementation tasks. HC-5 passed that way; eight checks remain open.

Separate computers, production domains, independent networks, physical audio
devices and listening still need the evidence each check names. Several
clients on one machine must be reported as such. The first five are ordered
so that doing the first one also covers parts of the second and third.
The [2026-09-08 evidence record](../desktop-check-results.md) distinguishes
completed checks from useful partial results.

---

### HC-1 · Cut a release and watch a machine update itself

*Closes M7's milestone check, and most of HC-2. The biggest one, and everything
it needs is already built.*

**0.3.1 preparation, 2026-09-21:** the four version sources and Rust lockfiles
move together to 0.3.1. [Release notes](../releases/0.3.1.md) collect the
packaged audio fix (PR #87) and composer, settings and message spacing fixes
(PR #91; issues #88, #89, #90 and #92). Issue #81 remains deferred. Matt
reported successfully updating the server and using the in-app updater to
reach 0.3.0; separate-computer and retained-sign-in details were not recorded,
so this does not close HC-1. The signed 0.3.1 packages must pass the runtime
audio checks before publication. Physical listening and network checks remain
open.
The combined package check exposed a recorder-start race: a short probe could
finish before recording began. Waiting for the recorder's first samples fixes
the controlled four-second-delay reproduction without changing app playback.

**0.3.0 preparation, 2026-09-21:** the four version sources and Rust lockfiles
move together to 0.3.0. [Release notes](../releases/0.3.0.md) cover the changes
since the published 0.2.0 tag and keep the open release checks explicit. A
WebKit persistence check now waits for saved panel widths before reloading;
the visible width can update before its storage effect completes. This starts
the next testing release; HC-1 still needs an installed copy on a separate
computer to update successfully while preserving its sign-ins.

This is the one thing no test can do: prove that a copy of Linger installed on
somebody else's computer can replace itself with a newer one.

**Before the first tag, once ever — two things:**

1. **Prove the container image builds on both chip types.** Go to the repo's
   *Actions* tab → *image* → *Run workflow*. It builds for regular PCs and for
   ARM (Raspberry Pi and similar) and pushes nothing. The ARM half has never
   been built, so if it is going to fail, this is where you want to find out —
   not on release day. It takes a while; ARM is built by emulation and is slow.
2. **Check the four version numbers agree.** Run `scripts/version-check.sh`. If
   it complains, bump all four files it names and commit that first.

**Then, the release itself:**

3. Tag it and push the tag:
   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```
4. Wait for *Actions* to finish. It builds a Windows installer and a Linux one,
   publishes the server image, and opens a **draft** release. Nothing is public
   yet — a draft is invisible to everybody.
5. **Make the container image public.** First time only. Go to
   `github.com/users/<you>/packages/container/linger/settings` and set the
   visibility to public. Skip this and every host's `docker compose up` fails
   with `unauthorized`, including yours.
6. Read the draft release, then press **Publish**. That is what makes it real.
7. **Install it on a machine that did not build it.** A second laptop, a
   virtual machine, a friend's PC — anything but your dev box. On Windows you
   will see *"Windows protected your PC"*; that is expected, click *More info*
   → *Run anyway* (see [`docs/decisions.md`](../decisions.md)).
8. Bump the version in all four files, commit, tag `v0.1.1`, push, wait, and
   publish that release too.
9. On the machine from step 7, open Linger → **settings → updates**. It should
   say a new version is waiting. Press install. It should download, replace
   itself, and come back as 0.1.1.

**Done when:** step 9 works. If it does not, the thing to look at first is
whether the signing key in the repository secrets is the mate of the public key
in `tauri.conf.json` — run the *release* workflow manually from the Actions tab
and it checks exactly that, without releasing anything.

---

### HC-2 · Watch a window open on all three operating systems

*Left over from T-002/T-003 (`docs/tasks/m0.md`). Was meant to close before M7.*

Steps 7 and 9 of HC-1 cover **Linux and Windows** — if the app opened, this is
two thirds done. What is left is **macOS**, and it cannot be done from a
release, because Linger deliberately does not build a Mac version yet
([`docs/decisions.md`](../decisions.md) says why).

**For the macOS third**, on a Mac, from a checkout:

```bash
cd client && pnpm install && pnpm tauri build
```

Then open the app it produces in `client/src-tauri/target/release/bundle/`.
macOS will complain that it cannot verify the developer — that is expected for
an unsigned build.

**Done when:** a window opens on all three, and you have seen it.

---

### HC-3 · Share a 400 MB video for real

*Closes M5's milestone check (`docs/tasks/m5.md`). Every piece is tested;
nobody has ever clicked `+ file` in a running app.*

Needs a real server on a real domain (see
[`docs/host-guide.md`](../host-guide.md)), not a local one — the point is the
network and the two domain names, which is where uploads actually break.

1. Sign in to your server from the desktop app.
2. Drag a **400 MB or larger video** into the message box. Watch the progress
   bar.
3. **Kill the network halfway** — turn wifi off and back on. The upload should
   pick up where it left off rather than starting again.
4. When it lands, check the message shows a **poster frame** (a still from the
   video), not a blank box.
5. Open **media** in the left rail. The video should be there. Star it.
6. Look at the **storage figure** in the status bar. It should have gone up by
   roughly 400 MB.
7. On a **second computer**, sign in as somebody else and check the video is
   there and plays.
8. Set a **status image** on one machine and check it appears on the other at a
   sensible size.

**Done when:** all eight work. If the upload fails but chat works, the `cdn.`
name is the first thing to check — see the host guide's troubleshooting.

---

### HC-4 · Watch a styled name go past in a room

*Left over from M6 (`docs/tasks/m6.md`).*

**Local desktop portion passed 2026-09-08.** Two isolated native clients
exchanged messages showing the selected gradient, font and shimmer. Screenshots
cover both themes, normalization, compact, IRC and a controlled evening hour.
The separate-machine/VM step below remains open; the names have now been seen
in a real room. [Evidence](../desktop-check-results.md).

1. Two computers (or one computer and a virtual machine), signed in as two
   different people.
2. On the first: **settings → how your name looks**. Set a gradient of two
   colors, a different face, and turn on shimmer.
3. Send a few messages.
4. On the second machine, look at the stream. The name should be drawn the way
   it was set, in colour, in that face.
5. Turn on **normalize everyone** on the second machine. Every name should go
   plain immediately, including in the stream.
6. Enable the desktop's reduced-motion preference. Shimmer should stop and
   glow should disappear. Density modes were removed on 2026-09-17.
7. Wait until after 7pm local time (or change the clock) and check the
   background goes slightly warmer, and that names are still readable.

**Done when:** you have watched a styled name scroll past in a real room.

---

### HC-5 · Press the export button

*Closes T-802 (`docs/tasks/m8.md`). The smallest one on this list.*

**✅ Passed 2026-09-08, Linux desktop development build, 0.1.0.** Real controls
built the archive and handed it to an isolated Chromium profile through the
native opener. An independent ZIP reader opened the room Markdown and image;
the recipient's DM was present and the outsider's archive omitted it. A second
click displayed the hour's cooldown. T-920 fixed the local URL failure found
on the first attempt. [Evidence and repeatable command](../desktop-check-results.md).

1. In the app: **settings → take everything with you**.
2. Press **export everything**. Watch the line underneath — it should count up.
3. When it says the archive is ready, press **download it**. Your normal
   browser should take the download.
4. Unzip the file. Open `rooms/<something>.md` in any text editor and read it.
   Open something in `media/`.
5. Press **export everything** again straight away. It should tell you, in
   words, roughly how long until you can ask again — not show an error.

**Done when:** you have read a room out of a zip that Linger did not open for
you. That is the whole promise of the feature.

---

### HC-6 · Hear a knock, on a second computer

*Closes M9's milestone check (T-1102). The newest one on this list, and the
only one not left over from V1.*

The knock was built and tested with one real client on one machine and a second
member knocking over the endpoint. That proves the card and the endpoint. It
does not prove the two things a second computer proves: that a knock crosses a
network, and that the sound is a sound you would want to hear.

1. Two computers, both signed into the same server as different people.
2. On one: open the other person's card in the roster and press **knock**.
3. On the other: a card should appear bottom-right, say who knocked, and go
   away by itself after about eight seconds. **Nothing should be left** — not in
   the stream, not on the roster, not anywhere.
4. **Do this outside 22:00–08:00**, or you will hear nothing and it will look
   broken. Quiet hours are on by default, which is the point.
5. Listen to it. It is two soft taps built out of an oscillator, not a recorded
   sound, and nobody has heard it on speakers yet. If it is annoying, say so —
   it is about twenty lines in `client/src/lib/sound.ts` and easy to change.
6. Press knock four times inside an hour. The fourth should say *"That's three
   this hour. Give them a bit."* rather than failing.

**Done when:** a knock has crossed two machines and you have heard it.

---

### HC-7 · Hold a DM on two computers, with a third watching

*Closes M11's milestone check (T-1301…T-1303). The same shape as HC-6 and for
the same reason: everything was verified with one real client and two scripted
sockets on one machine.*

**Local desktop content isolation passed 2026-09-08.** Three native windows
exercised the conversation, media, search and browser-downloaded exports.
The outsider found no private message or file. Its presence wording says
“in a room” rather than “around”; T-921 tracks that mismatch. The separate
computers and usability assessment below remain open.

1. **Three computers**, or two plus a phone browser you can sign in on — all on
   the same server, as three different people. Call them A, B and C.
2. On **A**: open B's card in the roster and press **message**. A `direct`
   section appears in the rail with B's name in it.
3. Say something. It should turn up on **B** immediately, in a conversation
   that appeared in their rail without them doing anything.
4. **On C, look for it.** There should be nothing: no `direct` section entry,
   nothing in `media`, nothing in `search` for a word only used in the DM. C's
   roster should show A as *around* — **not** "in a message with" anybody.
5. Share a file in the DM. Check `media` on B (it is there) and on C (it is
   not).
6. On **C**, press **export everything** in settings and open the zip. There
   should be no `direct/` folder in it at all.
7. On **B**, do the same. There should be `direct/<A's username>.md`, readable,
   with the conversation in it.

**Done when:** a DM has crossed two machines and a third person has looked for
it in four places and not found it.

---

### HC-8 · Hear somebody talk, from a second computer

*The first half of M12's milestone check (T-1402), and T-1404's "usable by
somebody who has not read anything". The other half — different networks —
is HC-9, and needs the relay from T-1403 running.*

The audio path has run end to end in one process (a tone in one engine comes
out of the other's speaker, over a real peer connection), the microphone and
speaker code has opened a real sound card, and there is a button. What it has
never done is carry a voice between two machines, or been pressed by anybody
who did not build it.

1. Two computers **on the same network** — the same wifi is fine. Start
   here even if the relay is running: it takes the network out of the
   question. Both signed into the same server as different people, both in
   the same room.
2. On each, press **Join Voice** under the room's name. Nothing else; if you
   had to look anything up, T-1404 has not met its criterion — say what.
3. Talk. The other machine should play it within a fraction of a second, and
   your name should come up to full weight on their screen while you do.
   Listen for a delay that grows over a minute — that is a clock drift the
   200 ms ceiling should be hiding, and if it is not, say so.
4. Press **mute**. The other side should hear nothing, and your name should
   drop back to rest on their screen. Unmute; it comes back.
5. Turn the other person down with the slider beside their name. Only your
   side changes.
6. In settings → voice, turn on **push to talk**, leave and join again. You
   should be silent until you hold `ctrl`.
7. Unplug one machine's headphones mid-sentence, then plug them back in (or
   let the sound move to the built-in speakers). **Audio should continue
   within a second or two** on whatever the system now uses (T-1405). If the
   line under the header says the microphone stopped, that means twenty
   seconds passed with no device coming back — say what you unplugged and
   what the OS did.
8. Close one app. On the other, the name should go within a few seconds, and
   the room should go quiet rather than hiss.

**Done when:** you have heard the other person, in the room, from a second
computer, without reading anything first. Write down the delay you noticed
and whether it grew.

---

### HC-9 · Talk across two networks, with the relay running

*The second half of M12's milestone check (T-1402), and T-1403's acceptance:
"two clients connect where at least one is behind carrier-grade NAT". This is
the one AGENTS §"Where you will be wrong" was written about, and nothing on a
dev box can stand in for it — the relay could not even be started there.*

Do HC-8 first; it takes the network out of the question.

**Partial field evidence, 2026-09-17:** a host on Omarchy and a friend on
Windows reported working two-way voice across separate networks through their
DigitalOcean-hosted setup, after removing the rejected coturn flag (T-1406).
Rooms, emojis, DMs and status also worked during that session. Carrier-grade
NAT, relay selection, device changes and the four-person hour were not
verified. HC-8 and HC-9 remain open.

1. On your real server, follow the host guide's *Voice between different
   networks*: a secret in `.env`, your address as the realm, the four ports
   open, `docker compose --profile voice up -d`. `docker compose ps` should
   list `coturn`, and `docker compose logs linger` should **not** say there
   is no relay.
2. Two computers on **different networks**: one at home, one on a phone's
   hotspot is the honest test, because a phone network is carrier-grade NAT
   and is exactly what a direct connection cannot cross.
3. Both press **Join Voice** in the same room. Within a few seconds the other
   person's name should be on your line without `connecting…` or `can't
   reach` beside it, and you should hear them.
4. Talk for **ten minutes**. Listen for dropouts and for a delay that grows.
5. Turn the relay off (`docker compose stop coturn`) and join again from the
   hotspot. **Expect it to fail** — `can't reach` beside the name — because
   that is the failure the relay exists to prevent, and seeing it once is how
   you will recognise it if it ever comes back.
6. Then the real one: **four people, four networks, one hour.** That is M12's
   milestone check and the only evidence that counts.

**Done when:** you have heard somebody on a phone network, through your own
relay, and the four-person hour has happened once. Write down what dropped.
