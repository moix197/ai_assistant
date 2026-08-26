-- Singleton row: exactly one Telegram bot token, one getUpdates poll stream —
-- there is no per-chat concept to key on, so a single fixed-id row (rather
-- than a per-chat table) is the whole schema. See packages/store/README.md.
CREATE TABLE telegram_offset (
  id smallint PRIMARY KEY DEFAULT 1,
  update_id bigint NOT NULL DEFAULT 0,
  CHECK (id = 1)
);

INSERT INTO telegram_offset (id, update_id) VALUES (1, 0);
