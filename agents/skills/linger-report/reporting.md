# The shape of a Linger issue

Read this when drafting (step 5 of `SKILL.md`). The GitHub issue form asks for
the same things, so a report drafted this way can be pasted into it too.

## Title

What goes wrong, where, in plain words. Not a guess at the cause.

- Good: `Voice names jump when someone starts talking, at 200% scale`
- Good: `App closes on launch on NVIDIA + Wayland (0.3.5 AppImage)`
- Not: `Bug in VoiceBar.tsx`, `Linger broken`, `Please fix ASAP`

## Body

```markdown
## What happened

<One or two sentences, in the user's words. What they saw, not why.>

## Expected

<What should have happened.>

## Steps to reproduce

1. Open Linger ...
2. ...
3. ...

Happens: every time / sometimes / once.

## Where

- Linger: <version>, installed as <Windows .exe/.msi | AppImage | .deb | .rpm | Arch/Omarchy package>
  (for an AppImage, say how the version was checked; the file name can be stale)
- OS: <name and version>
- Linux only: <desktop or window manager>, <Wayland | X11>
- Graphics: <GPU(s) from lspci; say if there are two>, driver <version>, Mesa <version>;
  WebKitGTK <version> for a package install
- Launched by: <menu entry's Exec= line, if it sets any variables>
- Interface scale: <if it's a layout problem>
- Voice only: <devices>, <same network | different networks>

## Evidence

<Exact error text, crash signal, when and how often it happened (from
coredumpctl / journalctl), what ~/.local/state/linger/ held, trimmed command
output. Screenshots or a recording, cropped to the problem. Nothing private.>

## Related

<Existing issues this may relate to, e.g. "Looks like a regression of #127
(closed), still happens on 0.3.5". Omit if none.>
```

Leave out any section that has nothing true to say. An honest "not sure" beats
a filled-in guess.

## Before showing it to the user

Read the draft once more for:

- message text, other people's names or statuses
- server addresses, invite or setup links, tokens
- which windows or apps anybody has open
- usernames, home paths, hostnames, UIDs, machine IDs, boot IDs and core-dump
  paths in pasted output
- any line naming an AI tool or model as author or helper

Remove every one of them, then show the user the exact title and body.
