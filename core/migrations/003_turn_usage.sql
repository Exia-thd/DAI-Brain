-- What each turn cost.
--
-- Added after a round of testing quietly consumed a person's quota with
-- nothing recording it. A Gateway that spawns a billable subprocess per
-- message and keeps no account of it cannot answer the only question that
-- matters afterwards: which conversation ran away.
--
-- Per turn rather than a running total, because a total cannot answer that.

CREATE TABLE IF NOT EXISTS turn_usage (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  input_tokens    INT NOT NULL DEFAULT 0,
  output_tokens   INT NOT NULL DEFAULT 0,
  -- Null when the runner did not report one; a missing price is not a free turn.
  cost_usd        DOUBLE PRECISION,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS turn_usage_conversation_idx
  ON turn_usage (conversation_id, id);
