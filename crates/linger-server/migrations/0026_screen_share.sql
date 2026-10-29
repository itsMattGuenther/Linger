-- The quiet line a room gets when somebody shares their screen in its voice
-- and keeps sharing (#746, SPEC §4.20): `wire::Message::screen_share`. Like
-- the line saying somebody joined voice it is left out of a room's
-- `last_message_id`, so it never makes a room look new, and search passes
-- over it.
ALTER TABLE messages ADD COLUMN screen_share INTEGER NOT NULL DEFAULT 0;

-- The flood guard asks, before every line, whether this person already has
-- one in this room in the last ten minutes. Only share lines are in here.
CREATE INDEX idx_messages_screen_share ON messages(room_id, author_id, created_at)
  WHERE screen_share = 1;
