-- "Show my local time" (#604, SPEC §4.6): the time-zone name a person shares
-- on their card, like `America/Chicago`. NULL is the switch off, which is
-- where everybody starts. `wire::User::time_zone` carries it; `PATCH /me`
-- sets it and clears it with "".
ALTER TABLE users ADD COLUMN time_zone TEXT;
