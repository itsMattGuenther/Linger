-- Indexes the query planner was missing (#518). Each one is here because a
-- query that runs often was reading a whole table to find a handful of rows.
--
-- A message's files, by the message. `repo::attachments::hydrate` asks for
-- them on every page of messages and on every new message, edit and reaction,
-- and the search triggers in 0004 ask on every attach, edit and delete —
-- including each file the expiry sweep takes. Without this, every one of those
-- read every file ever uploaded.
CREATE INDEX idx_attachments_message ON attachments(message_id);

-- Media's own order (SPEC §4.4): starred first, then newest, then by id, over
-- finished files — the `ORDER BY` in `repo::media::attachment_sql`, column for
-- column. With it, a page of Media is the next sixty entries of this index
-- rather than a sort of every file on the server.
CREATE INDEX idx_attachments_media_order
  ON attachments((starred_at IS NOT NULL), created_at, id) WHERE state = 'complete';
