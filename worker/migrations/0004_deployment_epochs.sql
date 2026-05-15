-- Epochs used for Walrus site storage (for retention / "active until" UX)
ALTER TABLE deployments ADD COLUMN epochs INTEGER;
