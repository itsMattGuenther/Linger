-- A status's short fields get labels the person chooses (SPEC §4.6,
-- PROTOCOL §5, #270).
--
-- A status had three fixed fields: listening, reading and working_on. Now it
-- has up to three, each a label ("Listening to", "Playing", or anything the
-- person types, 24 characters) and a value (80). They live in their own table,
-- one row per field, in the order the card shows them.
CREATE TABLE user_status_fields (
  user_id         BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,            -- 0, 1 or 2: the order they show in
  label           TEXT NOT NULL,               -- 24 chars
  value           TEXT NOT NULL,               -- 80 chars
  PRIMARY KEY (user_id, position)
);

-- Today's three columns become fields with those labels, so nobody's status
-- changes on update. They are numbered in the order the card has shown them
-- since 0.4.0: Listening to, Reading, Working on. An empty column makes no
-- field, and the values are carried over as they are.
--
-- The three columns stay in `user_status`. The server keeps them in step with
-- the fields from here on, but never reads them: an older app's `reading`,
-- `listening` and `working_on` are filled from the fields whose labels match
-- exactly.
INSERT INTO user_status_fields (user_id, position, label, value)
SELECT user_id,
       ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY slot) - 1,
       label,
       value
FROM (
  SELECT user_id, 0 AS slot, 'Listening to' AS label, listening AS value
    FROM user_status WHERE TRIM(COALESCE(listening, '')) <> ''
  UNION ALL
  SELECT user_id, 1, 'Reading', reading
    FROM user_status WHERE TRIM(COALESCE(reading, '')) <> ''
  UNION ALL
  SELECT user_id, 2, 'Working on', working_on
    FROM user_status WHERE TRIM(COALESCE(working_on, '')) <> ''
);
