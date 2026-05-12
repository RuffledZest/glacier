-- Migration: initial schema
-- Creates the deployments table for tracking build+deploy state

CREATE TABLE IF NOT EXISTS deployments (
  id              TEXT PRIMARY KEY,
  user_address    TEXT NOT NULL,
  repo_url        TEXT NOT NULL,
  branch          TEXT NOT NULL DEFAULT 'main',
  base_dir        TEXT NOT NULL DEFAULT '.',
  install_command TEXT,
  build_command   TEXT,
  output_dir      TEXT,
  network         TEXT NOT NULL DEFAULT 'mainnet' CHECK (network IN ('mainnet', 'testnet')),
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'building', 'built', 'deploying', 'deployed', 'failed', 'deleted')),
  error           TEXT,
  object_id       TEXT,
  base36_url      TEXT,
  logs            TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deployments_user ON deployments(user_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployments_repo ON deployments(repo_url);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
