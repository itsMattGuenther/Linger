-- The quiet line a room gets when somebody joins its voice and stays (#473,
-- SPEC §4.14): `wire::Message::voice_join`. Like a message-of-the-day line it
-- is left out of a room's `last_message_id`, so it never makes a room look
-- new, and search passes over it.
ALTER TABLE messages ADD COLUMN voice_join INTEGER NOT NULL DEFAULT 0;

-- The flood guard asks, before every line, whether this person already has
-- one in this room in the last ten minutes. Only join lines are in here.
CREATE INDEX idx_messages_voice_join ON messages(room_id, author_id, created_at)
  WHERE voice_join = 1;
