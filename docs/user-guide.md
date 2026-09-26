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

## Getting in

For a **new member**:

1. Ask the host for an invite, such as `https://linger.example.com/invite/CODE`.
2. Paste the **whole invite link** into **Server or link** and press **Continue**.
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
- **DMs**: your direct messages, named by who's in them. The pencil starts a
  new one.
- **People**: everyone on the server, with where they are and their status.
  **Away** and **Offline** fold up under them.

Click a room or a DM and it opens in the **chat window**. Each conversation
gets a tab there; **Ctrl+Tab** moves between them and **Ctrl+W** closes one.
The ⧉ button pops a tab out into a window of its own, and **Back to tabs**
puts it back. If you'd rather every conversation had its own window, choose
that in **Settings → Windows**.

At the foot of the list are **Media** and **Search**, each in a window of its
own. When you're in voice, the voice bar sits just above them.

**Closing the list doesn't quit Linger.** It keeps running in the tray (the
little door icon near your clock), so voice, knocks and notifications carry
on. To bring the list back, choose **Show Linger** from the tray icon's menu
(on Windows, a click on the icon does it too), or just open Linger again. The
same menu has **Mute**, **Leave voice** and **Quit Linger**. To make closing the list
quit instead, open **Settings → Windows → When You Close Your List**. On a
Linux desktop with no tray, closing the list always quits.

Several servers? Each is a section of the list with its own rooms, DMs and
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
- **Sound & Voice**: notification chimes and quiet hours; microphone, speakers,
  push to talk
- **Notifications**: desktop banners, and whose messages you want them for
- **Account & App**: password, export, updates, adding a server, and signing out
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
tab or quit Linger, until you send it.

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

- **Reply**: quotes what you're answering. The **×** beside the quote cancels it.
- **Edit**: your own messages only. **Shortcut: press Up arrow in an empty box**
  to edit the last thing you said.
- **Pin** (or **Unpin**): anyone can pin a message, and it gets a small pin
  after its words. Media's **Pinned** filter collects them, and a file on a
  pinned message never expires.
- **Delete**: asks once, then it's gone.

Click anybody's name in a conversation to open their card, with **Message**
and **Knock**.

The **smile** on the right of the box opens a small set of ordinary emoji to
drop into what you are typing. Hover it for **Emoji**. There are no custom emoji.

There are no reactions on messages, for now. They are out as a trial: to answer
something, reply to it, emoji and all.

## Sharing files

Three ways, all the same thing: the **+** in the message box, drag a file onto
the box, or paste one from your clipboard.

Click a posted image to expand it. It stays centered and fits the window, even
when you resize it. Press **Escape** or click it to go back.

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

## Talking

Voice happens in a room, not in a call. There is nothing to ring and nobody to
invite. In a room's tab, the line under its name says who's talking there:
press **Join** (or **Start talking** when nobody is) to turn your microphone
on in that room. Already talking in another room? **Move voice here** (or
**Talk here instead**) takes you there.

While you're in, the **voice bar** at the bottom of your list shows the room,
who's in it (whoever is speaking lights up), and your controls:

- **Mute** stops sending, instantly, and nobody else can change it. Nobody can
  mute you either, and nobody can turn your microphone on.
- **Deafen** silences incoming voice and mutes your microphone together.
  Pressing it again restores your previous mic choice. Deafen doesn't change
  notification sounds.
- A crossed-out microphone beside a name means that person is muted, and
  crossed-out headphones mean they're deafened, when they share it. Hover
  the symbol for the word. An unmuted microphone is not a guarantee somebody
  is listening.
- **Leave** turns the microphone off. Quitting Linger does too; closing the
  list doesn't, since Linger keeps running in the tray.
- Click someone's name in the voice bar to set **how loud they are for you**,
  from silent to twice as loud. Linger remembers it for that person on this
  server, on this computer only; nobody else hears or sees the change.
- The arrow beside the room's name opens its conversation.

With the list tucked away in the tray, the tray icon's menu has **Mute** and
**Leave voice**.

**Push to talk** is in **Settings → Sound & Voice**. With it on, every call
starts muted and the microphone is open only while you hold the **talk key**:
**Right Ctrl** unless you pick another under **Talk key** (press **Change**,
then the key). The shortcuts use the left Ctrl, so they never open your
microphone. Switching away from Linger releases a held key; press it again to
speak. It's off by default, because a room you leave running is the point,
and a key you have to hold is the opposite of that.

Which microphone and speakers to use is also in **Settings → Sound & Voice**. A
change applies the next time you join. If a device you picked isn't plugged in,
the system default is used and the picker says so.

**Voice through the server.** On a server whose host has turned it on, your
voice goes to the server once and the server passes it on to everyone else in
the room, which is what lets a room of twenty talk at once. If it ever gives
you trouble, **Settings → Sound & Voice → Voice through the server** turns it
off and goes back to the old way, straight to each person. If anybody in a
room turns it off, or is on an older version of Linger, the whole room uses
the old way, so everybody can always hear everybody. It takes effect the next
time you join voice.

**Nothing is recorded.** Not by the server, not by anybody's app, not "for
transcription". The server passes voice along without keeping it; the person
who runs it could listen, the same way they could read messages, and Linger
says so rather than pretending otherwise.

Two things to know: voice between computers on **different networks** needs
the host to run the relay (the host guide says how), and if your headphones
come unplugged mid-sentence, Linger moves to whatever your computer now uses
within a second or two. If nothing comes back for twenty seconds, the voice bar
says the microphone stopped, and you join again.

## Talking to one person

**Direct messages.** Click somebody in **People** and press **Message** on
their card (or double-click them, the old AIM way). The pencil beside **DMs**
starts one with several people. The conversation works exactly like a room,
except only the people in it can see it, anywhere: not in media, not in search,
not in anybody else's export. There's no way to add someone later; a different
set of people is a different conversation.

**Knocking.** On the same card, **Knock** is a tap on the shoulder: the other
person sees a small card for eight seconds, then it's gone, and their row in
your list gives a little shake. That confirms the knock went, not that they
saw it. There is no message and nothing for them to
answer. Three an hour per person, so it stays a tap. A soft sound accompanies
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

Next to each person, a dot (a small moon when they're away) and a few words:

- **in a room** — they are in that room right now
- **around** — the app is in front of them, but not in a room
- **idle** — no typing or clicking for ten minutes
- **away** — they set an away message on purpose
- **offline** — the app is closed

Click someone to open their card, with their status and **Message** and
**Knock**. Press Escape or click outside it to close it.

## Your status

Click your status at the top of the list to change the line in your own words.
**Settings → Profile → Your Status** has the rest: three optional fields
(*reading*, *listening to*, *working on*) and one image. Other people see a
change only when you save it.

There's also an **away message**: **Away** at the top of the list. Pick a
recent one or write your own; setting one is what makes you away, and it shows
instead of your status. With several servers, tick where it shows. **I'm
back** clears it.

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

Linger is dark only for now. The light theme and evening warmth of earlier
versions come back once the new look has versions of its own.

## Being interrupted, or not

Desktop banners appear for **somebody naming you**, or a person you've
specifically asked to hear about. Open **Settings → Notifications** to choose
those people, either everywhere or in selected rooms. A server you've made
**Quiet** makes no sounds and no arrival cards, but somebody naming you there
still gets a banner, and knocks still come through. Clicking a banner opens
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

A code push to GitHub is **not a release**. New downloads appear when a
desktop release is published. Updating your app also does not update the
server: the host follows the [server update steps](host-guide.md#updating-the-server).

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
