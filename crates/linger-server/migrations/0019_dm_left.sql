-- The quiet line a group DM gets when somebody leaves it (#565, SPEC §4.13):
-- `wire::Message::left`. Like the line saying somebody joined voice it is left
-- out of a room's `last_message_id`, so it never makes a DM look new, and
-- search passes over it.
--
-- Leaving needs nothing else stored. The leaver's `room_members` row goes, so
-- every check that asks "whose" stops answering them; and the DM's
-- `member_key` is cleared, so `POST /dms` never finds it by its people again.
-- A NULL key is also how a DM says somebody has left it (`Room::someone_left`).
ALTER TABLE messages ADD COLUMN dm_left INTEGER NOT NULL DEFAULT 0;
