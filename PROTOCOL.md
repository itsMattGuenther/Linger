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

Standard codes: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`,
`VALIDATION_FAILED`, `INVITE_INVALID`, `INVITE_EXPIRED`, `QUOTA_EXCEEDED`,
`FILE_TOO_LARGE`, `UNSUPPORTED_MEDIA`, `CONFLICT`, `INTERNAL`.

---

## 2. Auth

Access token: JWT, EdDSA, 15 min TTL, sent as `Authorization: Bearer <jwt>`.
Refresh token: opaque, 30 days, **rotating**. Reuse of a consumed refresh token revokes
the entire token family and forces re-login.

```
POST /auth/register     { invite_code, username, display_name, password }
                     →  { access_token, refresh_token, expires_in, user }

POST /auth/login        { username, password }
                     →  { access_token, refresh_token, expires_in, user }

POST /auth/refresh      { refresh_token }
                     →  { access_token, refresh_token, expires_in }

POST /auth/logout       { refresh_token }              → 204

GET  /auth/invite/:code → { valid, server_name, expires_at }  # unauthenticated preview
```

A new account (from `POST /auth/register` or `POST /setup`) starts with a
name style whose fill is the hued palette color the fewest active people on
the server wear, ties going around the color wheel in steps of seven (SPEC
§4.5). Slate is never handed out. Everything else in the style is the default.

`POST /auth/register` announces the new account on the gateway: it fans out
`user.update` carrying the new `User`, which is "here is this person, whether or not
you had them" (§8). Without it a client that is already connected has no card to draw
the newcomer with, and would not see them until it reconnected.

### 2.2 Shareable links

Nothing on the server serves these paths — they exist so a person has one thing to
paste into the client, which parses them and calls the endpoints above. The origin
is the server; everything else is the client's business.

```
https://linger.example/setup?token=…   first-run link, printed to the console
https://linger.example/invite/CODE     an invite (?code=CODE is also accepted)
linger.example                         no path: sign in to an existing account
```

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
`password`: minimum 8 characters. Do not impose composition rules, do not expire
passwords, and do not ask for a hint. The floor was 12 until 2026-08-21; it came
down because the client remembers the password in the OS keyring, so the length
was friction paid on every fresh install and bought very little. 8 with no
composition rules is the NIST SP 800-63B floor and the honest answer here.

Refresh-token reuse (presenting an already-rotated token) revokes the token's whole
family — every token descended from the same login — and forces re-login on that
device chain. Logout likewise revokes the presented token's family.

When renewal fails, a client ends its saved sign-in only if refresh is rejected with
`UNAUTHENTICATED` or `FORBIDDEN`. A temporary server error, rate limit, or transport
failure leaves the saved token in place and reports the failure to the caller. A
later request can try again; clients must not loop on refresh or infer token
revocation from `INTERNAL`. This applies both at startup and during normal use.

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
                             voice? }
PATCH /server            (host or co-host) { name?, accent_key?, icon_key? }   # accent_key from PALETTE

GET  /rooms              → Room[]                       # public rooms only
POST /rooms              (host or co-host) { slug, name, topic? }         → Room
PATCH /rooms/:id         (host or co-host) { name?, topic?, position?, motd?, reactions_off? }   → Room
POST /rooms/:id/archive  (host or co-host)                                → Room

GET  /dms                → Room[]                       # the DMs you are in
POST /dms                { user_ids }                   → Room
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
topic is what the room is about. `PATCH /rooms/:id { motd }` sets it, trimmed, up to
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

**The three storage figures** are read-only and every member sees them; the status bar
draws the first two (SPEC §5.6). `storage_used_bytes` counts stored objects *and*
uploads still in flight, because a slot already handed out is not space anybody else can
have. `storage_limit_bytes` is the pool ceiling. `file_expiry_days` is how long a file
stands before the server sweeps it, or `null` on a server that keeps files for good;
starred files, files on pinned messages and the server's emoji pictures (§5, "Custom
emoji") never expire whatever it says (SPEC §4.10).

They are not on `PATCH /server`. Both knobs are environment variables set in the
deployment (`LINGER_POOL_BYTES`, `LINGER_FILE_EXPIRY_DAYS`), not rows a host edits from
inside the app — see `docs/decisions.md`.

**`voice`** says whether this server carries voice: it has a voice address, set or worked
out from its domain (§8, "Voice forwarding"). `false` means nobody can join voice here, and the app says so
rather than offering a call. A server from before the field leaves it out, which a client
reads as "maybe" (#306).

### 3.1 DMs

```
GET  /dms                → Room[]
POST /dms   { user_ids } → Room
```

`POST /dms` is **create-or-find**: the same set of people always gives the same DM, so
asking twice is not how you end up with two conversations with the same three people
(SPEC §4.13). `user_ids` is everybody *else* — the caller is always a member and does
not name themselves; naming yourself, or the same person twice, is
`VALIDATION_FAILED`, and so is an empty list, because a DM with only you in it is not a
conversation. Two to eight people in total. An id that is not a member of this server
is `NOT_FOUND`.

**Membership is fixed at creation.** There is no endpoint to add or remove somebody:
a different set of people is a different DM. Adding one later would mean deciding what
they can read of what was already said, and that decision is a permission system in its
first disguise (AGENTS rule 10).

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
POST /rooms/:id/messages   { body, reply_to?, attachment_ids? }  → Message
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

`attachment_ids` are finished uploads (§6). Each must belong to the author, be
in the `complete` state, and not already be on another message; at most
`linger-core::limits::MAX_ATTACHMENTS_PER_MESSAGE` per message. Reusing
somebody else's attachment id is `FORBIDDEN`, and reusing one that is already
posted is `CONFLICT`.

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
| `422 VALIDATION_FAILED` "Nobody can react to that line." | the line a closing poll leaves, or one saying somebody joined voice |
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
client neither notifies nor sounds for it.

**Polls** (SPEC §4.18, #474). A question the host or a co-host asks a room, which everybody
in it answers with a click.

```
POST /rooms/:id/polls      (host or co-host) { question, choices, multi, closes_in_days } → Message
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
  (`NOT_FOUND`), and not an archived one. The question is trimmed, 1 to
  `MAX_POLL_QUESTION_CHARS` (300); `MIN_POLL_CHOICES` to `MAX_POLL_CHOICES` (2 to 10)
  choices, each trimmed, 1 to `MAX_POLL_CHOICE_CHARS` (80), none the same as another
  ignoring case; `closes_in_days` is one of `POLL_DAYS` (1, 3, 7, 14, 28). Anything else is
  `VALIDATION_FAILED`. It is a `Message` from whoever asked, sent as `message.create`, and it
  is a room's `last_message_id` like anything said. Its body is the question and the choices
  as a Markdown list, so an app from before polls shows them as words, and search finds them.
  A client neither notifies nor sounds for one, whoever it names. It can't be edited.
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

---

## 5. Users, styling, statuses

```
GET   /users              → User[]              # all members of this server
GET   /users/:id          → User
GET   /me                 → User
PATCH /me                 { display_name?, style?, status?, entrance_sound? } → User
PATCH /me/password        { current_password, new_password }                 → 204

GET  /me/notify-rules     → NotifyRule[]
PUT  /me/notify-rules     { target_user_id, room_id | null }   → 204
DELETE /me/notify-rules   { target_user_id, room_id | null }   → 204

GET  /users/removed       → User[]                  # host or co-host
POST /users/:id/remove    → 204                     # host or co-host
POST /users/:id/restore   → 204                     # host or co-host
PUT    /users/:id/cohost  → User                    # the host only: make a co-host
DELETE /users/:id/cohost  → User                    # the host only: not a co-host

GET    /me/blocks           → UserId[]                         # who you've blocked
PUT    /me/blocks/:user_id  → 204
DELETE /me/blocks/:user_id  → 204

POST   /reports             { message_id } | { user_id }, note? → 201 Report   # 10/hour
GET    /reports             → Report[]                          # host or co-host, open ones
DELETE /reports/:id         → 204                               # host or co-host: dealt with
```

### Co-host (SPEC §4.16, #424)

One switch per person, `is_cohost` on `User`. A co-host can call every endpoint marked
"host or co-host", and gets `reports.changed` and `GET /reports` like the host. Two
things stay the host's alone, and nothing else is split off:

- **Making and clearing co-hosts.** `PUT /users/:id/cohost` turns it on and
  `DELETE /users/:id/cohost` turns it off. Neither carries a body; both answer the
  person as they are now and fan out `user.update` to everybody, so their own app learns
  it can show them the host's controls (or stop). Setting it to what it already is
  changes nothing and answers the same. Anybody but the host gets `FORBIDDEN`, co-hosts
  included. The host naming themselves is `VALIDATION_FAILED`, and somebody who isn't a
  member now (never was, or removed) is `NOT_FOUND`.
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

Removal also revokes every refresh family the user owns and every invite they created,
in the same transaction as the column. Their messages are untouched; removing a person
is not deleting what they wrote.

`restore` is not an undo. It clears the column and nothing else: the revoked invites stay
revoked and the revoked sign-ins stay revoked, so the person signs in again with their
password. `GET /users/removed` is how the host finds somebody to restore — a removed
member is absent from every other surface by design.

Both endpoints announce themselves on the gateway: `remove` fans out `user.remove`, and
`restore` fans out `user.update`, which is "here is this person, whether or not you had
them" (§8).

`PATCH /me` semantics: absent fields are unchanged; `style` and `status` replace the
whole object when present. `entrance_sound: ""` clears the sound (bundled keys are
validated against `linger-core::ENTRANCE_SOUNDS` until custom uploads land in M4).

```ts
type User = {
  id: string; username: string; display_name: string;
  is_host: boolean;
  is_cohost: boolean;                 // a co-host the host named (#424); never with is_host
  style: Style;
  status: UserStatus | null;
  entrance_sound: string | null;      // bundled key or object key
  last_seen_at: number | null;
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
  away_message: string | null;        // supersedes `line` when set
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
trimmed. An empty value is refused rather than dropped: an app leaves out a
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

Server rejects at slot creation: `size_bytes > 500 MB` (`FILE_TOO_LARGE`), server pool
over quota (`QUOTA_EXCEEDED`), or a mime not on the allowlist in `linger-core::media`
(`UNSUPPORTED_MEDIA`). Server re-validates real size and sniffs actual MIME at complete —
never trust the declared values. A file whose bytes disagree with its declared type is
`UNSUPPORTED_MEDIA`; a file that is not the size it said it would be is
`VALIDATION_FAILED`.

`upload_id` and `attachment_id` are the same identifier. An upload is an attachment that
has not arrived yet, and there is nothing to remember about one that the attachment does
not already hold.

**Parts.** `part_size_bytes` is 8 MB. At or under that the upload is a single PUT to
`url` and `parts` is absent; above it, `parts` lists one signed URL per part, numbered
from 1, and `url` is the first of them. The layout is a pure function of `size_bytes`, so
a client that resumes recomputes exactly the plan it was given. Each successful PUT
answers with an `ETag` (which CORS exposes), and those etags may be handed back at
complete; the server checks them against what actually landed.

**Resuming.** Re-PUTting a part replaces it. Completing with parts missing is
`VALIDATION_FAILED` and **leaves the slot alive**: send the missing parts and complete
again. Any other refusal at complete is final — the parts are discarded and the slot
cannot be retried, because resending the same bytes under the same declaration cannot
make them acceptable.

`DELETE /uploads/:id` throws an upload away, finished or not, along with its bytes. It is
`CONFLICT` once the attachment is on a message; delete the message instead. It is
`CONFLICT` for a picture that is one of the server's emoji too (§5, "Custom emoji"):
remove the emoji, which takes its picture with it. An unposted upload ages out after the
file expiry window like any file, except an emoji's picture, which never does.

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
          &author=<user_id>&since=<ms>&until=<ms>
          &before=<cursor>&limit=<1..100>               → MediaItem[]
PUT    /media/:attachment_id/star                        → 204
DELETE /media/:attachment_id/star                        → 204
```

Everything shared on the server, in one list: uploads, links people typed, and
pinned messages. `since`/`until` are Unix ms and inclusive; a range that ends
before it starts is `VALIDATION_FAILED` rather than an empty answer.

**Order.** Starred first, then newest first. Only an upload can be starred, so
everything starred comes ahead of every link and pin.

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
none of it can be made to mean something the person typing did not intend.
Matching is on whole words with simple English endings folded together, so
`photo` finds `photos`.

A `q` that holds no searchable characters — empty, blank, or only punctuation —
is `VALIDATION_FAILED`, not every message on the server. Terms past the twelfth
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
GET  /export/:job_id     → { job_id, state, progress, url? } # the asker's own only
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
the relay looks nothing up; both hold the secret and both compute. `ttl_secs` is
how long the password lasts (a day by default); a client asks again on every
join, so it only has to outlast one call. Audio never touches this server, and
what the relay carries is the encrypted stream it cannot read.

A host with no relay answers `{ servers: [], ttl_secs: 0 }`. That is not an
error: voice then works between machines on one network and nowhere else, and
the client joins anyway. The endpoint needs a signed-in member and answers the
same for all of them; there is no host-only view of it.

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

### Handshake

```
S→C  { "op": "hello",  "d": { "heartbeat_interval_ms": 30000 } }
C→S  { "op": "identify", "d": { "token": "<access_jwt>", "client": "linger-desktop/0.1.0" } }
S→C  { "op": "ready",  "d": { "session_id", "user", "users": User[],
                              "rooms": Room[], "dms": Room[],
                              "presence": PresenceEntry[],
                              "voice"?: VoiceRoomState[],
                              "emoji"?: CustomEmoji[],
                              "reactions"?: true },
                              "s": 0 }
```

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

### Client → server

| op | payload | notes |
|---|---|---|
| `presence.update` | `{ state, away_message? }` | Where you are, and nothing about what you are doing (SPEC §4.3). |
| `room.focus` | `{ room_id \| null }` | fires on focus; `null` = left the room |
| `typing.start` | `{ room_id }` | server rate-limits to 1 per 4s per room |
| `voice.join` | `{ room_id, controls?: { muted, deafened }, forwarding: true }` | join or update your own controls; moving leaves the old room. `forwarding` says this client takes voice through the server (#197); a join without it is refused (#306) |
| `voice.leave` | `{}` | no room id: you are in at most one |
| `voice.answer` | `{ sdp }` | the answer to the server's latest `voice.offer` |
| `voice.restart` | `{}` | start this session's connection to the server afresh; the server sends a new `voice.offer` |

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
| `user.remove` | `{ user_id }` — this person is off the server. The mirror of `user.update`, and it names an id rather than carrying a `User` because there is no state left to describe: `User` has no `deactivated_at` field and is not going to grow one to carry a tombstone |
| `room.create` / `room.update` | `Room` — a DM's `room.create` reaches its members and nobody else, which is how the other members find out it exists |
| `typing` | `{ room_id, user_id }` |
| `knock` | `{ from_user_id }` — **sent to that one person's sessions and nobody else's** (SPEC §4.9) |
| `block.update` | `{ user_id, blocked }` — **sent to the blocker's own sessions and nobody else's** (§5, "Report and block") |
| `reports.changed` | `{}` — **sent to the host's and the co-hosts' sessions and nobody else's**: the open reports changed, so ask `GET /reports` again |
| `emoji.update` | `{ emoji: CustomEmoji[] }` — the server's emoji changed (one added, renamed or removed, §5): the whole set every time, to everybody |
| `voice.state` | `{ room_id, peers: [{ session_id, user_id, controls?, forwarded? }] }` — who is in voice in that room, whole every time |
| `voice.offer` | `{ sdp, tracks: [{ mid, session_id }], bitrate? }` — the forwarding server's offer, **addressed to one session**, whole every time somebody joins or leaves. `bitrate` is what to send the microphone at, in bits a second (#431) |
| `voice.removed` | `{ room_id }` — **addressed to one session**: the host or a co-host took it out of that room's voice (#423), just before the room's `voice.state` without it. It says why; leaving is the `voice.state`, which an app from before this frame acts on the same |

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
type VoicePeer   = { session_id: string; user_id: string; controls?: VoiceControls | null; forwarded?: boolean }
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
it missed, the server's latest offer included.

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
- **A failed connection is restarted, not left.** A client whose connection to the
  server fails sends `voice.restart` a few seconds later: the server starts that
  session's connection afresh and sends a new `voice.offer`. Its seat, and what the room
  sees, don't change. A client that isn't in voice is ignored.
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

Any breaking change means `/api/v2` and a client that speaks both during a transition
window.
