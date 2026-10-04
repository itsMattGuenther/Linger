-- Co-host (#424, PROTOCOL §5): one switch the host can give somebody, for
-- when they're away. A co-host can do everything the host does in the app
-- except make or clear co-hosts and act on the host (`auth::HostOrCohost`).
--
-- One on/off per person, set only by the host from a person's card. It is not
-- a role and nothing may grow from it: no other levels and no per-power
-- switches (`docs/decisions.md`, *a co-host, for when the host is away*).
-- The host is never a co-host, and a server that updates has none until its
-- host names one.
ALTER TABLE users ADD COLUMN is_cohost INTEGER NOT NULL DEFAULT 0;
