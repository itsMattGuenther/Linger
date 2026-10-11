# Linger — Architecture

Companion to `SPEC.md`. Wire protocol is in `PROTOCOL.md`. Agent working rules are in
`AGENTS.md`.

---

## 1. Shape

```
┌────────────────────────────────────────────┐
│  CLIENT (Tauri 2)                          │
│                                            │
│  Frontend — TypeScript + React + Vite      │
│    message list (virtualized)              │
│    roster, composer, settings              │
│                                            │
│  Core — Rust                               │
│    gateway client (WS, resume, backoff)    │
│    token storage (OS keyring)              │
│    voice (WebRTC, microphone, speakers)    │
└────────────────────────────────────────────┘
                    │ WSS + HTTPS
                    ▼
┌────────────────────────────────────────────┐
│  SERVER (single Rust binary)               │
│                                            │
│  axum   REST + WS gateway                  │
│  SQLite (WAL)  messages, users, rooms      │
│  Object store adapter                      │
│    local filesystem | S3-compatible        │
│  Background: media processing, expiry      │
└────────────────────────────────────────────┘
```

Deployment is one binary plus one data directory, or one Docker image.

---

## 2. Stack decisions and why

| Choice | Reason | When to revisit |
|---|---|---|
| **Rust server (axum + tokio)** | A single static binary is a dramatically better self-host story than "install Node, install pnpm, run migrations." Also lets client and server share types. | Never for V1. |
| **SQLite (WAL), not Postgres** | 20 friends, a few hundred messages a day. Postgres is ceremony at this scale. One file to back up. | Only if a server exceeds ~2k users or needs multi-node. A `Repository` trait keeps the swap cheap. |
| **Tauri 2, not Electron** | Uses the OS WebView rather than bundling a browser; the gateway, keyring and audio live in Rust. Installed size, startup time and memory use still need release measurements (T-910). | Only if WebKitGTK rendering on Linux becomes untenable. |
| **TypeScript + React frontend** | Largest ecosystem for virtualized lists and rich text; fastest to iterate. | — |
| **Object store adapter, not blobs in DB** | 500 MB files must never traverse the app server. | — |

### The Tauri caveat, stated up front

Tauri uses the OS WebView: WebView2 on Windows, WKWebView on macOS, **WebKitGTK on
Linux**. WebKitGTK is the weak link — it lags on newer CSS and has historically been
rough with WebRTC.

Consequences:
1. **Test on Linux first, every milestone.** If it works on WebKitGTK it works
   everywhere. The reverse is not true.
2. **Keep V2 audio in Rust, not in the WebView.** Use a Rust WebRTC stack (`webrtc-rs`)
   with `cpal` for device I/O. This is the better architecture anyway and it removes
   WebKitGTK from the critical path for voice.
   Mute and deafen are enforced here too: the outgoing encoder receives silence
   while muted, and the speaker mixer discards voice while deafened, including
   queued samples. The page requests both controls together; the native engine
   applies them before sharing their state with the room (PROTOCOL §8).
   Gateway delivery marks replayed frames in its local WebView envelope, not
   on the wire. State still catches up without chimes; existing mention-banner
   batching is unchanged. The existing sound player owns all notification audio;
   native desktop banners explicitly request silent presentation.
   Notification chimes are rendered in the WebView and, in the desktop app,
   played by the shell on the Speakers picked in Settings (#250): the samples
   go to `sound_play`, which mixes them into the call's output in voice and
   otherwise opens a short-lived CPAL output on that device (`sounds.rs`). The
   WebView can't choose an output (WebKitGTK has no `setSinkId`; WebView2's
   device names don't match CPAL's), and its audio could start late in a
   window that isn't in front (#241). Web Audio playback in the WebView is
   the fallback, and what plays outside the app. For it, Linux AppImages must
   bundle GStreamer and its playback plugins; DEB/RPM packages must require
   those plugins through the system package manager. Windows installers ensure
   WebView2 is installed. Package checks exercise that fallback's real WebView
   audio graph; a browser unit test alone cannot establish that these runtime
   files shipped.
   The shared score is rendered once per cue into a cached, mono audio buffer
   at the context's sample rate. Each buffer includes 50 ms of zero samples
   before its attack so output startup cannot cut into the note. Preview and
   live notifications use the same buffers and retain their existing policy.
3. Avoid CSS features newer than ~2023 without checking WebKitGTK support. `oklch()` is
   supported and is required by §4.5 of the spec; verify it in the target WebKitGTK
   version during M0.

Linux startup accepts an explicit `LINGER_LINUX_BACKEND=wayland` or `x11`
before initializing GTK. This app-specific choice overrides an AppImage
launcher's `GDK_BACKEND` assignment. Without an explicit choice, a nonempty
`WAYLAND_DISPLAY` selects native Wayland; other desktops keep the packaging
fallback. Invalid values fail clearly. It is a per-launch option, not a global
desktop change. See `docs/linux-input-checks.md` for packaged evidence and
hardware limits.

WebKit's GPU display path (GBM) is decided per launch unless
`WEBKIT_DMABUF_RENDERER_DISABLE_GBM` is set explicitly. It is on under native
Wayland for builds that run the system's WebKitGTK, because without it typing
runs a frame behind (#169). It is off
in the AppImage, whose bundled WebKitGTK 2.50.4 aborts creating a GBM display
on NVIDIA + Wayland machines (#187), and off under X11. A launch that tries it
leaves a probe in `$XDG_STATE_HOME/linger` naming its WebKit version; the page
clears it after drawing two frames. A probe still there at the next launch
means that launch died, so `gbm-off-<version>` keeps that WebKit off the GPU
path (`client/src-tauri/src/graphics.rs`, `linux_startup.rs`). Every launch
also holds a lock on `running.lock` there until it exits. A launch that finds
it held is a second copy, which the single-instance plugin hands over to the
running Linger before its page could draw, so it neither leaves a probe nor
reads one (#447).

With GBM off, WebKit's page process draws through a surfaceless EGL display on
whichever GPU the graphics drivers offer, not the window's, and still hands its
frames over as GPU buffers. On a computer with two GPUs the window may be unable
to read any of them and stays grey while the page draws (#433). So whenever GBM
is off, by Linger or by hand, and `/sys/class/drm` lists more than one
`renderD<n>`, startup also sets `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1` unless it
is already set: frames reach the window in ordinary memory, which any GPU can
show.

On NVIDIA's legacy driver (the 580 branch and older, which Maxwell, Pascal and
Volta cards need), startup sets `GDK_GL=disable` unless `GDK_GL` is already
set (#229). With that driver, GTK's GL drawing crashed when one Linger window
was resized while another was open: GTK finished a frame with the other
window's GL context and read its NULL paint surface. With GTK's GL off, WebKit
turns hardware acceleration off too and paints on the CPU, so there is no GBM
probe on those launches. The driver version comes from
`/sys/module/nvidia/version`; the 610 driver keeps the GPU.

The same startup path ignores `SIGHUP` so closing the launching terminal does
not kill the window, and an AppImage writes a user menu entry
(`com.linger.desktop`) so the next open does not need a terminal. Packaged
`.deb` / `.rpm` installs already ship a system launcher. The entry's `Exec`
line (the AppImage file rather than its temporary mount, quoted, with any
backend or GPU setting somebody chose by hand) is built in `desktop_entry.rs`,
which the sign-in entry shares: Settings → Account & App can write an XDG
autostart entry of the same shape (#228, `autostart.rs`), off until somebody
turns it on.

Arch and Omarchy get a pacman package from Linger's own repository (#188),
built by repackaging the release `.deb` (`packaging/arch/`), so it runs against
the system's WebKitGTK. The package installs `share/linger/package-manager`
beside the program. With that marker present the in-app updater reports
"managed" and never installs anything (the program inside is stamped for
Debian's installer), and startup removes a stale AppImage menu entry, which
would otherwise shadow the package's own launcher
(`client/src-tauri/src/packaging.rs`).

---

## 3. Repository layout

```
linger/
├─ SPEC.md
├─ ARCHITECTURE.md
├─ PROTOCOL.md
├─ AGENTS.md
├─ Cargo.toml                 # workspace
├─ crates/
│  ├─ linger-core/             # shared types, ID generation, color palette
│  ├─ linger-server/           # axum, SQLite, object store, gateway
├─ client/
│  ├─ src-tauri/              # Tauri shell, commands, keyring, gateway client
│  └─ src/                    # React frontend
├─ assets/
│  ├─ fonts/                  # subset, bundled
│  └─ sounds/                 # curated entrance sounds
└─ deploy/
   ├─ Dockerfile
   ├─ compose.yaml            # linger + caddy
   └─ Caddyfile
```

`linger-core` is the contract. Types defined there are exported to TypeScript via `ts-rs`
during build. **The frontend never hand-writes a type that crosses the wire.**

---

## 4. Identifiers

**UUIDv7**, stored in SQLite as `BLOB(16)`, rendered on the wire as lowercase hex.

- Time-sortable, so `ORDER BY id` is chronological and pagination is a simple range scan
- No coordination needed, unlike Snowflake
- 16 bytes indexed, not 36 bytes of text

Do not use auto-increment integers (leaks volume, breaks any future merge) and do not
use UUIDv4 (destroys index locality).

---

## 5. Schema

SQLite, WAL mode, `foreign_keys=ON`, `synchronous=NORMAL`.

```sql
CREATE TABLE users (
  id              BLOB PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,        -- lowercase, [a-z0-9_]{2,24}
  display_name    TEXT NOT NULL,
  password_hash   TEXT NOT NULL,               -- argon2id
  is_host         INTEGER NOT NULL DEFAULT 0,
  is_cohost       INTEGER NOT NULL DEFAULT 0,  -- set by the host only (#424, 0010)
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER,
  deactivated_at  INTEGER
);

-- name and message styling; see SPEC §4.5
CREATE TABLE user_style (
  user_id         BLOB PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  font_key        TEXT NOT NULL DEFAULT 'geist-sans',
  weight          INTEGER NOT NULL DEFAULT 500,
  italic          INTEGER NOT NULL DEFAULT 0,
  fill_kind       TEXT NOT NULL DEFAULT 'solid',   -- solid | gradient
  fill_from       TEXT NOT NULL DEFAULT 'slate',   -- palette key; solid uses this alone
  fill_to         TEXT,                            -- palette key; gradient only
  effect          TEXT NOT NULL DEFAULT 'none',    -- none | shimmer | glow
  msg_font_key    TEXT
);

-- the user status card; see SPEC §4.6
CREATE TABLE user_status (
  user_id         BLOB PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  line            TEXT,                        -- 240 chars
  reading         TEXT,                        -- these three: kept in step with the fields
  listening       TEXT,                        --   labelled "Reading", "Listening to" and
  working_on      TEXT,                        --   "Working on" since 0007 (#270), never read
  image_key       TEXT,                        -- left over, always NULL: cleared by 0006 (#269)
  away_message    TEXT,                        -- supersedes `line` when set
  away_since      INTEGER,
  updated_at      INTEGER NOT NULL
);

-- a status's short fields, each a label the person chose and a value (#270);
-- PROTOCOL §5 says how older apps' three fixed fields map onto them
CREATE TABLE user_status_fields (
  user_id         BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,            -- 0, 1 or 2: the order they show in
  label           TEXT NOT NULL,               -- 24 chars
  value           TEXT NOT NULL,               -- 80 chars
  PRIMARY KEY (user_id, position)
);

CREATE TABLE entrance_sounds (
  user_id         BLOB PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sound_key       TEXT NOT NULL                -- bundled key, or object key for custom
);

CREATE TABLE rooms (
  id              BLOB PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,        -- [a-z0-9-]{1,32}; `dm-` reserved
  name            TEXT NOT NULL,
  topic           TEXT,
  kind            TEXT NOT NULL DEFAULT 'room',-- room | dm (M11)
  member_key      TEXT UNIQUE,                 -- DMs: sorted member ids, canonical
  position        INTEGER NOT NULL,
  archived_at     INTEGER,
  created_at      INTEGER NOT NULL,
  motd            TEXT,                        -- message of the day (#464); the three
  motd_set_by     BLOB REFERENCES users(id),   -- are null together, and always so
  motd_set_at     INTEGER,                     -- for a DM
  reactions_off   INTEGER NOT NULL DEFAULT 0   -- host turned reactions off (#485); never a DM
);

-- Who is in a DM (SPEC §4.13). Rooms have no rows here: their members are
-- everybody, and writing that out would be a copy of the user table that goes
-- stale the moment somebody joins. `member_key` is what makes create-or-find
-- work — the ids sorted and joined, so the same set of people always produces
-- the same string, and UNIQUE is what settles two people asking at once.
CREATE TABLE room_members (
  room_id         BLOB NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id         BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE messages (
  id              BLOB PRIMARY KEY,            -- UUIDv7: chronological
  room_id         BLOB NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  author_id       BLOB NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL,
  reply_to        BLOB REFERENCES messages(id) ON DELETE SET NULL,
  pinned_at       INTEGER,
  edited_at       INTEGER,
  deleted_at      INTEGER,
  created_at      INTEGER NOT NULL,
  motd            INTEGER NOT NULL DEFAULT 0,  -- 1: the line saying a message of the
                                               -- day was set; never last_message_id
  voice_join      INTEGER NOT NULL DEFAULT 0,  -- 1: the line saying somebody joined
                                               -- voice (#473); never last_message_id
  poll_closed     BLOB REFERENCES messages(id) -- on the line a closing poll leaves (#474):
                                               -- which poll; never last_message_id
);
CREATE INDEX idx_messages_room ON messages(room_id, id DESC);
CREATE INDEX idx_messages_pinned ON messages(room_id, pinned_at) WHERE pinned_at IS NOT NULL;
CREATE INDEX idx_messages_voice_join ON messages(room_id, author_id, created_at) WHERE voice_join = 1;

CREATE TABLE attachments (
  id              BLOB PRIMARY KEY,
  message_id      BLOB REFERENCES messages(id) ON DELETE CASCADE,
  uploader_id     BLOB NOT NULL REFERENCES users(id),
  object_key      TEXT NOT NULL,
  filename        TEXT NOT NULL,
  mime            TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  width           INTEGER,
  height          INTEGER,
  duration_ms     INTEGER,
  blurhash        TEXT,
  poster_key      TEXT,                        -- video poster frame
  display_key     TEXT,                        -- an image as drawn small: its copy, or itself (#382)
  starred_at      INTEGER,                     -- starred => never expires
  state           TEXT NOT NULL,               -- pending | complete | failed
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_attachments_media ON attachments(created_at DESC) WHERE state='complete';

-- One row per URL in a message body, re-extracted on every edit. This is what
-- the media grid pages over for `kind=link`; the stream re-extracts client-side
-- for the inline card. See SPEC §4.4 and §5.6.
CREATE TABLE message_links (
  message_id      BLOB NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,            -- 0-based, order of appearance
  url             TEXT NOT NULL,
  PRIMARY KEY (message_id, position)
);
CREATE INDEX idx_message_links_message ON message_links(message_id DESC);

-- What the web said about a URL: a shared cache, not per-message state. The
-- host's own IP does the fetching, behind the SSRF guard in `links.rs`, and the
-- favicon is stored as a small data: URI so that reading a message never makes
-- a request from the reader's machine.
CREATE TABLE link_previews (
  url             TEXT PRIMARY KEY,
  state           TEXT NOT NULL,               -- ok | failed
  title           TEXT,
  icon            TEXT,                        -- small data: URI, or NULL
  fetched_at      INTEGER NOT NULL
);

-- Full-text search (SPEC §4.12). One FTS5 row per message, keyed by the
-- message's implicit rowid, carrying its own copy of the text — an external
-- `content=` table cannot produce a snippet, and a filename does not live in
-- `messages` at all. It is maintained entirely by triggers on `messages` and
-- `attachments`, so no application code can forget to index something.
--
-- Two invariants: a message with `deleted_at` set has **no row here at all**
-- (its words and its filenames both leave, the rule the export follows), and an
-- edit replaces its row rather than adding to it. `filenames` joins the names
-- with `char(31)`, which `validate::filename` guarantees cannot occur inside
-- one, so a hit can say which file it matched.
CREATE VIRTUAL TABLE message_fts USING fts5(
  body,
  filenames,
  tokenize = "porter unicode61 remove_diacritics 2"
);

CREATE TABLE reactions (
  message_id      BLOB NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id         BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,               -- one emoji, or emoji:<id> for a server's own (#485)
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, key)
);

-- Polls (SPEC §4.18, #474). A poll is a message; these hold its question, its
-- choices, who picked what, and when it closes. Votes aren't secret.
CREATE TABLE polls (
  message_id      BLOB PRIMARY KEY REFERENCES messages(id),
  question        TEXT NOT NULL,
  multi           INTEGER NOT NULL DEFAULT 0,  -- 1: people may pick more than one
  closes_at       INTEGER NOT NULL,            -- when it closes on its own
  closed_at       INTEGER,
  closed_by       BLOB REFERENCES users(id)    -- null when it closed on its own
);
CREATE INDEX idx_polls_open ON polls(closes_at) WHERE closed_at IS NULL;
CREATE TABLE poll_choices (
  message_id      BLOB NOT NULL REFERENCES polls(message_id),
  position        INTEGER NOT NULL,            -- what a vote names; never changes
  text            TEXT NOT NULL,
  PRIMARY KEY (message_id, position)
);
CREATE TABLE poll_votes (
  message_id      BLOB NOT NULL REFERENCES polls(message_id),
  position        INTEGER NOT NULL,
  user_id         BLOB NOT NULL REFERENCES users(id),
  voted_at        INTEGER NOT NULL,
  PRIMARY KEY (message_id, position, user_id)
);

CREATE TABLE read_markers (
  user_id         BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id         BLOB NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  last_read_id    BLOB NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, room_id)
);

CREATE TABLE notify_rules (
  user_id         BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id  BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id         BLOB REFERENCES rooms(id) ON DELETE CASCADE,  -- NULL = all rooms
  PRIMARY KEY (user_id, target_user_id, room_id)
);

-- Report and block (SPEC §4.15, PROTOCOL §5, T-1605). A block is one
-- person's private list; the server only stops their knocks.
CREATE TABLE blocks (
  user_id         BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- who blocked
  blocked_id      BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);

-- A report goes to the host and the co-hosts only, keeping the message's
-- words as they were.
CREATE TABLE reports (
  id              BLOB PRIMARY KEY,
  reporter_id     BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id         BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- who it's about
  message_id      BLOB,                       -- no reference: the message may be deleted
  room_id         BLOB,
  excerpt         TEXT,
  message_at      INTEGER,
  note            TEXT,                       -- 1000 chars
  created_at      INTEGER NOT NULL,
  closed_at       INTEGER                     -- the host or a co-host dealt with it
);

CREATE TABLE invites (
  code            TEXT PRIMARY KEY,            -- 12 chars, base32, CSPRNG
  created_by      BLOB NOT NULL REFERENCES users(id),
  expires_at      INTEGER,
  max_uses        INTEGER,
  uses            INTEGER NOT NULL DEFAULT 0,
  revoked_at      INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE TABLE refresh_tokens (
  id              BLOB PRIMARY KEY,
  user_id         BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id       BLOB NOT NULL,               -- login lineage: rotation keeps it,
                                               -- reuse of a rotated token revokes it
  token_hash      TEXT NOT NULL,               -- sha256 of the token
  device_label    TEXT,
  expires_at      INTEGER NOT NULL,
  revoked_at      INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE TABLE server_config (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL
);
```

**Presence is never persisted.** It lives in an in-memory `DashMap<UserId, Presence>` in
the gateway. On restart everyone is offline until they reconnect. This is correct: stale
persisted presence is worse than none.

---

## 6. Presence

Where somebody is: `in_room`, `around`, `idle` (no input for 10 minutes), `away`
(explicit, with a message), `offline`. It lives in the gateway
(`crates/linger-server/src/gateway/`), it is held in memory, and it is not stored.

**This section used to be "Activity detection — the hard part"** and it described a
`linger-activity` crate with a per-OS backend for KWin, X11, Windows and macOS, a
bundled registry of ~200 applications, a poller with a 20-second debounce, and five
privacy controls to make it safe. All of it is cut (Matt, 2026-08-28 —
`docs/decisions.md`). The crate is deleted, the registry is deleted, the wire field
is deleted, and SPEC §4.3 says what replaced it: a status somebody typed.

It is worth knowing why it was the hard part, because the reason is still true of
anything that reaches into the desktop: Wayland deliberately has no equivalent of
X11's `_NET_ACTIVE_WINDOW`, so there is no cross-compositor way to ask what window
is in front. Every implementation is per-compositor, and KDE, GNOME, Hyprland and
sway each need different code. If a future feature wants that kind of access, that
is the wall it hits, and the answer is very likely still "ask the person instead".

**No window titles.** Nothing in this codebase reads one, and no type has a field
that could carry one. That was a hard rule when there was code that could have
broken it, and it stays a hard rule now that there is not.

---

## 7. Security

### Threat model, stated plainly — publish this verbatim in the README

> Messages and files travel over TLS in a deployed server. Linger does not encrypt
> its database or stored files; encryption at rest depends on the host's disk or
> storage provider configuration.
> **The person running the server can read everything on it.** There is no
> end-to-end encryption. Run your own server, or trust the person who runs the one
> you're on. If you need cryptographic guarantees against your host, use Signal.

**Do not implement partial E2EE.** Real E2EE with multi-device, searchable history, and
file sharing means MLS (RFC 9420) plus device verification, key transparency, and backup
escrow — a larger project than everything else in this repo combined. Half-implemented
E2EE launders a false promise, which is worse than an honest limitation.

### Baseline requirements

1. **Passwords:** argon2id, `m=19456, t=2, p=1` minimum. Never SHA/bcrypt.
2. **Tokens:** access JWT, 15 min TTL, `EdDSA`. Refresh token, 30 days, rotating, stored
   hashed. Reuse of a rotated refresh token revokes the whole family.
3. **Client token storage:** OS keyring via `tauri-plugin-stronghold` or the `keyring`
   crate. **Test the headless / no-wallet fallback path explicitly** — a Linux box with
   no KWallet or gnome-keyring unlocked must degrade to a clear prompt, not a crash.
   On Android the phone app (SPEC §4.15) keeps the same entries in the platform's
   store: `keyring-core` with `android-native-keyring-store`, which encrypts each one
   into the app's private SharedPreferences with a key that never leaves the Android
   Keystore (`src-tauri/src/secrets.rs`). The iPhone uses the Keychain through the
   same `keyring` crate as the desktop; CI builds it for iOS, but it hasn't run on an
   iPhone yet.
4. **No open registration.** Invite code required, always. Codes are 12 chars from a
   CSPRNG, single-use by default.
5. **Rate limits:** login 5/min/IP, message send 10/10s/user, upload slot 20/hour/user,
   invite creation 10/day/user, knock 3/hour/target, search 30/min/user.
6. **CORS is an allowlist, not a wildcard.** The client is a webview page, so it is
   a cross-origin caller and the server must grant it permission explicitly. The
   allowed origins are the Tauri app's (`tauri://localhost`, and
   `http(s)://tauri.localhost` on Windows) plus Vite's dev server. Reflecting any
   origin would let a website you happened to visit probe whether this server
   exists, which is worth avoiding for a product that is otherwise this private.
7. **Tauri capabilities:** the WebView gets the minimum permission set. Every
   native capability it has is one narrow command in `client/src-tauri/src/`, and
   it has no others — not the updater plugin's own commands, not the keyring, not
   the socket.
8. **Signed auto-updates.** Tauri's updater, with one minisign key whose public half
   is committed in `client/src-tauri/tauri.conf.json` and whose private half is
   **generated once by `scripts/updater-key.sh` and backed up offline** (T-701).
   Losing it means you can never ship an update; leaking it means whoever has it
   can ship code to every machine running Linger. Verification is not optional and
   has no bypass: a build with no key configured refuses every update rather than
   installing an unverified one. The WebView is granted none of the updater
   plugin's permissions — it calls two of the app's own commands
   (`client/src-tauri/src/updates.rs`), so a page can never start an installer.
   **The Arch package is signed too, by a separate key.** The package and the
   repository database are signed with the Linger packages OpenPGP key
   (`packaging/arch/linger.asc`, fingerprint
   `A539799132574CE3EB51B01AB5FA9838135B10DF`), whose private half is the
   `ARCH_SIGNING_KEY` secret and an offline backup. pacman refuses anything the
   key did not sign. The repository only changes when a release is published
   (`.github/workflows/arch-repo.yml`), and its `arch` release stays a
   pre-release so the updater's `releases/latest` can never point at it.
9. **No telemetry.** Not opt-in, not anonymous, not crash reporting. None.

### User content is hostile

- **Serve uploads from a separate origin** (`cdn.linger.example`, not
  `linger.example/files`). Uploaded SVG and HTML are XSS vectors, and same-origin serving
  makes them session-stealing vectors.
- Force `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` on
  anything not on the image/video/audio allowlist.
- Re-encode images server-side. This strips EXIF (spec §4.10) and neutralizes polyglot
  files in one step.
- CSP on the app origin: no remote scripts or remote fonts. The shipped policy
  permits HTTPS and WSS origins generally, so members can connect to multiple
  self-hosted servers and fetch their media. It is not an allowlist of the
  signed-in servers. `unsafe-inline` survives on
  `style-src` alone and cannot be removed: the message list is virtualized, so a row's
  position is a style attribute, and a person's name is painted from `--person-*`
  properties set the same way. `script-src` is `'self'` and nothing else.
- **The policy comes in two, and the shipped one is the strict one.**
  `tauri.conf.json` carries `csp` and `devCsp`; Tauri picks between them at compile
  time, so `pnpm tauri dev` gets the local-server relaxations
  (`http://localhost:*`, `http://127.0.0.1:*`) and anything the bundler produces
  does not. A shipped page that could reach `http://localhost:*` could knock on
  every other service the person is running. Two sources in both policies look like
  relaxations and are not: `ipc:` and `http://ipc.localhost` are Tauri's own IPC
  channel — `invoke()` is a `fetch` at one of them — and blocking them does not stop
  IPC, it drops it silently onto a slower `postMessage` fallback.
  `client/src-tauri/tests/csp.rs` holds both policies to this.
- **Nothing the bundler produces is embedded as a `data:` URL**
  (`build.assetsInlineLimit: 0`). Vite embeds files under 4 KB by default, and
  the shipped policy allows `data:` for images only, so an embedded font or sound
  is refused in every installed app while `pnpm tauri dev`, which serves files,
  looks fine. Both Silkscreen faces went that way (#318). CI's web job runs
  `scripts/csp-assets.mjs` on each build to hold it.
- Markdown rendering: allowlist-based sanitizer, no raw HTML passthrough, ever.

**The origin split is enforced, not just advertised.** `LINGER_MEDIA_DOMAIN` defaults to
`cdn.<LINGER_DOMAIN>`, and the server refuses to start if it is the same host as the app.
Both names reach the same process through the reverse proxy, so a `Host` check decides
what each one serves: on the media host, `/objects/...` and nothing else; on every other
name, everything *but* `/objects/...`. A file that talked a browser into running it would
find no API at its own origin, and an upload cannot be fetched from the app's own name at
all. A server with no `LINGER_DOMAIN` has one origin and no split — honest for a box on a
LAN, and what every test server runs as. **It is also unreachable from an installed
client**, whose CSP allows `https` and nothing else, so that mode belongs to
development and to tests rather than to anybody's friends. The server says so at
startup: no domain gets a warning, and the first-run setup link says the address
cannot be reached by an installed app. It warns rather than refusing, because a bare
bind address is what `cargo test` and `pnpm tauri dev` both run against.

Every served object also carries `Content-Security-Policy: default-src 'none'; sandbox`
and `Cross-Origin-Resource-Policy: cross-origin`, and the `Content-Type` is never the
uploader's claim: it is one of the thirteen media types the server sniffed for itself, or
`application/octet-stream`. A piece of a file (a `206`, below) goes out with every one of
these headers too.

**On S3, the bytes come from the bucket**, and S3 has no `response-` override for
`X-Content-Type-Options` or `Content-Security-Policy` — only for the content type and the
disposition, both of which are signed into every presigned URL. Proxying the bytes back
through this process to add the other two would break the rule the S3 backend exists to
keep (§8). What stands in for them:

1. Active content is not storable. `image/svg+xml`, `text/html` and every script type are
   off the allowlist in `linger-core::media`, checked against the declared type at slot
   creation and against the *sniffed* type at complete.
2. Everything off the inline list is `application/octet-stream` with
   `Content-Disposition: attachment`, which a browser downloads rather than renders
   whatever it decides the bytes are.
3. Those two headers are stored **on the object** as well as signed into the URL, so a
   bucket behind a CDN, or one somebody made public, still hands the file over as a
   download.

A host who wants the literal header on the S3 path adds a response-header rule at
whatever CDN fronts the bucket (an R2 transform rule, a CloudFront response-headers
policy). It is defence in depth on top of the three above, not the thing holding the
door.

**Link previews are a server-side request forgery machine** if written carelessly, and
this server sits on a home LAN next to a router admin page. `links.rs` fetches them, and
the rules are: `http(s)` on default ports only; the hostname is resolved by the server and
the whole name refused if **any** address it answers with is private, loopback,
link-local (which is where cloud metadata services live), CGNAT or reserved; the
connection is then pinned to the address that was checked, so the name cannot resolve to
something else in between; redirects are followed by hand, three at most, every hop
re-checked; time and bytes are both capped and the body is read in chunks. Nothing the
response says is trusted either — the HTML is scanned for a title and an icon href by a
small tag reader and never rendered, and an icon is kept only if its *bytes* sniff as a
raster image. SVG is refused wherever it appears, exactly as it is on the upload
allowlist.

The fetch is host-side for a privacy reason before a caching one: if each client fetched
its own preview, every site anybody linked would collect the IP of every person who
scrolled past the message, and a remote favicon would do it without a click. The host's
IP does it once for everybody, and the icon reaches the client as a small `data:` URI.

---

## 8. File pipeline

Never proxy bytes through the app server.

```
1. Client  → POST /uploads          { filename, size, mime }
2. Server  → validates quota, creates attachment(state=pending),
             returns { upload_id, url, method, headers, part_size }
3. Client  → PUT direct to object store (multipart if > 8 MB, resumable)
4. Client  → POST /uploads/{id}/complete
5. Server  → verifies size, sniffs real MIME, re-encodes image (strips EXIF),
             generates blurhash + poster frame + an image's display copy,
             sets state=complete
6. Server  → attaches to message, fans out over gateway
```

**Storage backends:**
- `local` — filesystem under the data dir. Default. Correct for a home server.
- `s3` — any S3-compatible endpoint.

Both sit behind one `ObjectStore` trait (`crates/linger-server/src/storage/`). It has
four jobs: hand out a slot, gather an upload's parts into one local file the server can
inspect, store/read/delete a finished object, and throw away the parts of an upload that
died. Everything that decides *whether* bytes are acceptable is in `media`, not storage.

**The S3 backend does not use S3's own multipart upload.** Each part is presigned to its
own key, `uploads/{upload_id}/{part}`, and `assemble` streams those down into one local
file. S3 multipart would assemble the object inside the bucket, and the server's next
move is to download it anyway — sniffing the real type and re-encoding an image both need
the bytes on local disk — so the file would cross the wire three times. It would also
introduce an upload id of S3's own, handed out by a network call, which is exactly the
per-upload state this design does not want to store. The finished object goes up as one
PUT; files are capped at 500 MB, well under S3's 5 GB single-PUT limit.

Serving from S3 is a redirect to a presigned GET, so bytes never cross the app process on
the way out either. The `Content-Type` and `Content-Disposition` that force a download for
anything off the inline allowlist are signed into that URL as `response-*` overrides,
because the app server is not the thing sending the response any more.

For cloud hosting, recommend **Cloudflare R2**: zero egress fees, which matters
enormously for a file-sharing app. Backblaze B2 is the runner-up. Plain AWS S3 will bite
you on egress.

**The local backend's listener.** Step 3 is trivial with S3 — the client PUTs at Amazon.
With a filesystem there is no second machine, so the local backend hands out URLs under
`PUT /upload/{upload_id}/{part}` on the app host, and objects come back from
`GET /objects/{key}` on the media host and only there (§7). That route answers one byte
range per request with `206 Partial Content`, reading only the bytes asked for: a video
player seeks by asking for the part of the file it needs, and GStreamer, the player under
WebKitGTK, gives up when it gets the whole file back instead (#222). The forms it takes
and what it does with the rest are in PROTOCOL §6.
Neither path is under `/api/v1`, neither reads an `Authorization` header, and neither
touches a session: the part URL is signed with an HMAC over the upload id, the part
number and an expiry, which is what an S3 presigned URL is. The signing key lives in the
data dir beside the JWT key, because it has to survive a restart or a resumed upload
would find every URL it was holding invalid — the exact case resumability exists for.

An upload id **is** an attachment id. The part layout is a pure function of the declared
size, so nothing about an in-flight upload needs its own table.

**Failing at step 5 is two different things.** Parts missing is the ordinary shape of a
dropped connection: the slot stays pending and the client sends what is missing. Anything
else — wrong size, a file that is not the type it claimed, an image that will not decode
— is final, and the parts go.

**ffmpeg is optional.** `ffprobe` supplies video and audio duration and video dimensions;
`ffmpeg` grabs the poster frame. A server without them stores media perfectly well and
simply has no poster. The published image installs them. The file they read is an
upload and so hostile (§7), which makes both tools the video equivalent of the image
decoder's limits: `ffprobe` gets 15 seconds, the poster gets 30 across both of its seek
positions, and a run past its limit is killed and counts as no probe data or no poster —
the same outcome as a server without ffmpeg.

**Display copies** (#382). An engine that decodes a whole picture holds all of it in
memory however small it is drawn: about 80 MB a phone photo in WebKit, measured. So
when the server re-encodes an image over 960 px on its longest side, it also stores a
copy that size beside it, like a poster frame (`display_key`; JPEG for a JPEG, PNG
otherwise). Conversations and media tiles draw the copy; the viewer, downloads and
exports take the original. A smaller image, and an animated GIF, is drawn from itself.
Images from before copies get theirs from `display.rs`, which `main` spawns once at
startup, newest first, a few at a time. It reads each original back as an export does,
so it works on S3, where the bucket answers requests for a copy and a copy could never
be made on its first request. Ten phone photos in a conversation cost a WebKit page
about 65 MB with copies, against 800 to 900 without.

**The sweeper** (`expiry.rs`) is one of the server's two recurring background tasks — spawned by `main`,
not by `AppState`, so building the state in a test never starts a loop nobody asked for.
The other closes polls whose time is up (`polls.rs`, #474): at startup, for any that ran
out while the server was down, then every thirty seconds, each in one transaction with the
line it leaves in the room.
It runs at startup and every six hours, in batches, and takes three kinds of object:

- files past `LINGER_FILE_EXPIRY_DAYS` (default 365) that are neither starred nor on a
  pinned message — the rule in SPEC §4.10. `LINGER_FILE_EXPIRY_DAYS=off` turns it off.
- files on a **deleted** message, at once. A delete is a tombstone with an empty body,
  and neither the stream nor the media collection will ever draw what it carried again,
  so the bytes are unreachable and still counted against the pool. A star does not hold
  one of these: a star stops a file ageing out, and this is not ageing out.
- **finished uploads that never became a message**, once they are past the same window.
  The 48-hour sweep in `routes::uploads` only takes uploads that never *completed*.

A file a status picture pointed at used to be kept at any age. Status pictures are
gone (#269), so such a file is now an upload that never became a message, and the
third rule takes it. Deletion is bytes first, row second — the other order can lose
an object with nothing left pointing at it, and a crash between the two leaves a row the
next pass finishes.

**Exports are the one path that brings bytes back to the app host.** An archive
(`export.rs`, SPEC §4.11) is built in scratch under `{data_dir}/staging` and then stored
as one object. On `local`, the files it carries are read in place, so one export needs
local scratch of roughly the finished zip, and the zip is then renamed into the data dir.
On `s3`, there is no way to read an object without fetching it, so every file the member
can see is downloaded into scratch before zipping: one export needs roughly **twice** the
member's visible data on local disk while it builds, and costs a full download of that
data in egress (free on R2, billed on plain S3). The scratch is deleted when the job ends
and the finished zip lives in the bucket, but a host sizing an S3-backed box should size
the staging disk for the largest export, not only for the uploads in flight.

**The pool and the expiry window are environment variables** (`LINGER_POOL_BYTES`,
`LINGER_FILE_EXPIRY_DAYS`), read once at startup like every other deployment setting, not
rows a host edits from inside the app (`docs/decisions.md`). `GET /server` reports the
used figure, the ceiling and the window, and the status bar draws the first two.

---

## 9. Deployment

Windows MSI upgrades preserve the desktop shortcut choice: a fresh install
creates one, while an upgrade only refreshes the canonical desktop shortcut
if it still exists. Renaming, moving or deleting that shortcut must not create
a second one on the next in-app update. Start-menu and uninstall shortcuts
continue to refresh normally. The MSI template in `client/src-tauri/windows/`
extends the pinned Tauri template for this rule; installation identifiers and
the main executable name remain stable so retained shortcuts keep working.

Target: a non-expert friend gets a working server in under 15 minutes.

```yaml
# deploy/compose.yaml
services:
  linger:
    image: ghcr.io/OWNER/linger:latest
    restart: unless-stopped
    volumes: [ "./data:/data" ]
    env_file: .env                         # every LINGER_* setting (#440)
    environment:
      LINGER_DATA_DIR: /data
    ports: [ "3479:3479/udp" ]             # voice forwarding's one port
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: [ "80:80", "443:443" ]
    environment:
      LINGER_DOMAIN: ${LINGER_DOMAIN:?...}   # the Caddyfile's two names
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
  coturn:                # optional, behind `--profile voice` (T-1403)
    image: coturn/coturn:4
    network_mode: host
    command: [ "--use-auth-secret", "--static-auth-secret=${LINGER_TURN_SECRET}", ... ]
volumes: { caddy_data: {} }
```

**One settings file** (#440). A host's choices all live in `.env`, next to the compose
file: the domain, the relay's secret, the file pool. Compose hands it to `linger`, and the
Caddyfile builds its two names from `{$LINGER_DOMAIN}`, so a host never edits either file
and a newer copy can replace the old one. `deploy/setup.sh` writes `.env` (it asks for the
name, checks the DNS, makes the secret, opens `ufw`) and starts everything; doing it by
hand is copying `.env.example`. An older compose file with its settings written inline
keeps working.

Voice goes through the `linger` container itself (#197): with UDP 3479 open, each client
sends its voice there once and the server passes it on. Where clients send it is
`LINGER_VOICE_ADDRESS` if set; unset, the server looks `LINGER_DOMAIN` up once at startup
and uses its first public address (#440), since the host already pointed it at this
machine. `off`, or no domain to look up, and the server carries no voice (#306).

The image starts as root only to give the data folder to its `linger` user, then runs the
server as `linger` (`deploy/entrypoint.sh`, #440): Docker makes a missing `./data` for
root, which used to need a `chown` before the first start. It also makes the folder 0700
and runs the server with umask 077, so what the server writes is 0600 (#506): on a
machine with more than one account, the others can't read the database or the files.
Nothing on the host reads inside it: `update.sh` copies the database out through a
one-off container of the image and writes the backup 0600, so a host needs Docker and
not root.

The third container is the voice relay (SPEC §4.14), for people on networks that block
UDP. It is optional and behind a compose profile, so a plain `docker compose up -d`
needs no secret and runs no relay. Its one secret lives in `.env`, never in the compose file, and is shared
with `linger` so the server can sign the short-lived relay passwords it hands
members (`PROTOCOL.md` §7, `GET /voice/ice`). It runs on the host's own network
because a relay's job is being reachable at its real address on a range of UDP
ports, and container NAT would get in the way of exactly that.

Caddy is bundled specifically so TLS certificates are automatic. A self-hoster should
never have to think about certbot. Its Caddyfile has two blocks and the deployment needs
two DNS records: the domain, and `cdn.` in front of it for uploaded files (§7).

**First-run flow:** binary starts, finds no config, prints a one-time host-setup URL with
a token to stdout. Host opens it, creates their account, names the server. No env-var
bootstrap credentials.

**Backup:** the entire server is `data/linger.db` plus `data/objects/`. Document
`sqlite3 linger.db ".backup"` and a cron one-liner in the README. Do not build a backup
feature.

**Locked out:** no reset email, no reset link — the setup token only exists while the
server has no users, so the only remaining proof of ownership is access to the box.
`linger-server reset-password <username>` sets a new password and revokes that user's
refresh families. The password is generated and printed, or read from stdin; never
taken from argv, which leaks into shell history and `ps`. Stop the server first — one
SQLite file has one writer.

---

## 10. Build milestones

Each milestone is independently verifiable. Do not start the next until the current one
passes its check.

| # | Milestone | Done when | Estimate |
|---|---|---|---|
| **M0** | Workspace scaffold, CI, `ts-rs` type export, Tauri shell opens on all 3 OSes | `cargo test` and `pnpm build` green in CI; blank window opens on Linux/Win/macOS | 1 day |
| **M1** | Server: auth, invites, rooms, messages | Integration test suite drives the full REST surface with `reqwest`. No UI yet. | 2–3 days |
| **M2** | Gateway: WS, heartbeat, sequence numbers, resume | Test client survives a forced disconnect mid-stream and replays without gaps or duplicates | 2 days |
| **M3** | Client: message list, composer, session grouping, aging, comfortable layout | Two clients on one machine exchange messages in real time | 4–5 days |
| **M4** | Presence + roster + in-room state + statuses | Roster updates live across two clients; a status set on one shows up on the other | 2 days |
| **M4.5** | Host controls (rooms, invites, server settings), member settings, the server list | A host who has only seen the app can create a server, add a room, invite a friend, and rename the server — no curl, no docs | 2–3 days |
| **M5** | Uploads, media pipeline, the media collection, status images | 400 MB video uploads, resumes after a killed connection, appears in the media grid | 3 days |
| **M6** | Styling: names, statuses, 16-color palette, themes, fonts | A user sets a gradient name from two palette keys; contrast is verifiably ≥4.5:1 in both themes | 2–3 days |
| **M7** | Packaging: installers and signed auto-updates | Linux and Windows installers, and an update ships end-to-end. Installer signing and macOS notarization are deferred by decision (T-705). | 3–5 days |
| **M8** | Export | One archive contains every message and file, and it opens | 1 day |

**V2 starts here.** Planned 2026-08-28. **M9, M10 and M11 are built**
(2026-08-29 and 2026-08-31). **M12 is built:** signalling, audio path,
controls, relay and device recovery, with voice in daily use across separate
networks. M13 ambient voice is not started. The order below is not SPEC §6's listing order: knock and search
are small and self-contained, and voice is the largest and riskiest thing in the
project. All nine release checks (V1's and those of M9, M11 and M12) closed
on 2026-09-25 from real use of the published app (`TASKS.md`, *Release
checks*; steps in `docs/tasks/release-checks.md`). M12's full four-people,
four-networks hour was not run; it moves to #197, which rebuilt voice for
large rooms through the host's server (0.4.1). The mesh that came before it
is gone (#306).

| # | Milestone | Done when | Estimate |
|---|---|---|---|
| **M9** | Knock (SPEC §4.9) | A knock crosses two machines, fades on its own, and leaves nothing behind | 1–2 days — **built 2026-08-29; its two-machine check passed in real use 2026-09-25 (HC-6)** |
| **M10** | Search | Type a word, get the messages containing it, click one, land on it in its room | 3–4 days — **built: index and endpoint 2026-08-30, surface 2026-08-31. Its check passed in a running app** |
| **M11** | DMs and group DMs | Two people hold a conversation no other member can see in *any* surface — stream, media, search, export, notifications | 4–6 days — **built 2026-08-31.** Its check passed surface by surface against a running server, and on separate computers in real use 2026-09-25 (HC-7) |
| **M12** | Voice rooms | Four people, four networks, one hour, no drops | 1–2 weeks — **the audio path and the surface landed 2026-09-01 and 2026-09-04 (T-1401, T-1402, T-1404): frames, peer connections, ICE, microphone → Opus → RTP → speakers, and join / mute / push-to-talk / who is talking / per-person volume / a device picker. and a coturn relay in the deploy with short-lived passwords the server signs (T-1403). In real use across separate networks since 2026-09-17; HC-8 and HC-9 closed 2026-09-25, without the four-person hour (see #197)** |
| **M13** | Ambient voice | A room left running all day costs almost no CPU, and nobody joined anything | 3–5 days |
| **M15** | The Buddy list client (#198) | The new client does everything in `docs/design/parity.md` and becomes the default; the old client is deleted | Several weeks — **the app from 0.4.0; the old client deleted after 0.4.3 (#306).** What's left is in `TASKS.md`; plan in `docs/design/architecture.md` |
| **M14** | Custom themes | Somebody makes a colour scheme, it survives a restart, and a file carries it to another computer | **V3, not V2.** Three decisions come first — see `TASKS.md` *Parking lot* |

**A mobile client is not in this sequence** (Matt, 2026-08-28). It was going to
be M14 and went to `TASKS.md`'s *Backburner*, because the desktop app had to be
finished and used by real people before a second platform doubled the surface
of every bug still in it. It came back on 2026-10-02 as its own section of
`TASKS.md` (T-16xx), not a milestone: a phone app for iPhone and Android from
the same Tauri 2 crate, text first, with no push (SPEC §4.15). **M14 is now custom themes** (Matt,
2026-08-31), which is V3 rather than V2: SPEC §6 carries the scope line and
`TASKS.md` M14 carries the three things that have to be decided before any of it
starts. The short version is that a theme is a list of token values rather than
a stylesheet, §5.1's visual rules are not themeable, and if a theme can repaint
the 16 name colours then the 4.5:1 contrast test has to move out of CI and into
the app.

Where search lives in the layout was Matt's and was answered on 2026-08-30 —
a destination in the rail next to `media`, covering what people typed and the
names of files (SPEC §4.12). **Landing on a hit changed how the client holds
history** (T-1203, [`docs/tasks/m10.md`](docs/tasks/m10.md)): a message six
months back is thousands of pages behind the newest, so the messages endpoint
grew `around=<id>` and a room can now be *behind its own newest message*. While
it is, live message frames for that room are dropped rather than folded into
history they do not join onto — an invisible gap is the one thing the message
store must never produce. The decision that blocked mobile, whether push
through Apple and Google was acceptable at all, was answered on 2026-10-02: it
isn't, so the phone app has no push (SPEC §4.15).

**The activity-detection spike came before M0** and did its job. One evening,
Kubuntu/Plasma 6 Wayland and Windows, a throwaway binary that printed the
foreground app every second. It was retired on 2026-08-19 having answered the
question it was for. The feature it was a spike for was cut on 2026-08-28
(`docs/decisions.md`); the spike was still worth the evening, because finding
out early what a thing costs is how you get to decide whether to build it.

**Entrance sounds moved to the end of the queue** (Matt, 2026-08-21). They are still
V1 (SPEC §6, item 4) — they are simply the last thing built, after M8, and M4's check
no longer waits on them. `TASKS.md` holds them under *Backburner* as T-901…T-903
(they were T-403, T-404, T-408).

**Activity detection is cut** (Matt, 2026-08-28 — `docs/decisions.md`). Parked on
2026-08-23, deleted five days later: the crate, the registry, the wire field, and
tasks T-911…T-917. It was V1 item 8; §4.3 of the spec now says what replaced it,
which is a status somebody typed. Do not build it back — that is Matt's call, not
a maintenance decision.

**M4.5 was added on 2026-08-21**, after the client turned out to have no way to create
a room, invite anybody, or edit the server — every endpoint for all three has existed
since M1 with nobody calling it. It also carries the server list from §3 of the spec
(V1 item 17), which had never been given a task at all.

M7's install-and-update check cannot be skipped. Installer signing and macOS
notarization remain on the backburner under T-705; they are not prerequisites
for the agreed Linux and Windows release.
