CREATE TABLE samples (
  id TEXT PRIMARY KEY,              -- ULID
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  register TEXT NOT NULL CHECK (register IN ('slack','email','doc','social','general')),
  source TEXT,
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','ready','failed')),
  error TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  word_count INTEGER NOT NULL DEFAULT 0,
  features_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX samples_user_register ON samples (user_id, register, status);

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,              -- {sampleId}-{ord}
  sample_id TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  register TEXT NOT NULL,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  features_json TEXT NOT NULL
);
CREATE INDEX chunks_user_register ON chunks (user_id, register);

CREATE TABLE profiles (
  user_id TEXT NOT NULL,
  register TEXT NOT NULL,
  version INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  targets_json TEXT NOT NULL,
  guide_json TEXT NOT NULL,
  hard_rules_json TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, register, version)
);

CREATE TABLE settings (
  user_id TEXT PRIMARY KEY,
  overrides_json TEXT NOT NULL DEFAULT '{"em_dash":"banned"}',
  default_register TEXT NOT NULL DEFAULT 'general'
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  register TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  model TEXT,
  input_sha256 TEXT NOT NULL,
  input_chars INTEGER NOT NULL,
  output TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  distance REAL,
  violations_json TEXT,
  latency_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX runs_user_created ON runs (user_id, created_at);
