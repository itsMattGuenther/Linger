-- Personal entrance sounds are cut (#974, SPEC §4.1, docs/decisions.md). No
-- Linger app ever set one: every release sends `entrance_sound: null`, so the
-- table holds nothing anybody chose. `User.entrance_sound` and `room.enter`'s
-- stay on the wire, always null, for older apps (PROTOCOL §9).
DROP TABLE entrance_sounds;
