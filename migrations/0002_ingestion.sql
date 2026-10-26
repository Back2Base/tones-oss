-- The profile Workflow is phase 3. Persist dirty registers now so no refresh is lost.
CREATE TABLE profile_rebuild_requests (
  user_id TEXT NOT NULL,
  register TEXT NOT NULL,
  dirty_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, register)
);
