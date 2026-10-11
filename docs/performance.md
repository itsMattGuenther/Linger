# How fast Linger opens, and what it costs to keep open

SPEC §7 rests on Linger opening in 400 ms. This page is where that, and the
rest of T-910 (size, memory, idle processor use), gets measured, with the
machine, the method and the numbers, so each release can be checked against
the last. Newest measurements first. Measure again when something that runs
at startup changes, and before a release that touches the shell, WebKit
settings or the list window.

## What "opens" means

From the moment Linger's process starts, which is what clicking its icon
does once the launcher has done its part, to the moment the list window on
screen shows your servers, their rooms and the people in them, signed in.
The "Signing you back in…" screen doesn't count, and neither does a list
whose rooms or people haven't arrived yet.

Three ways of opening, because a person meets all three:

- **After a restart** ("boot"): nothing of Linger's is in memory, and no
  other app on the desktop uses WebKitGTK, so its libraries come from disk
  too. The first open of the day.
- **Cold**: Linger's own files come from disk, but WebKitGTK is already in
  memory because another app uses it.
- **Warm**: Linger was open a moment ago. Closing it from the tray and
  opening it again, say.

What isn't counted: the launcher's own part before the process starts
(Omarchy's launcher, the Start menu), and the network. The servers here are
on the same computer, so a real server adds its round trips on top (below).

## How it's measured (Linux)

`scripts/startup-time.mjs` does it all, from outside the app: nothing in the
app is changed, asked or switched on. It needs Hyprland, because it watches
the screen.

1. It starts two throwaway servers and fills them like a friend group's: 22
   and 11 people, 12 rooms, about 2,000 messages, four DMs, statuses, name
   styles (one of them shimmering) and ten people online.
2. It signs one person in to both, in a keyring of its own: a private D-Bus
   that starts nothing on demand, and a gnome-keyring. Your own Linger, its
   settings and your sign-ins are never touched.
3. It opens Linger on a screen of its own that nobody can see (a headless
   Hyprland output, 1280×1120 at 1.25 scale, far away from the real
   screens), where the list floats at its own size, and photographs it
   with `grim` every 30–60 ms. The list counts as open at the first
   photograph from which the window looks the way it finally settles and
   stays that way. A shimmering name, and the
   scrollbar that shows for a moment on the right edge and fades, are left
   out of that comparison. Each number below is known to within one
   photograph, about 50 ms.
4. A proxy in front of each server notes when the app first asked it
   anything and when its gateway (the live connection) opened. A launch
   that never reached both servers isn't counted.
5. Before a cold open it asks the kernel to drop Linger's files from memory
   (`dd iflag=nocache`). Without root nothing can drop a file another
   running program has loaded, which is why "boot" starts the app with fresh
   copies of the libraries only Linger uses (WebKitGTK and the rest, 133 MB
   here): the same bytes, nothing of them in memory.
6. After each open it adds up the memory of Linger and every process it
   started. At the end it leaves one open, on a 60 Hz screen, for a minute
   and measures the processor time each process used.

Two or more builds can be measured in one go, taking turns launch by launch,
so whatever else the machine is doing weighs on both alike. Measuring them
one after the other, half an hour apart, mostly compared the machine: the
same build came out 20% slower while other work was running.

The app measured is the release build, as `release.yml` makes it, with one
change: its CSP also lets it reach `http://127.0.0.1`. An installed Linger
only talks https, and the throwaway servers have no certificate. The script's
header has the exact commands.

## Measured 2026-10-11

**The machine:** AMD Ryzen 9 7950X3D (16 cores, 32 threads), 64 GB, Samsung
990 PRO NVMe (encrypted, btrfs), NVIDIA RTX 4090 and AMD Raphael graphics,
Omarchy (Arch Linux, kernel 7.2.5), Hyprland 0.56.2, WebKitGTK 2.52.6. A fast
desktop: most of the people Linger is for have slower computers.

**The builds:** `main` is 0.4.10 as on `main` at `39e1bdca`. "Combined" is the
night audit's `integration` branch (`450f524`, `main` plus 38 pull requests),
which adds the smaller release profile (#542) and the audio context sleeping
between sounds (#543). Seven opens of each kind, the two builds taking turns.
The machine was quiet (a load average of 1–5 on 32 threads) for all but the
first and last rounds, when other work pushed it to 15.

| | main (0.4.10) | combined |
|---|---|---|
| **Opens, warm** (median / worst of 7) | **1.03 s** / 1.37 s | **1.08 s** / 1.27 s |
| **Opens, cold** | **1.14 s** / 1.54 s | **1.12 s** / 1.41 s |
| **Opens, after a restart** | **1.29 s** / 1.53 s | **1.16 s** / 1.62 s |
| First open on a new profile (once, while the machine was busy) | 1.57 s | 1.30 s |
| Memory, all processes (proportional set size, warm, median) | 303 MB | 303 MB |
| Memory, resident (each process counted whole, so shared libraries twice) | 649 MB | 647 MB |
| Idle processor use, list open, a minute, nothing moving | 0.2% of a core | 0.2% of a core |
| The same, with one shimmering name in the list | 12% of a core | 20% of a core |
| The app's binary | 43.0 MB | 24.2 MB |
| `.deb`, built here | 13.9 MB | 10.7 MB |

The two builds open at the same speed: the differences above are smaller
than the spread between one open and the next. A 19 MB smaller binary didn't
make opening faster, because reading it from this disk takes a few
milliseconds. The memory is the same too.

**Where the second goes**, warm, main (the combined branch is within 20 ms
at every step):

| ms after the process starts | |
|---|---|
| 0 | The process starts |
| 120 | WebKit's network process starts: GTK and the app are up, and the window and its web view are being built |
| 180 | WebKit's page process starts |
| 180–690 | Nothing on screen |
| 690 | The window appears: dark grey, black for a moment, then the page's own background |
| 870 | The page asks both servers for the sign-in |
| 910 | The first thing drawn: the title bar and "Signing you back in…" |
| 930 | Both gateways are connected |
| 1,030 | The list is filled: rooms, people, statuses |

So two thirds of it happens before there is a window at all, most of it the
half second between WebKit's page process starting and the window showing.
WebKitGTK alone is quicker than that: its own test browser (`MiniBrowser`,
which comes with it) shows a window with a page in it 270–320 ms after it
starts, on the same screen. So about 400 ms of Linger's wait is something
Linger or Tauri does before the window can show. It isn't the graphics
drivers: with GTK drawing without the GPU (`GDK_GL=disable`) the window came
20 ms sooner, and with only the AMD graphics driver (Mesa) loaded no sooner
at all. Splitting it further needs a profiler, which this machine doesn't
have (#591).
The servers' part (asking, connecting, answering) is about 150 ms here. Cold
adds about 100 ms, a restart about 150–250 ms, almost all of it before the
window appears.

**Memory**, warm, main: the app's own process 106 MB, WebKit's page process
152 MB, WebKit's network process 38 MB (proportional: a library two of them
share is split between them). GTK's image loader, which runs in a sandbox of
its own (`glycin`), adds about 4 MB for the first few seconds.

**Idle**: with the list open and nobody doing anything, Linger and its
WebKit processes use 0.2% of one processor core between them: next to
nothing. That changes completely when one person in the list has the
Shimmer name effect: the page redraws their name every frame, for as long
as it is on screen, and the same idle minute costs 10–20% of a core (four
measurements: 10.5%, 10.4%, 11.8% and 19.6%), two thirds of it in WebKit's
page process and a third in the app's own. On a laptop that is battery.
That's #532, still open. The measurements above were on a 60 Hz screen,
except the first two, at 240 Hz; it made no clear difference.

### Over a real network

The servers above are on the same computer. With 60 ms between the app and
both servers (`--rtt 60`: a server across the country), three opens of each
kind:

| | main (0.4.10) | combined |
|---|---|---|
| Opens, warm (median / worst) | 1.54 s / 1.56 s | 1.58 s / 1.86 s |
| Opens, cold | 1.78 s / 1.99 s | 1.70 s / 1.71 s |
| Opens, after a restart | 1.82 s / 2.05 s | 1.81 s / 1.88 s |

The extra half second is waiting. Before the list is complete the app waits
for about seven answers in a row, because the page asks the server for each
thing it needs, and the WebView first asks permission for each new kind of
request (a CORS preflight, an `OPTIONS` request). Warm, main, in ms after the
process starts:

| ms | |
|---|---|
| 944 | `OPTIONS /auth/refresh` |
| 1006 | `POST /auth/refresh`: the sign-in |
| 1111 | `OPTIONS /me` |
| 1174 | `GET /me` |
| 1242 | `OPTIONS` for `/read`, `/me/notify-rules`, `/me/blocks` and `/server`, at once |
| 1268 | the gateway connects (from the app's own process, so no preflight) |
| 1305 | those four requests |
| 1377 | `GET /read` again |

A real server also speaks https, and each new connection's handshake costs a
round trip more, which the proxy here doesn't add. So against a typical
server, Linger takes about 1.6–2 seconds to open on this machine.

### Sizes as shipped (0.4.10, from the release page)

| Package | Size |
|---|---|
| Windows `-setup.exe` | 7.2 MB |
| Windows `.msi` | 10.0 MB |
| Linux `.deb` | 13.8 MB |
| Linux `.rpm` | 13.8 MB |
| Linux `.AppImage` (carries its own WebKitGTK and GStreamer) | 103.5 MB |
| Android `.apk` | 20.3 MB |

## Budgets

What a change may cost before it needs a reason in its pull request, on this
machine, measured with the script. They are where Linger is today plus some
room, not the goal: SPEC §7 says 400 ms, and Linger takes about two and a
half times that here (#591).

| | Budget |
|---|---|
| Opens, warm, median | 1.2 s |
| Opens, cold, median | 1.3 s |
| Opens, after a restart, median | 1.5 s |
| Memory, all processes, proportional, warm | 350 MB |
| Idle processor use, list open, nothing moving, one minute | 1% of one core |
| Windows `-setup.exe` | 8 MB |
| Linux `.deb` / `.rpm` | 15 MB |
| Linux `.AppImage` | 110 MB |

A worse number on a busy machine isn't a regression until it is worse with
the two builds taking turns.

## Measuring on Windows

Not measured yet: this machine can't. Most of the people Linger is for are
on Windows, so this is the next measurement worth having. A friend with a
Windows computer can do it with what Windows has:

1. **Opening.** Quit Linger from its tray icon. Start recording the screen
   (Win+Alt+R with the Xbox Game Bar, or OBS at 60 frames a second), click
   Linger in the Start menu or on the taskbar, and stop recording once the
   list shows your rooms and people. In the recording, count the frames
   from the click to the filled list, and divide by 60. Three times right
   after restarting Windows, three times after quitting it again.
2. **Memory.** A minute after it opens, Task Manager's Processes tab groups
   Linger with its WebView2 processes: expand it and note the total in the
   Memory column.
3. **Idle.** Leave the list open and untouched for a minute and note the CPU
   column for the same group (Resource Monitor's "Average CPU" is steadier).
4. Note the computer: processor, memory, disk, Windows version.

## Not measured yet

The rest of T-910: Windows (above), memory and processor use after a long
session with several rooms open, during four-person voice, and how retained
message history grows.
