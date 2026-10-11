-- Sign-in links (#581, PROTOCOL §5): a host or co-host makes one for somebody
-- who forgot their password, and it lets them set a new one, once, within a
-- day. Only the code's sha256 is kept, as for refresh tokens: a copy of the
-- database holds no link that works.
--
-- Rows are kept after use, so the person's Settings can say who made them a
-- link and when (`GET /me/sign-in-links`). Making a new link cancels any open
-- one for the same person, so at most one works at a time.
CREATE TABLE sign_in_links (
  token_hash    TEXT PRIMARY KEY,
  user_id       BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  made_by       BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER,
  cancelled_at  INTEGER
);

-- Somebody's links, newest first: what Settings lists, and what a new link
-- or a removal cancels.
CREATE INDEX idx_sign_in_links_user ON sign_in_links(user_id, created_at);
-- The links somebody made, cancelled when they're removed.
CREATE INDEX idx_sign_in_links_made_by ON sign_in_links(made_by);
