-- Keep tombstones after deleting sample metadata to fence queue redelivery and late writes.
CREATE TABLE sample_deletions (
  sample_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  requested_at INTEGER NOT NULL
);
CREATE INDEX sample_deletions_user ON sample_deletions(user_id, sample_id);
CREATE INDEX samples_user_created ON samples(user_id, created_at DESC, id DESC);
