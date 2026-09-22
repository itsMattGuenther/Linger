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
package. It verifies shortcut identity, the installed executable's version,
MSI uninstall-link validity and uninstall cleanup. Installer logs are uploaded
with the workflow evidence. This isolates installer behavior; it does not
repeat signature download verification or a real user's update session.
