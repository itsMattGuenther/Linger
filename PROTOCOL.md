# Linger — Wire Protocol v1

All REST under `/api/v1`. Gateway at `/api/v1/gateway` (WSS).
Content type `application/json` unless noted. Timestamps are Unix milliseconds (i64).
IDs are lowercase hex UUIDv7 strings.

**Rule: every type crossing this boundary is defined in `crates/linger-core` and exported
to TypeScript via `ts-rs`. The frontend never hand-writes a wire type.**

---

## 1. Errors

Every non-2xx response:

```json
{ "error": { "code": "INVITE_EXPIRED", "message": "That invite has expired.",
             "retry_after_ms": null } }
```

`code` is a stable SCREAMING_SNAKE identifier the client switches on. `message` is
human-readable and safe to display. Never leak internals in `message`.

`retry_after_ms` is set when waiting is the answer, which is every `RATE_LIMITED`:
how long until the same request would be taken. A response that sets it also
carries HTTP's own `Retry-After` header, the same wait in whole seconds rounded up,
for tools other than the app. The app reads `retry_after_ms`.

Standard codes: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`,
`VALIDATION_FAILED`, `INVITE_INVALID`, `INVITE_EXPIRED`, `QUOTA_EXCEEDED`,
`FILE_TOO_LARGE`, `UNSUPPORTED_MEDIA`, `CONFLICT`, `INTERNAL`,
`DISPLAY_NAME_TAKEN` (§2, #574).

Codes are additive: a newer server may send one an older client has never heard of.
The client reads an unknown code as `INTERNAL` and shows `message` as it is, which is
why every `message` is a whole sentence for a person.

---

## 2. Auth

Access token: JWT, EdDSA, 15 min TTL, sent as `Authorization: Bearer <jwt>`.
Refresh token: opaque, 30 days, **rotating**. Reuse of a consumed refresh token revokes
the entire token family and forces re-login.

Some things end every sign-in an account has at once: a password change (§5), a reset
from the command line, and removal (§5). Each revokes every refresh family the account
has, and refuses every access token minted before it, at once rather than when it
expires: on REST (`UNAUTHENTICATED`) and at the gateway's `identify` and `resume`
(`invalid_session { reason: "unauthenticated" }`). A password change and removal also
close the account's open gateway sessions (§8). A reset from the command line runs
while the server is stopped (`docs/host-guide.md`), which has closed them already. Each
access token carries the account's `token_generation`
(the `gen` claim), and ending every sign-in adds one to it, so a token whose number is
smaller is refused (#496). It is a count rather than a time on purpose: token times are
whole seconds, and a time could not tell a token minted just before a password change
from the fresh one minted just after it. Tokens from before #496 carry no `gen` and
count as 0. Clients treat the token as opaque and never read it.

```
POST /auth/register     { invite_code, username, display_name, password }
                     →  { access_token, refresh_token, expires_in, user }

POST /auth/login        { username, password }
                     →  { access_token, refresh_token, expires_in, user }

POST /auth/refresh      { refresh_token }
                     →  { access_token, refresh_token, expires_in }

POST /auth/logout       { refresh_token }              → 204

GET  /auth/invite/:code → { valid, server_name, expires_at }  # unauthenticated preview

GET  /auth/sign-in-link/:code
                     →  { valid, server_name, username, made_by, expires_at }  # unauthenticated
POST /auth/sign-in-link { code, new_password }
                     →  { access_token, refresh_token, expires_in, user }
```

The two sign-in link endpoints are §5's "Sign-in links" (#581).

A new account (from `POST /auth/register` or `POST /setup`) starts with a
name style whose fill is the hued palette color the fewest active people on
the server wear, ties going around the color wheel in steps of seven (SPEC
§4.5). Slate is never handed out. Everything else in the style is the default.

`POST /auth/register` announces the new account on the gateway: it fans out
`user.update` carrying the new `User`, which is "here is this person, whether or not
you had them" (§8). Without it a client that is already connected has no card to draw
the newcomer with, and would not see them until it reconnected.

### 2.2 Shareable links

These exist so a person has one thing to paste into the client, which parses them
and calls the endpoints above. The origin is the server; everything else is the
client's business.

People tap links, though, so the server answers the first two in a browser with one
small page (#578), outside `/api/v1` and only on the app's host, never the media
host. `GET /invite/:code` (and `/invite?code=`) says which server the invite is for
and how long it has left, in words ("about 6 days": the page can't know the reader's
time zone), then three steps: get the app (Windows, Linux and Android, all to the
project's latest release), paste this link into **Server or link**, make your
account. A used-up, revoked or made-up code says the invite doesn't work, an expired
one that it has run out, and neither names the server (`404`), as
`GET /auth/invite/:code` doesn't. `GET /setup?token=` (and `/setup/:token`) is the
same page with a warning not to share the link; a wrong token, or a server already
set up, says so (`404`). `GET /sign-in/:code` (and `/sign-in?code=`) is the same page
for a sign-in link: whose account it is, who made it, how long it has left, and a
warning not to share it, with "choose a new password" as the last step. A used link
says it has been used, and any other dead one that it doesn't work (`404`), neither
naming anybody. Opening the page doesn't use the link. Only an invite-shaped code (lowercase base32) or a hex token
is ever looked up or written into the page.

The page is inert: its one style sheet and one script (the Copy button) are fixed,
and their hashes are its whole `Content-Security-Policy`
(`default-src 'none'; style-src 'sha256-…'; script-src 'sha256-…'; base-uri 'none';
form-action 'none'; frame-ancestors 'none'`). It loads no fonts or images and
nothing from anywhere else, and is sent with `Cache-Control: no-store`,
`Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and `X-Robots-Tag: noindex`.
The link it shows starts with `https://` + `LINGER_DOMAIN`, or, on a server without
one, the address the browser used. It isn't a directory and isn't sign-up: the code
is still the only way in.

Under the link, for somebody who already has the app, the page offers **Open in
Linger** (#607): the same link as a `linger://` one, with "Nothing happened? Paste
the link instead." under it, since a computer without Linger does nothing with it.
It carries the server and the code or token, and nothing else:

```
linger://invite?server=linger.example&code=CODE
linger://setup?server=linger.example&token=TOKEN
linger://sign-in?server=linger.example&code=CODE     (#581, on a sign-in link's page)
```

`server` is the host (and port) of an `https://` server, or the whole origin of one
reached over plain `http://` (`http%3A%2F%2F127.0.0.1%3A8420`); everything in it but
letters, digits and `-._~` is percent-encoded. The desktop installers, the Linux
menu entries and the phone app's intent filter register the scheme. The app reads
the link strictly (`client/src-tauri/src/deep_link.rs`): exactly one shape, those
two parameters once each, a host the paste box would accept, a code of letters and
digits, a hex token, or it's dropped. It turns it into the `https://` link above and
puts that in the **Server or link** box, with the paste box's own rules after that
(an invite still makes a new account). Nothing is contacted until the person presses
Continue, so a page can't make the app reach any server by itself.

```
https://linger.example/setup?token=…   first-run link, printed to the console
https://linger.example/invite/CODE     an invite (?code=CODE is also accepted)
https://linger.example/sign-in/CODE    a sign-in link (§5, #581; ?code=CODE too)
linger.example                         no path: sign in to an existing account
```

An app from before sign-in links reads one as a bare address and goes to signing in,
which is harmless: the link is still unused.

`username`: `[a-z0-9_]{2,24}`, unique, immutable after creation.
`display_name`: 1–32 chars after trimming, mutable, stored trimmed. Any script,
emoji, accents, spaces and punctuation. The server refuses (never cleans up) a name
that holds any of the following (#296), each with its own sentence, checked in this
order:

1. a control character, line break or tab (category Cc, U+2028, U+2029);
2. a direction control: U+202A–U+202E, U+2066–U+2069, U+200E, U+200F, U+061C;
3. an invisible character: any format character (category Cf, e.g. U+200B, U+2060,
   U+FEFF, U+00AD), and U+034F, U+17B4, U+17B5. Allowed where they are part of the
   writing: U+200D between two emoji (a family, 🏳️‍🌈), U+200C/U+200D between two
   letters or marks of a script that spells with them (Arabic, Syriac, N'Ko, Mandaic,
   the Indic scripts through Sinhala, Myanmar, Khmer, Mongolian, Adlam), and the tag
   characters U+E0020–U+E007F after 🏴 (the England, Scotland and Wales flags);
4. a letter carrying more than 2 accent marks (U+0300–U+036F, U+1AB0–U+1AFF,
   U+1DC0–U+1DFF, U+20D0–U+20FF, U+FE20–U+FE2F), or more than 4 combining marks of
   any kind (categories Mn, Me), counted from the last character that is not one;
5. nothing visible at all: only whitespace, marks, or blank letters (U+115F, U+1160,
   U+3164, U+FFA0, U+2800, U+1D159).

The limits are `MAX_ACCENT_MARKS_PER_LETTER` and `MAX_MARKS_PER_LETTER` in
`linger-core::limits`. They apply when a name is set or changed: a name saved before
them is left as it is, and a `PATCH /me` whose `display_name` is the saved name
unchanged is not held to them.

A display name that passes those must also not look like anybody else's (#574). The
server refuses it with `409 DISPLAY_NAME_TAKEN` "Someone here already goes by a name
that looks like that. Try something a little different." when it looks the same as
the display name or the username of any other active member. Removed members don't
count, and nor does the person's own name, so saving it again or changing only its
capitals is fine.

"Looks the same" (`linger-server::names`): each name is put in NFKC, every
Default_Ignorable_Code_Point is dropped, every run of whitespace or blank letters
(rule 5) becomes one space, and none is left at the ends. That gives `n`. Its three
shapes are `skeleton(n)`, `skeleton(lower(n))` and `skeleton(lower(skeleton(n)))`,
where `skeleton` is UTS #39's confusables skeleton. Two names look the same when any
shape of one is a shape of the other. The three cover `Ilya` beside `llya` (a
capital I is taken for an l), `Matt` beside `matt`, and a Cyrillic `Маtt` beside
`matt`.

The check runs in the transaction that saves the name, so two people can't both get
look-alikes at once. `POST /auth/register` checks it after the invite, so somebody
without a good invite learns nothing about who is here, and a refusal leaves the
invite's use and the username unspent. `POST /setup` makes the first account, so
there is nobody to look like. Like the rules above, it applies when a name is set or
changed: two names saved before it that look alike both stay.

**Direction controls in other short text** (#488). The direction controls in rule 2
come in two kinds. The embeddings, overrides and isolates (U+202A–U+202E,
U+2066–U+2069) turn the text after them around: a file named `invoice` + U+202E +
`fdp.exe` reads "invoiceexe.pdf", and one left open turns the app's own words beside
it around too. The three marks (U+200E, U+200F, U+061C) only move the punctuation and
numbers beside them, and people writing Hebrew or Arabic use them on purpose: "בחוץ!"
draws its "!" at the start of the line without U+200F after it. A display name
refuses all of them. Everywhere else the app draws short text beside its own words,
the server **takes them out** on the way in, before trimming and counting, and stores
the rest:

- an upload's `filename` (§6) loses all of them, the marks too, and so does the name
  in a file's `Content-Disposition`, for a name stored before this. A file's name is
  what the trick is aimed at, and nobody needs a mark in one;
- every text in a status: `line`, `away_message`, `reading`, `listening`, `working_on`
  and each field's `label` and `value` (§5), and the `away_message` of a
  `presence.update` (§8);
- a room's `name`, `topic` and `motd`, and the server's `name`, at setup too (§3, §2.1);
- a poll's `question` and `choices` (§4).

All but the file name lose only the embeddings, overrides and isolates, and keep the
marks. Taken out rather than refused, because nobody can see them: a refusal would ask
somebody to delete a character they can't find, and they mostly arrive by pasting (a
song title, a file from somebody's disk). A message's `body` keeps everything:
somebody writing a paragraph in Hebrew or Arabic may want any of them, and a client
keeps each message's words to themselves. Text stored before this keeps them, so a
client draws all of the above isolated from the words around it, and a file's name
without them (`docs/design/system.md`, principle 10).

`password`: minimum 8 characters. Do not impose composition rules, do not expire
passwords, and do not ask for a hint. The floor was 12 until 2026-08-21; it came
down because the client remembers the password in the OS keyring, so the length
was friction paid on every fresh install and bought very little. 8 with no
composition rules is the NIST SP 800-63B floor and the honest answer here.

Refresh-token reuse (presenting an already-rotated token) revokes the token's whole
family — every token descended from the same login — and forces re-login on that
device chain. Logout likewise revokes the presented token's family.

The server keeps a rotated token only until its own 30 days are up, then deletes it
(#520). Reuse is caught for those 30 days. A token presented after them is refused
as expired, the same `UNAUTHENTICATED`, and no longer revokes its family.

When renewal fails, a client ends its saved sign-in only if refresh is rejected with
`UNAUTHENTICATED` or `FORBIDDEN`. A temporary server error, rate limit, or transport
failure leaves the saved token in place and reports the failure to the caller. A
later request can try again; clients must not loop on refresh or infer token
revocation from `INTERNAL`. This applies both at startup and during normal use.

Sign-in and sign-up are limited per address (#495): `POST /auth/login` 5 a minute
(`RATE_LOGIN_PER_IP`), `POST /auth/register` 60 an hour by default, all at once if
need be. The host sets the sign-up figure with `LINGER_SIGNUPS_PER_HOUR`, or turns
it off; the sign-in figure is the brake on guessing passwords and isn't a setting.
Past either, the answer is `RATE_LIMITED` with `retry_after_ms`. The address is the
connection's own; from a proxy the server trusts (`LINGER_TRUSTED_PROXIES`, by
default the same machine or a private network), it is the last `X-Forwarded-For`
entry, never an earlier one. An IPv6 address counts by its /64, so every address in
one home connection's block shares one allowance (#546). Checking a password is slow on purpose and the server
does only a few at once (`LINGER_PASSWORD_CHECKS_AT_ONCE`, default 4), so a sign-in,
sign-up, first-run setup or password change that can't get a turn within 5 seconds
is also `RATE_LIMITED`. `POST /auth/register` checks the invite before it touches
the password: a bad invite is refused straight away, and a sign-up refused for any
reason has not used up its invite.

The three share a code, and each has its own `message`, which says what is
happening and, with the wait from `retry_after_ms` in words, when to try again
(#538). The app shows `message` as it comes, so an app from before a new sentence
shows it too:

- sign-ups from the address used up: *"Lots of people have joined from your network
  in the last hour, so this server is pausing new sign-ups from it. Try again in
  about 10 minutes. If your group is joining together, the host can raise this
  limit."*
- sign-in tries from the address used up: *"Too many sign-in tries from your network
  in the last minute. Try again in 12 seconds."*
- no turn to check a password: *"The server is busy letting other people in. Try
  again in a moment."*

### 2.1 First-run setup

On boot with zero users, the server generates a one-time setup token and prints a
setup URL to stdout (ARCHITECTURE §9). The token dies on use or restart. There are
no env-var bootstrap credentials.

```
GET  /setup/:token      → { valid }                            # unauthenticated
POST /setup             { token, server_name, username,
                          display_name, password }
                     →  { access_token, refresh_token, expires_in, user }
```

`POST /setup` creates the host account (`is_host: true`), names the server, and
consumes the token. Once any user exists, both endpoints return `NOT_FOUND`.

---

## 3. The server and rooms

```
GET  /server             → { name, accent_key, icon_key, member_count, created_at,
                             storage_used_bytes, storage_limit_bytes, file_expiry_days,
                             file_expiry_when_full?, voice?, screens?, health? }
PATCH /server            (host or co-host) { name?, accent_key?, icon_key? }   # accent_key from PALETTE

GET  /rooms              → Room[]                       # public rooms only
POST /rooms              (host or co-host) { slug, name, topic? }         → Room
PATCH /rooms/:id         (host or co-host) { name?, topic?, position?, motd?, reactions_off? }   → Room
POST /rooms/:id/archive  (host or co-host)                                → Room

GET  /dms                → Room[]                       # the DMs you are in
POST /dms                { user_ids }                   → Room
POST /dms/:id/leave                                     → 204   # a group DM you're in (§3.1)
```

```ts
type RoomKind = "room" | "dm"

type Room = {
  id: string; slug: string; name: string; topic: string | null;
  kind: RoomKind; member_ids: string[] | null;
  position: number; archived_at: number | null;
  last_message_id: string | null;   // client compares to read marker; never a motd line
  motd?: { text: string; set_by: string; set_at: number };   // left out when none
  reactions_off?: true;             // the host turned reactions off here (§4); left out when on
  someone_left?: true;              // a DM somebody has left (§3.1, #565); left out otherwise
  deleted_member_ids?: UserId[];    // a DM whose other person deleted their account (§5, #650): not in member_ids, named so the app can say "Deleted account"; left out otherwise
}
```

**`GET /rooms` never returns a DM and `GET /dms` never returns a room.** They are two
lists because they are two things: rooms are the server's, in an order the host sets,
and everybody sees the same ones; a DM is yours, and the set of them is different for
every person on the server. Keeping them apart means a surface that draws rooms cannot
accidentally draw somebody's DM by forgetting a filter — it never had it to begin with.

`kind` says which one you are holding. `member_ids` is the people in a DM, and it is
`null` for a room — a room's members are everybody, and a list of every account on the
server is a different thing wearing the same field. A DM's `slug` and `name` are
generated and are not for drawing: a DM is named by who is in it (SPEC §4.13), so a
client draws `member_ids` and ignores both. The `dm-` slug prefix is reserved and
`POST /rooms` refuses it.

**A room's message of the day** (`motd`, SPEC §4.1, #464) is what's happening now; the
topic is what the room is about. `PATCH /rooms/:id { motd }` sets it, trimmed and
without the direction controls that turn text around (§2), up to
`linger-core::limits::MAX_MOTD_CHARS` (300) characters, longer is `VALIDATION_FAILED`;
`""` clears it, and leaving `motd` out leaves it alone. Setting it also writes a line in
the room, in the same transaction: a `Message` from whoever set it, with the words as
its body, `created_at` equal to `set_at`, and `motd: true` (§4). Both arrive as frames,
`room.update` then `message.create`. Clearing writes no line, and neither do the same
words set again, which change nothing at all, `set_at` included: a client keys "folded
on this device" by `set_at`, so only a new message of the day opens the strip again. A
DM has none (`NOT_FOUND`, as for anything else a host would do to a DM), and an archived
room takes no new one (`VALIDATION_FAILED`).

The line is never a room's `last_message_id`, so it never makes a room look new, and a
client neither notifies nor marks a mention for it. A room with no message of the day,
and every server from before this, leaves `motd` out.

**The storage figures** are read-only and every member sees them; the status bar
draws the first two (SPEC §5.6). `storage_used_bytes` counts stored objects *and*
uploads still in flight, because a slot already handed out is not space anybody else can
have. `storage_limit_bytes` is the pool ceiling. `file_expiry_days` is how long a file
stands before the server sweeps it, or `null` when no age rule takes files.
`file_expiry_when_full` (#583, optional, always sent by a server that has it) is `true`
when old files go only once the server needs the room: past 90% of
`storage_limit_bytes`, the oldest go first until it is under 80%. `file_expiry_days` is
then `null`, which a client from before reads as "kept for good", the nearest thing it
knows. Both `null` and `false` is a server that keeps files for good. Starred files,
files on pinned messages and the server's emoji pictures (§5, "Custom emoji") never
expire whatever these say (SPEC §4.10).

They are not on `PATCH /server`. Both knobs are environment variables set in the
deployment (`LINGER_POOL_BYTES`, `LINGER_FILE_EXPIRY_DAYS`), not rows a host edits from
inside the app — see `docs/decisions.md`.

**`health`** is for the host alone (#582): not a co-host, not a member, and a server
from before it leaves it out. `{ backups, last_backup_at, backup_overdue,
disk_nearly_full, file_space_nearly_full }`: whether the server makes its nightly copy
of the database (`LINGER_BACKUPS`), when the newest copy that checked out was made
(`null` before the first), whether it has run three days without one (always `false`
with backups off), whether less than a tenth of the disk under its data folder is free,
and whether uploads take 90% or more of `storage_limit_bytes` (under `when-full`, only
when nothing is left that could go: every file starred, pinned or not yet sent). The app says each of the
last three in words at the foot of the host's list while it is true, and never as a
figure. Nothing in it is a count of anything.

`health.bucket` is there only when the host set `LINGER_BACKUP_S3_*` (#614), and left out
by a server from before it: `{ name, last_sent_at, overdue }`, the bucket's name, when
the newest copy in it got there by the bucket's own clock (`null` before the server has
looked, a few minutes after it starts, or when none has), and whether the server has run
three days without a copy reaching it. The app says the last in words at the foot of the
host's list too, unless the copy itself is overdue, which says it already.

**`voice`** says whether this server carries voice: it has a voice address, set or worked
out from its domain (§8, "Voice forwarding"). `false` means nobody can join voice here, and the app says so
rather than offering a call. A server from before the field leaves it out, which a client
reads as "maybe" (#306).

**`screens`** says whether this server passes shared screens on (§8, "Screen sharing",
#360): `true` when it carries voice, since only people in a room's voice share or watch,
and its host hasn't turned screens off (`LINGER_SCREENS=off`, docs/host-guide.md). A server from before it leaves it out, and the app offers neither Share nor Watch
there.

### 3.1 DMs

```
GET  /dms                → Room[]
POST /dms   { user_ids } → Room
POST /dms/:id/leave      → 204
```

`POST /dms` is **create-or-find**: the same set of people always gives the same DM, so
asking twice is not how you end up with two conversations with the same three people
(SPEC §4.13). `user_ids` is everybody *else* — the caller is always a member and does
not name themselves; naming yourself, or the same person twice, is
`VALIDATION_FAILED`, and so is an empty list, because a DM with only you in it is not a
conversation. Two to eight people in total. An id that is not a member of this server
is `NOT_FOUND`. A DM somebody has left is never found this way (below).

**Membership is fixed at creation.** There is no endpoint to add somebody: a different
set of people is a different DM. Adding one later would mean deciding what they can read
of what was already said, and that decision is a permission system in its first
disguise (AGENTS rule 10). The one change is leaving, which only goes one way.

**Leaving a group DM** (SPEC §4.13, #565). `POST /dms/:id/leave` takes the caller out of
a group DM they are in, and answers `204`. A group is a DM made for three or more
people, or one somebody has already left, so a group that shrinks to two stays a group.

| Refusal | When |
|---|---|
| `404 NOT_FOUND` "No such room on this server." | a DM the caller isn't in (as for any room they can't see), or a room, which nobody leaves |
| `422 VALIDATION_FAILED` "A DM with one person can't be left. It's their row in your list." | a one-to-one DM |

One transaction does all of it:

- **The caller stops being a member**, so everything that asks whose (`GET /dms`,
  `ready`, messages, search, Media, the export, typing, voice, `room.focus`) stops
  answering them about it, exactly as for a DM they were never in.
- **The DM stops matching its people.** `POST /dms` with the same set makes a new DM,
  so nobody is pulled back into one they left, and the DM carries `someone_left: true`
  from now on, so an app can tell it apart from a DM it would find by its people.
- **The caller's read position and notification rules for it go.**
- **The people still in it get a line**, a `Message` from whoever left with the body
  "left" and `left: true` (§4). Like the line saying somebody joined voice it is never a
  room's `last_message_id`, search passes over it, it can't be edited or reacted to, and
  an app neither notifies nor sounds for it. An app from before the field shows it as
  them saying "left".

Frames, in this order. If the caller was in the DM's voice, each of their seats there
gets `voice.removed` and the people still in it the `voice.state` without them (§8).
Then **every session of the caller gets `dm.remove { room_id }`**, and nothing about
the DM after it. Then the people still in it get `room.update`, with the new
`member_ids`, and the line's `message.create`. An app from before `dm.remove` ignores
it, as any unknown frame (§9): it keeps showing the DM until it next signs in afresh,
and everything it asks about it is `NOT_FOUND`.

**The last person to leave deletes the conversation.** Nobody is left who could read it,
and nobody can be added. Every message in it is deleted as `DELETE /messages/:id`
deletes one (a tombstone, its body emptied), its reactions and link cards go, its files
are swept straight away rather than at the sweeper's next pass (§6), and no line is
written.

Everything else about a DM is a room. `GET /rooms/:id/messages`, `POST` to it,
reactions, uploads, typing and presence all work unchanged and are addressed by the
same `room_id`. **A non-member gets `NOT_FOUND` from every one of them** — not
`FORBIDDEN`, which would confirm the DM exists. There is nothing a non-member can ask
that distinguishes "a DM you are not in" from "no such room".

---

## 4. Messages

```
GET  /rooms/:id/messages?before=<id>&after=<id>&limit=<1..100>   → Message[]
GET  /rooms/:id/messages?around=<id>&limit=<1..100>              → Message[]
POST /rooms/:id/messages   { body, reply_to?, attachment_ids?, nonce? }  → Message
PATCH  /messages/:id       { body }                              → Message
DELETE /messages/:id                                             → 204
POST   /messages/:id/pin                                         → Message
DELETE /messages/:id/pin                                         → Message
PUT    /messages/:id/reactions/:key                              → 204
DELETE /messages/:id/reactions/:key                              → 204
```

`before`/`after` are message IDs, not timestamps. UUIDv7 sorts chronologically, so
pagination is a range scan. Results are always newest-first.

`around` is the same range scan run from the middle: it returns that message
plus as much either side of it as `limit` allows — the older half carries the
message itself and gets the odd one. **The two halves are capped separately and
neither borrows from the other**, so a window near an edge comes back short
rather than growing the other side. That is what makes each half readable on its
own: fewer than `⌈limit/2⌉` at or before the message means the start of the
room, and fewer than `⌊limit/2⌋` after it means the newest message. It exists for search (SPEC §4.12): a hit
six months back is thousands of messages behind the newest, and reaching it by
paging is dozens of round trips for history nobody asked to read. It cannot be
combined with `before` or `after` (`VALIDATION_FAILED`), and a message that is
not in the room named in the path is `NOT_FOUND`.

A client holding a window from `around` is **not** at the newest message, and
that is the thing to get right: folding a live message frame into it would
leave a gap in the middle of the history with nothing to show that it is there.
Read forwards to the end of the room, or open the room again.

`body` is 1–8000 chars after trimming (`linger-core::limits::MAX_MESSAGE_CHARS`);
empty or oversize bodies are `VALIDATION_FAILED` — **except** that a message
carrying at least one attachment may have an empty body. Handing somebody a
photo without typing a caption over it is the ordinary way to share a photo.

A body with nothing visible in it counts as empty (#512), by the rule a display
name is held to (§2, rule 5): only whitespace, format characters (category Cf, e.g.
U+200B, U+2060, U+FEFF), control characters, marks, and blank letters (U+115F,
U+1160, U+3164, U+FFA0, U+2800, U+1D159). Sent or edited, it gets the answer a
blank one gets, `VALIDATION_FAILED` "Say something."; it used to be taken and drew
as an empty row. Beside visible text those characters are kept as written. A
caption is not held to this: a message with an attachment has something to show.

`attachment_ids` are finished uploads (§6). Each must belong to the author, be
in the `complete` state, and not already be on another message; at most
`linger-core::limits::MAX_ATTACHMENTS_PER_MESSAGE` per message. Reusing
somebody else's attachment id is `FORBIDDEN`, and reusing one that is already
posted is `CONFLICT`.

A post is all or nothing: the message, the links it holds, its files and the
sender's read marker are saved in one transaction (#524). A post that fails
left nothing behind, so sending it again doesn't post it twice, and its files
are still free to send.

`nonce` is what makes sending again safe when the post did land and only its
answer was lost on the way back (#524). Asking a poll takes one the same way (below). It is a one-time key the client makes
up for each send (the app uses a UUID) and sends again, unchanged, with every
retry of that send: 1–64 letters, digits, `-` or `_`
(`linger-core::limits::MAX_NONCE_CHARS`), or `VALIDATION_FAILED`. When the same
person already posted with the same key in the last week
(`linger-core::limits::NONCE_KEPT_MS`), the answer is that message as it is
now, edited or deleted since or not, with a success status, and nothing else
happens: no second message, no second `message.create`, the read marker isn't
moved, and the files named in the retry aren't looked at (they're on that
message already). A deleted message's key stays spent, so a retry answers
with its tombstone and can't bring it back. The key is checked before whether
the room is archived, since it was posted while it wasn't. The same key from
two people is two messages. The same person's key used in another room is
`CONFLICT`: one send lands in one room.

Keys are remembered for a week, not for the message's life: a retry only comes
from a client still holding the unsent message. Each post that carries a key
clears out the keys older than that. A post without `nonce` is always a new
message, which is what a client from before the field gets; a server from
before it ignores the field, so a new client there is as it always was.

`reply_to` must reference a message in the same room. Pin/unpin is any member;
there is no pin hierarchy.

```ts
type Message = {
  id: string; room_id: string; author_id: string;
  body: string;                                // markdown source, unrendered
  reply_to: string | null;
  attachments: Attachment[];
  reactions: { key: string; count: number; user_ids: string[] }[];
  pinned_at: number | null;
  edited_at: number | null;
  deleted_at: number | null;                   // tombstone; body is "" when set
  created_at: number;
  motd?: true;                                 // the line saying the message of the day was set (§3)
  voice_join?: true;                           // the line saying somebody joined voice (§8, #473)
  poll?: Poll;                                 // the poll this message asks (#474), below
  poll_closed?: PollClosed;                    // on the line a closing poll leaves (#474), below
  left?: true;                                 // the line saying its author left a group DM (§3.1, #565)
}
```

**Reactions** (SPEC §4.8, #485). A reaction's `key` is one emoji, as the picker gives it
(`"👍"`, `"👍🏽"`, `"👩🏽‍💻"`, `"🇨🇦"`), or `emoji:<id>` for one of the server's own (§5
"Custom emoji"), its id written as 32 hex digits. It goes in the path escaped, as any
path segment is. Each group is one emoji, in the order each was first left, with
`user_ids` in the order people reacted; a client draws the emoji and `count`. Adding
your own twice is one, and taking back one you never left is `204` too.

| Refusal | When |
|---|---|
| `422 VALIDATION_FAILED` "A reaction is one emoji." | the key is words, two emoji, a lone skin tone or joiner (the twelve names reactions had before #485 included) |
| `404 NOT_FOUND` "That emoji isn't on this server." | `emoji:<id>` names no emoji this server has, or writes the id another way |
| `422 VALIDATION_FAILED` "Nobody can react to that line." | the line a closing poll leaves, or one saying somebody joined voice or left a group DM |
| `403 FORBIDDEN` "Reactions are off in this room." | the host turned them off (§3); taking one back is still allowed |
| `409 CONFLICT` "This message has six different reactions, the most it can hold. Add yours to one of them." | it has `MAX_REACTIONS_PER_MESSAGE` (6) different emoji already, and this isn't one of them |

Removing one of the server's emoji removes every reaction with it, and no frame is sent
per message: an app stops drawing a reaction whose emoji isn't in the set (`emoji.update`,
§8). A room whose `reactions_off` is set shows no reactions and no way to add one, but
keeps them: turning it back on shows them again. A DM is never off. Reactions never
notify, sound, or make a room look new (`reaction.update`, §8).

Reactions left before the trial (#168) were stored under twelve names; migration 0015
made each the emoji it drew.

Edits are only permitted by the author, and never on a message-of-the-day line
(`VALIDATION_FAILED`): it says what the message was set to, then (§3). An app from
before the field shows the line as an ordinary message from whoever set it. Nor on a
line saying somebody joined voice (`voice_join`, §8): nobody typed it. Its body is
"joined voice" and its author whoever joined, so an app from before the field shows it
as them saying so; it is never a room's `last_message_id`, search passes over it, and a
client neither notifies nor sounds for it. The line saying somebody left a group DM
(`left`, §3.1) is the same in every way, with the body "left"; whoever left can't reach
it to edit it anyway.

**Polls** (SPEC §4.18, #474). A question the host or a co-host asks a room, which everybody
in it answers with a click.

```
POST /rooms/:id/polls      (host or co-host) { question, choices, multi, closes_in_days, nonce? } → Message
PUT  /messages/:id/vote    { choices: number[] }                                       → Message
POST /messages/:id/close   (whoever asked)                                             → Message
```

```ts
type Poll = {
  question: string;
  choices: { text: string; voter_ids: string[] }[];   // in the order written; votes name choices by place
  multi: boolean;                                      // people may pick more than one
  closes_at: number;                                   // when it closes on its own
  closed_at: number | null;
  closed_by: string | null;                            // null when it closed on its own
};
type PollClosed = { poll_id: string; question: string; winners: string[] };   // winners: most votes; [] when nobody voted
```

- **Asking** is the host or a co-host (`FORBIDDEN` for anybody else), in a room, never a DM
  (`NOT_FOUND`), and not an archived one. Question and choices lose the direction
  controls that turn text around (§2). The question is trimmed, 1 to
  `MAX_POLL_QUESTION_CHARS` (300); `MIN_POLL_CHOICES` to `MAX_POLL_CHOICES` (2 to 10)
  choices, each trimmed, 1 to `MAX_POLL_CHOICE_CHARS` (80), none the same as another
  ignoring case; `closes_in_days` is one of `POLL_DAYS` (1, 3, 7, 14, 28). Anything else is
  `VALIDATION_FAILED`. It is a `Message` from whoever asked, sent as `message.create`, and it
  is a room's `last_message_id` like anything said. Its body is the question and the choices
  as a Markdown list, so an app from before polls shows them as words, and search finds them.
  A client neither notifies nor sounds for one, whoever it names. It can't be edited.
  `nonce` is the ask's one-time key, exactly as a message's (above, #524): the same rules,
  the same week, kept in the same place, so asked again with its key, a poll that was
  asked is answered with that poll and nothing is asked twice.
- **Voting** is anybody who can see the room, whoever asked included: the choices' places,
  replacing any vote before, `[]` taking it back; more than one only when `multi`; at most
  `RATE_POLL_VOTE` (20 in 10 s). A poll that is closed, or whose `closes_at` has passed, takes
  no votes (`VALIDATION_FAILED`); a deleted one is `NOT_FOUND`. The poll as it stands goes to
  the room as `message.update`, which never makes a room look new. Votes aren't secret, and
  there is no count field anywhere: a client that needs one counts `voter_ids`.
- **Closing** early is whoever asked, and nobody else, the host included (`FORBIDDEN`).
  Otherwise the server closes it when `closes_at` comes, whether anybody is online or not, at
  most half a minute late; `closed_by` is then null. Either way, one transaction sets
  `closed_at` and writes a line in the room from whoever asked: body "Poll closed: “Which
  faction…?” Horde won." ("Horde and Alliance tied.", "Nobody voted."), `poll_closed` set.
  The room gets the poll as it ended (`message.update`), then the line (`message.create`).
  The line is never a room's `last_message_id`, search passes over it, it can't be edited, and
  a client neither notifies nor sounds for it. A deleted poll never closes and leaves no line. Deletes are
permitted by the author, the host or
a co-host, except that a co-host can't delete the host's messages (`FORBIDDEN`, §5).
Deleted messages become tombstones; they are not removed, so reply chains survive.
The files a deleted message carried are not kept (#502): the delete removes them, a
tombstone's `attachments` is always empty, and their URLs answer `404` from the moment
the delete does.

**Read markers**

```
PUT /rooms/:id/read      { last_read_id }     → 204
GET /read                → { [room_id]: last_read_id }
```

The client sends this at most once per 5 seconds per room, debounced. **No count is ever
returned by the server.** There is no unread-count endpoint and one must not be added.

A marker only moves forward. A `PUT` naming a message earlier than the one held answers
`204` and changes nothing, so a device that comes back with an older position can't pull
back what another of your devices has read. Posting a message moves its author's marker
to it: something you said is something you've seen, on every device (#454). A server from
before these leaves both to the client, which has always moved its own copy forward only.

`ready` doesn't carry markers, so a client asks `GET /read` on every fresh `ready`, not
only the first: a session that started over has missed whatever was read elsewhere
meanwhile, and the room's `last_message_id` in `ready` would make it look new (#453).
Where the two disagree, the later position wins. The phone app sends a marker still
waiting out its 5 seconds the moment it leaves the screen, since Android stops its timers
and its network soon after (SPEC §4.15).

**A marker that moves is told to its owner's open sessions** (#647), so a device that
stays connected, and so never sees a fresh `ready`, still stops showing what you read
elsewhere as new. A `PUT` that moves it sends `read.update` `{ room_id, last_read_id }`
(§8) to every session that person has open, the one that asked included, and to nobody
else. A `PUT` that changes nothing sends nothing, so however often an app asks, the
frames are bounded by the messages there are to read. A post sends no `read.update`:
its `message.create` already reaches the author's sessions, and a client moves its own
place to a message of its own. **Where somebody has read to is theirs alone.** No frame
or endpoint tells anybody else, and this is not read receipts and must not become them.
A server from before it never sends the frame, and a client catches up on its next fresh
`ready` as before.

---

## 5. Users, styling, statuses

```
GET   /users              → User[]              # all members of this server
GET   /users/:id          → User
GET   /me                 → User
PATCH /me                 { display_name?, style?, status?, entrance_sound?, time_zone? } → User
PATCH /me/password        { current_password, new_password }
                       →  { access_token, refresh_token, expires_in, user }
POST  /me/delete          { password, everything? }  → 204   # never the host

GET  /me/notify-rules     → NotifyRule[]
PUT  /me/notify-rules     { target_user_id, room_id | null }   → 204
DELETE /me/notify-rules   { target_user_id, room_id | null }   → 204

GET  /users/removed       → User[]                  # host or co-host
POST /users/:id/remove    → 204                     # host or co-host
POST /users/:id/restore   → 204                     # host or co-host
POST /users/:id/delete    { everything? } → 204     # the host only, removed people only
PUT    /users/:id/cohost  → User                    # the host only: make a co-host
DELETE /users/:id/cohost  → User                    # the host only: not a co-host
POST /users/:id/sign-in-link → { code, user_id, expires_at }  # the host only, 10/hour
GET  /me/sign-in-links    → SignInLinkMade[]        # the links made for you, newest first

GET    /me/blocks           → UserId[]                         # who you've blocked
PUT    /me/blocks/:user_id  → 204
DELETE /me/blocks/:user_id  → 204

POST   /reports             { message_id } | { user_id }, note? → 201 Report   # 10/hour
GET    /reports             → Report[]                          # host or co-host, open ones
DELETE /reports/:id         → 204                               # host or co-host: dealt with
```

### Changing your password

`PATCH /me/password` checks `current_password` (`FORBIDDEN` when it doesn't match) and
ends every sign-in the account has, the one that asked included (§2): every refresh
family, every access token, and every open gateway session, which gets
`invalid_session { reason: "unauthenticated" }` and is closed. The usual reason to
change a password is that somebody else might have it, and anything that outlived the
change would be theirs to keep.

The device that asked carries on. The answer is a fresh sign-in, the same shape as
`POST /auth/login`'s, in a new refresh family: the client swaps it in for the tokens it
held and reconnects the gateway with it. A token refused while the answer is on its way
is expected, and a client waits for the answer rather than spend its old refresh token,
which is revoked and would sign it out.

A server from before #496 answered 204 with no body, revoked only the refresh tokens,
and closed nothing. A client that gets 204 signs in again with the new password.

An app from before #496 (0.4.10 and earlier) ignores the body and signs in again with
the new password, which leaves the fresh family unused until it expires. It doesn't
wait, though. Its own connection is closed like every other, and its reconnect asks
for a token, by the second ask at the latest renewing with the refresh token the change
just revoked. That is refused, and the app signs itself out. Whichever lands last, that or its own sign-in,
decides whether it stays signed in, so the person may have to sign in again with the
new password. The server closes that connection too, on purpose. The only thing that
could pick it out is the access token it identified with, which is usually older than
the one the change was made with, and a thief holding that same token would be spared
along with it.

### Deleting an account (#650, SPEC §4.19)

Both app stores require that somebody who made an account in the app can delete it
there. An account lives on one server, so the server does the deleting and the app asks
it to; an app signed in to several servers deletes from one at a time.

`POST /me/delete` deletes your own. `password` is checked first (`FORBIDDEN`, "That
password doesn't match.", when it doesn't), so a borrowed, unlocked phone can't. **The
host can't** (`FORBIDDEN`): the server would have nobody in charge, and the host runs the
machine and can wipe the whole server instead. A co-host can, and stops being one.

`POST /users/:id/delete` is the host deleting the account of **somebody they removed**,
who can't sign in to do it (the host only, not a co-host, as for sign-in links; it can't
be undone). Somebody still on the server is `VALIDATION_FAILED`: they delete their own,
or the host removes them first. A deleted account, or no such account, is `NOT_FOUND`.

`everything` is the person's choice, "Also delete everything I wrote", and absent is
off:

- **Off**, what they wrote stays and loses its name: messages and the files on them,
  reactions, poll votes. It still points at their id, which the app draws as "Deleted
  account" (`ready.deleted_users`, `user.remove`'s `deleted`).
- **On**, every message they wrote becomes a tombstone, as `DELETE /messages/:id`
  makes one, and the files on them go with it (the sweep after the delete takes them).
  So do their reactions, their votes in polls still open, and a message of the day they
  set. A closed poll keeps how it came out (SPEC §4.18), so a vote in one stays,
  nameless. The quiet lines saying they joined voice or left a DM stay: they carry no
  words of theirs.

**The `users` row stays, emptied, and keeps the name taken.** Everything else that
points at an account (messages, files, invites, emoji, polls, reports) would stop the
row's delete, and the links that cascade would take the reports about the person with
them. So it is kept as a stand-in: display name, password, style, status and its fields,
entrance sound and time zone are cleared, `deactivated_at` and `deleted_at` are set, and
the username stays. A mention is stored as the text `@username`, and a newcomer who took
the name would inherit every old mention of the person who left, so it is never free
again. Each deleted person keeps their own stand-in, so two people's messages never run
together.

In the same transaction, what was theirs alone goes: sign-ins (every refresh token row,
and every access token through `token_generation`, §2), sign-in links made for them,
read positions, notification rules they set and those set about them, the blocks they
made, their send keys (`message_nonces`). Their invites are revoked. **Two things stay
on purpose.** Blocks *of* them: whoever blocked them chose not to see what they wrote,
and that doesn't change because they left. Reports, both ways, for the host: deleting an
account must not be a way to erase the reports about it. Server emoji they added stay,
as on removal: they're the server's.

DMs: a **group DM** is left as `POST /dms/:id/leave` leaves one (§3.1), with the line
saying so, or deleted when nobody who could read it is left. A **one-to-one DM** stays
the friend's, with what was said in it, as it does when somebody is removed; when nobody
who could read it is left (the friend removed or deleted too), it is deleted the same
way.

Then, after the commit: their gateway sessions are closed with `invalid_session {
reason: "unauthenticated" }`, their uploads in progress and unsent files go, their
export goes, and `user.remove { user_id, deleted: true }` goes to everybody. With
`everything`, everybody also gets `message.delete` for each message, `reaction.update`
for each reaction that came off, `message.update` for each open poll, and `room.update`
for a room whose message of the day went. Those can number thousands, so they go out
paced, about a thousand a second, rather than at once: the gateway's bus holds 1024
frames, and a burst bigger than that would cut every session off (§8, "Resume"). An app
that missed one has it at its next fresh `ready` or the next time it loads the room.

A deleted account can't sign in (`UNAUTHENTICATED`, as a wrong password), is in no list
(`GET /users`, `GET /users/removed`, the roster), and is `NOT_FOUND` to
`GET /users/:id`, remove, restore and delete.

### Sign-in links (#581)

The way back in for a member who forgot their password, without the host stopping the
server to run `reset-password`. `POST /users/:id/sign-in-link` (the host only) answers
a `SignInLink`: a 26-character code of the invite alphabet, the account it is for, and
when it stops working, 24 hours on (`SIGN_IN_LINK_TTL_HOURS`). The app turns it into
`https://<server>/sign-in/<code>` (§2.2) and the host sends it however they send
invites. The code is in that answer and nowhere else: the server keeps only its sha256.

- **Only the host makes one.** Whoever holds a link can sign in as that person, so it
  stays with the person who runs the server. A co-host asking gets the same `FORBIDDEN`
  a member does ("Only the host can do that."). The host can make one for anybody else,
  a co-host included.
- **Never for the host** (`FORBIDDEN`), the host's own asking included: a locked-out
  host uses `reset-password` on the machine, which is the proof of owning it. Nor for
  somebody who isn't a member now (`NOT_FOUND`). Ten an hour
  (`RATE_SIGN_IN_LINK_CREATE`).
- **One works at a time.** Making a link cancels any unused one for the same person.
- **Once.** `POST /auth/sign-in-link { code, new_password }` checks the link before the
  password is hashed, then, in one transaction, marks the link used, sets the password
  and ends every sign-in the account had (§2), and closes its gateway sessions, exactly
  as a password change does. The answer is a fresh sign-in, the same shape as
  `POST /auth/login`'s. It shares `POST /auth/login`'s per-address allowance. A used link
  is `FORBIDDEN` "That sign-in link has been used. If that wasn't you, ask the host for
  a new one."; any other dead one (run out, cancelled, made up, for somebody since
  removed) `FORBIDDEN` "That sign-in link doesn't work any more. Ask the host for a new
  one." A password under the minimum is `VALIDATION_FAILED` and leaves the link unused.
- `GET /auth/sign-in-link/:code` needs no sign-in, like an invite's preview, so the app
  can say whose account it is before asking for a password: `{ valid, server_name,
  username, made_by, expires_at }`, where `made_by` is the maker's display name. A link
  that doesn't work is `{ valid: false }` with everything else `null`.
- **The person is told.** `GET /me/sign-in-links` lists the last five links made for
  you, newest first: `{ made_by, made_at, expires_at, used_at, cancelled_at }`, never
  the code. Settings shows the newest under your password, so a link you didn't ask for
  doesn't go unnoticed.
- **Removal** cancels every unused link made for the person.

A server from before #581 answers `NOT_FOUND` to all four. The app then says the server
needs updating when a host asks for a link, and shows nothing under your password.

### Co-host (SPEC §4.16, #424)

One switch per person, `is_cohost` on `User`. A co-host can call every endpoint marked
"host or co-host", and gets `reports.changed` and `GET /reports` like the host. Three
things stay the host's alone, and nothing else is split off:

- **Making and clearing co-hosts.** `PUT /users/:id/cohost` turns it on and
  `DELETE /users/:id/cohost` turns it off. Neither carries a body; both answer the
  person as they are now and fan out `user.update` to everybody, so their own app learns
  it can show them the host's controls (or stop). Setting it to what it already is
  changes nothing and answers the same. Anybody but the host gets `FORBIDDEN`, co-hosts
  included. The host naming themselves is `VALIDATION_FAILED`, and somebody who isn't a
  member now (never was, or removed) is `NOT_FOUND`.
- **Making sign-in links** (§5, "Sign-in links", #581). A co-host gets the same
  `FORBIDDEN` a member does.
- **Acting on the host.** A co-host can't remove the host, take them out of voice,
  delete their messages or revoke their invites: each is `FORBIDDEN`.

Removing a co-host turns the switch off, and `restore` brings them back as a member.
A server that updates to #424 has no co-hosts until its host names one (migration
`0010_cohost.sql`); a server from before it leaves `is_cohost` out, which reads as false.

### Removing a member

`remove` sets `deactivated_at`; `restore` clears it. Neither carries a body. The host or a
co-host can remove anybody but themselves (that answers `FORBIDDEN`), and a co-host
can't remove the host. There is no ban and no ban list:
usernames are unique and immutable, the account row survives, and registration is
invite-only, so the host is already the only way back in. Nothing durable enough to ban
by (an address, a device id) is stored anywhere in Linger, and nothing is going to be.

Deactivation is enforced in four places, because setting the column alone leaves a
removed member sitting in the room:

- **The bearer extractor** reads it on every authenticated request, so a removed
  member's existing access token stops working immediately. That is one primary-key read
  per request, and it is the deliberate answer to the alternative — letting the token
  lapse on its own, which would leave up to fifteen minutes in which somebody the host
  just removed can still post.
- **Refresh rotation** refuses a deactivated user, so no new access tokens are minted
  for the remaining 30 days of the refresh window.
- **The gateway** closes every live session that user has open, with
  `invalid_session { reason: "unauthenticated" }`, and the socket ends. The token is
  checked once at identify and never again, so an open socket would otherwise keep
  receiving fan-out forever.
- **`GET /users`** and the roster query filter deactivated accounts, so they leave the
  roster on their own.

Removal also ends every sign-in the user has (§2: every refresh family, and every access
token minted before it) and revokes every invite they created, in the same transaction
as the column. Their messages are untouched; removing a person is not deleting what they
wrote. What they had on its way into a message is deleted (#503): their uploads still
going up and the finished uploads they never posted, which nobody else could see, delete
or send, and which held the pool. Files on their messages stay, and so does the picture
of an emoji they added, which is the server's.

`restore` is not an undo. It clears the column and nothing else: the revoked invites stay
revoked and the revoked sign-ins stay revoked, an access token from before the removal
included, so the person signs in again with their password. `GET /users/removed` is
how the host finds somebody to restore — a removed member is absent from every other
surface by design.

Both endpoints announce themselves on the gateway: `remove` fans out `user.remove`, and
`restore` fans out `user.update`, which is "here is this person, whether or not you had
them" (§8).

`PATCH /me` semantics: absent fields are unchanged; `style` and `status` replace the
whole object when present. `entrance_sound: ""` clears the sound (bundled keys are
validated against `linger-core::ENTRANCE_SOUNDS` until custom uploads land in M4).

A `status` that clears the away message the saved one had (from a message to `null` or
`""`) also **ends away on every one of the person's gateway sessions** (#653, §8). A
save that keeps the away, or sets one, leaves presence alone: setting away is the
device's own `presence.update`.

`time_zone` is "Show my local time" (#604, SPEC §4.6): a time-zone name turns it on or
moves it, and `""` turns it off. Absent or `null` leaves it as it is, so an app from
before it never turns it off by saving a status. The server checks the name's shape
(1–3 parts split by `/`, each of ASCII letters, digits, `_`, `-` or `+`, starting with a
letter, at most `MAX_TIME_ZONE_CHARS` = 64; `VALIDATION_FAILED` otherwise) and keeps no
zone database: an app that doesn't know a zone shows no time. The app sends this
computer's zone, and moves it when the computer's clock says somewhere else.

```ts
type User = {
  id: string; username: string; display_name: string;
  is_host: boolean;
  is_cohost: boolean;                 // a co-host the host named (#424); never with is_host
  style: Style;
  status: UserStatus | null;
  entrance_sound: string | null;      // bundled key or object key
  last_seen_at: number | null;
  time_zone?: string;                 // "America/Chicago" when they show their local time (#604); absent when off
}

// One of the 16 named palette keys defined in linger-core::PALETTE. See SPEC §5.4.
// ember rust amber brass lime fern mint teal
// cyan  sky  azure indigo violet orchid rose slate
type ColorKey = string;

type Style = {
  font_key: string;                   // must be in linger-core::FONTS
  weight: 400 | 500 | 700;
  italic: boolean;
  fill: { kind: "solid"; color: ColorKey }
      | { kind: "gradient"; from: ColorKey; to: ColorKey };   // angle is fixed at 92°
  effect: "none" | "shimmer" | "glow";
  msg_font_key: string | null;
}

type UserStatus = {
  line: string | null;                // <= 240 chars
  reading: string | null;             // <= 80; the field labelled "Reading" (#270)
  listening: string | null;           // <= 80; the field labelled "Listening to"
  working_on: string | null;          // <= 80; the field labelled "Working on"
  fields: StatusField[] | null;       // <= 3, in order; absent from servers before #270
  image_id: string | null;            // always null; accepted and ignored (#269)
  image_url: string | null;           // always null; server-owned
  away_message: string | null;        // <= 240 chars; supersedes `line` when set
  away_since: number | null;
}

type StatusField = {
  label: string;                      // 1–24 chars: a suggestion, or the person's own
  value: string;                      // 1–80 chars
}
```

`msg_font_key` retains the existing `FONTS` validation for compatibility with
older clients. The current client offers only the four sans-serif faces for
message bodies and renders other saved keys with its default body face. This
is a rendering fallback; it does not migrate stored styles or change the wire
format.

**A status has no image** (SPEC §4.6, #269). `image_id` and `image_url` stay in
`UserStatus` so apps from before the removal keep reading and saving statuses, and
they are **always null** on the way out. On the way in the server accepts an
`image_id` and ignores it: nothing is checked or stored for it, so a save from an
older app that still names a picture succeeds with the rest of the status and no
picture. Send null for both. Taking the two fields out of the wire is a later,
breaking protocol change.

A server that had status pictures loses them when it updates: migration
`0006_no_status_image.sql` clears every one. The files they pointed at are finished
uploads on no message, so the expiry sweeper takes them after the file expiry window
like any upload that was never posted (SPEC §4.10).

**Status fields** (SPEC §4.6, #270). A status has up to three short fields,
each a `label` and a `value`, in the order the card shows them. The app
suggests Listening to, Reading, Working on, Playing and Watching, and takes
any label typed; the server doesn't keep a list. It checks every field: at
most three (`VALIDATION_FAILED` for a fourth), each label 1–24 characters and
each value 1–80, counted after trimming, neither holding a control character
(a tab, a line break), and no label twice, ignoring case. It stores them
trimmed, and without the direction controls that turn text around (§2),
which every text in a status loses. An empty value is refused rather than dropped: an app leaves out a
field nobody filled in. A web address in a value is the app's to draw as a
link; on the wire a value is plain text.

Older apps keep working, both ways:

- **Reading.** Every status still carries `reading`, `listening` and
  `working_on`, each the value of the field whose label is exactly "Reading",
  "Listening to" or "Working on" (case and spelling as written), or null. A
  field with any other label is only in `fields`. A server from #270 on always
  sends `fields`, `[]` when there are none.
- **Saving with `fields`** (an app from #270 on): the list is the whole set,
  and replaces what was there. `reading`, `listening` and `working_on` in the
  same request are checked like values and otherwise ignored; the server fills
  them from the fields. Send them filled from your fields anyway, so a server
  from before #270, which ignores `fields`, keeps the three it knows.
- **Saving without `fields`**, or with `fields: null` (an app from before
  #270): the three keys change only the fields with those labels, and every
  other field stays where it is. For each of "Listening to", "Reading" and
  "Working on": a non-empty value replaces that field's value in its place, or
  adds a field with that label at the end if there is none; an empty or null
  value removes that field. Replacing and removing happen before adding. A
  value that would make a fourth field is refused with `VALIDATION_FAILED`
  ("Your status already has three fields…") and nothing is saved, because the
  older app can't show the field it would push out. The three keys are held to
  a value's rules: 80 characters, no control characters.

A server that updates to #270 turns each status's three old values into
fields with those labels, in the order Listening to, Reading, Working on
(migration `0007_status_fields.sql`), so every status reads back unchanged.

### Report and block (SPEC §4.15, T-1605)

Both stores require them in an app where people post things. Among friends who
trust each other they should be rare, so they are the least that does the job.

**Block** is one person's private list. `PUT` adds somebody and `DELETE` takes
them off; both answer 204 whether or not that changed anything. Blocking yourself
is `VALIDATION_FAILED`, and an id that isn't a member of this server is
`NOT_FOUND`. Nobody else can read the list, and the person blocked is never told:
nothing they can call answers any differently.

The server enforces one thing itself: a `knock` from somebody you've blocked is
answered 204, as any knock is, and goes nowhere. Everything else is the client's.
A blocked person's messages still arrive, live and in history, and the client
draws each one as a single grey line you can open (SPEC §4.15). They don't chime,
light a DM, or show in Media or Search. That is deliberate: in a room of friends,
a reply to a message that vanished reads as somebody talking to nobody.

A change reaches every session of the person who made it as
`block.update { user_id, blocked }`, so a block made on a phone holds on the
computer at once. Nobody else's session hears of it.

**Report** goes to the host and any co-hosts, and nobody else; a self-hosted
server has nobody else to send it to. A report names a message (`message_id`: one the reporter can
read, and not their own) or a person (`user_id`: anybody but yourself). The
`note` is optional, up to 1000 characters. The server keeps the message's words as
they were when it was reported (`excerpt`), so the host still sees what was
reported after it has been edited or deleted. A report about a DM shows the host
and the co-hosts that one message, which is what the reporter is asking for.
Anything else in a DM stays out of their sight. Ten reports an hour per reporter
(`RATE_REPORT_PER_HOUR`).

`GET /reports` answers the open reports, newest first, to the host and the
co-hosts; anybody else gets `FORBIDDEN`.

A co-host never sees a report about themselves: their `GET /reports` leaves it out, and
their `DELETE /reports/:id` on it is 404, as for one that doesn't exist. The person
reported isn't told, co-host or not. The host sees every report.

```ts
type Report = {
  id: string;
  reporter_id: string;
  user_id: string;          // who it's about
  message: { id: string; room_id: string; excerpt: string; created_at: number } | null;
  note: string | null;
  created_at: number;
}
```

`DELETE /reports/:id` closes one: the host or a co-host dealt with it, by
deleting the message, removing the person, or letting it go. A closed report
isn't listed again, and nothing reopens it.

Whenever the open reports change (one sent, one closed), every session the host
and each co-host has open gets `reports.changed`, with nothing in it, and the
client asks `GET /reports` again. Who that is gets read from the database each
time, so somebody just made a co-host hears the next one. A client also asks
when its own `user.update` says it has just become a co-host. There is **no
count** anywhere (AGENTS rule 3): the list shows one quiet row while any report
is open, never how many.

### Custom emoji (SPEC §4.8, #359)

A server's own emoji: pictures the host or a co-host adds for everybody on the server,
written `:name:` in a message and drawn as the picture.

```
GET    /emoji                                        → CustomEmoji[]   # any member, by name
POST   /emoji        { name, attachment_id }         → CustomEmoji     # host or co-host
PATCH  /emoji/:id    { name }                        → CustomEmoji     # host or co-host
DELETE /emoji/:id                                    → 204             # host or co-host
```

```ts
type CustomEmoji = {
  id: string; name: string;
  url: string;          // the picture, on the media origin like an attachment's (§6)
  animated: boolean;    // a GIF: it stays animated
  created_by: string; created_at: number;
}
```

**Adding one** makes a finished upload into an emoji: the app uploads the picture
through `POST /uploads` like any file (§6), so its type is what its bytes say and nothing
hidden in it survives the re-encoding, then names it here. The checks, in order:

| Refusal | When |
|---|---|
| `422 VALIDATION_FAILED` "An emoji's name is 2 to 32 lowercase letters, digits or underscores." | the name isn't `[a-z0-9_]{2,32}` (`linger-core::limits::emoji_name_ok`) |
| `422 VALIDATION_FAILED` "A server has room for 200 emoji. Remove one to add another." | it has `MAX_CUSTOM_EMOJI` (200) already |
| `404 NOT_FOUND` "No such upload." | the upload isn't finished, or isn't the caller's |
| `409 CONFLICT` "That picture is on a message. Upload it again to make it an emoji." | the upload went out on a message |
| `409 CONFLICT` "That picture is already an emoji." | it is one already |
| `415 UNSUPPORTED_MEDIA` "An emoji is a PNG, GIF, WebP or JPEG picture." | anything else |
| `422 VALIDATION_FAILED` "An emoji's picture can be at most 256 KB and 512 pixels wide or tall." | `MAX_EMOJI_BYTES`, `MAX_EMOJI_EDGE` |
| `409 CONFLICT` "There's already an emoji called :name:." | the name is taken |

A plain member gets `403 FORBIDDEN` from the three that change the set. A rename is held
to the same name rule and the same clash (its own name again is none); an unknown id is
`404 NOT_FOUND` "No such emoji." Removing an emoji removes its picture.

**Everybody hears every change** as the whole set, in `emoji.update` (§8), and `ready`
carries it too. There are no per-room or per-person emoji, and nobody's emoji are for
sale (AGENTS rule 13).

**A message keeps the text.** `:name:` is stored as typed, so search and export see
`:name:`, a renamed emoji leaves older messages saying the old name, and a removed one
reads as its name. An app draws `:name:` as the picture only when it is one of the
message's own server's emoji, never inside code, and reads it as `:name:` to a screen
reader. A reaction with one is kept by its id instead (§4), so a rename keeps it and a
removal takes it.

**The picture is the emoji's.** It never expires (§3), `DELETE /uploads/:id` on it is
`409 CONFLICT` "That picture is one of the server's emoji. Remove the emoji instead.",
and putting it on a message is `409 CONFLICT` "That picture is one of the server's
emoji." It doesn't show in the media collection and isn't in anybody's export.

### Palette validation (server-side, mandatory)

There is no runtime color clamping, because there are no arbitrary colors. The server
validates that every `ColorKey` and `font_key` is a member of `linger-core::PALETTE` and
`linger-core::FONTS` respectively, and rejects anything else with `VALIDATION_FAILED`.

Contrast safety is structural. The palette is defined once, at one lightness (the app is
dark only, SPEC §5.3):

```
oklch(0.76 0.13 <hue>)     // slate: chroma 0.02
```

Every entry holds ≥4.5:1 against the background, and its evening version, by construction.
A property test asserts this across all 16 keys and must run in CI — it is the guard
against someone "improving" a palette value later.

---

## 6. Uploads, media, search

```
POST /uploads              { filename, size_bytes, mime }
                        →  { upload_id, attachment_id, method, url,
                             headers, part_size_bytes, parts? }

POST /uploads/:id/complete { parts?: [{ number, etag }] }   → Attachment
DELETE /uploads/:id                                         → 204
```

Client PUTs bytes **directly to the returned URL**, never through the app server.
Files over 8 MB use multipart with per-part URLs, which is what makes uploads resumable.

Server rejects at slot creation: `size_bytes > 500 MB` (`FILE_TOO_LARGE`), more than
1 GB of the caller's own uploads still going up (`QUOTA_EXCEEDED`, #503), server pool
over quota (`QUOTA_EXCEEDED`), or a mime not on the allowlist in `linger-core::media`
(`UNSUPPORTED_MEDIA`). The two `QUOTA_EXCEEDED` refusals differ only in `message`: the
first says it is the caller's uploads, not the server's storage, and clears as they
finish or are thrown away. A slot reserves its declared size from the moment it is
handed out, so a client that gives up on an upload should `DELETE` it. Server
re-validates real size and sniffs actual MIME at complete — never trust the declared
values. A file whose bytes disagree with its declared type is
`UNSUPPORTED_MEDIA`; a file that is not the size it said it would be is
`VALIDATION_FAILED`. An image that can't be decoded, or that would take more memory to
re-encode than the server allows (ARCHITECTURE §8), is `UNSUPPORTED_MEDIA` with "That
image can't be read." A video or sound file the server can't copy without its tags
(#651) is `UNSUPPORTED_MEDIA` with "That video can't be read." or "That sound file can't
be read.", and every video and sound file on a server without ffmpeg is
`UNSUPPORTED_MEDIA` with "This server can't take videos or sound files until its host
installs ffmpeg."

`upload_id` and `attachment_id` are the same identifier. An upload is an attachment that
has not arrived yet, and there is nothing to remember about one that the attachment does
not already hold.

**Parts.** `part_size_bytes` is 8 MB. At or under that the upload is a single PUT to
`url` and `parts` is absent; above it, `parts` lists one signed URL per part, numbered
from 1, and `url` is the first of them. The layout is a pure function of `size_bytes`, so
a client that resumes recomputes exactly the plan it was given. Each successful PUT
answers with an `ETag` (which CORS exposes), and those etags may be handed back at
complete; the server checks them against what actually landed.

Each part is exactly its planned length: `part_size_bytes` for every part but the last,
and what is left over for the last (the whole file, for a one-part upload). Send each
part as one body of that length; a browser sets `Content-Length` from it. A longer part
is refused when it is PUT, on both backends. On S3 a shorter one is too, because the
length is signed into the URL and the bucket answers any other with `403`. A part
longer than planned that reaches the store anyway makes complete fail with
`VALIDATION_FAILED`, and that refusal is final.

**Resuming.** Re-PUTting a part replaces it. Completing with parts missing is
`VALIDATION_FAILED` and **leaves the slot alive**: send the missing parts and complete
again. So does `RATE_LIMITED` ("The server is busy with other pictures…", with
`retry_after_ms`), which an image gets when the server has been working on two others
for longer than it can wait (ARCHITECTURE §8): complete again after `retry_after_ms`. Any
other refusal at complete is final — the parts are discarded and the slot cannot be
retried, because resending the same bytes under the same declaration cannot make them
acceptable.

**A slot that hears nothing for an hour is released** (#503): when no part has arrived
for an hour, or none has since the slot was handed out an hour ago, its space is given
back and its parts are discarded. After that `complete` is `NOT_FOUND`, and so is a part
PUT to the server's own listener; the client starts again with a new slot. A bucket may
still take a part from a link it signed, but nothing will ever use it, and the server
deletes it once the slot's links have expired.

`DELETE /uploads/:id` throws an upload away, finished or not, along with its bytes; one
that never finished is released, as above, and `complete` on it is `NOT_FOUND`. It is
`CONFLICT` once the attachment is on a message; delete the message instead. It is
`CONFLICT` for a picture that is one of the server's emoji too (§5, "Custom emoji"):
remove the emoji, which takes its picture with it. A finished upload that is never posted
is deleted after a week, or after the file expiry window if that is shorter, and even
with expiry off (#503); an emoji's picture never is.

**Serving.** `Attachment.url` (and `poster_url` and `display_url`) point at the object store, on the media
origin — a host of its own, `cdn.<LINGER_DOMAIN>` by default, which serves `/objects/...`
and nothing else. On a server with `LINGER_DOMAIN` set these URLs are absolute; on one
without, there is only one origin and they are root-relative, resolved against the server
the client is talking to. The URL is the secret: an object key contains a UUIDv7, and the
request is not authenticated, which is what lets an `<img>` tag work. Only image, video
and audio types on the `linger-core::media` inline list are served with their own content
type; everything else is served as `application/octet-stream` with
`Content-Disposition: attachment`, and every response carries
`X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`
(ARCHITECTURE §7). A file on a deleted message is `404`, like one that never existed. A
file the server sends itself goes out with `Cache-Control: private, max-age=31536000,
immutable`: the client's own cache may keep it, a shared cache may not, because a file can
still be deleted (ARCHITECTURE §8).

**Ranges.** A file stored on the server's own disk can be fetched a piece at a time,
which is how a video player seeks and how a browser resumes a download. One byte range
per request is served: `Range: bytes=a-b`, `bytes=a-` or `bytes=-n` (the last `n` bytes)
answers `206 Partial Content` with `Content-Range: bytes a-b/<length>` and the piece's own
`Content-Length`, and carries every header the whole file does. A range that starts at or
past the end is `416` with `Content-Range: bytes */<length>`, no body, and
`Cache-Control: no-store`. Anything else —
several ranges, a malformed header, or a `Range` under an `If-Range` (the server hands out
no validator for one to match) — gets the whole file with `200`. Every file response says
`Accept-Ranges: bytes`. On S3 the route is a redirect and the bucket answers ranges
itself. Export archives (§7) are served the same way.

A client should treat these URLs as opaque and use them as given. Nothing else on the
media origin answers, and the API does not answer there.

```ts
type Attachment = {
  id: string; filename: string; mime: string; size_bytes: number;
  url: string;                       // separate CDN origin, see ARCHITECTURE §7
  width: number | null; height: number | null; duration_ms: number | null;
  blurhash: string | null; poster_url: string | null;
  display_url?: string;              // an image's smaller copy, for lists; see below
  starred_at: number | null;
  uploader_id: string; created_at: number;
}
```

`mime`, `filename` and `size_bytes` on a finished attachment describe what the server
**stored**, not what the client declared. Images are re-encoded on upload, which strips
EXIF and can change the format (a WebP comes back as a PNG, with its extension corrected).
A photo is turned the way its EXIF Orientation says before that, so `width` and `height`
are as it is seen, and a client draws the stored picture as it is (#569). A video's
`width` and `height` are as it plays, the same size as its poster: a phone stores a
portrait video on its side with a quarter turn to play it at, and the server swaps them
for it (#658). A video stored before that keeps the size it was stored with. Video and
sound files are copied without their tags (#651), in the same container, so their
`size_bytes` is usually a little smaller than what was sent.
The stored `filename` has no folders in it, and no control characters, double quotes,
backslashes or direction controls (§2).

**Display copies (#382).** An image's `display_url` is the picture to draw where it is
shown small: in a conversation and on a media tile. An engine that decodes the full
picture holds all of it in memory, about 50 MB for a phone photo, however small it is
drawn. When the stored image is over 960 px on its longest side, `display_url` is a copy
the server made, 960 px on its longest side, JPEG for a JPEG and PNG for anything else.
Otherwise it is `url` itself, and so is an animated GIF's, which a still copy would stop.
`url` is still the whole picture, for the image viewer and for downloads. Video, audio
and other files have no `display_url`. An older server leaves it out, and so does this one
for an image uploaded before it had copies, until its background pass has made that
image's: either way, draw `url`. A copy is not counted in the pool, is not in an export
(§7), where the original is, and goes when its file goes.

**Media**

```
GET /media?kind=image|video|audio|file|link|pin
          &author=<user_id>&since=<ms>&until=<ms>&leaving=true
          &before=<cursor>&limit=<1..100>               → MediaItem[]
PUT    /media/:attachment_id/star                        → 204
DELETE /media/:attachment_id/star                        → 204
```

Everything shared on the server, in one list: uploads, links people typed, and
pinned messages. `since`/`until` are Unix ms and inclusive; a range that ends
before it starts is `VALIDATION_FAILED` rather than an empty answer.

**Order.** Starred first, then newest first. Only an upload can be starred, so
everything starred comes ahead of every link and pin.

**`leaving=true`** is "Leaving soon" (#583): only the uploads that would go next, in the
same order and with the same paging. Never a starred file or one on a pinned message,
and never a link or a pin. Under `when-full` (§3), nothing until the file space is past
80% of `storage_limit_bytes`, then the oldest files that add up to a tenth of it; under
an age rule, the files within 30 days of their date; with expiry off, nothing. A server
from before #583 ignores the parameter and answers with everything, so a client asks
only a server that sends `file_expiry_when_full`.

**Paging** is keyset, not offset: pass the last item's `cursor` back as
`before`. A cursor is opaque — do not parse it, build one, or compare two. All
the links in one message share a page, so a page may hold slightly more than
`limit` items; a page that comes back empty is the end.

```ts
type MediaKind = "image" | "video" | "audio" | "file" | "link" | "pin"

type LinkPreview = {
  url: string; domain: string;
  title: string | null;
  icon: string | null;              // small data: URI, never a remote address
}

type MediaItem = {
  kind: MediaKind;
  cursor: string;                   // opaque; hand back as `before`
  author_id: string; created_at: number;
  message_id: string | null; room_id: string | null;
  attachment: Attachment | null;    // set iff kind is image|video|audio|file
  link: LinkPreview | null;         // set iff kind is link
  excerpt: string | null;           // the message's text, shortened
  starred_at: number | null;
}
```

`PUT`/`DELETE /media/:attachment_id/star` take an **attachment** id: a star is
what keeps a file from being swept at 365 days, and a link or a pin has no
object to keep. Anyone may star anything — the collection belongs to the server,
not to a reader, so there is no per-person star. An id that is not a finished
upload sitting on a message is `NOT_FOUND`.

**Link cards**

```
POST /links/preview   { urls: string[] }   → LinkPreview[]
```

One card per URL asked about, in the order asked, at most 16 per call. The
client asks about the links it is drawing; the server answers from its cache and
fetches whatever is missing or stale (a week for a success, an hour for a
failure).

A card's title is the page's `og:title`, or its `<title>`, from the first
256 KB of the page. A **YouTube video** is the exception (#300): its page is
far bigger than that, with the title a long way in, so the server asks
YouTube's oEmbed address instead (`https://www.youtube.com/oembed?url=…`) and
reads only the `title` from the answer, never a thumbnail or a player. A video
is a `watch?v=` link on `youtube.com` (with or without `www.`, `m.` or
`music.`), a `youtu.be` link, or a `/shorts/`, `/live/` or `/embed/` one, with
an eleven-character id. The request goes through the same guard as every
other fetch. A YouTube video's card that has no title is asked about again
after an hour rather than a week, so cards remembered before this, and videos
oEmbed couldn't name at the time, get their titles.

**The client never fetches a preview itself, and neither does the reader's
browser.** If it did, every site anyone linked would collect the IP of everyone
who scrolled past the message — a remote favicon `<img>` alone would do it. So
the host's IP does the looking, once per URL for everybody, and `icon` comes
back inline as a `data:` URI. Treat a card as text to draw, and never turn its
`url` into a request the reader makes without them clicking it.

A URL the server will not fetch — a private or loopback address, a port, a
scheme other than `http(s)` — still answers with a card made of its domain.
Refusing would only make a client ask again forever, and a link to `192.168.1.1`
in a message is far more likely to be somebody's router than an attack. The
fetch itself resolves the name, refuses the whole name if **any** address it
answers with is private, pins the connection to the address it checked, follows
at most three redirects with the same check on every hop, and caps both time and
bytes (ARCHITECTURE §7).

**Search**

```
GET /search?q=<words>&room_id=<room_id>&author_id=<user_id>
           &before=<cursor>&limit=<1..50>              → SearchHit[]
```

Messages containing every word in `q` (SPEC §4.12). Newest first, always — there
is no relevance ordering and no parameter to ask for one.

`q` is **words, not a query language.** The server takes the searchable runs out
of it and looks for all of them; a run inside double quotes is one phrase, those
words in that order. Nothing else is syntax: `AND`, `OR`, `NEAR`, `*`, `(` and
`^` are characters to tokenize like any other, so no input is a parse error and
none of it can be made to mean something the person typing did not intend. A
control character (NUL, escape, a C1 code) splits words the way a space does.
Matching is on whole words with simple English endings folded together, so
`photo` finds `photos`.

A `q` that holds no searchable characters — empty, blank, or only punctuation
or control characters — is `VALIDATION_FAILED`, not every message on the server. Terms past the twelfth
are ignored rather than refused, and a `q` over 200 characters is
`VALIDATION_FAILED`. `room_id` or `author_id` naming something that is not here
is `NOT_FOUND`, because "no results" and "no such room" send a reader looking in
different places. The rate limit is `RATE_SEARCH`: 30 per person per minute.

**Paging** is keyset, like `/media`: pass the last hit's `cursor` back as
`before`. A cursor is opaque — do not parse one, build one, or compare two. A
page that comes back empty is the end.

```ts
type SearchSnippetPart = { text: string; matched: boolean }

type SearchHit = {
  message_id: string; room_id: string; author_id: string;
  created_at: number;
  cursor: string;                    // opaque; hand back as `before`
  snippet: SearchSnippetPart[];      // in order; draw `matched` runs emphasised
  matched_filenames: string[];       // set when the match was a file's name
}
```

A hit is **not** a `Message`. A result list draws who, where, when and a few
words; opening one fetches the real message from its room, which is the moment
its attachments and reactions are worth sending.

`snippet` arrives already cut into runs rather than as a string with markers in
it, because any marker is a character a message could contain. Draw the runs in
order and emphasise the matched ones in the reader's presentation — there is
nothing to parse and nothing to escape. It is empty when the message said
nothing, which happens when a photo was posted with no caption and the match was
its filename.

**A deleted message is not searchable** — neither its words nor the names of the
files it was carrying, and it never comes back as a hit. That is the same rule
the export follows (§7).

---

## 7. Invites, export, knock

```
GET    /invites          → Invite[]
POST   /invites          { expires_in_hours?, max_uses? }   → Invite
DELETE /invites/:code                                       → 204

POST /export             → { job_id }                        # any member, 1/hour
GET  /export/:job_id     → { job_id, state, progress, url?, expires_at? } # the asker's own only
POST /knock              { target_user_id }                 → 204   # 3/hour per target
GET  /voice/ice          → { servers: IceServer[], ttl_secs } # the voice relay, for you
DELETE /rooms/:id/voice/:user_id → 204   # host or co-host: take them out of that room's voice (#423)
```

```ts
type IceServer = { urls: string[]; username: string | null; credential: string | null }
```

**Invites.** `max_uses` left out is one use: an invite is single-use unless the
host asks otherwise (ARCHITECTURE §7). `"max_uses": null` is no limit, and a
number is that many uses; `0` is `VALIDATION_FAILED`. A plain JSON parser reads
a missing field and `null` alike, so the server tells them apart on purpose,
and a client asking for no limit must send the `null` rather than leave the
field out (#246). `expires_in_hours` left out or `null` is never. An `Invite`
comes back with `max_uses: null` when it has no limit. `DELETE /invites/:code`
is for whoever made the invite, the host or a co-host; a co-host can't revoke
the host's invites (§5, "Co-host").

**Voice relay** (SPEC §4.14, T-1403). What a client puts in its peer connections'
ICE configuration before joining voice: the host's STUN and TURN addresses, with a
password made for the asking member on the spot. The password is coturn's
time-limited scheme — `username` is `<unix expiry>:<user id>` and `credential` is
`base64(HMAC-SHA1(shared secret, username))` — so the server stores nothing and
the relay looks nothing up; both hold the secret and both compute. The expiry is
a day from now (`ttl_secs` at least), rounded up to the hour, so a member asking
again within the hour gets the same username and password: the relay's
per-person limit on relay ports counts a person, not a request (#501).
`ttl_secs` is how long the password has left. A client asks again on every join,
so it only has to outlast one call. The relay carries the encrypted stream, which
it cannot read, to this server's voice address and nowhere else (#501).

A host with no relay answers `{ servers: [], ttl_secs: 0 }`. That is not an
error: voice then works between machines on one network and nowhere else, and
the client joins anyway. The endpoint needs a signed-in member and answers the
same for all of them; there is no host-only view of it. It allows 20 asks a
minute per member and answers `RATE_LIMITED` past that (#501); a client that
gets no answer joins without the relay, as it would on a server with none.

**Export** (SPEC §4.11, T-801). `state` is `queued | running | complete |
failed`; `progress` is `0.0`–`1.0`; `url` appears once `state` is `complete`
and points at the **media origin**, the host uploads are served from, because
an archive of the whole server has no more business being same-origin with the
app than an upload does. It is served like an upload, byte ranges included
(§6), so a browser can resume a download that broke off.

As with attachment URLs (§6), a server without `LINGER_DOMAIN` returns a
root-relative export URL. The client resolves it against that server's origin
before handing it to the system browser, never against the WebView's origin.

Asking about somebody else's job is `NOT_FOUND`, not `FORBIDDEN` — which of the
two it was is not the asker's business. A member has one archive at a time:
starting a new export deletes the previous one's bytes, so an old `url` stops
working. The rate limit is about the host's disk and CPU, not about permission;
there is no host approval anywhere in this flow and there must never be one.
For the same reason, one archive builds at a time across the whole server: a
job waits in `queued` (progress `0.0`) until the one ahead of it finishes, so a
client must not treat a long `queued` as a failure.

**An archive lasts a week** (#504). `expires_at` (unix ms) comes with `url`:
when the server deletes the archive, a week after it finished. After that the
`url` is a `404`, and so is asking about the job. Removing a member deletes
their archive and job at once. A server from before archives expired leaves
`expires_at` out, and a client must not invent one. A job cut off by a server
restart is `failed` from the next start, and the member can ask again.

`POST /export` is refused with `QUOTA_EXCEEDED` (HTTP 507) when the server's
disk can't hold the archive, with a `message` that says so in words; nothing is
started, the member's current archive is kept, and the refusal doesn't count as
their export for the hour, so they can ask again once there's room. A job that passed that check
and waited in `queued` is checked again when its turn comes, and is `failed` if
the room has gone. Like a rate-limit refusal, this is not permission: it keeps a
full disk from stopping the server.

**Knock** (SPEC §4.9, T-1101). One member nudges one member. The target has to
be a member of this server — a stranger and somebody the host removed are both
`NOT_FOUND` — and knocking yourself is `VALIDATION_FAILED`. The rate limit is
`RATE_KNOCK_PER_TARGET`: three per hour **per target**, so knocking five
different people is five separate buckets. A refused knock is `RATE_LIMITED`
with `retry_after_ms` set to how long until the next knock at that person is
allowed; the client says when that is in words (#268).

The server writes nothing. A knock is not a row, and there is no endpoint that
lists knocks, because there is nothing to list. All it does is put one `knock`
frame on the target's sessions (every session that person has open, and nobody
else's — see §8's fan-out rules). If they are not connected it lands nowhere,
which is correct: it is a tap on the shoulder, not a voicemail.

The frame carries `from_user_id` and nothing else. No id, no body, nothing to
reply to and nothing to dismiss — a knock that a client could mark as read
would be a message, and §4.9 exists to avoid making anybody write one.

---

## 8. Gateway

`wss://<host>/api/v1/gateway`. JSON frames.

```ts
type Frame = { op: string; d: unknown; s?: number }
```

`s` is a monotonically increasing sequence number, present on server→client frames only.

A client→server frame is one WebSocket text message of at most `MAX_CLIENT_FRAME_BYTES`
(256 KiB) of JSON, twice `MAX_VOICE_PAYLOAD_BYTES`: the biggest frame a client sends is
`voice.answer`, and JSON writes the line breaks in its `sdp` longer than they are. A
bigger message ends the connection at once, before `identify` as after, and nothing in
it is read: the server stops at the header that gives its size, or, for a message sent
in pieces, at the piece that takes it past the cap (#517). Server→client frames have no
such cap.

### Handshake

```
S→C  { "op": "hello",  "d": { "heartbeat_interval_ms": 30000 } }
C→S  { "op": "identify", "d": { "token": "<access_jwt>", "client": "linger-desktop/0.1.0" } }
S→C  { "op": "ready",  "d": { "session_id", "user", "users": User[],
                              "rooms": Room[], "dms": Room[],
                              "presence": PresenceEntry[],
                              "voice"?: VoiceRoomState[],
                              "emoji"?: CustomEmoji[],
                              "reactions"?: true,
                              "deleted_users"?: UserId[] },
                              "s": 0 }
```

`ready.deleted_users` is every account deleted on this server (§5, #650). None of them
is in `users`; a client draws what they left as "Deleted account" rather than the
"someone" a removed member's messages get. A server from before leaves it out, which a
client reads as none.

`ready.emoji` is the server's own emoji, the whole set (§5, "Custom emoji"); a server
from before them leaves it out, which a client reads as none.

`ready.reactions` is `true` from a server that takes any emoji as a reaction (§4,
#485). A server from before leaves it out, and a client offers no reactions there: it
would refuse anything but the twelve names reactions used to have.

`VoiceRoomState` is `{ room_id, peers: VoicePeer[] }`. New servers include
`ready.voice` for occupied rooms visible to this member, including their DMs.
Older servers omit it. Clients render these names without joining voice or
playing arrival sounds. Subsequent `voice.state` events replace each list as
usual. The snapshot is captured after subscribing to events, as with presence,
so changes during sign-in are replayed rather than lost.

### Heartbeat

Client sends `{ "op": "heartbeat", "d": { "s": <last_seq> } }` every
`heartbeat_interval_ms` ± jitter. Server replies `{ "op": "heartbeat_ack" }`. Two missed
acks → client reconnects.

### Resume

```
C→S  { "op": "resume", "d": { "session_id", "token", "s": <last_seq> } }
S→C  { "op": "resumed", "d": { "replayed": <n> } }    # then replays missed frames
S→C  { "op": "invalid_session", "d": { "reason": "expired" } }   # → re-identify
```

The server holds a 500-frame ring buffer per session for 120 seconds after disconnect.
Beyond that, the client must re-identify and refetch.

### `invalid_session`

The server's way of saying a session is over. It is a control frame (no `s`), and the
socket ends after it. The reasons:

| reason | when | the client |
|---|---|---|
| `unauthenticated` | `identify` or `resume` with a token that is not good: a bad signature, expired, or from before something ended every sign-in the account had (§2). Also sent to an open session when that happens: the account was removed or its password changed. | Gets a fresh access token and identifies. If renewal is refused, the sign-in is over. |
| `unknown user` | `identify` for an account that is removed (§5). | Nothing works until the host restores the account. |
| `expired` | `resume` of a session the server no longer holds: the 120 seconds passed, or the server restarted. | Identifies afresh. |

A `resume` with a token from before a password change is refused with
`unauthenticated` even when the session it names is live, and the session is left
alone (#496).

### Client → server

| op | payload | notes |
|---|---|---|
| `presence.update` | `{ state, away_message? }` | Where you are, and nothing about what you are doing (SPEC §4.3). `away_message` is held to `PATCH /me`'s rule, 240 characters; told at most `RATE_PRESENCE` times (below) |
| `room.focus` | `{ room_id \| null }` | fires on focus; `null` = left the room. Told at most `RATE_ROOM_FOCUS` times (below) |
| `typing.start` | `{ room_id }` | server rate-limits to 1 per 4s per room; ignored in an archived room, which takes no messages |
| `voice.join` | `{ room_id, controls?: { muted, deafened }, forwarding: true }` | join or update your own controls; moving leaves the old room. `forwarding` says this client takes voice through the server (#197); a join without it is refused (#306). At most `RATE_VOICE_SEAT` with `voice.leave` (below) |
| `voice.leave` | `{}` | no room id: you are in at most one |
| `voice.answer` | `{ sdp }` | the answer to the server's latest `voice.offer` |
| `voice.restart` | `{}` | start this session's connection to the server afresh; the server sends a new `voice.offer` |

The gateway has no way to answer a client frame, so a frame that breaks a rule is
**ignored, whole**, and nothing it says is told to anybody. The rules are the ones REST
keeps for the same thing: a room the sender can't see, an away message over its cap,
typing where no message can go (#497).

**`presence.update`** goes to everybody connected, and the state it sets is in every
`ready` until it changes, so the server keeps two rules for it (#497):

- **The away message is held to the rule `PATCH /me` holds it to**: at most 240
  characters (`MAX_STATUS_LINE_CHARS`). A frame with a longer one is ignored whole: its
  `state` doesn't change either, and nobody is told anything.
- **A burst is told as a few, then the newest.** One that changes nothing is told to
  nobody. Changes are told at most `RATE_PRESENCE` times per person: five, and then one
  every two seconds. Past that, a change is held back, not dropped: when the person's
  turn comes, the server tells whatever is newest then, once, however many changes came
  in between. The server has the newest from the start, so a `ready` in between already
  carries it. An app sends a handful an hour, and never sees the limit.

**`room.focus`, `voice.join` and `voice.leave`** each make the server tell many people
something, so a burst from one app is cut short the same way (#527): a few, then the
newest, never dropped.

- **Moves are told at most `RATE_ROOM_FOCUS` times per person**: ten, then one a second.
  Each can be a `room.leave`, a `room.enter`, two `room.occupancy` and a
  `presence.update` to everybody. The move itself happens when the frame arrives, so a
  `ready` has it at once and a `presence.update` after it lands in order. Only the
  telling waits: at the person's turn, everybody is told where they are by then, once.
  A room they passed through on the way hears nothing and plays no entrance sound.
- **Joins and leaves are taken at most `RATE_VOICE_SEAT` times per session**: ten, then
  one a second, mute and deafen changes included. Each seat taken or left makes the
  forwarding server offer everybody in that voice room a fresh connection. Past the limit
  the newest request waits for the session's turn and is taken then, so a burst ends
  where its last frame said, with one round of offers. A session that left or moved while
  it waited, and ends up back in the seat it had, still gets a fresh `voice.offer`: its
  app closed the old connection.

**Each session speaks for itself** (#653). Somebody signed in on a phone and a computer
is two sessions, and the server keeps what each one's `presence.update` and `room.focus`
said apart. What everybody is told, in `presence.update`, `room.*` and every `ready`, is
worked out from all of them, in this order:

1. **Away** on any session is `away`, in no room, with the away message set most
   recently.
2. Otherwise, **in a room** on any session is `in_room`, in the room moved into most
   recently.
3. Otherwise, **around** on any session is `around`.
4. Otherwise every session is idle, and so is the person: `idle`.

With no session open they are `offline`. A frame changes only its own session's part.
Moving ends that session's idle, but not its away, so a phone opening a room can't undo
the away set on the computer. Away ends when the session that set it sends another
state, or closes, or when a `PATCH /me` clears the away saved on the person's status
(§5): that ends it on every session, so I'm back on the phone ends an away the computer
set. The app saves the status before it sends its own frame, so with one device the
frame that follows changes nothing and nobody is told twice. A `presence.update` saying
`in_room` or `offline` counts as `around`: where somebody is comes from `room.focus`,
and offline from their last session's part going.

**A short drop tells nobody anything** (#654). A session's part goes at once when its
socket closes with a goodbye (a WebSocket close frame, which the app sends when it
closes its connection, as on signing out of a server), or when the server ends the
session (`invalid_session`, above). A socket that drops without a
goodbye leaves its part in place for `PRESENCE_GRACE_MS` (5 seconds), counted as it
was, and nobody is told anything meanwhile, the way a voice seat waits out a drop
(SPEC §4.14). If the session isn't resumed by then, its part goes, and everybody is told
what that changed: `offline`, out of their room, if it was their last. If it is resumed
in time, nothing anybody is told changes. The app says where it is again on every
`ready` and `resumed`, counting from `around` in no room and sending only where it
differs, so what the session said before the drop stands until its first
`presence.update` or `room.focus`. That frame starts its part again from `around` in no
room, and saying the same as before tells nobody anything. A session that says nothing
by the end of the grace period is `around` in no room from then. A socket a resume has
already replaced (#451) isn't the session's last, and its closing changes nothing.
`identify` and `resume` carry no presence of their own.

The frames are the same as with one session; only what goes in them is worked out
differently. A change that moves somebody is told as a move (`room.leave`, `room.enter`,
`room.occupancy`, then `presence.update`) under `RATE_ROOM_FOCUS`, whichever frame
caused it: away on the computer takes them out of the room open on the phone. A change
that tells everybody nothing new is told to nobody.

### Server → client

| op | payload |
|---|---|
| `message.create` | `Message` |
| `message.update` | `Message` |
| `message.delete` | `{ id, room_id }` |
| `reaction.update` | `{ message_id, key, count, user_ids }` — one emoji's reactions on a message as they now are; `count` 0 means none are left. It never notifies, sounds, or makes a room look new (#485) |
| `presence.update` | `PresenceEntry` |
| `room.occupancy` | `{ room_id, user_ids }` |
| `room.enter` | `{ room_id, user_id, entrance_sound }` — triggers the sound |
| `room.leave` | `{ room_id, user_id }` |
| `user.update` | `User` — the current state of this person, **whether or not the client already had them**. A display name, style or status change, and equally somebody who was not on the roster a moment ago: the client's fold appends when the id is unknown |
| `user.remove` | `{ user_id, deleted? }` — this person is off the server. The mirror of `user.update`, and it names an id rather than carrying a `User` because there is no state left to describe: `User` has no `deactivated_at` field and is not going to grow one to carry a tombstone. `deleted: true` when the account was deleted rather than removed (§5, #650), so the client labels what they left "Deleted account"; left out for a removal and by servers from before |
| `room.create` / `room.update` | `Room` — a DM's `room.create` reaches its members and nobody else, which is how the other members find out it exists |
| `dm.remove` | `{ room_id }` — **sent to the sessions of the person who left that group DM and nobody else's** (§3.1, #565): it's gone from their list. Nothing about the DM reaches them after it |
| `typing` | `{ room_id, user_id }` |
| `knock` | `{ from_user_id }` — **sent to that one person's sessions and nobody else's** (SPEC §4.9) |
| `block.update` | `{ user_id, blocked }` — **sent to the blocker's own sessions and nobody else's** (§5, "Report and block") |
| `read.update` | `{ room_id, last_read_id }` — **sent to the reader's own sessions and nobody else's** (§4, #647): your place in that room moved forward, on this device or another. A client moves its copy forward only. A position, never a count |
| `reports.changed` | `{}` — **sent to the host's and the co-hosts' sessions and nobody else's**: the open reports changed, so ask `GET /reports` again |
| `emoji.update` | `{ emoji: CustomEmoji[] }` — the server's emoji changed (one added, renamed or removed, §5): the whole set every time, to everybody |
| `voice.state` | `{ room_id, peers: [{ session_id, user_id, controls?, forwarded? }] }` — who is in voice in that room, whole every time |
| `voice.offer` | `{ sdp, tracks: [{ mid, session_id }], bitrate? }` — the forwarding server's offer, **addressed to one session**, whole every time somebody joins or leaves. `bitrate` is what to send the microphone at, in bits a second (#431) |
| `voice.removed` | `{ room_id }` — **addressed to one session**: the host or a co-host took it out of that room's voice (#423), or its person left that group DM (§3.1), just before the room's `voice.state` without it. It says why; leaving is the `voice.state`, which an app from before this frame acts on the same |

```ts
type PresenceEntry = {
  user_id: string;
  state: "in_room" | "around" | "idle" | "away" | "offline";
  room_id: string | null;
  away_message: string | null;
}
```

### Voice

The server's part in voice is **taking each client's voice once and passing it on to
everyone else in the room** (SPEC §4.14, #197). It forwards the packets without decoding
or keeping them. Until #306 there was also a mesh, where the server only introduced
clients to each other (`voice.signal`) and each sent to every other; it is gone, and so is
that frame. A client that still sends one is ignored, as any unknown frame is (§9).

```ts
type VoiceControls = { muted: boolean; deafened: boolean }
type VoicePeer   = { session_id: string; user_id: string; controls?: VoiceControls | null; forwarded?: boolean;
                     screen?: ScreenShare | null; watching?: string | null }
type ScreenShare = { fps: 30 | 60 }
```

**A seat is a session, not a person.** Each client has its own connection to the server,
and one person signed in on a laptop and a desktop is two of them. Session ids survive a
resume and change on a fresh `identify`.

**Controls are self-reported, not remote commands.** Repeating `voice.join`
for your current room with `controls` changes only your own session's state;
it does not leave/rejoin or rebuild the connection. The server normalizes
`deafened: true` to `muted: true`. Unchanged reports produce no frame. Missing
controls on a join mean unknown, not an open microphone; repeating a join
without them does not erase known state. Reports are held in memory, survive
resume with the seat, and disappear on leaving. They use the ordinary
membership-filtered `voice.state`, including inside DMs.

**The host or a co-host can take somebody out of a room's voice** (#423, #424): `DELETE /rooms/:id/voice/:user_id`,
for somebody who walked away with their microphone on. Every seat that person has in that
room ends (a laptop and a desktop are two); each of those sessions gets `voice.removed`, and
then the room gets its `voice.state` without them. It isn't a ban: they can join again. It is
the one thing anybody can do to somebody else's voice, and it isn't a remote mute: their
microphone is closed by their own app leaving, and nothing turns anybody's microphone on.
Only in a room the host can see, so a DM's call is as private as the DM; never the one
asking (422, they have Leave); for a co-host never the host (403); 404 when the person
isn't in that room's voice.

Old servers ignore the extra join field and old clients ignore the extra peer field. New
clients still enforce local controls on an old server, but cannot show others' state. Mic
activity and output-device health are not inferred from these two booleans. Nor is
push-to-talk: a client whose push-to-talk key is up sends silence but reports
`muted: false`, because not holding the key isn't muting (SPEC §4.14, #232).

**Joining puts a quiet line in the room** (SPEC §4.14, #473). A `voice.join` that gives a
session a new seat (arriving, or moving here from another room; not a repeated join that
only changes controls) starts a wait of `linger-core::limits::VOICE_JOIN_LINE_AFTER_MS`
(10 s). If the session still holds that same seat when it ends, the server writes a
`Message` in the room from that person, body "joined voice", `voice_join: true`, and sends
it as `message.create` to the room's members, a DM's only to its people. It doesn't when
that person already has a join line in that room from the last
`VOICE_JOIN_LINE_EVERY_MS` (ten minutes), counted from the lines stored, so a restart
forgets nothing; the check and the write are one statement, so two of somebody's
devices joining together write one line. Nor in an archived room. A seat left inside
the wait writes nothing, and leaving never writes a line.

**`voice.state` is the whole list every time**, never a delta. It is sent to a room's
members whenever anybody joins, leaves or changes controls, and a client can act on the
newest one it has without replaying what came before. Getting it twice is harmless;
missing one is not, which is why it is a snapshot.

**Leaving is implicit as well as explicit.** A session that ends leaves the voice room
it was in and the others are told — as are the others of a session whose resume
window lapses, which is what stops a dead client sitting in the list looking connected.
A session that *resumes* keeps its seat: it is the same client, and it replays whatever
it missed, the server's latest offer included. A client that gets a fresh `ready`
instead has no seat, whatever it had before, and no `voice.state` without it is coming:
the new session was never in the list. It closes its microphone on the `ready` itself,
and doesn't take a seat again on its own (#589). A client signing out sends
`voice.leave` before it closes the socket, so the room isn't left waiting out the window.

### Voice forwarding (#197)

A server with a voice address **forwards voice**: each client sends its voice once, to the
server, and the server passes it on to everyone else in the room. It is the only way voice
travels (#306). The address is `LINGER_VOICE_ADDRESS`, or with that unset, the first
public address `LINGER_DOMAIN` looks up to, once, at startup (#440). A server without one
(the setting is `off`, or there's no domain to look up, or it gives only private
addresses) carries no voice at all: every `voice.join` there is refused, and `GET /server`
says `voice: false` (§3).

- **Who gets a seat.** A `voice.join` that carries `forwarding`, true or false, on a
  server that forwards. Every app from 0.4.1 sends it; 0.4.1 to 0.4.3 send `false` when
  their Settings said "the old way", and are forwarded anyway. A join without it is an app
  from before 0.4.1, which spoke only the mesh: it is refused, and the room carries on as
  it was. A refused join, like any voice frame that doesn't fit, gets no answer.
- **Everybody is marked `forwarded: true`** in `voice.state`. Nobody needs it to know
  anything now, but apps 0.4.1 to 0.4.3 read it to know they're forwarded, and without
  it would wait for a mesh nobody offers. A server from before #306 leaves it out for a
  room on the mesh; a current app that finds its own seat unmarked leaves voice and says
  the server needs an update.
- **The server makes every offer; the client only answers.** On joining, the server
  sends `voice.offer`: one m-line for the client to send its microphone on, and one
  receiving m-line per other person in the room. `tracks` names whose voice each
  receiving m-line carries, by `mid`; the one m-line it doesn't name is the microphone's.
  When somebody joins or leaves, everybody else gets a new offer, whole. Only one offer
  is out per session at a time: a change while one is out waits for its `voice.answer`.
  Two offers can never cross.
- **Full ICE, one address.** The server's offer carries one host candidate, its voice
  address, on one UDP port (3479 by default) that carries every
  voice connection. The client needs no candidates from the server and sends none: the
  server learns where a client is from the checks that client sends, and a client that
  can't reach UDP goes through the TURN relay to that address. The server checks each
  connection itself every few seconds. It is not ICE-lite, which would count a connection
  alive only while the client sends checks, and a client's WebRTC stack may send none while
  voice flows both ways (#210).
- **What the server sees.** Voice is encrypted on the wire (DTLS-SRTP) but each hop ends
  at the server, which forwards packets without decoding them. It stores nothing. It
  could, in principle, listen: SPEC §4.14 says so, and #200 is the layer that would stop it.
- **A failed connection is restarted, not left.** A client sends `voice.restart` when its
  connection to the server has heard nothing for a few seconds (the app: 3 s for ICE to
  call it disconnected, and still so 2 s later), when it fails, or when its gateway socket
  resumes while it's in voice, the plainest sign the network under it changed (#656). The
  server starts that session's connection afresh and sends a new `voice.offer`. Its seat,
  and what the room sees, don't change. A client that isn't in voice is ignored. The app
  keeps one restart in flight at a time, until the new offer is answered, asks again if
  none comes within 3 s, and never sends two closer than that. A `voice.offer` in a
  resume's replay is for the connection the restart replaces, so the app doesn't answer it.
  Each connection the server starts has an ICE username fragment (`a=ice-ufrag`) of its
  own; an offer with a different one from the connection a client holds is from a fresh
  start, and the client answers it on a new connection, never by renegotiating the old one.
- **Limits.** `voice.answer`'s `sdp` is at most `MAX_VOICE_PAYLOAD_BYTES`; anything
  larger is dropped. Answers and restarts are rate-limited per session
  (`RATE_VOICE_SIGNAL`), loosely, because a busy room re-offers everybody each time
  somebody comes or goes. A room holds `MAX_VOICE_PEERS` (60). An app sends voice only
  while its person is talking (Opus DTX, its "still here" frames left unsent too), so the
  server forwards little but the people talking. An app from before 0.4.9 sends silence
  as well; the server reads it and passes none of it on (a packet of `SILENCE_MAX`, 3
  bytes, or fewer is silence).
- **The six loudest at once** (#197). A room passes on at most `LOUDEST` (6) voices at a
  time, so however many talk, the server's work stops growing at six. Every offer
  negotiates the audio level header extension (RFC 6464, `urn:ietf:params:rtp-hdrext:ssrc-audio-level`,
  in `str0m`'s standard set), and the app from 0.4.9 puts each frame's level on its
  packet (`level::dbov`). A voice holds a seat while it's passed on: a free seat goes to
  the first voice that needs one; with all six taken, a newcomer takes the quietest
  holder's seat only when it is 6 dB louder, a holder silent for 200 ms counting as
  silent; a seat is free again after 500 ms of silence (`linger-sfu`'s `floor`). A
  voice with no level, from an app before 0.4.9, counts as the quietest. Nothing changes
  on the wire for a listener: a voice without a seat simply sends nothing for a while, as
  a pause does.
- **Quality is the room's** (#431). Every `voice.offer` carries `bitrate`: 128,000 in a
  room of up to twenty sessions, 96,000 from twenty-one, back to 128,000 once the room is
  down to sixteen (`linger-sfu`'s `SMALL_ROOM_BITS`, `BIG_ROOM_BITS`, `BIG_ROOM`,
  `SMALL_AGAIN`). A room's size changes only when somebody joins or leaves, and both send
  everybody in it a new offer, so the newest offer is always right. The app sends its
  microphone at that rate from its next frame, held to 16,000–128,000 whatever a server
  says; Opus changes rate between packets with nothing renegotiated. An app from before
  0.4.9 ignores it and lets Opus choose (about 51 kbit/s), and a server from before leaves
  it out, which an app takes the same way. The forwarding server's work doesn't change
  with it, since it passes packets on unopened; the host's upload does.

### Screen sharing (#360)

Somebody in a room's voice can share their screen, and anybody else in that room's voice
can watch it (SPEC §4.20). The pictures don't travel on the gateway or on voice's UDP
port: each share and each watcher has a **screen socket**, a WebSocket of its own at
`/api/v1/screen` on the server's address. The sharing app turns the screen into video
itself (WebCodecs) and sends it there; the server passes each frame on, unopened, to the
people watching; their apps play it. Nothing is stored. `docs/decisions.md` has why it
isn't a WebRTC track.

**Who is sharing and watching is in `voice.state`.** Each `VoicePeer` gains:

- `screen: { fps }`, while that session shares, at 30 or 60 frames a second;
- `watching: session_id`, the session whose screen it is watching.

Both are left out otherwise, and by a server from before this. A share or a watch
starting, switching or ending sends the room a new `voice.state`, whole, as joining does.

**A screen socket is one session's, and lives inside its seat.** Its first message, text,
within `linger-core::limits::SCREEN_HELLO_MS` (10 s), says who it is and what for:

```ts
type ScreenCodec = "vp8" | "avc1"     // VP8, or H.264 in Annex B
type ScreenHello =
  | { op: "share"; token: string; session_id: string; fps: 30 | 60; encode: ScreenCodec[] }
  | { op: "watch"; token: string; session_id: string; target: string; decode: ScreenCodec[] }
```

`token` is an access token (§2) and `session_id` the gateway session it belongs to, from
`ready`. The server checks that the token is good and still signed in, and that the
session is that person's and has a voice seat. Then:

- **`share`**: at most `MAX_SCREENS_PER_ROOM` (3) sessions share in one room at a time;
  `fps` is 30 or 60; `encode` names the formats the app can make, best first, and needs at
  least one the server knows. A session that already shares is sharing again: its old
  socket closes (4006) and the new one takes over, at the new `fps`.
- **`watch`**: `target` is a session sharing in the same room's voice, not this one.
  `decode` names the formats the app can play. A session that already watches moves its
  watching here, and its old socket closes (4006).

A hello that doesn't pass closes the socket with a code and nothing else happens:

| Code | Why |
|---|---|
| 4001 | The token isn't good, or that sign-in ended |
| 4002 | That session has no voice seat, or isn't that person's |
| 4003 | Three people are sharing in that room already |
| 4004 | Nothing to watch there: the target isn't sharing in this room |
| 4005 | The hello wasn't one: not JSON, too late, an unknown `op` or `fps`, no format |
| 4006 | Another socket took over this session's share or watching |
| 4007 | The share or the watching ended: the seat left voice, or the session ended |
| 4008 | This server doesn't pass screens on: it carries no voice, or its host set `LINGER_SCREENS=off` |

**Frames are binary messages**, the same shape both ways: a 12-byte header, then one
encoded frame as WebCodecs made it (`EncodedVideoChunk`).

| Bytes | |
|---|---|
| 0 | Version, `1` |
| 1 | Format: `1` VP8, `2` H.264 (Annex B, parameter sets on every key frame) |
| 2 | Flags: bit 0 set on a key frame, the others `0` |
| 3 | `0` |
| 4–11 | When the frame was captured, in microseconds on the sharer's clock, big-endian |

The server reads bytes 0–2 and passes the message on as it came. Anything else on a share
socket is dropped, as is a frame over `MAX_SCREEN_FRAME_BYTES` (1 MiB), one with an
unknown version or format, or one in a format the server didn't ask for.

**The server picks the formats** (#360). For each share it works out, from its watchers'
`decode` and the sharer's `encode`:

1. The first of the sharer's formats that **every** watcher can play: everybody gets that.
2. Otherwise each watcher gets the first of the sharer's formats it can play, and the
   sharer makes each of those.
3. A watcher that can play none of them gets none, and is told so.

With nobody watching the sharer is asked for nothing, and makes nothing.

**Text messages carry the rest**, JSON, `{ op, … }`:

```ts
// To a share socket
type ScreenShareSays =
  | { op: "want"; codecs: ScreenCodec[] }      // make exactly these from now on; [] is nothing
  | { op: "keyframe"; codec: ScreenCodec }    // make the next frame of this format a key frame
// To a watch socket
type ScreenWatchSays =
  | { op: "showing"; target: string | null; codec: ScreenCodec | null }
// From a watch socket
type ScreenWatchAsks =
  | { op: "watch"; target: string; decode?: ScreenCodec[] }   // watch another share here
  | { op: "keyframe" }                                        // my player lost its place
```

`want` comes right after a good `share` hello, and again whenever the answer changes.
`showing` comes right after a good `watch` hello and whenever what this socket shows
changes: `codec: null` with a `target` is a share this app can't play; `target: null` is
the share ending, after which the socket stays open with nothing on it until the app
closes it or sends `watch`. The app ignores ops it doesn't know (§9).

**Key frames.** A watcher is sent nothing until a key frame in its format arrives. The
server asks for one whenever a watcher starts getting a format, falls behind, or sends
`keyframe`, at most once every `SCREEN_KEYFRAME_EVERY_MS` (500 ms) for each format of a
share. A sharing app also makes one at least every 10 seconds of its own accord.

**A watcher that falls behind is skipped forward.** The server holds at most
`SCREEN_WATCH_QUEUE` frames (60) waiting to go to one watcher. Past that, it drops that
watcher's frames until the next key frame, and asks for one. The share and the other
watchers don't wait.

**The server holds each share to a ceiling.** A share sends at most
`SCREEN_MAX_BITS_PER_SECOND` (10 Mbit/s) over a second, with
`SCREEN_BURST_BYTES` (2 MiB) to spare for key frames, whatever the app asks for; frames
past it are dropped, and its watchers wait for the next key frame. The apps aim lower:

| Speed | Size | Rate the app asks of its encoder |
|---|---|---|
| 30 | Fits 1920×1080 | up to 4.5 Mbit/s, sharpness kept over frames |
| 60 | Fits 1920×1080 | up to 6 Mbit/s, frames kept over sharpness |

**Ending.** A share ends when its socket closes, its session leaves voice or ends, or a
newer share takes over; watching ends the same way, or when the share does. A session
leaving voice closes both its sockets (4007). Nothing of either outlives its seat, and
neither survives a server restart, as voice doesn't.

**Hard rule 2 holds here too.** Nothing in a hello, a frame or `voice.state` names a
window or an application; the operating system's picker is the app's only way to choose
what to share, and its choice reaches the app as pictures alone.

**Limits.** Hellos are rate-limited per person (`RATE_SCREEN_HELLO`), and `watch` and
`keyframe` messages per socket (`RATE_SCREEN_ASK`). A text message over 2 KiB closes the
socket (4005).

### Fan-out rules

**Every frame that names a room is filtered by that room's membership.** A public room's
members are everybody on the server, so this changes nothing for rooms; a DM's members
are the people in it, and nobody else's session is sent the frame at all. It is not a
client-side decision and never was one — a client that receives a frame has already been
told the thing.

- **A frame that names a room the receiver cannot see is not sent.** That covers
  `message.create`, `message.update`, `message.delete`, `reaction.update`,
  `room.occupancy`, `room.enter`, `room.leave`, `room.create`, `room.update`,
  `typing` and `voice.state`. The server resolves the audience when it publishes; there is no filtering
  left for anybody downstream to forget.
- **A new frame type is members-only until somebody says otherwise.** The mapping from
  frame to room is exhaustive in `linger-server`, so a frame added later does not
  compile until its author has said whether it names a room. Defaulting the other way is
  how a leak gets added by somebody who was not thinking about DMs at all.
- **Being in a DM is being `around`, to everybody.** A `presence.update` (and the
  `ready` snapshot) for somebody standing in a DM says `state: "around"`,
  `room_id: null` to every receiver, the DM's own members included, and no
  `room.enter`, `room.leave` or `room.occupancy` is sent for a DM at all (SPEC §4.13).
  It is rewritten, not withheld: dropping the frame would make that person appear
  offline, which is a worse answer and a slower leak. Servers before 0.4.1 sent members
  the DM's id and outsiders `in_room` with `room_id: null`; a 0.4.1 client shows either
  as around.
- `room.enter` is sent only to clients currently in that room, *and* only to members
  of it. The receiving client applies its own mute rules and quiet hours before playing
  anything (SPEC §4.1).
- `user.update` and `user.remove` go to every connected client. They are about a person,
  not a place.
- `knock` is an **addressed** frame: it goes to every session the target
  has open and to no other member, the sender included. The address is not on
  the wire — the receiver is the only one who gets the frame, so a field naming
  them would carry nothing (SPEC §4.9, T-1101).
- `block.update` and `reports.changed` are addressed too: the first to the
  sessions of the person who blocked or unblocked, the second to the host's and
  every co-host's.
  Neither names a room.
- `read.update` is addressed to the sessions of the person whose place moved (§4,
  #647). It names a room they can see, but it goes by address, never to the room:
  nobody else learns where somebody has read to.
- `dm.remove` is addressed to the sessions of whoever left that group DM (§3.1). It
  names a room, but a room they are no longer in, so a membership check would drop it;
  it is published to them by address instead, after they are out of the DM's audience,
  so the frames about it from then on (the line, the new `member_ids`) never reach them.

---

## 9. Versioning

```
GET /health              → { ok, version }              # no sign-in
```

`ok` says the server is up and its database answers; `version` is the release
it runs, like `0.4.4` (`wire::Health`). It needs no account, so the app uses it
to check a pasted address is a Linger server, and a host's app compares
`version` with the newest release to say when their server is behind (#314).
Every server since 0.2 answers with exactly these two fields.

The path carries the major version. Within v1, additive changes only: new optional
fields, new `op` values, new error codes. Clients must ignore unknown fields and unknown
`op` values rather than erroring.

A break of the wire as a whole, such as an endpoint renamed or a field that means
something else, means `/api/v2` and a client that speaks both during a transition window.
A narrower break, one thing an older app or server can't do (the mesh voice before
0.4.1 was one, #306), follows the rules below.

### Which apps and servers work together

**Decided by Matt, 2026-10-19 (#315).** An app and the server it talks to are on
different releases most of the time. Hosts update their servers when they get to it,
an Android app installed from a release never updates itself, and an app store holds
every update for review.

- **Before 1.0, every change works both ways wherever it can**: a new app with an older
  server, and an older app with a new server, as it has from the start. Nothing older is
  promised in writing while the design is still settling.
- **From 1.0, a promise.** An app works with every server released in the 12 months
  before it or the two releases before it, whichever reaches further back, and a server
  works with every app from the same window. A slow year still covers the last release,
  and a busy month still covers a year.
- **The app asks the server what it can do, not which version it is.** A feature that
  needs the server is announced by the server, in `GET /server` or `ready`, the way
  `voice` (#306) and the list of deleted accounts (#650) are. An app that doesn't find
  it hides the feature or says the server needs an update, and never tries it and
  fails. `version` above is for telling a host their server is behind (#314), never for
  turning a feature on.
- **A break is rare, chosen, and said ahead.** Something that can't work both ways may
  only leave behind versions outside the window, and the release before it says so in
  its notes (`docs/releasing.md`). Anybody whose app meets it is told in plain words, the
  server needs an update and to ask the host, or this app needs one, rather than a
  feature quietly not working.
- **One version number for the app and the server.** One release is a new app and a new
  server, from the same tag, and its notes say when something new needs the server
  updated. Releasing them apart would give each its own number, and every rule above
  would have to be written out for both.
