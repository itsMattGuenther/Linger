-- Reactions come back as any emoji (#485, SPEC §4.8), after #168's trial.
--
-- A reaction's key was one of twelve names ("heart", "laugh"…). It is now the
-- emoji itself, or `emoji:<id>` for one of the server's own (custom_emoji.id,
-- 32 hex). The twelve names become the emoji they always drew, so a reaction
-- left before the trial comes back as what it was.
UPDATE reactions SET key = CASE key
  WHEN 'heart' THEN '❤️'
  WHEN 'laugh' THEN '😂'
  WHEN 'wow' THEN '😮'
  WHEN 'cry' THEN '😢'
  WHEN 'fire' THEN '🔥'
  WHEN 'skull' THEN '💀'
  WHEN 'up' THEN '👍'
  WHEN 'down' THEN '👎'
  WHEN 'eyes' THEN '👀'
  WHEN 'clap' THEN '👏'
  WHEN 'hundred' THEN '💯'
  WHEN 'sparkles' THEN '✨'
  ELSE key
END;

-- Removing a server emoji takes the reactions that used it (#485).
CREATE INDEX reactions_by_key ON reactions (key);

-- A host can turn reactions off for a room (#485). Off hides them and refuses
-- new ones; nothing is deleted, so turning them back on shows them again. A DM
-- has no host and is never off.
ALTER TABLE rooms ADD COLUMN reactions_off INTEGER NOT NULL DEFAULT 0;
