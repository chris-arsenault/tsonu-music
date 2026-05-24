CREATE TABLE music_draft_albums (
    album_id      TEXT PRIMARY KEY,
    release_id    TEXT NOT NULL,
    slug          TEXT NOT NULL UNIQUE,
    title         TEXT NOT NULL,
    release_type  TEXT NOT NULL,
    release_date  TEXT,
    publish_state TEXT NOT NULL,
    document      JSONB NOT NULL,
    revision      BIGINT NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_music_draft_albums_publish_state
        CHECK (publish_state IN ('draft', 'ready', 'published')),
    CONSTRAINT chk_music_draft_albums_revision
        CHECK (revision > 0),
    CONSTRAINT chk_music_draft_albums_document
        CHECK (jsonb_typeof(document) = 'object')
);

CREATE INDEX idx_music_draft_albums_updated_at
    ON music_draft_albums (updated_at DESC);

CREATE TABLE music_encode_jobs (
    job_id       TEXT PRIMARY KEY,
    album_id     TEXT NOT NULL,
    track_id     TEXT NOT NULL,
    status       TEXT NOT NULL,
    document     JSONB NOT NULL,
    requested_at TIMESTAMPTZ,
    started_at   TIMESTAMPTZ,
    finished_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_music_encode_jobs_status
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
    CONSTRAINT chk_music_encode_jobs_document
        CHECK (jsonb_typeof(document) = 'object')
);

CREATE INDEX idx_music_encode_jobs_album_track
    ON music_encode_jobs (album_id, track_id, updated_at DESC);

CREATE INDEX idx_music_encode_jobs_updated_at
    ON music_encode_jobs (updated_at DESC);

CREATE TABLE music_published_albums (
    album_id               TEXT PRIMARY KEY,
    release_id             TEXT NOT NULL,
    slug                   TEXT NOT NULL UNIQUE,
    title                  TEXT NOT NULL,
    subtitle               TEXT,
    artist_name            TEXT NOT NULL,
    release_type           TEXT NOT NULL,
    release_date           TEXT NOT NULL,
    visibility             TEXT NOT NULL,
    published_at           TIMESTAMPTZ NOT NULL,
    description            TEXT,
    copyright              TEXT,
    artwork                JSONB NOT NULL,
    credits                JSONB,
    links                  JSONB,
    tags                   TEXT[],
    track_count            INTEGER NOT NULL,
    total_duration_seconds DOUBLE PRECISION NOT NULL,
    document               JSONB NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_music_published_albums_visibility
        CHECK (visibility IN ('public', 'unlisted')),
    CONSTRAINT chk_music_published_albums_track_count
        CHECK (track_count >= 0),
    CONSTRAINT chk_music_published_albums_duration
        CHECK (total_duration_seconds >= 0),
    CONSTRAINT chk_music_published_albums_artwork
        CHECK (jsonb_typeof(artwork) = 'object'),
    CONSTRAINT chk_music_published_albums_document
        CHECK (jsonb_typeof(document) = 'object')
);

CREATE INDEX idx_music_published_albums_release
    ON music_published_albums (release_date DESC, title ASC);

CREATE TABLE music_published_tracks (
    album_id         TEXT NOT NULL REFERENCES music_published_albums(album_id) ON DELETE CASCADE,
    track_id         TEXT NOT NULL,
    disc_number      INTEGER NOT NULL,
    track_number     INTEGER NOT NULL,
    slug             TEXT NOT NULL,
    title            TEXT NOT NULL,
    duration_seconds DOUBLE PRECISION NOT NULL,
    explicit         BOOLEAN NOT NULL,
    isrc             TEXT,
    description      TEXT,
    credits          JSONB,
    playback         JSONB NOT NULL,
    published_job_id TEXT NOT NULL,
    document         JSONB NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (album_id, track_id),
    UNIQUE (album_id, slug),
    CONSTRAINT chk_music_published_tracks_disc_number
        CHECK (disc_number > 0),
    CONSTRAINT chk_music_published_tracks_track_number
        CHECK (track_number > 0),
    CONSTRAINT chk_music_published_tracks_duration
        CHECK (duration_seconds >= 0),
    CONSTRAINT chk_music_published_tracks_playback
        CHECK (jsonb_typeof(playback) = 'object'),
    CONSTRAINT chk_music_published_tracks_document
        CHECK (jsonb_typeof(document) = 'object')
);

CREATE INDEX idx_music_published_tracks_order
    ON music_published_tracks (album_id, disc_number, track_number);
