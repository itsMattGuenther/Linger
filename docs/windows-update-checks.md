# Windows update shortcuts

Issue [#108](https://github.com/itsMattGuenther/Linger/issues/108) reports two
desktop shortcuts after an in-app update from 0.3.0. The original installer
format and shortcut names on the reporting computer have not been confirmed.

## Published-client reproduction, 2026-09-22

The actual signed 0.3.0 → 0.3.1 in-app update was exercised on disposable
Windows Actions runners, through the shipped `update_check` and
`update_install` commands in the native WebView2 app.

- [Original desktop shortcuts](https://github.com/itsMattGuenther/Linger/actions/runs/35764855782):
  both MSI and NSIS retained exactly one shortcut and the original executable
  path, with the installed file version changing to 0.3.1.
- [Renamed desktop shortcuts](https://github.com/itsMattGuenther/Linger/actions/runs/35765104288):
  NSIS preserved `Linger custom.lnk`. MSI retained that link and created a new
  `Linger.lnk`, both targeting the same installed executable. The first MSI
  attempt failed to attach the test driver before updating; the rerun reached
  0.3.1 and failed specifically because two shortcuts remained.

The reproduction harness is recorded in PR #111's diagnostic commits. It uses
the then-current public update endpoint and is not a permanent CI dependency.
This confirms an installer bug matching the symptom, not the exact shortcut
history of the reporting computer. HC-1 remains open.

## Installer change

The MSI template in `client/src-tauri/windows/main.wxs` is Tauri CLI v2.11.4's
template under its MIT license, with two additions: a file search for the
canonical desktop shortcut and a condition on its component. Fresh installs
create the shortcut. Major upgrades create it only if the canonical shortcut
still exists; ordinary maintenance of the installed product remains allowed.
Renamed, moved or deleted desktop shortcuts are left alone. Start-menu and
uninstall shortcuts retain the upstream behavior; the uninstall link must
refresh because its MSI product code changes between versions.

Keep the executable name and install location stable so retained shortcuts
continue to launch the app. Compare the custom template with upstream when
upgrading the pinned Tauri CLI. Do not replace this with a blanket
`CreateShortcuts` suppression, which leaves the uninstall link pointing to an
old product code. Existing duplicates are not automatically deleted: their
names alone cannot establish which one a person wants to keep.

## Regression check

On a **disposable Windows Actions runner**, after building both packages:

```powershell
scripts/windows-update-check.ps1 -Bundle client/src-tauri/target/debug/bundle -Output package-check/updates
```

The package-check and release workflows run this before their icon/audio
checks. It downloads the published 0.3.0 installers, installs each format,
then upgrades to the newly built package with the updater's installer mode
(without app relaunch). Cases cover untouched, renamed, moved between personal
and public desktops, and deleted shortcuts, plus a fresh install of the new
package, and an NSIS update and uninstall that meet a program something else
has open ([#568](#a-busy-program-during-an-update-568-2026-10-11)). It verifies shortcut identity, the installed executable's version,
MSI uninstall-link validity and uninstall cleanup. Installer logs are uploaded
with the workflow evidence. This isolates installer behavior; it does not
repeat signature download verification or a real user's update session.

Each install, update and uninstall gets five minutes (they take seconds), and
each scenario is named as it starts. Once an NSIS update sat for 29 minutes
until the job was cancelled, with nothing in the log to say where (#414); now
a stuck installer is stopped and the check fails naming the package and its
arguments, in its scenario. Before stopping it, the check saves what it was
waiting on (#568): `stuck-N.log` lists the installer's processes and threads
and its windows with their text, so a dialog's message and buttons are in the
log, and `stuck-N.png` is the runner's screen. Both are uploaded with the
installer logs. It looks at the installer's own processes only.

## A busy program during an update (#568, 2026-10-11)

The NSIS update stuck in #414 and #568 was waiting on NSIS's own dialog:
"Error opening file for writing … Abort, Retry, Ignore". Windows opens a
program for a fraction of a second now and then. Explorer reads it for a
desktop shortcut's icon about 0.5–0.8 s after an install, and again just
after an update changes it; the compatibility scanner (`CompatTelRunner`)
reads new programs too, seen at 0.6 s and at 3.1 s. NSIS's `File` opens the
program for writing, sharing it only with readers that allow that; if one of
those reads holds it at that moment, the open fails and NSIS asks. In passive
mode, the updater's, the dialog waits for a click, and on a runner nobody
makes one.

The check met it on a runner's first NSIS update. That update starts slowly
and reaches the program 0.6–0.9 s after it starts, against about 0.25 s on
later ones, which is the moment Explorer looks at the program the 0.3.0
install has just put there. Both stuck runs were that update ("original"):
#414 on 2026-10-04, and #568 once in about 108 package checks since #418.

Measured on disposable runners, on a throwaway branch
([runs](https://github.com/itsMattGuenther/Linger/actions/runs/38151645628),
[2](https://github.com/itsMattGuenther/Linger/actions/runs/38152664834),
[3](https://github.com/itsMattGuenther/Linger/actions/runs/38154062962),
[4](https://github.com/itsMattGuenther/Linger/actions/runs/38155539522),
[5](https://github.com/itsMattGuenther/Linger/actions/runs/38156325861)):

- Holding the installed program open, as Explorer does for an icon, makes a
  passive update stop on that dialog every time (screenshot and window text
  in the run's evidence).
- Something held the program shortly after 5 of 30 installs; Restart Manager
  named Explorer when it could see the holder.
- Starting the update so that it reaches the program about when Explorer
  looks hung 3 of 317 updates, each on "Error opening file for writing" for
  the program; in two of them Restart Manager saw Explorer holding it just
  before. The same timing hung 0 of 723 updates with the fix below.
- Waiting three seconds after the install, in the check, still hung once in
  320: `CompatTelRunner` held the program at 3.1 s. A wait in the check can't
  outlast Windows' own readers, so the fix is in the installer.
- With the fix, an update started while the program was held for 3 s
  finished as soon as it was let go; held for 15 s, it fell back to the
  dialog after its ten seconds. An uninstall started while the program was
  held for 3 s removed it and its folder. The in-app updater's own order (app
  open, installer started, app quits at once) passed 20 of 20, as it passed 60
  of 60 before.

The fix is a set of Tauri NSIS hooks, `client/src-tauri/windows/installer-hooks.nsh`
(`bundle > windows > nsis > installerHooks`). In an update (`/UPDATE`, which
the in-app updater always passes), the installer writes the program itself,
before the template's own `File`, with `SetOverwrite try`, and tries again
every 100 ms for up to ten seconds. A busy file is then an error to act on,
not a dialog. The template's `File` is built with `SetOverwrite ifdiff`, so
it skips the program the hook wrote (same date as this build) and writes it
as before otherwise, dialog included if it is still busy after ten seconds.
The hook runs before the template checks for a running app, so an update
also lets the app finish quitting by itself; the template stops it and
waits half a second only if it is still running after that. The uninstaller tries its `Delete` of the program
again for up to ten seconds as well: on a busy program it gives up quietly,
and an uninstall straight after an update left the program behind once in
317. Neither changes the installer's size; NSIS stores the program once.

The update check now proves it on every package build: after the shortcut
scenarios it holds the installed program open for two seconds, the way an
icon is read, as an NSIS update starts, and again as an uninstall starts.
Without the hooks the update stops on the dialog, and the uninstall leaves
the program behind; with them, both pass
([run](https://github.com/itsMattGuenther/Linger/actions/runs/38156978377)).

People can meet the same dialog, but rarely: an update runs long after the
install, when nothing usually reads the program, and a person can press
Retry where a runner can't. With the hooks, the update waits instead of
asking.

## Fixed-package results, 2026-09-22

[Windows package check](https://github.com/itsMattGuenther/Linger/actions/runs/35766081266/job/106875831477)
passed all ten scenarios against the new MSI and NSIS packages. Renamed and
moved shortcuts remain byte-for-byte unchanged, deleted shortcuts remain
absent, and default/fresh shortcuts are removed correctly on uninstall. MSI
uninstall links still reference the current installed product. The same job's
packaged icon and WebView2 audio checks passed.

`scripts/check.sh origin/main` passed locally, including the separate desktop
shell. [Regular CI](https://github.com/itsMattGuenther/Linger/actions/runs/35766080785)
passed all seven jobs. These are disposable-runner results, not a retest on the
reporter's computer, and do not close the existing release checks.

## A minimized or tray-hidden window (#594, 2026-10-11)

`client/scripts/windows-hidden-check.mjs` runs in the Windows package check,
after `windows-icon-check.ps1` has installed the app. It starts the installed
app with WebView2's debugging port on (the same HKLM policy as the other
checks, removed after), finds the list window by the app's own main window
handle, and does to it what a person does, with Win32 calls from
`client/scripts/windows-window.ps1`: minimize, restore, close to the tray,
and start Linger again to bring it back (the same `tray::show_list` as the
tray's Show Linger). A busy canvas on the page gives WebView2 something to
draw. At each step it reads whether WebView2 has switched its own windows
inside Linger's off (their `WS_VISIBLE`), the frames the page draws, and the
page's own busy time (Chromium's `TaskDuration`); that an event emitted
through the shell comes back to the hidden page within a second, which is how
a server's messages reach it; and, after each return, a capture of the window
that mustn't be one flat colour. The captures, the page's screenshots and
`result.json` are uploaded as `package-check-Windows`.

What it found on a runner, before the fix was finished:

- [Without the fix](https://github.com/itsMattGuenther/Linger/actions/runs/38184377348/job/114603465517)
  (the app as 0.4.10 has it): minimized or in the tray, the page drew about 64
  frames a second and kept its main thread as busy as when shown. 7 of 16
  checks failed.
- [With the fix, before its focus rule](https://github.com/itsMattGuenther/Linger/actions/runs/38184377348/job/114603465358):
  minimized, WebView2 switched off, no frames, no work; but closed to the tray
  it was switched straight back on. On Windows Tauri's focus event is
  WebView2's, and switching off the WebView of a window that has the focus
  hands the focus to the window, which wry hands back to WebView2. The fix
  took that "focus" as the window being seen. 4 of 16 failed, all in the
  tray. Focus now counts only while the window is shown and not minimized.
- Either way, `document.visibilityState` stayed `"visible"` with no
  `visibilitychange`, and a 100 ms timer fired on time: WebView2's
  `IsVisible` stops drawing, not the page's timers. The check records this
  rather than asserting it (`docs/design/architecture.md`, "A page nobody can
  see").

What it can't show: a runner has no GPU and no person at it. How much CPU a
real machine saves, and that the window comes back right with a real
graphics card and display scaling, still want a quick try on a real Windows
computer.
