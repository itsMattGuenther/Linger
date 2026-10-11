-- A post's one-time key (#524, PROTOCOL §4). The app makes one up for each
-- send and sends it again with every retry of that send. When the answer to a
-- post is lost on the way back after the message was saved, the retry finds
-- its key here and is answered with that message instead of posting it twice.
--
-- Kept a week (`limits::NONCE_KEPT_MS`), not for the message's life: a retry
-- only comes from an app still showing the unsent message. Every post that
-- carries a key first clears out the keys older than that, so this holds
-- about a week of posts, never all of them. Two people may use the same key;
-- it's one person's key that means one message.
CREATE TABLE message_nonces (
  author_id   BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nonce       TEXT NOT NULL,
  message_id  BLOB NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (author_id, nonce)
) WITHOUT ROWID;

-- What the clearing out looks for: keys past their week.
CREATE INDEX idx_message_nonces_created ON message_nonces(created_at);
