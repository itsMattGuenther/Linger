<div align="center">
<img src="assets/logo/linger_v2.png" width="600px" alt="Linger">
</div>

# Linger

**A small, self-hosted place for a group of friends to hang out.**

Text rooms, presence, and file sharing. One person runs a server and their friends
install a client and connect to it. Not federated. Not a platform. No company in the
middle.

> To linger is to stay somewhere with no agenda and no obligation to be doing
> anything. That is the product thesis in one word.

**Status: pre-alpha, under active construction.** The core features are implemented;
installation, updates and voice still have outstanding checks on real computers.
See the [release readiness review](docs/release-readiness.md) for the priorities
and [SPEC.md](SPEC.md) for the full product specification.

The [0.3.6 release notes](docs/releases/0.3.6.md) cover the new Omarchy/Arch
package, the AppImage's NVIDIA fix, movable quiet hours and the new
problem-reporting help since 0.3.5, upgrade steps, and the checks still open for
this testing release.

---

## 🧭 Why this exists

The big chat platforms are built for a stadium of fifty thousand strangers. Linger is
built for a dinner party of eight. Every feature decision resolves against three
principles, in order:

1. **Presence over messages.** The app should feel alive when nobody is typing.
2. **Remove obligation.** No counters, no streaks, no red dots, no "you're behind."
3. **Keep the artifact.** Photos, clips, links, and jokes don't scroll away into nothing.

## 🏠 The case for running your own

There was a stretch of the internet where a group of friends just *had* a place. Somebody
ran it. You knew who that was, you could ask them for things, and the whole arrangement
was a few files on a machine somebody owned. Then everyone moved into one enormous
building owned by a company, and the terms changed:

- **Your conversations sit on someone else's disk, and the company's business depends on
  what it can learn from them.** You are not the customer.
- **Features get held back and sold back to you.** The free experience gets a little
  worse on purpose, because friction is what makes an upsell work. That is not a bug in
  the design... it *is* the design.
- **There's a storefront in the middle of your conversation**, selling cosmetics and
  subscriptions nobody asked for.
- **The product changes under you** whenever a growth target does, and nobody asks.

Linger is the other arrangement. One person runs a server for their friends. The whole
thing is one binary, one SQLite file, and a folder of uploads — you can back it up, move
it to another box, read it with off-the-shelf tools, or walk away with all of it. There
is no account that spans servers, no directory, no company in the middle.

And there is nothing to sell you, structurally: no paid tier, no store, no cosmetics, no
premium anything, and none of it held back for later. It's AGPL-3.0, so if someone runs a
modified server for other people, those people get the source. **Zero telemetry** — not
opt-in, not anonymous, not crash reports.

This is not an attempt to build a better platform. It's an attempt to not need one.

## 🗣️ Vocabulary

These terms are used everywhere — UI, code, docs, error messages:

| Concept | Term |
|---|---|
| An instance | **a server** |
| A text channel | **a room** |
| Being present in a room | **in the room** |
| The person running it | **the host** |
| Media/link archive | **media** |
| A user's status card | **their status** |

## ✨ What it does

- 🪑 **Rooms you're in.** Focusing a room means you're in it, and everyone sees
  who's where.
- 👥 **People first.** The right-hand panel is a stack of cards, one per friend:
  presence, which room they're in, and their status.
- 🔕 **No unread counts.** Rooms and DMs open at "you left off here", and a room
  with something new just gets a heavier name. Never a badge. Notifications are
  for direct mentions and people you choose to follow.
- ✍️ **Styled names and statuses** (the AIM feature): curated fonts, a named
  16-color palette, gradients, shimmer and glow, and away messages.
- 📝 **Text that stays text.** A small markdown subset, edit, delete and reply,
  drawn as elements, with **no raw HTML from a message, ever**. No reactions,
  for now: a trial of answering by saying something, emoji and all.
- 📁 **Files and media.** 500 MB uploads, resumable, **EXIF always stripped**. The
  Media view collects everything ever shared; star things to keep them forever.
- 💬 **DMs and group DMs**, private to the people in them: nobody else can find
  them through messages, media, search or export.
- 🎙️ **Voice rooms.** Mute, deafen, push-to-talk, per-person volume and device
  choice, with a relay the host can run for friends on different networks.
  **Experimental: the checks across separate computers and networks are still
  open.**
- 🚪 **Knock.** Nudge one person from their card: a soft sound and a card that
  fades on its own. No message, nothing written down.
- 🔎 **Search** (`Ctrl`/`Cmd`+`K`) through what people said and the names of files
  they shared. Newest first, no query language, no search history.
- 🔉 **Optional chimes** for voice, mic/deafen, DMs and knocks, with a master
  switch and quiet hours you can move. Room-message sounds start off.
- 📦 **Full export.** Any member can export public rooms and their own DMs,
  with files, without asking the host.
- 🏘️ **Several servers at once**, each its own sign-in, people and rooms.
- 🖥️ **A desktop app for Linux and Windows** (Tauri 2, not Electron), readable at
  100–200% interface scale, in dark, light or system theme. macOS builds from
  source; Mac installers aren't published yet.

## 🚫 What it will never have

XP, levels, streaks, or engagement metrics. Federation. A bot marketplace. A
role/permission matrix. Threads. `@everyone`. Algorithmic ordering. Unread badges.
**Telemetry or analytics of any kind.** A paid tier, a store, or anything else to sell
you. AI features. Anything that watches which applications you have open — your status
is where you say what you are doing, because you typed it.

The scope discipline is the product.

## 🔐 Privacy and the threat model

Stated plainly:

> Messages and files travel over TLS in a deployed server. Linger does not encrypt
> its database or stored files; encryption at rest depends on the host's disk or
> storage provider configuration.
> **The person running the server can read everything on it.** There is no
> end-to-end encryption. Run your own server, or trust the person who runs the one
> you're on. If you need cryptographic guarantees against your host, use Signal.

Other privacy properties that *are* guaranteed:

- **Nothing watches what applications you have open.** There is no activity
  detection in Linger and there is no code that could read a window title. If you
  want people to know what you are playing or listening to, you type it into your
  status — see [the decision](docs/decisions.md), 2026-08-28
- EXIF (including GPS) is stripped from every uploaded image, no toggle
- Zero telemetry and zero crash reporting — not even opt-in. The client does
  contact GitHub to check for application updates

## 📦 Installing the app

**New members need an invite link from their host.** The
[user guide](docs/user-guide.md) walks through everything below in plain
language, including what to do when something goes wrong.

| Your computer | How |
|---|---|
| **Omarchy or Arch** | Run the one-time setup below. Updates then come with your system updates. |
| **Windows** | The `…x64-setup.exe` from the [latest release](https://github.com/itsMattGuenther/Linger/releases/latest). |
| **Ubuntu, Debian, Mint** | The `…amd64.deb`: `sudo apt install ~/Downloads/Linger_<version>_amd64.deb` |
| **Fedora, openSUSE** | The `…x86_64.rpm`: `sudo dnf install` (or `zypper install`) the file |
| **Any other Linux** | The `…amd64.AppImage`: `chmod +x` it, then run it |

**Omarchy and Arch** get Linger from its own signed pacman repository. It uses
the system's WebKit, which is the fast option on Omarchy: the AppImage's older
bundled WebKit can't use the GPU on NVIDIA + Wayland machines. The script
trusts Linger's signing key after checking its fingerprint, adds the
repository and installs Linger; the [user guide](docs/user-guide.md#arch-and-omarchy)
shows each step it takes.

```bash
curl -fsSL https://raw.githubusercontent.com/itsMattGuenther/Linger/main/packaging/arch/setup.sh | bash
```

**Windows will warn you** with *"Windows protected your PC"*; *Run anyway* is
behind *More info*. The installer isn't code-signed, which is a
[decision](docs/decisions.md), not a broken download. Updates are signed, and
the app checks that signature before installing anything.

**Updates.** Settings → Account & App → Updates checks for a new version and
downloads nothing until you choose *install and restart*. The Arch package
updates with the system instead.

## 🚀 Running a server

**[The host guide](docs/host-guide.md) is the step-by-step path**: a VPS or a
computer at home, Docker, DNS, first-run setup, voice, backups and updates.
[Creating your first VPS](docs/vps-setup.md) covers SSH keys and the cloud
firewall. The short version, for someone who already has Docker:

```bash
mkdir linger && cd linger
curl -fLO https://raw.githubusercontent.com/itsMattGuenther/Linger/main/deploy/compose.yaml
curl -fLO https://raw.githubusercontent.com/itsMattGuenther/Linger/main/deploy/Caddyfile
# point two DNS names at this machine (yours, and cdn. in front of it);
# allow incoming TCP 80 and 443; put both names in compose.yaml and Caddyfile
docker compose run --rm --user root --entrypoint chown linger linger:linger /data
docker compose up -d
docker compose logs linger   # prints a one-time setup link on first run
```

Paste that setup link into the desktop app, not a browser. It makes your
account, makes you the host and names the server. It works once.

- **It needs two names, and they have to be names.** An installed app only
  talks `https`, and there's no certificate for a bare `IP:port`. Free
  dynamic-DNS names work. Files are served only from the `cdn.` name, and the
  server refuses to start if both names point at one place.
- **Voice between different networks needs the relay:** follow the
  [voice setup](docs/host-guide.md#voice-between-different-networks), then
  `docker compose --profile voice up -d`.
- **Everything else is in the app.** The host gets a `+` beside Rooms and a
  **⋯** menu beside the server for settings, invites, rooms and members.

What hosts change, in `compose.yaml`:

| | |
|---|---|
| `LINGER_POOL_BYTES` | total storage for files, default 50 GB |
| `LINGER_FILE_EXPIRY_DAYS` | default 365, or `off`. Starred and pinned files never expire |
| `LINGER_STORAGE: s3` | keep files in a bucket instead of on disk, plus five `LINGER_S3_*` lines. Cloudflare R2 charges nothing for bytes going out, which is most of the bill |

**Backup is two paths**, `data/linger.db` and `data/objects/` (on S3, the
second one is the bucket):

```bash
sqlite3 data/linger.db ".backup data/backups/linger-$(date +%F).db"
```

**Updating:** `docker compose pull && docker compose up -d` (add
`--profile voice` to both if you run the relay). Nothing updates itself.

**Locked out?** There's no reset email; being able to reach the machine is the
proof the server is yours. Stop the server, then
`docker compose run --rm linger reset-password <name>`.

## 🐞 Reporting a problem

Open an [issue](https://github.com/itsMattGuenther/Linger/issues/new/choose);
the forms ask for what a report needs. Issues are public, so leave out message
text, other people's names, server addresses and invite links.

Using a coding agent such as Claude Code or Codex? The
[`linger-report` and `linger-contribute` skills](agents/) teach it to look into
a problem, check whether it's already known or fixed, and draft the issue, or to
make a fix and open a pull request the way this project needs. It shows you
everything first and files nothing without your yes.

## 🛠️ Development

```
crates/linger-core/       shared types, IDs, palette — the wire contract
crates/linger-server/     axum REST + WS gateway, SQLite (WAL), object store
client/                   Tauri 2 shell + React/TypeScript frontend
deploy/                   Dockerfile, compose, Caddyfile
packaging/arch/           the Arch/Omarchy package, its signing key and the
                          script that builds the pacman repository
agents/                   skills for people's own coding agents
docs/                     guides, decisions, release notes and checks;
                          docs/tasks/ archives closed milestones
screenshots/              current Console review images and their capture notes
assets/fonts/             the twelve bundled faces, vendored rather than
                          fetched — no CDN and no remote font URL, ever
scripts/                  check.sh (the whole local gate) and the smaller
                          checks it calls
```

Read first, in order: [SPEC.md](SPEC.md) → [ARCHITECTURE.md](ARCHITECTURE.md) →
[PROTOCOL.md](PROTOCOL.md) → [AGENTS.md](AGENTS.md). The docs are the source of
truth, and if code and docs disagree the docs win. Contributing, with any coding
agent or none, starts at [CONTRIBUTING.md](CONTRIBUTING.md); the work queue is
[TASKS.md](TASKS.md).

```bash
cargo test --workspace                        # server + core, no GUI deps
cd client && pnpm install && pnpm check && pnpm test
cd client && pnpm tauri dev                   # the desktop app
```

The desktop app is the only part that needs system libraries: a webview, ALSA
headers for the microphone, cmake for the bundled Opus codec, and the GStreamer
plugins for sound.

```bash
# Debian/Ubuntu
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev \
                 libayatana-appindicator3-dev librsvg2-dev libasound2-dev cmake \
                 gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-pulseaudio
# Arch
sudo pacman -S webkit2gtk-4.1 gtk3 librsvg alsa-lib cmake gst-plugins-base gst-plugins-good
```

**Before pushing code, run `scripts/check.sh`.** It runs what CI runs, in the
order CI runs it. The browser tests, the S3 and relay checks, packaging, the
things that catch people out, and how the app starts on Linux are in
[docs/development.md](docs/development.md). Cutting a release, including the
Arch package, is in [docs/releasing.md](docs/releasing.md).

## 🗺️ Roadmap

- **V1** — replaces the text half of a big chat platform for one friend group
  (see [SPEC.md §6](SPEC.md))
- **Later (still V1, not on the critical path)** — entrance sounds (T-901…T-903).
  In the spec, not next. See [TASKS.md](TASKS.md) *Backburner*.
- **V2** — **knock (M9), search (M10) and DMs (M11) are built.** Voice rooms
  (M12) are built, including the relay a host runs for people on different
  networks, but **the checks across separate computers and networks are still
  open.** Ambient voice is planned and not started; V1 still has to be
  installed and used by real people.
- **Backburner** — a mobile client. Desktop comes first and has to be solid
  before anything else starts.
- **V3 or never** — opt-in directory, sandboxed client scripting, custom emoji

## 📜 License

[AGPL-3.0](LICENSE). If you run a modified server for other people, they get the source.
That's the deal.
