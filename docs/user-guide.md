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
| Omarchy or Arch | Nothing to download → [Arch and Omarchy](#arch-and-omarchy) |
| Any other Linux | File ending in `amd64.AppImage` → [AppImage](#linux-appimage) |
| An Android phone | File ending in `android-arm64.apk`, on the phone → [Android](#android) |

You do **not** need `.sig`, `latest.json`, or the source-code ZIP/tar files.
The `.msi` is an alternative Windows installer, not an extra required download.
There are no macOS or ARM desktop installers yet, and no iPhone app.

### Windows

1. Open the downloaded `.exe` and follow the installer.
2. If SmartScreen says **Windows protected your PC**, check that the file came
   from the official release linked above. Our installer is not code-signed.
   If you choose to continue, use **More info → Run anyway**.
3. Open **Linger** from the Start menu. Use that same entry to reopen it later.
4. Continue to [Getting in](#getting-in).

### Arch and Omarchy

Linger has its own package for Arch-based systems. You set it up once, and
after that Linger updates with the rest of your system: **Update** in the
Omarchy menu, or `sudo pacman -Syu`. It is also faster than the AppImage on
many computers, because it uses your system's WebKit, which can draw with the
graphics card (the AppImage's older copy often can't).

Open a terminal and paste this line:

```bash
curl -fsSL https://raw.githubusercontent.com/itsMattGuenther/Linger/main/packaging/arch/setup.sh | bash
```

It asks for your password once. It trusts Linger's package signing key,
adds Linger's package repository to pacman, installs Linger, and removes the
menu entry an old Linger AppImage left behind. Then open **Linger** from your
application menu and go to [Getting in](#getting-in). You stay signed in if you
used the AppImage before; you can delete the old `.AppImage` file.

If you'd rather see each step, this is all the script does:

```bash
curl -fsSLO https://github.com/itsMattGuenther/Linger/releases/download/arch/linger.asc
sudo pacman-key --add linger.asc
sudo pacman-key --lsign-key A539799132574CE3EB51B01AB5FA9838135B10DF
printf '\n[linger]\nServer = https://github.com/itsMattGuenther/Linger/releases/download/arch\n' | sudo tee -a /etc/pacman.conf
sudo pacman -Sy linger
```

To remove it later: `sudo pacman -R linger`, then delete the `[linger]` lines
from `/etc/pacman.conf`.

### Linux AppImage

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

### Android

The phone app is on the release page from 0.4.8, until it's in the Play
Store. It's for seeing who's around and answering them: rooms, DMs, your
status, media, search, pictures and voice messages. It doesn't join voice
rooms, and it never shows a notification, open or closed (when you open it,
it catches up).

1. On the phone, open the
   [latest release](https://github.com/itsMattGuenther/Linger/releases/latest)
   and download the file ending in `android-arm64.apk`.
2. Open it from the download. Android says it won't install apps from your
   browser: tap **Settings**, turn on **Allow from this source**, and go back.
   That's Android's rule for any app that isn't from the Play Store.
3. Tap **Install**. If Play Protect asks, it's because it hasn't seen this app
   before; choose to install anyway.
4. Open **Linger**, then continue to [Getting in](#getting-in): an invite link
   opened on the phone works the same way.

**It doesn't update itself.** For a new version, download the new `.apk` from
its release page and install it over the old one. You stay signed in. Every
release is signed with the same key, which is what lets it install over the
last one; if Android ever says the app "conflicts with an existing package",
it isn't from this project's release page.

## Getting in

For a **new member**:

1. Ask the host for an invite, such as `https://linger.example.com/invite/CODE`.
2. Paste the **whole invite link** into **Server or link** and press **Continue**.
   Do not remove the invite code or anything after `?`.
3. Choose a username, display name, and password of at least eight characters,
   then join the server. These are new credentials for this server, not your
   Windows, Linux or GitHub password.

**Already have an account?** Enter the server address, such as
`linger.example.com`, then sign in with that server's existing username and
password. You don't need a new invite: an invite makes a new account.
Linger always connects securely, so `http://` or `https://` in front of the
address makes no difference.

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

You can be on **more than one server**: open Settings (the gear), then **Account
& App → Add a server** (with several servers, it's under **Servers**). Each
server becomes a folding section of your list, and each one is completely
separate: separate account, separate friends, separate everything.

You can stop reading and use the app now. The rest of this guide explains
features as you need them.

---

## AppImage troubleshooting

**An error mentions FUSE or `libfuse.so.2`:** install `fuse2` only if needed.
On Omarchy, run `omarchy pkg add fuse2`; on Arch, run
`sudo pacman -S fuse2`. Then retry the launch command. `fuse3` is not a
substitute for this library; do not uninstall it. For other distributions,
see [AppImage's FUSE instructions](https://docs.appimage.org/user-guide/troubleshooting/fuse.html).

**`Could not create GBM EGL display` and the app aborts:** open Linger again.
Linger notices that the last launch stopped before it drew anything and turns
WebKit's GPU path (GBM) off while that WebKit is installed. To try the GPU path
again later, delete the `gbm-off-…` file in `~/.local/state/linger/`. Setting
`WEBKIT_DMABUF_RENDERER_DISABLE_GBM` yourself (`1` off, `0` on) always wins.
v0.3.5's AppImage hit this once after updating on NVIDIA + Wayland machines;
newer AppImages don't try the GPU path at all.

**Typing or scrolling feels a beat behind:** the AppImage keeps WebKit's GPU
path off, because the WebKit it carries can't use it on some graphics setups,
and without it every frame arrives a beat late. The `.deb` and `.rpm` packages
use your system's WebKit and keep it on. On Omarchy or Arch, install the Arch
package instead of the AppImage for the same result.

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

## The list

Linger is one tall window: your **list**. From the top:

- **You**: your name, where you are, and your status. Click the status to
  change it. **Away** sets an away message (more below).
- **Rooms**: each with the dots of who's in it, and a speaker when people are
  talking there. A room's name turns bold when something new is said. On a
  server with more than eight rooms, the quiet ones fold under **More rooms**.
  Group DMs sit after the server's rooms, named by who's in them, and the
  **+** on the **Rooms** heading starts one.
- **People**: everyone on the server, with where they are and their status.
  Your DM with somebody lives on their row, which lights up when they've
  written something you haven't read. The people you're talking to come first.
  **Away** and **Offline** fold up under them.

Click a room or a DM and it opens **beside the list**, in the same window: the
window grows to the right to make room (to the left if your screen ends
there), and the list and the conversation move, snap and minimize together.
Each conversation gets a tab; **Ctrl+Tab** moves between them and **Ctrl+W**
closes one. The fold button at the conversations' left edge folds the window
back to just your list and keeps your tabs; the button beside the gear
brings them back. Closing the last tab folds it too.

Drag the line between your list and the conversations to make the list wider
or narrower. The window stays the same size, and Linger remembers the width.
Double-click the line to put it back.

On a tiling desktop like Hyprland, the desktop decides how big a window is,
so Linger's doesn't grow or shrink. If its tile is too narrow for both, the
conversation takes the whole window and the fold button takes you back to
the list. Float the window if you'd like the slim list back.

The pop-out button in the title bar (a box with an arrow leaving it) puts a
tab in a window of its own, and the same box with the arrow coming in,
**Back beside your list**, puts it back. If you'd rather every conversation had its own window, choose
that in **Settings → Windows**.

At the foot of the list are **Media** and **Search**. Each opens as a tab
beside the list, like a conversation (**Ctrl+K** opens Search from anywhere),
and pops out into a window of its own the same way. When you're in voice, the
voice bar sits just above them.

**Closing the list doesn't quit Linger.** It keeps running in the tray (the
little door icon near your clock), so voice, knocks and notifications carry
on. To bring the list back, choose **Show Linger** from the tray icon's menu
(on Windows, a click on the icon does it too), or just open Linger again. The
same menu has **Mute**, **Leave voice** and **Quit Linger**. To make closing the list
quit instead, open **Settings → Windows → When You Close Your List**. On a
Linux desktop with no tray, closing the list always quits.

The first time you close the list, Linger says where it went in a
notification, and whether you're still in voice. It says it once on each
computer, and never again.

**On Windows 11 the icon starts out hidden** under the **^** by the clock.
Windows doesn't let an app put its own icon in sight, but you can: open
**Settings → Personalization → Taskbar → Other system tray icons** and turn
**Linger** on. Or drag the icon out from under the **^** onto the taskbar.

Several servers? Each is a section of the list with its own rooms and
people. Click its name to fold it, and use its **⋯** for **Quiet** (no sounds
or arrival cards from it, though somebody naming you still gets a banner) and
to move it up or down.

The list may also show a line at its foot, only while it's true: a server it
can't reach, a computer that can't remember your sign-in, or a new version of
Linger with **Update…**.

If one of your servers is down when Linger starts, the others open anyway. The
one that's down stays signed in and shows as "Can't reach … Still trying." at
the foot of the list, with **Try now**; it joins the list by itself when it
answers. If none of your servers answers, Linger says so rather than asking you
to sign in again.

## Settings, and where they are

Click the **gear** at the top of the list, or press **Ctrl+,** in any window.
Settings opens in its own window:

- **Profile**: your display name, your status, and how your name looks
- **Appearance**: interface size, and plain names (below)
- **Windows**: tabs or a window per conversation, and what closing the list does
- **Sound & Voice**: how loud Linger's sounds are, notification chimes and
  quiet hours; microphone, speakers, push to talk
- **Notifications**: desktop banners, and whose messages you want them for
- **Account & App**: password, export, updates, starting Linger when you sign
  in to the computer, adding a server, and signing out
- **Servers** (with more than one): their order, Quiet, and signing out of one

Everything this guide calls *Settings → something* is one of those.

**Too small?** Open **Appearance → Interface Size** and choose a larger size,
up to 200%. Every window follows, including the sign-in screen. It's saved
only on this computer.

**Hosts** also see a **Hosting** group in Settings: **Rooms**, **Invites**,
**People** (removing and re-admitting members) and **Server** (its name and
color).

## Saying things

Type and press **Enter**. **Shift+Enter** starts a new line instead of sending.
Something half-typed stays in its conversation's box, even if you close the
tab or quit Linger, until you send it. A message can be up to 8,000 characters.
One longer than twenty lines shows its first twenty with **Show all** under
them, so a long paste doesn't fill everybody's screen.

A little formatting works, the kind you already type:

```
**bold**    *italic*    ~~crossed out~~    `code`
> a quote
- a list
```

Paste a link and it becomes a link.

To mention somebody, type `@` and start their name or their username. A list
of people opens by the box: **Up** and **Down** move through it, **Enter** or
**Tab** (or a click) puts them in, and **Escape** closes it and keeps what you
typed. With the list open, Enter never sends. In a room the list has everyone on
the server, the people in the room first; in a DM, only the people in it. A
mention is the one thing that will interrupt someone.

In messages, a mention shows the person's name as it is now (`@Justin B`).
Hover it to see their username, which is what the message keeps.

Hover over a message or use Tab to reveal its **⋯** button. Click it or press
Enter to open the message actions; Escape closes the menu and returns focus.

- **Reply**: quotes what you're answering. The **×** beside the quote cancels it.
- **Edit**: your own messages only. **Shortcut: press Up arrow in an empty box**
  to edit the last thing you said.
- **Pin** (or **Unpin**): anyone can pin a message, and it gets a small pin
  after its words, or beside the picture, file, voice message or link card when
  it has no words. Media's **Pinned** filter collects them, and a file on a
  pinned message never expires.
- **Delete**: asks once, then it's gone.

Click anybody's name in a conversation to open their card, with **Message**
and **Knock**. Your own name opens your card, as friends see it.

The **smile** on the right of the box opens a small set of ordinary emoji to
drop into what you are typing. Hover it for **Emoji**. There are no custom emoji.

There are no reactions on messages, for now. They are out as a trial: to answer
something, reply to it, emoji and all.

## Sharing files

Three ways, all the same thing: the **+** in the message box, drag a file onto
the box, or paste one from your clipboard.

Files wait above the box until you send, one line each, with a **✕** to take
one out. A picture shows a small copy of itself there, so you can see it's the
right one before it goes. Other files, and pictures Linger can't show, get
the file icon.

Pasting works for pictures too. Copy one (take a screenshot to the clipboard,
use **Copy** in an image viewer, or **Copy Image** in a browser), click the
message box and press **Ctrl+V**. The picture joins the message as a file,
just as if you'd picked it with **+**, named for when you pasted it
(`pasted-image-2026-09-28-143005.png`). Whatever you'd typed stays put.

Some copies hold a picture and words together: a browser's **Copy Image**
also copies the picture's address, and some programs, spreadsheets among
them, copy what you selected both ways. Pasting one of those adds the picture
and leaves the words out, as Discord does. Copied words on their own paste as
words.

Click a posted image to expand it. It stays centered and fits the window, even
when you resize it. Press **Escape** or click it to go back.

Audio files play right in the conversation. Press **Play**, drag along the
line to move through it (or use the arrow keys), and set how loud it plays
with the slider beside the speaker; the speaker mutes it. Linger remembers
that level on this computer for the next file. Videos play with their own
controls.

Your keyboard's media keys, and other programs that pause "all media" (some
dictation tools do, while you talk), can pause a song or video that's playing
and resume it afterwards. They never start one you paused yourself, or one
nobody played.

For other files, **Download** hands the file to your browser, which may save
it straight to Downloads without asking; Linger says so when it has. If it
fails, **Try again**. A file may have expired. Treat download links as
private, especially for DM files.

- Up to 500 MB per file.
- **Location data is stripped from every photo, always.** Phone cameras record
  where a picture was taken, and Linger removes that before anyone else sees it.
  There is no setting for this and no way to turn it off.
- Files may be deleted after a while — a year, unless whoever runs the server
  chose differently. **Starring a file keeps it forever.**

### Voice messages

Rather say it than type it? Press the **microphone** beside the **+** in the
message box. A panel opens over the box:

1. Press **Record** when you're ready. Lines move with your voice, and the
   time counts up.
2. Press **Stop** when you're done. Stopping never sends anything.
3. Press **Play** to hear it back.
4. **Send voice message** sends it to the conversation. **Discard** throws it
   away.

It's a press, not a hold, so you can let go of the mouse while you talk. A
voice message runs up to five minutes; at five minutes Linger stops recording
by itself and keeps what you have, to hear back and send. Nothing leaves your
computer until you press Send.

Linger records from the microphone you picked in **Settings → Sound &
Voice**, or your computer's default. If you move to another conversation
while recording, it stops, and the clip waits in the one you recorded it in.

A voice message shows in the conversation with a microphone, a play button
and its length, and everyone can play it, whatever they're on, phone or
computer. On the phone it works the same way. The first time you press
**Record** there, Android asks whether Linger may use the microphone. It
uses it for voice messages and nothing else.

## Talking

Voice happens in a room, not in a call. There is nothing to ring and nobody to
invite. In a room's tab, the line under its name says who's talking there:
press **Join** (or **Start talking** when nobody is) to turn your microphone
on in that room. Already talking in another room? **Move voice here** (or
**Talk here instead**) takes you there.

While you're in, the **voice bar** at the bottom of your list shows the room,
who's in it (whoever is speaking lights up), and your controls, as symbols
(hover one for its name): a microphone, headphones, and an arrow leaving a
box. The same three sit at the end of the room's voice line in its chat
window, so you don't need the list in front to mute:

- **Mute** (the microphone) stops sending, instantly, and nobody else can
  change it. Nobody can mute you either, and nobody can turn your microphone
  on. While you're muted, the microphone is crossed out and lit.
- **The host can take somebody out of voice**: somebody who walked away with
  their microphone on, say. Click their name in the voice bar (or open their
  card and its **···**) and choose **Take out of voice**. They leave the call
  as if they'd pressed Leave, their app says the host took them out, and they
  can join again whenever they're back.
- **Deafen** (the headphones) silences incoming voice and mutes your
  microphone together. Pressing it again restores your previous mic choice.
  Deafen doesn't change notification sounds.
- A crossed-out microphone beside a name means that person is muted, and
  crossed-out headphones mean they're deafened, when they share it. Hover
  the symbol for the word. An unmuted microphone is not a guarantee somebody
  is listening.
- **Leave voice** (the arrow) turns the microphone off. Quitting Linger does
  too; closing the list doesn't, since Linger keeps running in the tray.
- Click someone's name in the voice bar to set **how loud they are for you**,
  from silent to twice as loud. Linger remembers it for that person on this
  server, on this computer only; nobody else hears or sees the change.
- The arrow beside the room's name opens its conversation.

With the list tucked away in the tray, the tray icon's menu has **Mute** and
**Leave voice**.

**Push to talk** is in **Settings → Sound & Voice**. With it on, your
microphone is open only while you hold the **talk key**: **Right Ctrl** unless
you pick another under **Talk key** (press **Change**, then the key). The
voice bar says which key to hold. Not holding it isn't muting, so nobody sees
a crossed-out microphone beside your name; they hear you, and see you light
up, while you hold it. **Mute** is still there, and the key doesn't undo it.
The shortcuts use the left Ctrl, so they never open your microphone.
Switching away from Linger releases a held key; press it again to speak.
Turning it on or off, or picking a new key, works straight away, even in the
middle of a call: turned off, your microphone opens, unless you'd muted
yourself. It's off by default, because a room you leave running is the point,
and a key you have to hold is the opposite of that.

Which microphone and speakers to use is also in **Settings → Sound & Voice**.
Linger's own sounds (chimes, knocks, the voice and mute sounds) come out of the
speakers you pick too, in a call and out of one. A change applies at once,
even in the middle of a call: you carry on talking
through the new device without leaving. If a device you picked isn't plugged
in, or won't open, the system default is used so you can still talk. The
picker marks one that isn't plugged in. If the microphone you picked is
plugged in but won't open (another program holding on to it, say), the voice
bar says so, with your computer's reason, for as long as you're on the
default.

**If voice won't start**, the room's voice strip says why, where it would
say who's talking. Click it for the whole reason, including your computer's
own words for what failed, with a **Copy** button for sending it to your
host. Joining needs a microphone and speakers that both open.

First, pick your microphone and speakers by name in **Settings → Sound &
Voice**, instead of leaving them on the system default. That's the likely
fix: the default can point at something that won't open, like an unplugged
jack, a monitor or an old headset. When the default is what failed, the
strip has a **Pick yours in Settings** button that opens Sound & Voice for
you.

Second, on Windows, check Windows' own privacy switch for the microphone,
which Linger can't turn on for you. If Discord or another desktop app can use
your microphone, it's already on.

- Windows 10: **Settings → Privacy → Microphone**, then turn on **Allow apps
  to access your microphone** and **Allow desktop apps to access your
  microphone**.
- Windows 11: **Settings → Privacy & security → Microphone**, then turn on
  **Microphone access** and **Let desktop apps access your microphone**.

Then press **Start talking** again.

**Voice goes through the server.** Your voice goes to the server once and the
server passes it on to everyone else in the room, which is what lets a room of
up to 25 talk at once. The host has to turn it on. On a server where they
haven't, a room's voice line says **Voice isn't set up on this server**
instead of offering to start. Linger 0.4.0 and older sent voice straight to
each person, a way that is gone now, so people on those versions need to
update to talk. A server that hasn't been updated either may still send a
call that old way, and then the voice line says the server needs an update.

**Voice rooms are never recorded.** Not by the server, not by anybody's app,
not "for transcription". The server passes voice along without keeping it; the
person who runs it could listen, the same way they could read messages, and
Linger says so rather than pretending otherwise. (A voice message is something
else: a clip you record yourself and choose to send. See
[Voice messages](#voice-messages).)

Two things to know: on a network that blocks voice (some offices and public
wifi), you need the host to run the relay (the host guide says how), and if
your headphones come unplugged mid-sentence, Linger moves to whatever your computer now uses
within a second or two. If nothing comes back for twenty seconds, the voice bar
says the microphone stopped, and you join again.

## Talking to one person

**Direct messages.** Click somebody in **People**: they open beside the list,
their card on top and your conversation with them underneath. When somebody
writes to you, their row lights up until you've read it, and the people you're
talking to sit at the top of each group, so they're easy to find on a busy
server. Clicking someone else replaces that tab until you type in it, so
you can look around without collecting tabs. The **+** beside **Rooms** starts
a conversation with several people, and those sit with the rooms. The
conversation works exactly like a room,
except only the people in it can see it, anywhere: not in media, not in search,
not in anybody else's export. There's no way to add someone later; a different
set of people is a different conversation.

**Knocking.** On their card, or the small button when you hover their row, **Knock** is a tap on the shoulder: the other
person's list rocks side to side and a small card says who knocked, for eight
seconds, then it's gone. Their row in your list gives a little shake. That
confirms the knock went, not that they saw it. With reduced motion turned on
in your system settings, nothing moves; the card still shows. There is no message and nothing for them to
answer. Three an hour per person, so it stays a tap; after the third, the card
says when you can knock again. You can't knock on somebody who's offline:
Knock stays greyed out and says so ("Can't knock while Jen is offline.")
until they're back. A one-to-one DM has Knock at the top too, and it says the
same things there. A soft sound accompanies
the card unless sounds are muted or quiet hours are on (22:00–08:00 on this
computer's clock unless you move them). Quiet hours are off until you turn them
on. They silence the sound, not the card.

## Finding things again

Open **Search** from the foot of the list, or press **Ctrl+K** in any window.
Type a word; you get the messages that contain it and the files whose names do,
newest first, and you can narrow to a room or a person. Pressing a result opens
that message in its conversation, however far back it is, with **Back to the
newest** to come home again.

Open **Media** from the foot of the list. It collects things shared in
conversations you can see (pictures, video, audio, files and links), filterable
by type, person and date. Every item links back to the moment it was posted,
and the line above the grid says how long the server keeps files and how full
it is.

The star does two jobs: it sorts things to the top, and it stops a file from
expiring automatically. Choose **Star** to keep a file; Linger confirms when
the server accepts it. Images keep their full shape in the collection. Click
an item to return to its conversation.

## What the list is telling you

Next to each person, a dot in their color and a few words. Somebody who's
here has their name in their own style and a bright dot. When they're idle,
away or offline, the lights are off: their name turns a plain grey, and the
dot tells you which. It's dimmed for idle, a dimmed moon for away, and just
an outline for offline.

- **in a room** — they are in that room right now, or in its voice
- **around** — the app is in front of them, but not in a room
- **idle** — no typing or clicking for ten minutes
- **away** — they set an away message on purpose
- **offline** — the app is closed

Being in a room's voice counts as being in that room, even with a game in
front of you and Linger behind it: you show in the room, and you're never
"idle" while you're in its voice. Reading another room while you talk, you
show in both. An away you set still shows.

Their colors come back the moment they're around or in a room again. An away
message keeps its warm color, since it's there for you to read.

Hover someone to see their whole status. Click them to open them beside the
list: their card, with **Knock**, above your conversation with them. Clicking a
name in a conversation opens just their card, with **Message** and **Knock**;
press Escape or click outside it to close it.

## Your status

Click your status at the top of the list to change the line in your own words.
**Settings → Profile → Your Status** has the rest, including up to three
short **fields**. Each is a label and a few words beside it:

- **Pick a label** from the list: *Listening to*, *Reading*, *Working on*,
  *Playing* or *Watching*.
- **Or type your own**, like *GitHub* or *Cooking*: choose **Your own…** and
  the list turns into a box (24 characters). The caret button beside it brings
  the list back.
- **What it says** is up to 80 characters. A field left empty isn't shown.

A web address in a field opens in the browser when somebody clicks it on your
card, like a link in a message. Write it with `https://`, start it with
`www.`, or give it a path, like `github.com/you`; a bare name like
`example.com` stays words, since file names such as `main.rs` look the same.

Other people see a change only when you save it. A status is words; to share
a photo, post it in a room.

Friends still on an older version of Linger see only the fields labelled
*Listening to*, *Reading* and *Working on*. If you use an older version
yourself somewhere, saving your status there keeps the fields it can't show.

To see what friends see, click your own name, at the top of the list or on one
of your messages. It opens your card exactly as it opens for them: where you
are, your status or away message, and your fields. **Edit profile** on it
opens Settings → Profile.

There's also an **away message**: **Away** at the top of the list. Pick a
recent one or write your own; setting one is what makes you away, and it shows
instead of your status. With several servers, tick where it shows. **I'm
back** clears it.

While you're away, the top of your list looks it: **I'm back** is filled in
a warm cream, and your away message sits where your status was, with the
moon. When you come back to your computer after ten minutes or more and
you're still away, Linger says so there: "Welcome back. You're still away."
It never brings you back by itself. Press **I'm back**, or **✕** to stay
away.

## Your display name

Your display name is what people see in their lists and on your messages.
Change it in **Settings → Profile → Who You Are**. It can be up to 32
characters, in any language, with emoji, accents, spaces and punctuation.

Linger turns a name down, and says why, when it has:

- a line break or a tab
- characters nobody can see, such as a zero-width space, or a name made only
  of blank-looking letters
- characters that turn text around to run right to left
- more than two accent marks piled on one letter

A name you saved before these rules stays as it is until you change it.

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

- **Interface Size**: enlarge text and controls from 100% to 200%. The default
  layout is comfortable; there are no density modes to choose between.
- **Use plain names and message fonts**: turns off other people's name styling
  and message fonts, for you only. Nobody is told. Use it if a room is too loud
  to read.

Linger is dark only; there is no light theme. The evening warmth of earlier
versions comes back once the new look has an evening version of its own.

## Being interrupted, or not

Desktop banners appear for **a DM**, **somebody naming you**, or a person
you've specifically asked to hear about. A DM's banner says who it's from, and
Linger's taskbar button flashes until you look (on Linux, the window is marked
as wanting attention, and your desktop decides how that looks). Nothing happens
for a DM you're already reading. In the list, a DM you haven't read is lit in
amber, not only bold, so you can see who wrote at a glance. Turn DM banners off
in **Settings → Notifications → DMs**. Open **Settings → Notifications** to choose
those people, either everywhere or in selected rooms. A server you've made
**Quiet** makes no sounds and no arrival cards, but somebody naming you there
and DMs still get a banner, and knocks still come through. Clicking a banner opens
that conversation at the message. On Windows that works while the banner is on
screen; once it has moved to the notification center, clicking it just brings
Linger up.

For chimes, open **Settings → Sound & Voice**. Voice-session joins, leaves and
moves, mute/deafen changes, DMs and knocks have sounds by default. Ordinary
room-message sounds start off. Turn each category on or off, press **play**
beside it to preview, or use **Mute all notification sounds**. Play always
sounds, even during quiet hours or with a category switched off, so you can
hear what you are choosing. Quiet hours, when you turn them on, silence
DM, room-message, knock and door chimes between 22:00 and 08:00 on your computer's
clock. Once they're on, **Quiet from** and **Quiet until** move the window in
half-hour steps: 21:00 to 06:00 for an early night, or 02:00 to 12:00 if you
sleep late. Voice and mute/deafen sounds still play during quiet hours, because
they answer something you just did, and voice chat itself is never affected.

If the chimes are hard to hear, turn up **Sound volume**, at the top of
**Settings → Sound & Voice**. It's one slider for all of Linger's own sounds:
the chimes, knocks, the door chime, and the voice join/leave and mute/deafen
sounds. They keep their balance with each other; only the overall level
moves. It starts at 100%, the level they have always had, and goes from
silent up to 400%. When you let go of the slider, Linger plays a DM chime at
the new level so you can hear what you picked. At 0% nothing plays, not even
**play**. Mute and quiet hours work the same at any level. It's kept on this
computer, and it doesn't change how loud people are in voice: click someone's
name in the voice bar for that.

When somebody comes into a room, a small **arrival card** says so ("Callie
came into #general") at the top of the list and goes by itself after a few
seconds. It never takes the cursor, so whatever you're typing keeps going.
There are none from a Quiet server or during quiet hours, and at most one a
minute for each person. Turn them off in **Settings → Notifications →
Arrivals**. The **door chime** is their sound: a soft ding-dong, off until you turn
it on in **Settings → Sound & Voice**, at most once every five minutes for each
person, and quiet during quiet hours.

Messages you are already reading, your own messages, reconnect replay and
push-to-talk presses do not chime. These switches do not silence voice chat;
use **deafen** for that. Muting chimes keeps visual notifications visible.

There are **no unread badges and no counters** anywhere in Linger. That is
deliberate. Nothing is keeping score of what you have not read, so nothing can
make you feel behind. A room with something new just has a bolder name. Opening
it lands on a **you left off here** line; caught-up rooms open at the bottom.
**Back to the newest** skips ahead. Search results still open
on the message you selected, and new arrivals do not pull you away from
earlier messages you are reading. If you scroll a long way back, the header
offers **back to the newest** too — Linger has put down the newest messages
to save memory, and scrolling down picks them up again.

## Reporting and blocking

Among friends these should hardly ever come up, so they stay out of the way.

**Report** sends a message, or a person, to whoever hosts the server, and to
nobody else. The person isn't told.

- **A message:** on a computer, its **···** and then **Report to host…**, the
  last item. On the phone, hold the message, and choose **Report to host…**.
- **A person:** open their card (click their name), then **···** beside
  **Knock**, and **Report**.

You can add a note for the host before you send it. A host has nobody to
report to, so they don't see Report at all: they can already delete a message
or remove somebody.

**Block** is on the same **···** on a person's card. It's private: they
aren't told, and they still see what you say in rooms. For you:

- Each of their messages folds into one grey line, "From Jules, who you
  blocked". Click **Show** to read one anyway.
- Their DMs never light up or chime, and their knocks stop reaching you.
- Nothing of theirs shows in Media or Search.

To undo it, choose **Unblock** on their card, or open **Settings → Account &
App → Blocked**, which lists everyone you've blocked on that server.

**If you host:** when somebody reports something, a row saying **A report to
look at** lights up in your list. It never shows how many. It opens
**Settings → People**, which shows who sent each report, what it's about and
their note. From there you can delete the message, remove the person, or
**Let it go**. Each of those closes the report.

## Taking everything with you

Any member can ask the server for a copy of **everything on it** — every
message, every file — at any time. You do not need the host's permission, and
there is nothing to ask for.

What you get is a single zip. Inside it: one plain text file per room in the
order things were said, a `media` folder with every file anybody shared, and an
index listing who shared what and when. It opens with an ordinary text editor
and an ordinary file browser. **You do not need Linger, or an account, or the
server to still exist**, which is the entire point.

**Settings → Account & App → Take Everything with You.** Press **Export
everything**, wait (it takes a moment on a busy server), then download it. The file opens in your
normal browser's downloads, like anything else you download.

You can ask for one an hour. If you ask again too soon the app tells you when
you can come back.

## Updates

1. Open **Settings → Account & App → Updates**.
2. Linger looks when you open it, and says so at the foot of your list when
   there's a new version (**Update…** brings you here). **Check again** looks
   now.
3. When you're ready, choose **Install and restart**. Nothing downloads or
   installs until you choose it.

**Arch and Omarchy package:** there is nothing to do in the app. New versions
arrive with your system updates, and the Updates panel says so.

If this copy cannot update itself, or an update fails, download the newer
installer/AppImage from [Releases](https://github.com/itsMattGuenther/Linger/releases/latest)
and use the installation steps above. Close the old app first. For an
AppImage, make the new file executable and launch that file, not the old one.
Do not delete your account or application data to update.

**The Android app** doesn't update itself: install the newer `.apk` from
[Releases](https://github.com/itsMattGuenther/Linger/releases/latest) over
the old one, as in [Android](#android).

A code push to GitHub is **not a release**. New downloads appear when a
desktop release is published. Updating your app also does not update the
server: the host follows the [server update steps](host-guide.md#updating-the-server).

## Starting Linger when you sign in

Linger doesn't start by itself unless you ask it to. To have it open each time
you sign in to your computer, turn on **Settings → Account & App → This
Computer → Start Linger when I sign in to the computer**. Turn the same switch
off to stop. It's off on a new install.

The switch asks your computer each time Settings opens, so it shows what will
happen at your next sign-in, even if you changed it somewhere else. If your
computer refuses the change, Settings says so and the switch stays off. There
is no Mac version yet.

**Windows.** Linger adds itself to your startup apps, the same list as **Task
Manager → Startup apps** and **Settings → Apps → Startup**. Switching it off
there works too, and Linger's switch shows it. Uninstalling with the
`x64-setup.exe` installer removes it. The `.msi` doesn't, so turn the switch off
before you uninstall that one. To remove it by hand, open **Registry Editor**,
go to `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run`, and
delete the value named `Linger`.

**Linux.** Linger writes one file, `~/.config/autostart/com.linger.desktop.desktop`
(or in `$XDG_CONFIG_HOME/autostart` if you set that). To undo it by hand,
delete that file. Removing the Linger package leaves the file behind. It does
nothing once Linger is gone, but you can delete it.

- **AppImage:** it starts the AppImage file you turned it on from. If you move
  or rename that file, the switch shows off again: open the file from its new
  place and turn the switch back on.
- **Moved from the AppImage to a package, or back?** Turn the switch off and on
  in the copy you use now, so sign-in starts that one.
- If you started Linger with a setting such as `LINGER_LINUX_BACKEND=x11` when
  you turned the switch on, sign-in starts it with the same setting, as the
  AppImage's menu entry does.

**Omarchy, Hyprland, Sway, i3 and other window managers.** GNOME, KDE Plasma,
Xfce, Cinnamon, MATE and similar desktops start what's in that folder. A window
manager started on its own doesn't, and Settings says so under the switch.
Start Linger from the window manager's own startup settings instead, and
remove the line to stop:

- **Omarchy:** add this line to `~/.config/hypr/autostart.lua`. For an
  AppImage, put its full path in place of `linger-client`.

  ```lua
  o.launch_on_start("linger-client")
  ```

- **Hyprland** with a `hyprland.conf`: `exec-once = linger-client`
- **Sway** or **i3**: `exec linger-client` in its config file.

If your session runs under uwsm or another systemd session manager, the switch
works as it is, and Settings shows no note.

## Signing out

**Settings → Account & App → Sign out.** That forgets the server on this
computer. With several servers, **Settings → Servers** signs out of one, and
**Sign out of everything** out of all of them. Your account and everything in it stays exactly where it is.

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

**On Linux, a shared video that plays without sound (or doesn't play at all)**
is missing a decoder. Linux plays video through GStreamer, and the sound in
most videos (AAC) and the picture (H.264) need its libav plugins. From 0.4.5,
the Arch package requires them, a fresh install of the `.deb` or `.rpm` brings
them, and the AppImage carries its own. Updating a `.deb` or `.rpm` from inside
the app doesn't add them, and neither did anything before 0.4.5. Add them
yourself: `sudo pacman -S gst-libav` on Arch and Omarchy,
`sudo apt install gstreamer1.0-libav` on Debian and Ubuntu, `sudo dnf install
gstreamer1-plugin-libav` on Fedora. Then restart Linger. An AppImage older than
0.4.5 ignores what's installed on the computer, so update it instead (#358).

**On Hyprland, including Omarchy, the mouse pointer jumps into a
conversation's window when it opens in a window of its own** (popped out, or
with **Each in its own window**). That's Hyprland, not Linger. When an app
brings one of its windows forward, Hyprland moves the pointer to the middle
of it, and Linger brings the conversation's window forward so you can start
typing. Conversations opened beside the list don't do this: they're in the
window you're already in. Linger leaves this to your desktop rather than working around it. If
you'd rather the pointer stayed put, turn the behaviour off in Hyprland. On
Omarchy, add this to `~/.config/hypr/looknfeel.lua`:

```lua
hl.config({
  cursor = {
    no_warps = true,
    -- Keep Omarchy moving the pointer to your last window when you switch workspaces.
    warp_on_change_workspace = 2,
  },
})
```

On other Hyprland setups, add `no_warps = true` inside the `cursor { }`
block of `~/.config/hypr/hyprland.conf`. Either way it applies to every app,
and to moving focus with the keyboard too: the pointer stays where you left
it.

**On an older NVIDIA card, Linger draws without the graphics card.** Cards
from before the GTX 16 and RTX series (a GTX 980 or 1080, say) need NVIDIA's
older "legacy" driver, the 580 branch. With that driver, on a GTX 980 Ti, Linger
closed when one of its windows was resized while another was open (#229).
Releases after 0.4.2 notice that driver and draw without the graphics card,
which stops it. Typing may feel a beat behind. On 0.4.2, or on any computer
where Linger closes the same way, start it with GTK's graphics-card drawing
turned off:

```bash
GDK_GL=disable linger-client
```

To have the menu start it that way on the Arch package, copy its menu entry
and change one line in the copy:

```bash
cp /usr/share/applications/linger.desktop ~/.local/share/applications/
sed -i 's/^Exec=linger-client$/Exec=env GDK_GL=disable linger-client/' ~/.local/share/applications/linger.desktop
```

Delete the copy to go back. Linger leaves a `GDK_GL` you set alone, so to keep
the graphics card on with the legacy driver anyway, start it with `GDK_GL=`
(nothing after the `=`).
