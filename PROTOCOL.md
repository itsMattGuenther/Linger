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
`display_name`: 1–32 chars, mutable.
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
                             storage_used_bytes, storage_limit_bytes, file_expiry_days }
PATCH /server            (host only) { name?, accent_key?, icon_key? }   # accent_key from PALETTE

GET  /rooms              → Room[]                       # public rooms only
POST /rooms              (host only) { slug, name, topic? }         → Room
PATCH /rooms/:id         (host only) { name?, topic?, position? }   → Room
POST /rooms/:id/archive  (host only)                                → Room

GET  /dms                → Room[]                       # the DMs you are in
POST /dms                { user_ids }                   → Room
```

```ts
type RoomKind = "room" | "dm"

type Room = {
  id: string; slug: string; name: string; topic: string | null;
  kind: RoomKind; member_ids: string[] | null;
  position: number; archived_at: number | null;
  last_message_id: string | null;   // client compares to read marker
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

**The three storage figures** are read-only and every member sees them; the status bar
draws the first two (SPEC §5.6). `storage_used_bytes` counts stored objects *and*
uploads still in flight, because a slot already handed out is not space anybody else can
have. `storage_limit_bytes` is the pool ceiling. `file_expiry_days` is how long a file
stands before the server sweeps it, or `null` on a server that keeps files for good;
starred files and files on pinned messages never expire whatever it says (SPEC §4.10).

They are not on `PATCH /server`. Both knobs are environment variables set in the
deployment (`LINGER_POOL_BYTES`, `LINGER_FILE_EXPIRY_DAYS`), not rows a host edits from
inside the app — see `docs/decisions.md`.

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
}
```

Reaction `key` is one of 12 fixed values defined in `linger-core::REACTIONS`. The server
rejects anything else. `count` is sent but the client renders weight, not the number
(SPEC §4.8) — it is present for accessibility labels and hover.

Edits are only permitted by the author. Deletes are permitted by the author or the host.
Deleted messages become tombstones; they are not removed, so reply chains survive.

**Read markers**

```
PUT /rooms/:id/read      { last_read_id }     → 204
GET /read                → { [room_id]: last_read_id }
```

The client sends this at most once per 5 seconds per room, debounced. **No count is ever
returned by the server.** There is no unread-count endpoint and one must not be added.

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

GET  /users/removed       → User[]                  # host-only
POST /users/:id/remove    → 204                     # host-only
POST /users/:id/restore   → 204                     # host-only
```

### Removing a member

`remove` sets `deactivated_at`; `restore` clears it. Neither carries a body. The host
cannot remove themselves — that answers `FORBIDDEN`. There is no ban and no ban list:
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
  reading: string | null;             // <= 80
  listening: string | null;           // <= 80
  working_on: string | null;          // <= 80
  image_id: string | null;            // an upload of yours: an image <= 512 KB
  image_url: string | null;           // server-owned; where to draw it from
  away_message: string | null;        // supersedes `line` when set
  away_since: number | null;
}
```

**The status image** (SPEC §4.6) is named by attachment id, not by URL and not by
storage key. On the way in the server checks that the id names a finished upload of
*this* member's, that it is an image, and that it is within
`linger-core::limits::MAX_STATUS_IMAGE_BYTES`; anything else is `VALIDATION_FAILED`, or
`FORBIDDEN` when the file exists and belongs to somebody else. On the way out it fills in
`image_url`, which is on the media origin like any other object URL (§6) and is
read-only — send whatever you like for it and the server ignores it, the same as
`away_since`.

Because `status` replaces the whole object, a save that omits `image_id` **removes** the
image. Send back the one you were given unless the person changed it.

Replacing or clearing an image deletes the file it stopped pointing at, unless that file
is also on a message — then it belongs to the message and stays. A status image is the
one thing the expiry sweeper never takes, whatever its age (SPEC §4.10).

### Palette validation (server-side, mandatory)

There is no runtime color clamping, because there are no arbitrary colors. The server
validates that every `ColorKey` and `font_key` is a member of `linger-core::PALETTE` and
`linger-core::FONTS` respectively, and rejects anything else with `VALIDATION_FAILED`.

Contrast safety is structural. The palette is defined once with theme-mirrored lightness:

```
dark theme:   oklch(0.76 0.13 <hue>)     // slate: chroma 0.02
light theme:  oklch(0.50 0.14 <hue>)
```

Every entry holds ≥4.5:1 against both theme backgrounds by construction. A property test
asserts this across all 16 keys × 2 themes and must run in CI — it is the guard against
someone "improving" a palette value later.

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
`CONFLICT` once the attachment is on a message; delete the message instead.

**Serving.** `Attachment.url` (and `poster_url`) point at the object store, on the media
origin — a host of its own, `cdn.<LINGER_DOMAIN>` by default, which serves `/objects/...`
and nothing else. On a server with `LINGER_DOMAIN` set these URLs are absolute; on one
without, there is only one origin and they are root-relative, resolved against the server
the client is talking to. The URL is the secret: an object key contains a UUIDv7, and the
request is not authenticated, which is what lets an `<img>` tag work. Only image, video
and audio types on the `linger-core::media` inline list are served with their own content
type; everything else is served as `application/octet-stream` with
`Content-Disposition: attachment`, and every response carries
`X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`
(ARCHITECTURE §7).

A client should treat these URLs as opaque and use them as given. Nothing else on the
media origin answers, and the API does not answer there.

```ts
type Attachment = {
  id: string; filename: string; mime: string; size_bytes: number;
  url: string;                       // separate CDN origin, see ARCHITECTURE §7
  width: number | null; height: number | null; duration_ms: number | null;
  blurhash: string | null; poster_url: string | null;
  starred_at: number | null;
  uploader_id: string; created_at: number;
}
```

`mime`, `filename` and `size_bytes` on a finished attachment describe what the server
**stored**, not what the client declared. Images are re-encoded on upload, which strips
EXIF and can change the format (a WebP comes back as a PNG, with its extension corrected).

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
order and emphasise the matched ones however the density mode allows — there is
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
```

```ts
type IceServer = { urls: string[]; username: string | null; credential: string | null }
```

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
app than an upload does.

Asking about somebody else's job is `NOT_FOUND`, not `FORBIDDEN` — which of the
two it was is not the asker's business. A member has one archive at a time:
starting a new export deletes the previous one's bytes, so an old `url` stops
working. The rate limit is about the host's disk and CPU, not about permission;
there is no host approval anywhere in this flow and there must never be one.

**Knock** (SPEC §4.9, T-1101). One member nudges one member. The target has to
be a member of this server — a stranger and somebody the host removed are both
`NOT_FOUND` — and knocking yourself is `VALIDATION_FAILED`. The rate limit is
`RATE_KNOCK_PER_TARGET`: three per hour **per target**, so knocking five
different people is five separate buckets.

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
                              "presence": PresenceEntry[] },
                              "s": 0 }
```

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
| `voice.join` | `{ room_id }` | join voice in that room; leaves the one you were in |
| `voice.leave` | `{}` | no room id: you are in at most one |
| `voice.signal` | `{ to, kind, payload }` | pass one WebRTC message to one peer |

### Server → client

| op | payload |
|---|---|
| `message.create` | `Message` |
| `message.update` | `Message` |
| `message.delete` | `{ id, room_id }` |
| `reaction.update` | `{ message_id, key, count, user_ids }` |
| `presence.update` | `PresenceEntry` |
| `room.occupancy` | `{ room_id, user_ids }` |
| `room.enter` | `{ room_id, user_id, entrance_sound }` — triggers the sound |
| `room.leave` | `{ room_id, user_id }` |
| `user.update` | `User` — the current state of this person, **whether or not the client already had them**. A display name, style or status change, and equally somebody who was not on the roster a moment ago: the client's fold appends when the id is unknown |
| `user.remove` | `{ user_id }` — this person is off the server. The mirror of `user.update`, and it names an id rather than carrying a `User` because there is no state left to describe: `User` has no `deactivated_at` field and is not going to grow one to carry a tombstone |
| `room.create` / `room.update` | `Room` — a DM's `room.create` reaches its members and nobody else, which is how the other members find out it exists |
| `typing` | `{ room_id, user_id }` |
| `knock` | `{ from_user_id }` — **sent to that one person's sessions and nobody else's** (SPEC §4.9) |
| `voice.state` | `{ room_id, peers: [{ session_id, user_id }] }` — who is in voice in that room, whole every time |
| `voice.signal` | `{ from, kind, payload }` — one peer's WebRTC message, **addressed to one session** |

```ts
type PresenceEntry = {
  user_id: string;
  state: "in_room" | "around" | "idle" | "away" | "offline";
  room_id: string | null;
  away_message: string | null;
}
```

### Voice signalling

The server's whole part in voice is **introducing two clients to each other** (SPEC
§4.14). Audio never touches it: `payload` is a WebRTC offer, answer or ICE candidate,
and it crosses this server as an opaque string that nothing here parses, validates or
stores. It is a post office, not a participant.

```ts
type VoicePeer   = { session_id: string; user_id: string }
type VoiceSignal = "offer" | "answer" | "candidate"
```

**A peer is a session, not a person.** A peer connection is between two *clients*, and
one person signed in on a laptop and a desktop is two of them. Session ids survive a
resume and change on a fresh `identify`, which is exactly the identity a WebRTC session
has.

**`voice.state` is the whole list every time**, never a delta. It is sent to a room's
members whenever anybody joins or leaves, and a client can act on the newest one it has
without replaying what came before. Getting it twice is harmless; missing one is not,
which is why it is a snapshot.

**Who offers is decided by the ids, not by who arrived first.** Of any two peers, the
one whose `session_id` sorts **lower** sends the offer. Both sides read the same
`voice.state` and reach the same answer, so exactly one offer is made and no pair ever
sends two offers at each other. "Whoever joined later offers" would need an order both
sides agree on, and a reconnect is precisely when they stop agreeing.

**`voice.signal` only reaches a peer in the same voice room.** Both the sender and `to`
have to be in voice in one room, and it has to be the same one. Without that rule this
frame is a way to send an arbitrary string to any session on the server, which is a
side channel nobody asked for and nothing else here has.

A signal to a session that is not there is **dropped, not refused**. Somebody's client
closing is the ordinary end of a call, and it happens mid-exchange all the time; an
error frame for it would be noise about a thing that is not wrong.

**Leaving is implicit as well as explicit.** A session that ends leaves the voice room
it was in and the other peers are told — as are the peers of a session whose resume
window lapses, which is what stops a dead client sitting in the list looking connected.
A session that *resumes* keeps its place: it is the same client, its peers are still
connected to it, and it replays whatever it missed.

**Limits.** `payload` is at most `MAX_VOICE_PAYLOAD_BYTES`; anything larger is not an
SDP this server needs to carry. Signals are rate-limited per session
(`RATE_VOICE_SIGNAL`) — generously, because trickle ICE arrives in bursts across every
peer at once, and a limit tight enough to be interesting would break a normal join.

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
- **`presence.update` is redacted, not withheld.** Somebody in a DM is in a room, and
  a receiver who cannot see that room is sent the same entry with `room_id: null` — so
  they still see the person is around, and are not told where. Dropping the frame would
  make that person appear offline to everybody outside the conversation, which is a
  worse answer and a slower leak.
- `room.enter` is sent only to clients currently in that room, *and* only to members
  of it. The receiving client applies its own mute rules and quiet hours before playing
  anything (SPEC §4.1).
- `user.update` and `user.remove` go to every connected client. They are about a person,
  not a place.
- `knock` is the one **addressed** frame: it goes to every session the target
  has open and to no other member, the sender included. The address is not on
  the wire — the receiver is the only one who gets the frame, so a field naming
  them would carry nothing (SPEC §4.9, T-1101).

---

## 9. Versioning

The path carries the major version. Within v1, additive changes only: new optional
fields, new `op` values, new error codes. Clients must ignore unknown fields and unknown
`op` values rather than erroring.

Any breaking change means `/api/v2` and a client that speaks both during a transition
window.
