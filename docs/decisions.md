# Decisions — settled questions and why

Moved from `TASKS.md` on 2026-08-25. These are settled. Reopening one is
Matt's call, not a maintenance decision. Tasks that lean on a decision here
point at this file.

## Decided — the password stays, the friction goes

**Matt, 2026-08-21.** The question was whether a locally-run server needs a
password at all, since Ventrilo asked for a name and nothing else. Answer: keep
it, but stop making people think about it.

The password is not protecting the messages — it is protecting *being you*. The
roster is the product, and the documented deployment is a box on the open
internet (ARCHITECTURE §7), so name-only would mean anyone who ever received an
invite link can connect as anybody. What was actually annoying was the
**12-character floor**, which is friction paid on every fresh install and buys
very little when the client already keeps the password in the OS keyring.

**Done in the same pass:** the floor is now **8**, which with no composition
rules is the NIST SP 800-63B position. One constant,
`linger-core::limits::MIN_PASSWORD_CHARS`; the server's error message counts off
it instead of spelling the number out, and the two client forms mirror it the
same way `Stream.tsx` mirrors `MAX_MESSAGE_CHARS`. PROTOCOL §2 says 8 and says
why.

The two bigger options were considered and **not** taken: making the invite link
itself the credential (a real change to PROTOCOL §2 and the refresh-token family
logic), and a host-set no-auth LAN mode (honest for a LAN party, dangerous the
day the box gets a public IP). If the friction comes back, those are the next
two rungs, in that order.

---

## Decided — the host's side

**Matt, 2026-08-21.** Four questions came out of reading T-410 before starting it.
The server-admin story is otherwise unchanged and already built: the host deploys
the image, reads the one-time setup URL out of the logs, pastes it into the
client, and from then on is a normal user with `is_host = 1`. Rooms and server
settings are database rows edited from inside the app — never a config file.

**No host transfer.** `is_host` stays a boolean that nobody can hand to anybody
else. If the host goes quiet, the friends stand up a new server. That is a real
answer for a group of eight, and it keeps a second root from growing on a product
whose anti-goals include a permission matrix (AGENTS rule 10).

**Removal, not banning** — T-413. A ban needs something durable to ban *by*, an
address or a device id, and Linger does not store either and should not. It would
not work anyway: housemates share one address and phone networks reshuffle them.
A removal here is already ban-shaped — usernames are unique and immutable, the
account row stays, and registration is invite-only, so the host is the only door
back in. One action, plus the reverse, so a removal made in a bad moment is
fixable.

**The M5 storage knobs are environment variables.** The 50 GB pool and the
365-day file expiry (SPEC §7) go in the compose file with everything else, per
the position `config.rs` already takes. No config-file format to document,
version, and migrate. Built that way in T-505: `LINGER_POOL_BYTES` (a plain
byte count or a size like `250GB`) and `LINGER_FILE_EXPIRY_DAYS` (a number of
days, or `off`). T-501 had parked the pool in a `server_config` row against a
host-facing endpoint that this decision says will not exist, so that row is
gone — one source of truth, and it is the environment.

**The printed setup URL is https when a domain is set** — fixed 2026-08-21, not a
task. The client keeps whatever scheme it is handed, for the REST base URL and
the gateway socket both, so printing `http://` pinned the host's own session to
plaintext on the very first thing they ever do. It falls back to `http` only for
a bare bind address, which has no certificate and is honestly plaintext.


---

## Decided — v1 ships unsigned, and macOS does not ship at all yet

**Matt, 2026-08-27.** M7 assumed installers would be code-signed on Windows and
notarized on macOS. Both turn out to be blocked on money rather than on work: a
Windows OV certificate is a few hundred dollars a year, and notarization needs an
Apple Developer Program membership at $99 a year. For a server you hand to a
friend group, neither is obviously worth buying yet.

**A correction that shaped this:** notarizing does not need a Mac in the room.
`release.yml`'s `macos-latest` runner is a Mac and can sign and notarize on its
own. The membership is the blocker. Somebody's Mac is still wanted for *opening*
the installer once — that is the T-002/T-003 sign-off, a different errand.

**So, for v0.1.0:**

- **Linux and Windows ship, unsigned.** Windows shows SmartScreen's
  "unrecognized app" warning, which is clickable past via *More info → Run
  anyway*. The README says so plainly rather than letting a friend discover it
  and assume the download is broken.
- **macOS does not ship.** Not even unsigned. Two reasons, and the second is the
  real one. Gatekeeper on recent macOS no longer takes a right-click → Open; it
  sends the user into System Settings to click past a malware warning. And the
  eventual move from an ad-hoc signature to a Developer ID one is precisely the
  transition that breaks an app the updater has replaced in place — so an
  unsigned macOS build now is not a step towards a signed one later, it is a
  thing that has to be uninstalled by hand. **Shipping nothing orphans nobody.**

**None of this is expensive to reverse.** The minisign updater key is
OS-independent and does not change. Adding a `darwin-aarch64` entry to a later
`latest.json` is a pure addition. With no macOS installs in the world, there is
nobody to strand.

**What this does to the queue:** T-702 keeps the half that is not blocked — the
release CSP hardening, and documenting the warning honestly. The signing itself
becomes **T-705**, parked until there is a certificate and an account. Note that
M7's milestone check says *a signed installer per OS*, so M7 closes on two
operating systems and unsigned; that is the decision, not an oversight.

---

## Decided — activity detection is cut, and mobile waits

**Matt, 2026-08-28.** Two calls on the same day, both about not building things.

### Activity detection is gone

It was V1 item 8 and SPEC §4.3: the client would watch which application you had
in front of you, resolve it against a bundled registry of ~200 apps, and show
the room "playing Factorio" or "♪ Bill Evans". It was parked on 2026-08-23 as
off the critical path. Five days later it is **deleted**, not parked.

**The reason is that a status already does it, and does it better.** If you want
people to know what you are playing, you type it. That is one line of effort,
once, and it is always right — it says what you meant rather than what a process
name implies. A status cannot mislabel your work project as a game, cannot
announce something you would rather not announce, and cannot leak on a day the
hide-list has a gap in it.

**Against that, the cost was enormous.** Four operating-system backends (KWin
over D-Bus, X11, Win32, `NSWorkspace`), a poller with a debounce, a curated
registry that somebody has to maintain forever, a local override file, and five
separate privacy controls — a global off switch, a per-server off switch, a
per-app hide list, an idle-only mode, and a persistent indicator — every one of
which exists only to make the feature safe enough to ship. When a feature needs
five controls to be safe and a typed sentence does the same job, the sentence
wins.

**What was deleted:** `crates/linger-activity/`, `registry/apps.json`, the
`ActivityInfo` wire type, the `activity` field on `PresenceEntry` and on
`presence.update`, the server's registry resolution, the Tauri `activity_probe`
command, the roster's activity line, and tasks T-911…T-917. SPEC §4.3 is now
just presence. ARCHITECTURE §6 keeps a short note about why it was hard, because
the reason (Wayland has no cross-compositor way to ask what window is in front)
is still true of anything else that reaches into the desktop.

**The rule that outlives it:** never report or transmit window titles, or what
application anybody has open. There is no code left that could, and no type with
a field that could carry it. AGENTS rule 2 is the enforceable version. Building
any of this back is Matt's call, not a maintenance decision — and the answer is
currently no, "if ever".

### Mobile moves to the backburner

It was going to be M14, the last V2 milestone. It is now on the backburner with
no milestone at all.

**Desktop first.** V1 is built and has not been through a single human check —
nobody has installed a release, watched an update land, uploaded a real video,
or pressed the export button. A mobile client doubles the surface of every bug
still in the desktop app, and it is a second set of stores, signing accounts,
review processes and release paths to keep green.

The unanswered question in front of it has not gone away and is recorded in the
parking lot: **push notifications go through Apple and Google, or they do not
exist.** There is no third way to wake a phone app, and the README's privacy
section does not currently allow for it. That has to be answered before any
mobile code is written, not during.

This is a "when the desktop app is boring" item, not a "next quarter" item.

---

## Decided — no AI features, said once

**Matt, 2026-08-28.** The product has no AI features. That has been true since
2026-08-19, when an earlier plan for local-only, opt-in features was dropped
before anything was built.

What changed today is the *volume*, not the decision. There was a SPEC section,
a README section, and a paragraph in the user guide arguing the case at length —
which turned "we don't have that feature" into a position the project campaigned
on. It was never meant to be a differentiator. It is now one bullet in SPEC §2's
anti-goals, alongside threads and algorithmic ordering, and one line in AGENTS
rule 13.

Kept here only so nobody restores the deleted sections thinking they were lost.
Adding an AI feature is still Matt's call rather than a maintenance decision;
there is just no need to explain that at length.

---

## Decided — reactions come out, as a trial

**Matt, 2026-09-24 (#168).** Emoji reactions on messages clutter the
conversation. The app no longer shows them or offers a way to add one. People
answer by replying or saying something, and the composer's emoji selector still
puts emoji into that text. This goes against the original design (SPEC §4.8,
V1 feature 11) on purpose. It is a trial to see how people take it.

**Taken out of the client only.** The server keeps the twelve keys, the
endpoints, the stored reactions, export and the `reaction.update` frame. So
bringing reactions back is a client change, nothing anybody already added is
lost, and an older client keeps working. The cost: somebody on 0.3.4 or earlier
can still add reactions and still sees them, and the new client does not.

If the trial sticks, removing the server side is a separate decision. It is a
protocol change that breaks older clients, and its migration deletes every
stored reaction.

---

## Decided — Omarchy and Arch get a package, from our own repository

**Matt, 2026-09-25 (#188).** The AppImage bundles an older WebKitGTK (2.50.4,
from the Ubuntu 22.04 build machine) so it runs on any Linux. On the Omarchy
machine that copy can't use the GPU display path at all (#187), and without it
typing and scrolling run a frame behind (#169). The system's WebKitGTK 2.52.6
has no such problem. Omarchy is popular in Matt's circle, so Omarchy and Arch
users get a package that uses the system's WebKit.

**How:** the program inside each release's `.deb` already runs on Arch against
the system's libraries, so the package repackages it (`packaging/arch/`); there
is no separate Arch build. It is served from a pacman repository on the `arch`
GitHub release, a pre-release so the in-app updater's `releases/latest` never
points at it. Omarchy's Update runs `pacman -Syu`, which checks every
repository, so new versions arrive with system updates. The repository only
changes when a release is **published**, keeping "publishing is a person's
click" true for pacman users.

**Signed.** A dedicated Linger packages OpenPGP key signs every package and the
database (fingerprint `A539799132574CE3EB51B01AB5FA9838135B10DF`). Its public
half is `packaging/arch/linger.asc`; the private half is the `ARCH_SIGNING_KEY`
secret, with an offline backup Matt keeps. Losing it means a new key that
everybody trusts again; leaking it means somebody could sign packages that
pacman installs as Linger.

**Not the AUR, yet.** AUR registration was closed on 2026-09-25. The same
recipe can be published there as `linger-bin` when it reopens.

