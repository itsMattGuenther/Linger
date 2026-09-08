<div align="center">
<img src="assets/logo/linger_logo.png" width="600px">
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

## ✨ What is implemented

- 🪑 **Rooms you're in** — focusing a room means you're in it; others see
  occupancy. Personal entrance sounds are planned and deferred
- 👥 **A roster-forward layout** — people are the primary surface, not a gutter; each
  friend is a card showing presence, the room they are in, and their status
- 🔕 **No unread counts** — a "you left off here" line and a subtle label-weight change,
  never a badge; notifications are for direct mentions and people you choose to follow
- ✍️ **Styled names** (the AIM feature) — curated fonts, a named 16-color palette,
  gradients, shimmer/glow; and **statuses** with away messages
- 🗄️ **Media** — everything ever shared, browsable and filterable; star things to
  keep them forever
- 📝 **Text that stays text** — a small markdown subset (bold, italic, strikethrough,
  code, quotes, lists, links), plus edit, delete and reply. Message bodies are parsed
  into a tree and drawn as elements; **no raw HTML from a message, ever**
- 🎚️ **Reactions by weight** — a fixed palette of 12; six identical reactions render
  denser and larger, not "👍 6"
- 📁 **File sharing** — 500 MB files, resumable uploads, **EXIF always stripped**, a
  poster frame and a blurhash generated for you
- 🖥️ **Desktop client** for Linux and Windows (Tauri 2, not Electron).
  macOS builds from source; published Mac installers are deferred
- 🏘️ **Several servers at once** — a list in the rail with a live dot each, and
  `+ add` to join another. Each one is its own sign-in, its own people and its own
  rooms; signing out of one leaves the rest alone
- 📦 **Full export** — any member can export public rooms and their own DMs,
  including shared files, without host approval
- 💬 **DMs and group DMs** — private to their participants within the server;
  people outside a DM cannot find it through messages, media, search or export
- 🎙️ **Voice rooms** — join, mute, push-to-talk, per-person volume and device
  selection. A host can run a relay for different networks. **Experimental:
  the tests across separate computers and networks are still open**
- 🚪 **Knock** *(the first piece of V2, built)* — nudge one person from their card in
  the roster. They get a soft knock and a card that fades on its own: no message, no
  thread, nothing to dismiss, and nothing written down at either end. Three an hour
  per person, and sounds are muted between 22:00 and 08:00 on your own clock
- 🔎 **Search** *(the second piece of V2, built)* — `search` sits in the rail under the
  rooms, next to `media`, and `Ctrl`/`Cmd`+`K` opens it. It covers what people typed and
  the names of the files they shared. Whole words with English endings folded together,
  so `photo` finds `photos`; several words means all of them; quotes mean a phrase.
  **No query language** — `AND` and `OR` are words to look for like any others, because
  a search box that quietly has a syntax is a search box that lies to most of the people
  typing in it. Newest first, always: no relevance ranking, no search history, no saved
  searches, nothing written down on either side. Click a hit and you land on that
  message in its room, however far back it is. A deleted message is findable by nothing
  — not its words, not the names of the files it was carrying

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

## 📦 Installing the client

**New here? The [user guide](docs/user-guide.md) covers installing and using
Linger in plain language** — no command line, nothing assumed.

Grab the installer for your platform from
[Releases](https://github.com/matthewguenther/Linger/releases). Linux and
Windows are built; **macOS is not built yet**, so on a Mac you build from a
checkout (see Development below).

**Windows will warn you.** You get *"Windows protected your PC"*, and *Run
anyway* is hidden behind the *More info* link. That is SmartScreen saying the
installer is not code-signed, which is true — see
[docs/decisions.md](docs/decisions.md) for why it isn't, and *Cutting a release*
for the difference between that and the signature on updates, which is in place.
Nothing about the download is broken.

Once installed, the app keeps itself up to date: it checks at launch, says so
quietly in the status bar, and downloads nothing until you ask it to under
*settings → updates*.

## 🚀 Running a server

**[The host guide](docs/host-guide.md) is the real instructions** — domain, DNS,
install, invites, backups, updates — written for somebody who is not a
developer. This is the short version.

```bash
cd deploy
# point two DNS records at this machine: linger.example and cdn.linger.example
# edit compose.yaml and Caddyfile: set both to your domain
docker compose up -d
docker compose logs linger   # prints a one-time setup URL on first run
```

Paste that setup URL into the desktop app, not a browser. It makes your account,
makes you the host, and names the server. It works once, and a restart replaces
it.

**It needs two names, and they have to be names.** An installed client only
talks `https`, and there is no certificate for a bare `IP:port` — so a server
without a domain is reachable from `pnpm tauri dev` and from nothing anybody
installed. The server says so at startup when `LINGER_DOMAIN` is unset. Buying a
domain is not required; two free dynamic-DNS names work. Uploads answer on the
`cdn.` name and nothing else does, because a file somebody sent you gets a lot
of latitude from a browser if it appears to come from the app itself. The server
refuses to start if both names point at one place.

Everything else is inside the app. As host you get `+ room` and `manage` on the
rail, which open one panel for rooms, invites, people, and the server's own name
and accent. Nobody else sees those controls. None of it needs `curl` and none of
it is a config file.

What hosts actually change, all in `compose.yaml`:

| | |
|---|---|
| `LINGER_POOL_BYTES` | total storage for files, default 50 GB |
| `LINGER_FILE_EXPIRY_DAYS` | default 365, or `off`. Starred and pinned files never expire |
| `LINGER_STORAGE: s3` | keep files in a bucket instead of on disk, plus five `LINGER_S3_*` lines. Pick Cloudflare R2 — it charges nothing for bytes going out, which is most of the bill for a place people share video |

**Backup is two paths**, `data/linger.db` and `data/objects/` (on S3, the second
one is the bucket):

```bash
sqlite3 data/linger.db ".backup data/backups/linger-$(date +%F).db"
```

**Locked out?** There is no reset email — Linger has no address to send one to,
so the proof that the server is yours is that you can reach the machine it runs
on. Stop the server, then `docker compose run --rm linger reset-password <name>`.

Uploads, expiry, S3, exports and what to do when something breaks are all in the
[host guide](docs/host-guide.md) at length.

## 🛠️ Development

```
crates/linger-core/       shared types, IDs, palette — the wire contract
crates/linger-server/     axum REST + WS gateway, SQLite (WAL), object store
client/                   Tauri 2 shell + React/TypeScript frontend
deploy/                   Dockerfile, compose, Caddyfile
docs/                     host-guide.md, user-guide.md, decisions.md and
                          screenshots; docs/tasks/ archives closed milestones
assets/fonts/             the twelve bundled faces, vendored rather than
                          fetched — no CDN and no remote font URL, ever, because
                          a remote face is a fingerprinting vector and somebody
                          else's uptime. See its own README before touching them
scripts/                  check.sh (the whole local gate) and the smaller
                          checks it calls
```

Read first, in order: [SPEC.md](SPEC.md) → [ARCHITECTURE.md](ARCHITECTURE.md) →
[PROTOCOL.md](PROTOCOL.md) → [AGENTS.md](AGENTS.md). The docs are the source of
truth, and if code and docs disagree the docs win. Contributing — with any coding
agent, or none — starts at [CONTRIBUTING.md](CONTRIBUTING.md); the work queue is
[TASKS.md](TASKS.md).

```bash
cargo test --workspace                        # server + core, no GUI deps
cd client && pnpm install && pnpm check && pnpm test
cd client && pnpm tauri dev                   # the desktop app
```

The desktop app is the only part that needs system libraries: a webview, ALSA
headers for the microphone, and cmake to build the bundled Opus codec.

The desktop icon comes from the friend group's selected
[porch artwork](<assets/logo/Linger Pixel Porch Icon Set FINAL.png>).
To regenerate the PNG, Windows ICO and macOS ICNS files after changing that
source, run `python3 scripts/app-icons.py` from the repository root after
`pnpm install` in `client`. It uses the pinned Tauri CLI and adds transparent
padding to make the source square, without cropping or stretching the artwork.

```bash
# Debian/Ubuntu
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev \
                 libayatana-appindicator3-dev librsvg2-dev libasound2-dev cmake
# Arch
sudo pacman -S webkit2gtk-4.1 gtk3 librsvg alsa-lib cmake
```

**Before you push, run `scripts/check.sh`.** It runs what CI runs, in the order
CI runs it — rules lint, version check, fmt, clippy, workspace tests, bindings
drift, frontend, and the desktop shell. Green there should mean green in CI. The
one thing it leaves out is `scripts/minio-test.sh`, which tests the S3 storage
backend against a throwaway MinIO; `cargo test --workspace` skips that code
entirely, so it proves nothing about S3 on its own.

For real desktop interaction, `python3 scripts/desktop-check.py` runs three
isolated Linux clients through live styling, private messages, uploads and a
browser-downloaded export. It needs additional test tools and built debug
binaries; see [desktop checks](docs/desktop-checks.md) for setup and the
[dated results](docs/desktop-check-results.md). It does not replace checks on
separate computers and networks.

Six things that catch people out. How the rest fits together is
[ARCHITECTURE.md](ARCHITECTURE.md).

- **Wire types and the color palette are generated, not written.** Both come out
  of `linger-core` when you run `cargo test -p linger-core`, into
  `client/src/generated/`. The output is committed and CI fails if it drifts, so
  commit the regenerated files alongside your change. Never hand-write a type
  that crosses the wire, and never put a hex or `oklch()` literal in the
  frontend — a color is a palette key everywhere.
- **Renaming a wire type leaves an orphan.** `ts-rs` writes files but never
  deletes them, so the old `.ts` stays behind and the drift check will not catch
  it. Delete it by hand.
- **The version number lives in four files** — `client/package.json`,
  `client/src-tauri/Cargo.toml`, `client/src-tauri/tauri.conf.json` and the root
  `Cargo.toml`. Bump all four together; `scripts/version-check.sh` fails if they
  disagree. If they drift, a release ships under the old number and every
  installed copy decides it is already up to date, which looks exactly like
  success.
- **`client/src-tauri` is not in the cargo workspace.** It links against webview
  libraries CI and server boxes do not have, so `cargo fmt`, `clippy` and `test`
  at the root never touch it. Build it with `pnpm tauri`; its own tests are `cd
  client/src-tauri && cargo test`. A few need a real desktop session — an
  unlocked keyring, for one — and are marked `#[ignore]`.
- **There are two content-security policies, and you develop under the loose
  one.** `pnpm tauri dev` may reach `http://localhost:*`; nothing you ship can.
  Tighten one and you must tighten both — `client/src-tauri/tests/csp.rs` fails
  if they drift apart.
- **File names that differ only in case break Windows and macOS.** They are the
  same file on both, so `Foo.tsx` beside `foo.ts` typechecks on Linux and fails
  everywhere else. `scripts/lint-rules.sh` rejects it.

### Cutting a release

`.github/workflows/release.yml` builds the installers, and only a tag fires it —
that job uses the signing key, so it has no business running on an ordinary push.

**Once, before the first release ever ships**, generate the update signing key:

```bash
scripts/updater-key.sh
```

It writes the public half into `client/src-tauri/tauri.conf.json` (commit that)
and prints what to do with the private half — back it up offline, then add it and
its password as repository secrets:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.local/share/linger/updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD   # prompts; paste the password
```

**Losing that key means you can never ship an update to an installed copy
again**, short of reinstalling every machine by hand. It is generated once and
never regenerated. To check the secrets without releasing anything, run the
`release` workflow from the Actions tab: it signs a throwaway file and checks
the key id against the committed public key, then stops. "Present" is not
"correct" — a key that signs fine but is not the mate of the committed one
produces a green release that no installed copy will accept.

**Per release:**

```bash
# bump the version in all four files, then:
scripts/version-check.sh
git commit -am "chore: 0.2.0"
git tag v0.2.0 && git push origin main v0.2.0
```

That builds Linux and Windows, signs the updater artifacts, and opens a **draft**
release carrying `latest.json`. Read it, then publish it — publishing is what
makes installed copies see the update, and it is a human's click on purpose. The
same tag publishes the server image to `ghcr.io/matthewguenther/linger` as
`0.2.0`, `0.2` and `latest`, for x86-64 and ARM64. Nothing about the image is
signed and nothing auto-updates; a host chooses when to `docker compose pull`.

**One thing to do by hand, once ever:** the first image push creates the ghcr
package as *private*, and a private package means `docker compose up` fails with
`unauthorized` for everybody who is not you. Set it public at
`github.com/users/<you>/packages/container/linger/settings`.

**Two signatures are easy to confuse.** The **update** signature is in place: the
app verifies it before installing anything, with no way to skip. The **installer**
signature — what your OS checks the first time you run a download — is the one
this project does not have, which is why Windows shows a warning. macOS is
deliberately not built at all yet. Both are decisions, not gaps; see
[docs/decisions.md](docs/decisions.md).

Current work queue lives in [TASKS.md](TASKS.md).

## 🗺️ Roadmap

- **V1** — replaces the text half of a big chat platform for one friend group
  (see [SPEC.md §6](SPEC.md))
- **Later (still V1, not on the critical path)** — entrance sounds (T-901…T-903).
  In the spec, not next. See [TASKS.md](TASKS.md) *Backburner*.
- **V2** — **knock (M9), search (M10) and DMs (M11) are built.** Voice rooms
  (M12) are most of the way there: the signalling, the audio path (microphone →
  Opus → peer connection → speakers) and the surface (join, mute, push-to-talk,
  who is talking, per-person volume, a device picker) and the relay a host runs
  for people on different networks are built. **None of it has crossed two
  machines yet.** Ambient voice is planned and not started; V1 still has to be
  installed and used by real people.
- **Backburner** — a mobile client. Desktop comes first and has to be solid
  before anything else starts.
- **V3 or never** — opt-in directory, sandboxed client scripting, custom emoji

## 📜 License

[AGPL-3.0](LICENSE). If you run a modified server for other people, they get the source.
That's the deal.
