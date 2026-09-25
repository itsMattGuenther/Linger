# Install and use Linger

Linger is a small, private place for a group of friends to hang out. Somebody
you know runs the server; you install the app and connect to it.

**Joining for the first time? Ask your host for an invite link.** A server
address alone takes you to sign-in; it cannot create an account. If you are
setting up a new server yourself, keep the private setup link from the
[host guide](host-guide.md). Install the app on your own computer, not the VPS.

---

## Installing Linger

Open the [latest release](https://github.com/itsMattGuenther/Linger/releases/latest),
expand **Assets** if needed, and download **one** file from this table. The
current installers are for 64-bit Intel/AMD computers (`x64`, `x86_64` and
`amd64` mean the same thing here, including Intel PCs).

| Your computer | Download and next step |
|---|---|
| Windows | File ending in `x64-setup.exe` → [Windows](#windows) |
| Ubuntu, Debian, Mint | File ending in `amd64.deb` → [Linux packages](#linux-packages) |
| Fedora or openSUSE | File ending in `x86_64.rpm` → [Linux packages](#linux-packages) |
| Omarchy, Arch, or other Linux | File ending in `amd64.AppImage` → [AppImage](#linux-appimage-including-omarchy) |

You do **not** need `.sig`, `latest.json`, or the source-code ZIP/tar files.
The `.msi` is an alternative Windows installer, not an extra required download.
There are no macOS or ARM desktop installers yet.

### Windows

1. Open the downloaded `.exe` and follow the installer.
2. If SmartScreen says **Windows protected your PC**, check that the file came
   from the official release linked above. Our installer is not code-signed.
   If you choose to continue, use **More info → Run anyway**.
3. Open **Linger** from the Start menu. Use that same entry to reopen it later.
4. Continue to [Getting in](#getting-in).

### Linux AppImage (including Omarchy)

An AppImage is the app itself, not an installer. Open a terminal on **your own
computer**, paste these two lines, and press Enter. This example uses version
`0.3.0` saved in `Downloads`; substitute your actual filename if it differs.
Filenames are case-sensitive on Linux. Older downloads start with `linger`;
newer builds may start with `Linger`. Match the name in Downloads exactly.

```bash
chmod +x ~/Downloads/Linger_0.3.0_amd64.AppImage
~/Downloads/Linger_0.3.0_amd64.AppImage
```

The first line allows it to run; the second opens the window. You can close
the terminal after that — Linger keeps running. The first launch also adds
**Linger** to your application menu; use that to reopen it. You can still
start the same file from a terminal or the file manager. No Docker commands
are needed on your computer.

**No window?** Use [AppImage troubleshooting](#appimage-troubleshooting) below
for FUSE or graphics errors. Once the window opens, go to [Getting in](#getting-in).

### Linux packages

Open a terminal on your own computer and run the command for your distribution.
Replace the example filename with the one you downloaded.

Ubuntu / Debian / Mint:

```bash
sudo apt install ~/Downloads/Linger_0.3.0_amd64.deb
```

Fedora:

```bash
sudo dnf install ~/Downloads/Linger-0.3.0-1.x86_64.rpm
```

openSUSE:

```bash
sudo zypper install ~/Downloads/Linger-0.3.0-1.x86_64.rpm
```

Open **Linger** from your application launcher, now and whenever you want to
reopen it. Then go to [Getting in](#getting-in).

## Getting in

For a **new member**:

1. Ask the host for an invite, such as `https://linger.example.com/invite/CODE`.
2. Paste the **whole invite link** into **server or link** and press **continue**.
   Do not remove the invite code or anything after `?`.
3. Choose a username, display name, and password of at least eight characters,
   then join the server. These are new credentials for this server, not your
   Windows, Linux or GitHub password.

**Already have an account?** Enter the server address, such as
`https://linger.example.com`, then sign in with that server's existing
username and password.

**Making the host account?** Paste the entire private `/setup?token=…` link
from the server log. Follow [host guide step 6](host-guide.md#6-make-your-host-account).
Setup links work once and belong only to the host; send friends invites instead.

**Seeing a password-mismatch error before you've made an account?** You likely
entered only the server address. Go back and paste an invite link. There is
no public sign-up. If the invite has expired or run out of uses, ask the host
for a new one.

The app remembers you. On most computers your sign-in is kept in the system's
password store — the same place your browser keeps passwords — so you do not
type it again. If your computer has no password store, the app says so and asks
you to sign in next time.

You can be on **more than one server**. They stack up in the far-left rail and
each one is completely separate: separate account, separate friends, separate
everything.

You can stop reading and use the app now. The rest of this guide explains
features as you need them.

---

## AppImage troubleshooting

**An error mentions FUSE or `libfuse.so.2`:** install `fuse2` only if needed.
On Omarchy, run `omarchy pkg add fuse2`; on Arch, run
`sudo pacman -S fuse2`. Then retry the launch command. `fuse3` is not a
substitute for this library; do not uninstall it. For other distributions,
see [AppImage's FUSE instructions](https://docs.appimage.org/user-guide/troubleshooting/fuse.html).

**`Could not create GBM EGL display` and the app aborts:** Linux v0.3.3 and
newer set WebKit’s narrow GBM workaround automatically, for every package
format. An explicit `WEBKIT_DMABUF_RENDERER_DISABLE_GBM=0` still enables GBM.
For **v0.3.2 and earlier**, use this exact command with your downloaded filename:

```bash
WEBKIT_DMABUF_RENDERER_DISABLE_GBM=1 ~/Downloads/Linger_0.3.0_amd64.AppImage
```

This opened Linger on the tested Omarchy/Wayland computer. It changes only
this launch, not your system graphics settings. If it works for you, run that
full command once so the application-menu entry keeps the same setting; after
the window opens you can close the terminal. It is not required on every
Linux computer. If it still fails, keep the terminal error to share when
asking for help; leave setup tokens and invite links out of screenshots.

**The app closes on launch with `Error 71 (Protocol error) dispatching to
Wayland display`:** this happens on some NVIDIA computers running Wayland.
Releases after v0.3.3 set NVIDIA's workaround automatically. For v0.3.3 and
earlier, launch with this exact command, using your downloaded filename:

```bash
__NV_DISABLE_EXPLICIT_SYNC=1 ~/Downloads/Linger_0.3.3_amd64.AppImage
```

Like the GBM command above, it changes only this launch. Only NVIDIA's driver
reads it, so it does nothing on other graphics cards.

**Voxtype puts numbers or symbols into chat instead of your words:** v0.3.3
uses native Wayland automatically on Wayland desktops, alongside the graphics
workaround above. Older AppImages default to X11; on a Wayland desktop,
simulated typing can be corrupted before Linger receives it. If you explicitly
choose X11, that limitation still applies. Clipboard output and paste remain
a workaround for older builds or an explicit X11 launch.

With your existing Voxtype daemon running, start **one recording** from a
terminal on your computer:

```bash
voxtype record start --clipboard --no-auto-submit
```

Speak, then run:

```bash
voxtype record stop
```

Wait for transcription to finish, click Linger's message box, and press
**Ctrl+V yourself**. Review the draft before pressing Enter. This replaces your
clipboard contents, but does not change your normal dictation shortcut or
Voxtype settings. It uses Voxtype's
[per-recording output override](https://github.com/peteonrails/voxtype/blob/dev/docs/USER_MANUAL.md#voxtype-record).
Avoid automatic `--paste` for this workaround: its simulated Ctrl+V can also
hit the failing input path. Clipboard insertion is verified; a complete
spoken recording still needs your check.

Do not edit the extracted AppImage or change global graphics settings to fix
this. The packaging limitation and developer reproduction are tracked in
[Linux input checks](linux-input-checks.md).

**Testing v0.2.0 or newer on Wayland:** these versions accept
`LINGER_LINUX_BACKEND=wayland` before the AppImage command. The older
**v0.1.0 does not support this option**; use the clipboard workaround
above with that version. The developer check page records the test commands
and graphics limits. Native Wayland is opt-in through v0.3.2 and automatic on Wayland desktops
from v0.3.3. No desktop-wide setting needs to change.

---

## The window

Three parts.

- **The rail**, on the left: your servers at the top, then the rooms on this
  server. A room shows who is in it.
- **The stream**, in the middle: the conversation, and the box you type in.
- **The roster**, on the right: everyone on the server and what they are up to.
  On a narrow window, click **People** to open it. If the window cannot fit the
  left panel either, **Navigation** opens your servers, rooms and settings.
  Widening the window brings the side panels back automatically.

## Settings, and where they are

Click the **Settings gear** beside your name at the bottom of the left panel. The panel
has four sections:

- **Profile** — your display name, name styling and status
- **Appearance** — interface size, theme, evening warmth and name styling preferences
- **Sound & Voice** — notification chimes and quiet hours; microphone, speakers,
  push to talk
- **Account & App** — password, export, updates and sign out

Everything this guide calls *settings → something* is on one of those. **Close**
at the top right puts the room back.

**Too small?** Open **Appearance → Interface Size** and choose a larger scale,
up to 200%. Your saved choice applies throughout the app, including sign-in.
Drag a side panel's inner edge to change its width. Double-click the edge to
reset it. With a keyboard, Tab to the edge and use Left/Right; Home/End choose
the smallest/largest width. These choices are saved only on this computer.

Hosts have a **⋯** menu beside the selected server. Use **⋯ → Manage members** for
member removal and re-admission; ordinary member cards are for chatting and
knocking, not managing access.

## Saying things

Type and press **Enter**. **Shift+Enter** starts a new line instead of sending.

A little formatting works, the kind you already type:

```
**bold**    *italic*    ~~crossed out~~    `code`
> a quote
- a list
```

Paste a link and it becomes a link. Type `@` and someone's username to mention
them — that is the one thing that will interrupt them.

Hover over a message or use Tab to reveal its **⋯** button. Click it or press
Enter to open the message actions; Escape closes the menu and returns focus.

- **reply** — quotes what you are answering. **Escape** cancels it.
- **edit** — your own messages only. **Shortcut: press Up arrow in an empty box**
  to edit the last thing you said.
- **delete** — asks once, then it is gone

The **smile** on the right of the box opens a small set of ordinary emoji to
drop into what you are typing. Hover it for **Emoji**. There are no custom emoji.

There are no reactions on messages, for now. They are out as a trial: to answer
something, reply to it, emoji and all.

## Sharing files

Three ways, all the same thing: the **+** on the left of the box, then
**Add file…**, drag a file onto the box, or paste one from your clipboard.
Hover **+** for **Add**.

Click a posted image to expand it. It stays centered and fits the window, even
when you resize it. Press **Escape**, click the preview, or choose **close** to
return to the conversation.

For other files, **download in browser** opens your system browser. It may save
straight to Downloads rather than ask where to save. Check its downloads list.
If nothing happens or Linger reports a failure, retry or copy the displayed
link into your browser. A file may have expired; a browser error is not a
successful save. Treat download links as private, especially for DM files.

- Up to 500 MB per file.
- **Location data is stripped from every photo, always.** Phone cameras record
  where a picture was taken, and Linger removes that before anyone else sees it.
  There is no setting for this and no way to turn it off.
- Files may be deleted after a while — a year, unless whoever runs the server
  chose differently. **Starring a file keeps it forever.**

## Talking

Voice happens in a room, not in a call. There is nothing to ring and nobody to
invite: you are already in the room, and **Join Voice** under the room's name
turns your microphone on there. The line under the header then says who is in
voice. Names stay readable; whoever is speaking has their name turned over,
drawn on a small block of their own color. Your own name comes first, without a visible
“you” label; screen readers still identify it.

While you are in:

- **mute** stops sending, instantly, and nobody else can change it. Nobody can
  mute you either, and nobody can turn your microphone on.
- **deafen** silences incoming voice and mutes your microphone together.
  **undeafen** restores your previous mic choice; with push-to-talk, press
  `ctrl` again to speak. Deafen does not change notification sounds.
- A crossed-out microphone beside a name means that person is muted, and
  crossed-out headphones mean they are deafened, when they share their state.
  Hover the symbol for the word.
  **mic state unknown** means their client or the server needs an update.
  An unmuted microphone is not a guarantee somebody is listening.
- Click a voice participant's name to adjust **how loud they are for you**.
  This computer remembers the level for that person on this server, across
  restarts and reconnects. Their other sessions use the same level.
  Right-click or keyboard activation works too. This never leaves your computer.
- The **chevron beside Voice** collapses the participant strip without hiding
  your voice controls. It does not hide the People sidebar.
- **leave voice** turns the microphone off. Closing the app does too.

Opening Settings, Media or another room does not end voice. A small strip keeps
your voice controls visible and names the room; click its name to return.

Moving voice to another room keeps your mute/deafen choices. Leaving and
joining starts a fresh session. Your per-person volume settings are unaffected
by deafen, and missed speech is discarded rather than played when you return.

**Push to talk** is in Settings → Sound & Voice. With it on, every call starts muted and
the microphone is open only while you hold `ctrl`, including in Settings.
Leaving the room view or switching away from the app releases a held key;
press it again to speak. It is off by default because
a room you leave running is the point, and a key you have to hold is the
opposite of that.

Which microphone and speakers to use is also in Settings → Sound & Voice. A change
applies the next time you join. If a device you picked is not plugged in, the
system default is used and the picker says so.

**Nothing is recorded.** Not by the server, not by anybody's app, not "for
transcription". Audio goes between the people in the room, and the server's
whole part is introducing them.

Two things to know today: voice between computers on **different networks**
needs the host to run the relay (the host guide says how), and if your
headphones come unplugged mid-sentence, Linger moves to whatever your computer
now uses within a second or two. If nothing comes back for twenty seconds the
line under the room's name says the microphone stopped, and you join again.

## Talking to one person

**Direct messages.** Open somebody's name in the roster and press **message**. A
*direct* section appears in the rail with their name in it, and the conversation
works exactly like a room — except only the two of you can see it, anywhere:
not in media, not in search, not in anybody else's export. There is no way to
add a third person later; a different set of people is a different
conversation.

**Knocking.** On the same card, **knock** is a tap on the shoulder: the other
person sees a small card for eight seconds, then it is gone. Your button says
**knocked** for three seconds, then returns to **knock**; that confirms the
request, not that they saw it. There is no message and nothing for them to
answer. Three an hour per person, so it stays a tap. A soft sound accompanies
the card unless sounds are muted or quiet hours are on (22:00–08:00 on this
computer's clock). Quiet hours are off until you turn them on. They silence
the sound, not the card.

## Finding things again

Open **search** from the rail (or press **Ctrl+K**, **Cmd+K** on a Mac). Type a
word; you get the messages that contain it and the files whose names do, newest
first, and you can narrow to a room or a person. Pressing a result takes you to
that message in its room, however far back it is, with a **back to the newest**
link in the header to come home again.

Open **Media** from the rail. It collects things shared in conversations you
can access — pictures, video, audio, files and links — newest first, filterable by type and
by person. Every item links back to the moment it was posted.

The star does two jobs: it sorts things to the top, and it stops a file from
expiring automatically. Choose **Star** to keep a file; Linger confirms when
the server accepts it. Images keep their full shape in the collection. Click
an item to return to its conversation.

## What the roster is telling you

Next to each person:

- **in a room** — they are in that room right now
- **around** — the app is in front of them, but not in a room
- **idle** — no typing or clicking for ten minutes
- **away** — they set an away message on purpose
- **offline** — the app is closed

Click or right-click a name in the People sidebar to open their profile and
status. Message and Knock sit together at the bottom of that panel. Press
Escape or click outside it to close it.

## Your status

Click your own name in the roster, then **Edit status**. There is a line in your own
words, plus three optional fields: *reading*, *listening to*, *working on*. You
can put one image on it.

Open **Preview your status** to check the draft. Other people see the change
only when you press **save**.

There is also an **away message**. Setting one is what makes you away, and it
shows instead of your status. Clearing it brings you back.

## Making your name yours

**Settings → Profile → Make Yourself At Home.** This is the fun part, and it is what everyone
else sees next to everything you write.

- a **face** (one of twelve fonts) and a **weight**, plus italic
- a **color**, or two colors blended, from a fixed set of sixteen
- an **effect** — a shimmer or a glow, or nothing
- optionally, a **font for your messages** too

The sixteen colors are the same for everybody, and every one of them is readable
on every background. You cannot pick something nobody can read.

The sample message previews your choices without posting anything. **Reset
changes** returns to your saved look; **Save your look** publishes it.

## Making it comfortable to read

Also in settings:

- **Interface Size** — enlarge text and controls from 100% to 200%. The default
  layout is comfortable; there are no density modes to choose between.
- **Theme** — dark, light, or follow your desktop.
- **Evening warmth** — after about 7pm the colors go slightly warmer, the way a
  room does when the lamps come on. It is subtle. You can switch it off.
- **Normalize everyone** — turns off other people's name styling and message
  fonts, for you only. Nobody is told. Use it if a room is too loud to read.

## Being interrupted, or not

Desktop banners appear for **somebody naming you** — or a
person you have specifically asked to hear about. Open **Settings → Sound &
Voice → Desktop Notifications** to choose those people, either everywhere or
in selected rooms.

For chimes, open **settings → sound & voice**. Voice-session joins, leaves and
moves, mute/deafen changes, DMs and knocks have sounds by default. Ordinary
room-message sounds start off. Turn each category on or off, press **play**
beside it to preview, or use **Mute all notification sounds**. Play always
sounds, even during quiet hours or with a category switched off, so you can
hear what you are choosing. Quiet hours, when you turn them on, silence
*live* chimes between 22:00 and 08:00 on your computer's clock.

Messages you are already reading, your own messages, reconnect replay and
push-to-talk presses do not chime. These switches do not silence voice chat;
use **deafen** for that. Muting chimes keeps visual notifications visible.

There are **no unread badges and no counters** anywhere in Linger. That is
deliberate. Nothing is keeping score of what you have not read, so nothing can
make you feel behind. When you come back, the stream shows a **go to where you
left off** marker. Opening a room or DM with new messages returns to that
line automatically. Caught-up rooms open at the bottom. There is no catch-up
button or band; **back to the newest** skips ahead. Search results still open
on the message you selected, and new arrivals do not pull you away from
earlier messages you are reading.

## Taking everything with you

Any member can ask the server for a copy of **everything on it** — every
message, every file — at any time. You do not need the host's permission, and
there is nothing to ask for.

What you get is a single zip. Inside it: one plain text file per room in the
order things were said, a `media` folder with every file anybody shared, and an
index listing who shared what and when. It opens with an ordinary text editor
and an ordinary file browser. **You do not need Linger, or an account, or the
server to still exist**, which is the entire point.

**Settings → Account & App → Take Everything With You.** Press the button, wait — it takes a
moment on a busy server — then press *download it*. The file opens in your
normal browser's downloads, like anything else you download.

You can ask for one an hour. If you ask again too soon the app tells you when
you can come back.

## Updates

1. Open **Settings → Account & App → Updates**.
2. Press **check again**. The panel shows your version and whether a newer
   release is available.
3. When you are ready to close the app, choose **install and restart** if
   offered. Nothing downloads or installs until you choose it.

If this copy cannot update itself, or an update fails, download the newer
installer/AppImage from [Releases](https://github.com/itsMattGuenther/Linger/releases/latest)
and use the installation steps above. Close the old app first. For an
AppImage, make the new file executable and launch that file, not the old one.
Do not delete your account or application data to update.

A code push to GitHub is **not a release**. New downloads appear when a
desktop release is published. Updating your app also does not update the
server: the host follows the [server update steps](host-guide.md#updating-the-server).

The in-app updater is implemented, but its full real-machine upgrade check
is still open ([HC-1](../TASKS.md#hc-1--cut-a-release-and-watch-a-machine-update-itself)).

## Signing out

**Settings → Account & App → sign out.** That forgets the server on this
computer. Your account and everything in it stays exactly where it is.

To change your password, use **Settings → Account & App → Password**. If you have forgotten it,
ask whoever runs the server — they can set you a new one.

---

## Worth knowing

**Whoever runs the server can read everything on it.** There is no end-to-end
encryption in Linger, and it does not claim any. Messages are encrypted while
they travel across the internet, and they sit in a database on someone's
machine. That person is your friend, which is the whole idea — but it is a
different promise from Signal, and you should know which one you are getting.

**Nothing is collected about you.** No telemetry, no analytics, no crash
reports. Not anonymous ones either. There is nothing to opt out of.
