-- Registers become categories: casual, professional, documentation, social, general.
-- SQLite cannot alter a CHECK constraint, so samples is rebuilt. chunks is rebuilt
-- first against the new table: dropping samples while chunks still references it
-- would run ON DELETE CASCADE and erase every chunk.
-- content_sha256 lets add_sample return an existing sample instead of a duplicate.
CREATE TABLE samples_new (
  id TEXT PRIMARY KEY,              -- ULID
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  register TEXT NOT NULL CHECK (register IN ('casual','professional','documentation','social','general')),
  source TEXT,
  content_sha256 TEXT,
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
INSERT INTO samples_new
  (id,user_id,title,register,source,r2_key,mime,bytes,status,error,chunk_count,word_count,features_json,created_at,updated_at)
SELECT id,user_id,title,
  CASE register WHEN 'slack' THEN 'casual' WHEN 'email' THEN 'professional' WHEN 'doc' THEN 'documentation' ELSE register END,
  source,r2_key,mime,bytes,status,error,chunk_count,word_count,features_json,created_at,updated_at
FROM samples;

CREATE TABLE chunks_new (
  id TEXT PRIMARY KEY,              -- {sampleId}-{ord}
  sample_id TEXT NOT NULL REFERENCES samples_new(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  register TEXT NOT NULL,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  features_json TEXT NOT NULL
);
INSERT INTO chunks_new (id,sample_id,user_id,register,ord,text,tokens,features_json)
SELECT id,sample_id,user_id,
  CASE register WHEN 'slack' THEN 'casual' WHEN 'email' THEN 'professional' WHEN 'doc' THEN 'documentation' ELSE register END,
  ord,text,tokens,features_json
FROM chunks;

DROP TABLE chunks;
DROP TABLE samples;
-- Renaming rewrites chunks_new's foreign key to point at samples.
ALTER TABLE samples_new RENAME TO samples;
ALTER TABLE chunks_new RENAME TO chunks;
CREATE INDEX samples_user_register ON samples (user_id, register, status);
CREATE INDEX samples_user_created ON samples (user_id, created_at DESC, id DESC);
CREATE INDEX samples_user_sha ON samples (user_id, content_sha256);
CREATE INDEX samples_user_source ON samples (user_id, source);
CREATE INDEX chunks_user_register ON chunks (user_id, register);

UPDATE profiles SET register = CASE register WHEN 'slack' THEN 'casual' WHEN 'email' THEN 'professional' WHEN 'doc' THEN 'documentation' ELSE register END;
UPDATE runs SET register = CASE register WHEN 'slack' THEN 'casual' WHEN 'email' THEN 'professional' WHEN 'doc' THEN 'documentation' ELSE register END;
UPDATE settings SET default_register = CASE default_register WHEN 'slack' THEN 'casual' WHEN 'email' THEN 'professional' WHEN 'doc' THEN 'documentation' ELSE default_register END;
-- Dirty markers under old names would never be rebuilt; mark their new names instead.
INSERT OR REPLACE INTO profile_rebuild_requests (user_id, register, dirty_at)
SELECT user_id,
  CASE register WHEN 'slack' THEN 'casual' WHEN 'email' THEN 'professional' WHEN 'doc' THEN 'documentation' END,
  dirty_at
FROM profile_rebuild_requests WHERE register IN ('slack','email','doc');
DELETE FROM profile_rebuild_requests WHERE register IN ('slack','email','doc');
