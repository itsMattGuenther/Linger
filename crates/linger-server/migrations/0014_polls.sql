-- Polls (#474, SPEC §4.18, PROTOCOL §4): a question the host or a co-host asks
-- a room, which everybody in it answers with a click. A poll is a message
-- (`wire::Message::poll`); these tables hold its question, its choices and
-- who picked what.
CREATE TABLE polls (
  message_id  BLOB PRIMARY KEY REFERENCES messages(id),
  question    TEXT NOT NULL,
  multi       INTEGER NOT NULL DEFAULT 0,   -- 1: people may pick more than one
  closes_at   INTEGER NOT NULL,             -- when it closes on its own
  closed_at   INTEGER,                      -- null while it's open
  closed_by   BLOB REFERENCES users(id)     -- null when it closed on its own
);

-- What the sweeper looks for: open polls, by when they're due.
CREATE INDEX idx_polls_open ON polls(closes_at) WHERE closed_at IS NULL;

-- A poll's choices, in the order they were written. A vote names a choice by
-- its place here, which never changes: a poll can't be edited.
CREATE TABLE poll_choices (
  message_id  BLOB NOT NULL REFERENCES polls(message_id),
  position    INTEGER NOT NULL,
  text        TEXT NOT NULL,
  PRIMARY KEY (message_id, position)
);

-- Who picked what. Votes aren't secret: a choice shows who picked it.
CREATE TABLE poll_votes (
  message_id  BLOB NOT NULL REFERENCES polls(message_id),
  position    INTEGER NOT NULL,
  user_id     BLOB NOT NULL REFERENCES users(id),
  voted_at    INTEGER NOT NULL,
  PRIMARY KEY (message_id, position, user_id)
);

-- The line a room gets when one of its polls closes, pointing at the poll
-- (`wire::Message::poll_closed`). Like a message-of-the-day line it is left out
-- of a room's `last_message_id`, so it never makes a room look new.
ALTER TABLE messages ADD COLUMN poll_closed BLOB REFERENCES messages(id);
