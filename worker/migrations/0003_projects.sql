-- Migration: projects table
-- Stores project-level build config and allows project deletion

CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  user_address    TEXT NOT NULL,
  repo_url        TEXT NOT NULL,
  branch          TEXT NOT NULL DEFAULT 'main',
  base_dir        TEXT NOT NULL DEFAULT '.',
  install_command TEXT,
  build_command   TEXT,
  output_dir      TEXT,
  network         TEXT NOT NULL DEFAULT 'testnet' CHECK (network IN ('mainnet', 'testnet')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_repo ON projects(user_address, repo_url);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_address);
