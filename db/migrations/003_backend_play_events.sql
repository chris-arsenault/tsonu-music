CREATE TABLE music_play_events (
    play_event_id       BIGSERIAL PRIMARY KEY,
    dedupe_key          TEXT NOT NULL UNIQUE,
    event_type          TEXT NOT NULL,
    release_id          TEXT NOT NULL,
    track_id            TEXT NOT NULL,
    song_id             TEXT NOT NULL,
    recording_id        TEXT NOT NULL,
    asset_id            TEXT,
    selected_quality    TEXT,
    position_seconds    DOUBLE PRECISION,
    duration_seconds    DOUBLE PRECISION,
    site_session_id     TEXT NOT NULL,
    playback_session_id TEXT NOT NULL,
    page_path           TEXT,
    referrer_origin     TEXT,
    referrer_host       TEXT,
    occurred_at         TIMESTAMPTZ NOT NULL,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT chk_music_play_events_type
        CHECK (event_type IN ('play_start', 'play_10s', 'play_25', 'play_complete')),
    CONSTRAINT chk_music_play_events_position
        CHECK (position_seconds IS NULL OR position_seconds >= 0),
    CONSTRAINT chk_music_play_events_duration
        CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
    CONSTRAINT chk_music_play_events_page_path
        CHECK (page_path IS NULL OR char_length(page_path) <= 512),
    CONSTRAINT fk_music_play_events_track
        FOREIGN KEY (release_id, track_id)
        REFERENCES music_published_release_tracks(release_id, track_id)
        ON DELETE CASCADE
);

CREATE INDEX idx_music_play_events_received
    ON music_play_events (received_at DESC);

CREATE INDEX idx_music_play_events_song
    ON music_play_events (song_id, recording_id, event_type, received_at DESC);

CREATE INDEX idx_music_play_events_release
    ON music_play_events (release_id, track_id, event_type, received_at DESC);

CREATE TABLE music_analytics_rate_limits (
    bucket_key    TEXT PRIMARY KEY,
    window_start  TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_count INTEGER NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_music_analytics_rate_limits_count
        CHECK (request_count >= 0)
);

CREATE INDEX idx_music_analytics_rate_limits_updated
    ON music_analytics_rate_limits (updated_at);
