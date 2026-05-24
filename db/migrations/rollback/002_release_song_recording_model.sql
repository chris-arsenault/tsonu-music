DROP TABLE IF EXISTS music_published_release_tracks;
DROP TABLE IF EXISTS music_published_songs;
DROP TABLE IF EXISTS music_published_releases;
DROP TABLE IF EXISTS music_draft_releases;
DROP TABLE IF EXISTS music_draft_songs;

DROP INDEX IF EXISTS idx_music_encode_jobs_recording;

ALTER TABLE IF EXISTS music_encode_jobs
    DROP COLUMN IF EXISTS release_id;

ALTER TABLE IF EXISTS music_encode_jobs
    RENAME COLUMN recording_id TO track_id;

ALTER TABLE IF EXISTS music_encode_jobs
    RENAME COLUMN song_id TO album_id;

CREATE INDEX IF NOT EXISTS idx_music_encode_jobs_album_track
    ON music_encode_jobs (album_id, track_id, updated_at DESC);
