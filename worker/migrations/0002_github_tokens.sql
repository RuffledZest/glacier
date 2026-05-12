-- Migration: GitHub integration
-- Stores OAuth tokens per user

CREATE TABLE IF NOT EXISTS github_tokens (
  user_address TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  github_user  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
