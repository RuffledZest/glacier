-- Project-scoped encrypted build secrets.
-- Values are encrypted in the worker before storage and are never returned by APIs.

CREATE TABLE IF NOT EXISTS project_secrets (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  user_address TEXT NOT NULL,
  name        TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  iv          TEXT NOT NULL,
  algorithm   TEXT NOT NULL DEFAULT 'AES-256-GCM',
  key_version TEXT NOT NULL DEFAULT 'v1',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_secrets_project_name ON project_secrets(project_id, name);
CREATE INDEX IF NOT EXISTS idx_project_secrets_user_project ON project_secrets(user_address, project_id);
