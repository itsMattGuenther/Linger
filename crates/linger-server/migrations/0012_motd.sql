-- A room's message of the day (#464, PROTOCOL §3): what's happening now, set
-- by the host or a co-host and shown whole under the room's header. It is not
-- the topic, which says what the room is about.
--
-- All three are null together: a room with no message of the day. A DM never
-- has one (`routes::rooms::only_a_room`).
ALTER TABLE rooms ADD COLUMN motd TEXT;
ALTER TABLE rooms ADD COLUMN motd_set_by BLOB REFERENCES users(id);
ALTER TABLE rooms ADD COLUMN motd_set_at INTEGER;

-- The line in the room saying somebody set it (`wire::Message::motd`). It is
-- left out of a room's `last_message_id`, so it never makes a room look new.
ALTER TABLE messages ADD COLUMN motd INTEGER NOT NULL DEFAULT 0;
