-- Report and block (SPEC §4.15, PROTOCOL §5, T-1605). Both stores require
-- them in an app where people post things.
--
-- A block is one person's private list. Nobody else reads it, and the person
-- blocked is never told. The server only stops their knocks reaching the
-- person who blocked them; the clients fold their messages away.
CREATE TABLE blocks (
  user_id     BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- who blocked
  blocked_id  BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- whom
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);

-- A report goes to the host and nobody else. It keeps the message's words as
-- they were when it was reported (`excerpt`), so an edit or a delete
-- afterwards doesn't take away what the host was asked to look at; the
-- message itself isn't referenced, since a delete would leave nothing to point
-- at. `closed_at` is the host saying it's dealt with, and a closed report is
-- never listed again.
CREATE TABLE reports (
  id           BLOB PRIMARY KEY,
  reporter_id  BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id      BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- who it's about
  message_id   BLOB,
  room_id      BLOB,
  excerpt      TEXT,
  message_at   INTEGER,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER
);
CREATE INDEX reports_open ON reports (closed_at, created_at);
