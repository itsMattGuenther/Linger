---
name: linger-report
description: >
  Look into a problem with Linger (the small self-hosted chat and voice app for
  friends) and, with the user's OK, turn it into a good GitHub issue on
  itsMattGuenther/Linger. Use when the user says Linger crashed, won't open,
  lags, looks wrong, can't connect, has no sound, or asks to report a Linger
  bug or suggest a Linger feature. Covers telling Linger's bugs apart from the
  OS, the window manager, the GPU driver or a self-hosted server's setup;
  collecting what a report needs; searching existing issues, including fixes
  that aren't released yet; and drafting the issue without anything private.
---

# Reporting a problem with Linger

Your job is an accurate report, not a fast one. A report that says what
happened, on what, with nothing private in it, gets fixed. A guess dressed up
as a finding wastes the maintainers' time. Often the right outcome is filing
nothing: the bug is known, or already fixed.

**Nothing is sent without the user.** You only act because they asked, you show
them every word before it goes anywhere, and you file only when they say yes.
Linger has no telemetry and no crash reporting of any kind; this skill must not
become one.

Links below go to the project on GitHub; you don't need a copy of the
repository to use them.

## 1. Understand what happened

Ask, or read from what the user already said:

- What they were doing, what they expected, and what happened instead.
- Whether it happens every time, sometimes, or happened once. On Linux you can
  often answer this from records instead of memory (section 3).
- Since when: after an update, a system change, a new server?

**Opening Linger is not a harmless check.** It signs in, connects to the
server and shows the user as online to their friends. Ask before launching it,
and never send messages or change settings for them.

## 2. Is it Linger's problem?

Be strict. Linger is a desktop app (Tauri: a Rust program that draws its window
with WebKitGTK on Linux and WebView2 on Windows) talking to a server somebody
hosts. Plenty of what goes wrong around it is not Linger's to fix.

The best single test: **what changed?** If the system didn't change and Linger
did (an update this morning), it's very likely Linger's. If a GPU driver,
Mesa, WebKit or the desktop updated and Linger didn't, suspect those first.
On Arch-based systems, `grep -E 'upgraded|installed' /var/log/pacman.log | tail -50`
shows recent package changes; on Debian/Ubuntu, `/var/log/apt/history.log`.

| Symptom | Usually | Check |
|---|---|---|
| Can't reach a server, sign-in fails for everyone on it | The server or its network | Does the server's address load in a browser? Does it work for others? See the [host guide's troubleshooting](https://github.com/itsMattGuenther/Linger/blob/main/docs/host-guide.md#when-something-is-wrong). |
| Whole desktop stutters, every app is slow | The system | Does another app lag the same way? |
| Crash or black window on launch, on Linux | Often the graphics path; Linger's if the system didn't change | Section 3. |
| No sound in voice for one person | Their devices or OS mixer | Settings → Sound & Voice device choice; does the OS play sound? |
| Voice fails only across different networks | The server's relay (TURN) setup | Ask whether the host followed [voice between different networks](https://github.com/itsMattGuenther/Linger/blob/main/docs/host-guide.md#voice-between-different-networks). |
| A layout, text, button or behavior looks wrong | Linger | Screenshot it. |

If it clearly isn't Linger's, say so plainly, suggest where it does belong
(the distro, the GPU driver, the window manager, the server's host), and stop.

## 3. Collect what a report needs

Run only read-only commands, and **say what each one is for before you run
it**. Times from `ls`, `coredumpctl` and `journalctl` are local; GitHub's
(`gh release list`, `mergedAt`) are UTC. Convert before comparing them.

**Which Linger, installed how.** The install type matters, because the Linux
ones behave differently: the AppImage carries its own older copy of WebKit,
while the packages use the system's.

- Arch/Omarchy package: `pacman -Q linger`
- `.deb`: `dpkg -s linger | grep Version`; `.rpm`: `rpm -qa | grep -i '^linger'`
- AppImage: the file itself, usually in `~/Downloads`. **Its name can be out of
  date**: the in-app updater replaces the file in place and keeps the original
  name, so `Linger_0.2.0_amd64.AppImage` may really be a later version. Use
  Settings → Account & App → Updates once the app opens. Otherwise, the newest
  `vX.Y.Z` release published before the file's change time
  (`ls -l --time-style=full-iso`) is the *likely* version; say in the report
  that it was worked out this way.
- Windows: Settings → Account & App → Updates, or Apps & features.

**The computer.**
- Windows: `winver`. Linux: `cat /etc/os-release`.
- Linux desktop and session: `echo $XDG_CURRENT_DESKTOP $XDG_SESSION_TYPE`
- Graphics: `lspci | grep -iE 'vga|3d|display'`. Note machines with two GPUs
  (a laptop or desktop with integrated and dedicated graphics). For graphics
  problems also the driver and Mesa versions (on Arch, `pacman -Q mesa` and
  `pacman -Q | grep -E '^nvidia'`; anywhere, `cat /proc/driver/nvidia/version`),
  and for a package install `pacman -Q webkit2gtk-4.1` or the distro's
  equivalent.
- How the menu launches it: the `Exec=` line of Linger's menu entry, in
  `~/.local/share/applications/` or `/usr/share/applications/`. Variables set
  there (such as `LINGER_LINUX_BACKEND` or `WEBKIT_DMABUF_RENDERER_DISABLE_GBM`)
  change how it starts. The AppImage **rewrites its own menu entry** on every
  launch, copying variables that were set by hand in a terminal, so one test run
  can change every later menu launch. Compare the entry's change time
  (`stat -c %y <file>`) with the launch times.
- Interface scale, if it's a layout problem (Settings → Appearance).

**What happened.** Steps to reproduce, numbered from opening the app; what
happened and what was expected, in the user's words; a screenshot or short
recording for anything visual or timing-related, cropped to the problem.

**For voice:** which microphone and speakers, whether the others were on
different networks, and whether it's everyone or one person.

### Crashes and "won't open" on Linux

1. **When, and how often.** `coredumpctl list linger-client` lists crashes of
   the app. WebKit draws in a separate process whose crashes are listed under a
   shortened name: `coredumpctl list WebKitWebProces`. Its `EXE` path tells you
   whose WebKit it was: `/tmp/.mount_…` is an AppImage's own copy,
   `/usr/lib/webkit2gtk-4.1/` is the system's, which other apps use too.
   - **Menu or terminal?** `coredumpctl info <pid> | grep 'User Unit'` names the
     launcher. A launch from a terminal may have had variables set by hand,
     which override Linger's own records (below).
   - **How long each launch ran.** On desktops that start apps through systemd
     (Omarchy, most GNOME and KDE setups),
     `journalctl --user --since today | grep -iE 'linger|dumped core'` shows the
     launches and crashes. Each launch line names a scope such as
     `app-Hyprland-gtk\x2dlaunch-<id>.scope`; `journalctl --user --since today
     | grep -F '<id>'` then shows its "Consumed … over Ns wall clock time" line.
     That turns "it won't open" into facts like "crashed on the first launch
     after the update, opened on the next".
   - **Privacy:** the user journal lists every app the user started. Grep for
     Linger's lines only, and never quote or summarize other apps' lines; which
     apps somebody runs is exactly what Linger promises never to report.
2. **Linger's own records.** `ls -la ~/.local/state/linger/` and read what's
   there, **without deleting anything**:
   - `gbm-probe`: a launch that tried WebKit's GPU drawing path (GBM) and
     hasn't drawn yet. Left behind after a crash.
   - `gbm-off` (written by 0.3.5) or `gbm-off-<webkit version>` (later
     versions): Linger saw a crash on the GPU path and keeps it off from then
     on. While it exists, the next launch will usually open, so a crash may not
     reproduce; that is expected, not "can't reproduce". A variable set by hand,
     `WEBKIT_DMABUF_RENDERER_DISABLE_GBM`, always overrides it.
   - The file says "Delete this file to try again". On a version with a known,
     unfixed GPU crash, deleting it just brings the crash back; say so if the
     user asks.
3. **What it prints as it dies.** Output from launches started by the menu is
   usually not saved anywhere. With the user's OK (see section 1), start it from
   a terminal (the AppImage file, or `linger-client`) and read the last lines.
   The text `Could not create GBM EGL display: EGL_SUCCESS. Aborting...` means
   WebKit's GPU display path failed; search for that exact text (step 4). If
   the user would rather not launch it, you can often still match a known issue
   from the pattern (a SIGABRT a second or two after launch, a `gbm-off` file);
   say in the report that the error text wasn't captured. To see whether it is
   running right now, use `pgrep -x linger-client` (not `pgrep -f`, which
   matches its own command line).
4. **Stacks from AppImages are unreadable.** `coredumpctl info <pid>` shows the
   signal, but for an AppImage the stack ends in `n/a (n/a + 0x0)`: the
   AppImage has unpacked into a temporary folder that is gone by the time you
   look. Don't go hunting in it. Never attach or upload a core dump: it is a
   copy of the app's memory and can hold messages and tokens.

## 4. Search before drafting

A duplicate costs more than no report. Search open **and** closed issues, on
the symptom, the error text and the component, not on the title you were about
to write:

```bash
gh search issues --repo itsMattGuenther/Linger "<error text or symptom>"
gh issue list --repo itsMattGuenther/Linger --state all --search "<words>"
gh issue view <number> --repo itsMattGuenther/Linger --json title,state,body,comments,closedByPullRequestsReferences
```

Search words that work: the error text, `crash`, `launch`, `GBM`, `NVIDIA`,
`Wayland`, the version number, and the component (`voice`, `composer`,
`search`, `upload`). Phrases like "won't open" rarely match.

Read the issue body, not just the comments: `gh issue view --comments` prints
only the comments, and nothing at all for an issue with none, which looks like
an empty issue. The `--json` form above shows both.

- **A matching open issue:** add to it only if you have something it lacks: a
  new way to reproduce it, a different OS or GPU, an exact error, a version
  where it started. "Me too" is noise; if that's all there is, tell the user
  and file nothing.
- **A matching closed issue:** first check whether its fix has been
  **released**. Find the latest release with
  `gh release view --repo itsMattGuenther/Linger --json tagName,publishedAt`
  (with no tag it shows the one marked Latest; the `arch` package repository
  is a pre-release and never counts). Then check whether the fix is inside it:
  `gh pr view <pr> --repo itsMattGuenther/Linger --json mergeCommit`, and
  `gh api repos/itsMattGuenther/Linger/compare/<tag>...<merge commit sha> --jq .status`,
  where `behind` or `identical` means the release contains the fix, and
  `ahead` or `diverged` means it doesn't yet:
  - Fix **not in** the latest release: it's on its way. File nothing; tell the
    user it's fixed and arrives with the next update.
  - Fix released, and the problem still happens on that release or later: that
    is a **regression**. Say so in the report and link the closed issue; it is
    worth more than a new duplicate.

## 5. Draft it, with nothing private

Issues on GitHub are public. The draft must not contain, unless the user adds
it themselves after seeing it:

- any message text, or other people's names, statuses or activity
- the server's address, invite links, setup links, tokens or passwords
- **what windows or applications anybody has open** (Linger's own hard rule: it
  never reports this, and neither may a report about it)
- usernames, home-folder paths, hostnames, UIDs, machine IDs, boot IDs, and
  core-dump storage paths from command output; replace them with `<user>`, `~`
  or `<host>`, or leave them out
- core dumps, full logs, or screenshots showing other people's conversations

Use the shape in [`reporting.md`](reporting.md). Keep it plain: say what
happened, not what you suspect, and label a guess as a guess.

## 6. Show it, wait for yes, then file

Show the user the exact title and body, and wait for a clear yes. Change what
they ask for. Then:

- **Only if `gh auth status` succeeds**, file it:
  `gh issue create --repo itsMattGuenther/Linger --title "..." --body-file <file> --label bug`
  (`enhancement` for an idea). Give the user the link.
- **If `gh` is missing or not logged in, don't install it or log in for them.**
  Hand them the finished title and body, and the link
  <https://github.com/itsMattGuenther/Linger/issues/new/choose>.
- For a comment on an existing issue, the same rule applies:
  `gh issue comment <n> --repo itsMattGuenther/Linger --body-file <file>`.

**No AI attribution, anywhere.** No "generated by", no "reported with", no
signature line naming a tool or a model. The report is the user's. This is one
of Linger's hard rules.

## 7. When you file nothing

Most careful investigations end here, and that's a good result. Tell the user
in plain words:

- what you found, and which issue it is (with its link), or why it isn't
  Linger's and where it belongs instead;
- whether a fix exists, and whether it's released or coming with the next
  update;
- anything that helps meanwhile, such as a workaround in the issue or in the
  user guide's troubleshooting **for the version they run**:
  `https://github.com/itsMattGuenther/Linger/blob/v<version>/docs/user-guide.md#appimage-troubleshooting`.
  The guide on `main` may describe fixes that aren't released yet. Mark any
  workaround "untested" unless you tested it.

## Ideas, not bugs

A feature idea is welcome as an issue labelled `enhancement`. First check it
against what Linger has chosen **not** to be: [the "never" list in the
README](https://github.com/itsMattGuenther/Linger#what-it-does) and
[SPEC §2](https://github.com/itsMattGuenther/Linger/blob/main/SPEC.md#2-design-thesis).
No unread counts, no telemetry, no AI features, no roles, threads or
federation, nothing for sale. If the idea is one of those, say so kindly and
don't file it.

If the user wants to fix the problem themselves, the `linger-contribute` skill
covers making the change and opening a pull request.
