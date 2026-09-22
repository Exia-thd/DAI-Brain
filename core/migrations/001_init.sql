-- DAI Brain Core schema.
--
-- The migration runner substitutes two placeholders here before this reaches
-- Postgres: one for the embedding column's type, one for its index. (They are
-- spelled in the runner, not repeated in this comment -- substitution is plain
-- text and does not know a comment from a statement, so naming them here would
-- splice multi-line SQL into a -- comment and break the file.)
--
-- They exist because a column's type cannot be chosen inside a DO block, and
-- whether pgvector is installed is a fact about the deployment, not about this
-- file. With the extension the column is `vector(N)` and gets an ANN index;
-- without it the column is `real[]` and the vector branch degrades to an exact
-- scan -- correct but linear, and it says so in every fusion report it appears
-- in.
CREATE TABLE IF NOT EXISTS memory_items (
  id              TEXT PRIMARY KEY,
  tenant          TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  project         TEXT NOT NULL,
  type            TEXT NOT NULL,
  content         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  source          TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Items are superseded, never deleted: a memory you cannot trace back is a
  -- memory you cannot check, and a memory that vanished is one you cannot undo.
  superseded_by   TEXT REFERENCES memory_items(id) ON DELETE SET NULL,
  conversation_id TEXT,
  embedding       {{EMBEDDING_TYPE}},
  embedding_model TEXT,
  -- 'simple' rather than 'english' on purpose: this store holds Vietnamese and
  -- English side by side, and an English stemmer mangles the former while
  -- helping the latter only slightly. BM25 ranking lives in the query, not here.
  tsv             TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);

-- Every index leads with the scope columns because every query does. A query
-- that could run without a scope is the one bug this schema is shaped to
-- prevent, so there is deliberately no index that would make one fast.
CREATE INDEX IF NOT EXISTS memory_items_scope_idx
  ON memory_items (tenant, user_id, project, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_items_tsv_idx
  ON memory_items USING GIN (tsv);
CREATE INDEX IF NOT EXISTS memory_items_live_idx
  ON memory_items (tenant, user_id, project) WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS memory_items_conversation_idx
  ON memory_items (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS memory_items_dedupe_idx
  ON memory_items (tenant, user_id, project, content_hash);

{{VECTOR_INDEX}}

CREATE TABLE IF NOT EXISTS entities (
  id          TEXT PRIMARY KEY,
  tenant      TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  project     TEXT NOT NULL,
  name        TEXT NOT NULL,
  -- Linking matches on the normalised form so "Brain Gateway", "brain gateway"
  -- and "brain-gateway" are one node rather than three.
  name_norm   TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'concept',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS entities_scope_name_idx
  ON entities (tenant, user_id, project, name_norm);
CREATE INDEX IF NOT EXISTS entities_norm_idx ON entities (name_norm);

CREATE TABLE IF NOT EXISTS relations (
  id            TEXT PRIMARY KEY,
  from_entity   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  weight        REAL NOT NULL DEFAULT 1.0,
  evidence_item TEXT REFERENCES memory_items(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS relations_from_idx ON relations (from_entity);
CREATE INDEX IF NOT EXISTS relations_to_idx ON relations (to_entity);
CREATE UNIQUE INDEX IF NOT EXISTS relations_edge_idx
  ON relations (from_entity, to_entity, type);

CREATE TABLE IF NOT EXISTS item_entities (
  item_id   TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, entity_id)
);

CREATE INDEX IF NOT EXISTS item_entities_entity_idx ON item_entities (entity_id);

CREATE TABLE IF NOT EXISTS conversations (
  id                TEXT PRIMARY KEY,
  tenant            TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  project           TEXT NOT NULL,
  title             TEXT NOT NULL DEFAULT '',
  -- Claude's own session id, so the next turn can --resume rather than replay.
  claude_session_id TEXT,
  -- Per-session working directory, kept so a resumed conversation lands in the
  -- same place and a finished one can be swept.
  workdir           TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_scope_idx
  ON conversations (tenant, user_id, project, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx
  ON messages (conversation_id, id);

-- A Postgres table with a worker polling it. A broker would be one more thing
-- to run for a queue that will not see a thousand jobs a day.
CREATE TABLE IF NOT EXISTS writeback_jobs (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  tenant          TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  project         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INT  NOT NULL DEFAULT 0,
  payload         JSONB NOT NULL,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS writeback_jobs_pending_idx
  ON writeback_jobs (status, created_at) WHERE status = 'pending';
