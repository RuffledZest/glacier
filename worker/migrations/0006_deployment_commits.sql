-- Commit metadata captured at deployment creation time.
-- Existing deployments predate commit tracking and keep NULL values.

ALTER TABLE deployments ADD COLUMN commit_sha TEXT;
ALTER TABLE deployments ADD COLUMN commit_ref TEXT;
ALTER TABLE deployments ADD COLUMN commit_message TEXT;
ALTER TABLE deployments ADD COLUMN commit_author_name TEXT;
ALTER TABLE deployments ADD COLUMN commit_author_date TEXT;
ALTER TABLE deployments ADD COLUMN commit_url TEXT;

CREATE INDEX IF NOT EXISTS idx_deployments_repo_commit ON deployments(repo_url, commit_sha);
