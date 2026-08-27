-- One row per (channel, chat_id): the full, untrimmed conversation history a
-- chat has with the bot, restart-safe. `packages/agent`'s chars/4 trim only
-- ever affects what is SENT to the model on a given call, never what is
-- stored here — the full history always lands in `messages`.
--
-- No size cap or archival policy yet — same unbounded-growth posture as
-- `telemetry_events` (see packages/store/README.md). Explicit open item, not
-- solved here.
CREATE TABLE threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL,
  chat_id text NOT NULL,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, chat_id)
);

-- Named explicitly for the getOrCreateThread lookup path — the UNIQUE
-- constraint above already covers it, but naming it matches
-- telemetry_events' explicit-index convention.
CREATE INDEX threads_channel_chat_id_idx ON threads (channel, chat_id);
