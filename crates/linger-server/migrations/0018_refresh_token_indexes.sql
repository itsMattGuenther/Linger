-- Revoking sign-in tokens by family (signing out, a reused token) or by person
-- (a password change, removal) read the whole of refresh_tokens, and the table
-- only grew: every renewal kept the token it used up (#520). The sweeper now
-- deletes each token once its 30 days are up (`expiry.rs`), and these make
-- the revokes, and the cascade when a person's row goes, a lookup.
CREATE INDEX idx_refresh_family ON refresh_tokens(family_id);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id);
