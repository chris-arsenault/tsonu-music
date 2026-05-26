ALTER TABLE music_published_release_tracks
    ADD COLUMN IF NOT EXISTS published_job_id TEXT;

UPDATE music_published_release_tracks
SET published_job_id = COALESCE(published_job_id, 'job_legacy_unknown');

ALTER TABLE music_published_release_tracks
    ALTER COLUMN published_job_id SET NOT NULL;
