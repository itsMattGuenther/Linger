-- Phone notifications (#830, #886, SPEC §4.15, PROTOCOL §5): a phone that
-- asked this server to notify it, one row per sign-in. Ending that sign-in
-- (signing out, a new password, removal) deletes the row, and so does the relay
-- saying the phone's push address is gone.
--
-- The server can't read `sealed_token`: it's the phone's Apple or Google push
-- address, locked by the relay, and only the relay opens it. `public_key` and
-- `auth_secret` are what each notification is encrypted to (RFC 8291), so the
-- relay, Apple and Google carry it without being able to read it.
CREATE TABLE push_devices (
  id            BLOB PRIMARY KEY,
  user_id       BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id     BLOB NOT NULL UNIQUE,         -- the sign-in: refresh_tokens.family_id
  sealed_token  TEXT NOT NULL,
  public_key    BLOB NOT NULL,                -- P-256, uncompressed, 65 bytes
  auth_secret   BLOB NOT NULL,                -- 16 bytes
  mentions      INTEGER NOT NULL,             -- the kinds' switches, 0 or 1
  dms           INTEGER NOT NULL,
  knocks        INTEGER NOT NULL,
  follows       INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Everybody's phones are looked up by person, once for each message that
-- could notify them.
CREATE INDEX idx_push_devices_user ON push_devices(user_id);

-- The rooms a phone hears from, and how much: `wakes` (the first message after
-- an hour with none) or `every`. A room not here is off. For `every`, when the
-- phone was last told about the room and the newest message it was told about:
-- the room stays quiet until it's read past that message, or 15 minutes pass.
CREATE TABLE push_rooms (
  device_id     BLOB NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
  room_id       BLOB NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  choice        TEXT NOT NULL,                -- wakes | every
  notified_at   INTEGER,
  notified_id   BLOB,
  PRIMARY KEY (device_id, room_id)
) WITHOUT ROWID;
CREATE INDEX idx_push_rooms_room ON push_rooms(room_id);
