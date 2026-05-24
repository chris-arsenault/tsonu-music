DROP TABLE IF EXISTS music_published_tracks;
DROP TABLE IF EXISTS music_published_albums;
DROP TABLE IF EXISTS music_draft_albums;

ALTER TABLE IF EXISTS music_encode_jobs
    RENAME COLUMN album_id TO song_id;

ALTER TABLE IF EXISTS music_encode_jobs
    RENAME COLUMN track_id TO recording_id;

CREATE TABLE music_draft_songs (
    song_id    TEXT PRIMARY KEY,
    slug       TEXT NOT NULL UNIQUE,
    title      TEXT NOT NULL,
    document   JSONB NOT NULL,
    revision   BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_music_draft_songs_revision
        CHECK (revision > 0),
    CONSTRAINT chk_music_draft_songs_document
        CHECK (jsonb_typeof(document) = 'object')
);

CREATE INDEX idx_music_draft_songs_updated_at
    ON music_draft_songs (updated_at DESC);

CREATE TABLE music_draft_releases (
    release_id     TEXT PRIMARY KEY,
    slug           TEXT NOT NULL UNIQUE,
    title          TEXT NOT NULL,
    release_kind   TEXT NOT NULL,
    release_status TEXT NOT NULL,
    release_date   TEXT,
    publish_state  TEXT NOT NULL,
    document       JSONB NOT NULL,
    revision       BIGINT NOT NULL DEFAULT 1,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_music_draft_releases_kind
        CHECK (release_kind IN ('album', 'ep', 'single', 'demo', 'preview', 'collection', 'prerelease')),
    CONSTRAINT chk_music_draft_releases_status
        CHECK (release_status IN ('official', 'demo', 'promo', 'prerelease', 'bootleg')),
    CONSTRAINT chk_music_draft_releases_publish_state
        CHECK (publish_state IN ('draft', 'ready', 'published', 'withdrawn')),
    CONSTRAINT chk_music_draft_releases_revision
        CHECK (revision > 0),
    CONSTRAINT chk_music_draft_releases_document
        CHECK (jsonb_typeof(document) = 'object')
);

CREATE INDEX idx_music_draft_releases_updated_at
    ON music_draft_releases (updated_at DESC);

ALTER TABLE music_encode_jobs
    ADD COLUMN IF NOT EXISTS release_id TEXT;

DROP INDEX IF EXISTS idx_music_encode_jobs_album_track;

CREATE INDEX IF NOT EXISTS idx_music_encode_jobs_recording
    ON music_encode_jobs (recording_id, updated_at DESC);

CREATE TABLE music_published_releases (
    release_id             TEXT PRIMARY KEY,
    slug                   TEXT NOT NULL UNIQUE,
    title                  TEXT NOT NULL,
    subtitle               TEXT,
    artist_name            TEXT NOT NULL,
    release_kind           TEXT NOT NULL,
    release_status         TEXT NOT NULL,
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
    CONSTRAINT chk_music_published_releases_kind
        CHECK (release_kind IN ('album', 'ep', 'single', 'demo', 'preview', 'collection', 'prerelease')),
    CONSTRAINT chk_music_published_releases_status
        CHECK (release_status IN ('official', 'demo', 'promo', 'prerelease', 'bootleg')),
    CONSTRAINT chk_music_published_releases_visibility
        CHECK (visibility IN ('public', 'unlisted')),
    CONSTRAINT chk_music_published_releases_track_count
        CHECK (track_count >= 0),
    CONSTRAINT chk_music_published_releases_duration
        CHECK (total_duration_seconds >= 0),
    CONSTRAINT chk_music_published_releases_artwork
        CHECK (jsonb_typeof(artwork) = 'object'),
    CONSTRAINT chk_music_published_releases_document
        CHECK (jsonb_typeof(document) = 'object')
);

CREATE INDEX idx_music_published_releases_release
    ON music_published_releases (release_date DESC, title ASC);

CREATE TABLE music_published_songs (
    song_id    TEXT PRIMARY KEY,
    slug       TEXT NOT NULL UNIQUE,
    title      TEXT NOT NULL,
    artist_name TEXT NOT NULL,
    document   JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_music_published_songs_document
        CHECK (jsonb_typeof(document) = 'object')
);

CREATE INDEX idx_music_published_songs_title
    ON music_published_songs (title ASC);

CREATE TABLE music_published_release_tracks (
    release_id       TEXT NOT NULL REFERENCES music_published_releases(release_id) ON DELETE CASCADE,
    track_id         TEXT NOT NULL,
    song_id          TEXT NOT NULL REFERENCES music_published_songs(song_id) ON DELETE RESTRICT,
    recording_id     TEXT NOT NULL,
    disc_number      INTEGER NOT NULL,
    track_number     INTEGER NOT NULL,
    slug             TEXT NOT NULL,
    title            TEXT NOT NULL,
    song_title       TEXT NOT NULL,
    recording_title  TEXT NOT NULL,
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
    PRIMARY KEY (release_id, track_id),
    UNIQUE (release_id, slug),
    CONSTRAINT chk_music_published_release_tracks_disc_number
        CHECK (disc_number > 0),
    CONSTRAINT chk_music_published_release_tracks_track_number
        CHECK (track_number > 0),
    CONSTRAINT chk_music_published_release_tracks_duration
        CHECK (duration_seconds >= 0),
    CONSTRAINT chk_music_published_release_tracks_playback
        CHECK (jsonb_typeof(playback) = 'object'),
    CONSTRAINT chk_music_published_release_tracks_document
        CHECK (jsonb_typeof(document) = 'object')
);

CREATE INDEX idx_music_published_release_tracks_order
    ON music_published_release_tracks (release_id, disc_number, track_number);

CREATE INDEX idx_music_published_release_tracks_song
    ON music_published_release_tracks (song_id, recording_id);
