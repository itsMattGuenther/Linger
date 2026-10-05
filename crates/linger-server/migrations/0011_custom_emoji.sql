-- A server's own emoji (#359, PROTOCOL §5 "Custom emoji"): pictures the host or
-- a co-host adds for everybody on the server, written `:name:` in a message.
--
-- The picture is an ordinary finished upload that was never posted: it went
-- through the same sniffing and re-encoding as any image, and its object is
-- served from the media origin like any attachment. A picture that is an
-- emoji never expires and can't be put on a message or thrown away through
-- `DELETE /uploads/:id`; removing the emoji removes it.
CREATE TABLE custom_emoji (
  id              BLOB PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  attachment_id   BLOB NOT NULL UNIQUE REFERENCES attachments(id),
  created_by      BLOB NOT NULL REFERENCES users(id),
  created_at      INTEGER NOT NULL
);
