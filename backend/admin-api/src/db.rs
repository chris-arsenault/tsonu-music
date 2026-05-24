use super::{
    draft_release_key, draft_song_key, encode_job_key, ApiError, BackendPlaySummary,
    BackendReleasePlaySummary, BackendSongPlaySummary, CatalogArtist, CatalogEntityType,
    DraftRelease, DraftSong, EncodeJob, ObjectList, ObjectSummary, PublishedCatalog,
    PublishedCatalogRelease, PublishedCatalogSong, PublishedRelease, PublishedSong,
    PublishedSongPlacement, PublishedStatus, RateLimitDecision, RumEventCount, StoredPlayEvent,
    Visibility, WriteResult, ARTIST_NAME, ARTIST_SLUG,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::types::Json;
use sqlx::{PgPool, Row};
use std::env;
use tracing::error;

const DB_POOL_MAX_CONNECTIONS: u32 = 5;

#[derive(Debug)]
pub struct DbJsonObject {
    pub text: String,
    pub e_tag: Option<String>,
}

pub async fn connect_pool_from_env() -> Result<PgPool, Box<dyn std::error::Error + Send + Sync>> {
    let host = env::var("DB_HOST")?;
    let port = env::var("DB_PORT").unwrap_or_else(|_| "5432".to_string());
    let db_name = env::var("DB_NAME")?;
    let username = env::var("DB_USERNAME")?;
    let password = env::var("DB_PASSWORD")?;
    let url = format!("postgres://{username}:{password}@{host}:{port}/{db_name}?sslmode=require");

    Ok(PgPoolOptions::new()
        .max_connections(DB_POOL_MAX_CONNECTIONS)
        .connect(&url)
        .await?)
}

pub async fn get_draft_song(pool: &PgPool, song_id: &str) -> Result<DbJsonObject, ApiError> {
    get_json_object(
        pool,
        "SELECT document::text AS document, revision FROM music_draft_songs WHERE song_id = $1",
        song_id,
        || ApiError::not_found(format!("draft song not found: {song_id}")),
    )
    .await
}

pub async fn get_draft_release(pool: &PgPool, release_id: &str) -> Result<DbJsonObject, ApiError> {
    get_json_object(
        pool,
        "SELECT document::text AS document, revision FROM music_draft_releases WHERE release_id = $1",
        release_id,
        || ApiError::not_found(format!("draft release not found: {release_id}")),
    )
    .await
}

async fn get_json_object(
    pool: &PgPool,
    query: &str,
    id: &str,
    not_found: impl FnOnce() -> ApiError,
) -> Result<DbJsonObject, ApiError> {
    let row = sqlx::query(query)
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(map_db_read_error)?
        .ok_or_else(not_found)?;

    Ok(DbJsonObject {
        text: row.get::<String, _>("document"),
        e_tag: Some(revision_etag(row.get("revision"))),
    })
}

pub async fn list_draft_songs(pool: &PgPool) -> Result<ObjectList, ApiError> {
    let rows = sqlx::query(
        "SELECT song_id, revision, octet_length(document::text) AS size_bytes
         FROM music_draft_songs
         ORDER BY updated_at DESC, song_id ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_read_error)?;

    Ok(ObjectList {
        bucket: "rds".to_string(),
        prefix: "draft/songs/".to_string(),
        objects: rows
            .into_iter()
            .map(|row| {
                let song_id: String = row.get("song_id");
                ObjectSummary {
                    key: draft_song_key(&song_id),
                    e_tag: Some(revision_etag(row.get("revision"))),
                    size_bytes: i64::from(row.get::<i32, _>("size_bytes")),
                }
            })
            .collect(),
    })
}

pub async fn list_draft_releases(pool: &PgPool) -> Result<ObjectList, ApiError> {
    let rows = sqlx::query(
        "SELECT release_id, revision, octet_length(document::text) AS size_bytes
         FROM music_draft_releases
         ORDER BY updated_at DESC, release_id ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_read_error)?;

    Ok(ObjectList {
        bucket: "rds".to_string(),
        prefix: "draft/releases/".to_string(),
        objects: rows
            .into_iter()
            .map(|row| {
                let release_id: String = row.get("release_id");
                ObjectSummary {
                    key: draft_release_key(&release_id),
                    e_tag: Some(revision_etag(row.get("revision"))),
                    size_bytes: i64::from(row.get::<i32, _>("size_bytes")),
                }
            })
            .collect(),
    })
}

pub async fn put_draft_song(
    pool: &PgPool,
    song_id: &str,
    document: &Value,
    if_match: Option<&str>,
    if_none_match: Option<&str>,
) -> Result<WriteResult, ApiError> {
    let song = draft_song_fields(song_id, document)?;
    let revision = if if_none_match == Some("*") {
        let row = sqlx::query(
            "INSERT INTO music_draft_songs (song_id, slug, title, document)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (song_id) DO NOTHING
             RETURNING revision",
        )
        .bind(song_id)
        .bind(&song.slug)
        .bind(&song.title)
        .bind(Json(document.clone()))
        .fetch_optional(pool)
        .await
        .map_err(map_db_write_error)?;

        row.map(|row| row.get("revision")).ok_or_else(|| {
            ApiError::precondition_failed(
                "write_precondition_failed",
                "draft song already exists; fetch the current revision and retry",
            )
        })?
    } else if let Some(if_match) = if_match {
        let expected_revision = parse_revision_etag(if_match)?;
        let row = sqlx::query(
            "UPDATE music_draft_songs
             SET slug = $2,
                 title = $3,
                 document = $4,
                 revision = revision + 1,
                 updated_at = now()
             WHERE song_id = $1 AND revision = $5
             RETURNING revision",
        )
        .bind(song_id)
        .bind(&song.slug)
        .bind(&song.title)
        .bind(Json(document.clone()))
        .bind(expected_revision)
        .fetch_optional(pool)
        .await
        .map_err(map_db_write_error)?;

        row.map(|row| row.get("revision")).ok_or_else(|| {
            ApiError::precondition_failed(
                "write_precondition_failed",
                "draft song revision changed; fetch the latest revision and retry",
            )
        })?
    } else {
        return Err(ApiError::precondition_required(
            "send If-None-Match: * to create or If-Match: <revision> to update",
        ));
    };

    Ok(WriteResult {
        bucket: "rds".to_string(),
        key: draft_song_key(song_id),
        e_tag: Some(revision_etag(revision)),
        version_id: None,
    })
}

pub async fn put_draft_release(
    pool: &PgPool,
    release_id: &str,
    document: &Value,
    if_match: Option<&str>,
    if_none_match: Option<&str>,
) -> Result<WriteResult, ApiError> {
    let release = draft_release_fields(release_id, document)?;
    let revision = if if_none_match == Some("*") {
        let row = sqlx::query(
            "INSERT INTO music_draft_releases
                (release_id, slug, title, release_kind, release_status, release_date, publish_state, document)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (release_id) DO NOTHING
             RETURNING revision",
        )
        .bind(release_id)
        .bind(&release.slug)
        .bind(&release.title)
        .bind(&release.release_kind)
        .bind(&release.release_status)
        .bind(&release.release_date)
        .bind(&release.publish_state)
        .bind(Json(document.clone()))
        .fetch_optional(pool)
        .await
        .map_err(map_db_write_error)?;

        row.map(|row| row.get("revision")).ok_or_else(|| {
            ApiError::precondition_failed(
                "write_precondition_failed",
                "draft release already exists; fetch the current revision and retry",
            )
        })?
    } else if let Some(if_match) = if_match {
        let expected_revision = parse_revision_etag(if_match)?;
        let row = sqlx::query(
            "UPDATE music_draft_releases
             SET slug = $2,
                 title = $3,
                 release_kind = $4,
                 release_status = $5,
                 release_date = $6,
                 publish_state = $7,
                 document = $8,
                 revision = revision + 1,
                 updated_at = now()
             WHERE release_id = $1 AND revision = $9
             RETURNING revision",
        )
        .bind(release_id)
        .bind(&release.slug)
        .bind(&release.title)
        .bind(&release.release_kind)
        .bind(&release.release_status)
        .bind(&release.release_date)
        .bind(&release.publish_state)
        .bind(Json(document.clone()))
        .bind(expected_revision)
        .fetch_optional(pool)
        .await
        .map_err(map_db_write_error)?;

        row.map(|row| row.get("revision")).ok_or_else(|| {
            ApiError::precondition_failed(
                "write_precondition_failed",
                "draft release revision changed; fetch the latest revision and retry",
            )
        })?
    } else {
        return Err(ApiError::precondition_required(
            "send If-None-Match: * to create or If-Match: <revision> to update",
        ));
    };

    Ok(WriteResult {
        bucket: "rds".to_string(),
        key: draft_release_key(release_id),
        e_tag: Some(revision_etag(revision)),
        version_id: None,
    })
}

pub async fn put_encode_job(pool: &PgPool, job: &EncodeJob) -> Result<(), ApiError> {
    let document = serde_json::to_value(job).map_err(|err| {
        error!(job_id = job.job_id, error = %err, "Failed to serialize encode job for database");
        ApiError::internal("job_serialize_failed", "failed to serialize encode job")
    })?;

    upsert_encode_job_document(pool, job, document).await
}

pub async fn upsert_encode_job_document(
    pool: &PgPool,
    job: &EncodeJob,
    document: Value,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO music_encode_jobs
            (job_id, song_id, recording_id, status, document, requested_at, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (job_id) DO UPDATE SET
             song_id = EXCLUDED.song_id,
             recording_id = EXCLUDED.recording_id,
             status = EXCLUDED.status,
             document = EXCLUDED.document,
             requested_at = EXCLUDED.requested_at,
             started_at = EXCLUDED.started_at,
             finished_at = EXCLUDED.finished_at,
             updated_at = now()",
    )
    .bind(&job.job_id)
    .bind(&job.song_id)
    .bind(&job.recording_id)
    .bind(job_status(job))
    .bind(Json(document))
    .bind(parse_optional_rfc3339(Some(job.requested_at.as_str())))
    .bind(parse_optional_rfc3339(job.started_at.as_deref()))
    .bind(parse_optional_rfc3339(job.finished_at.as_deref()))
    .execute(pool)
    .await
    .map_err(map_db_write_error)?;

    Ok(())
}

pub async fn get_encode_job(pool: &PgPool, job_id: &str) -> Result<EncodeJob, ApiError> {
    let row = sqlx::query(
        "SELECT document::text AS document
         FROM music_encode_jobs
         WHERE job_id = $1",
    )
    .bind(job_id)
    .fetch_optional(pool)
    .await
    .map_err(map_db_read_error)?
    .ok_or_else(|| ApiError::not_found(format!("encode job not found: {job_id}")))?;

    serde_json::from_str(&row.get::<String, _>("document")).map_err(|err| {
        error!(job_id, error = %err, "Stored encode job cannot be parsed");
        ApiError::internal("invalid_stored_job", "stored encode job cannot be parsed")
    })
}

pub async fn list_encode_jobs(pool: &PgPool) -> Result<ObjectList, ApiError> {
    let rows = sqlx::query(
        "SELECT job_id, octet_length(document::text) AS size_bytes
         FROM music_encode_jobs
         ORDER BY updated_at DESC, job_id ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_read_error)?;

    Ok(ObjectList {
        bucket: "rds".to_string(),
        prefix: "jobs/".to_string(),
        objects: rows
            .into_iter()
            .map(|row| {
                let job_id: String = row.get("job_id");
                ObjectSummary {
                    key: encode_job_key(&job_id),
                    e_tag: None,
                    size_bytes: i64::from(row.get::<i32, _>("size_bytes")),
                }
            })
            .collect(),
    })
}

pub async fn replace_publication(
    pool: &PgPool,
    release: &PublishedRelease,
    songs: &[PublishedSong],
    total_duration_seconds: f64,
) -> Result<WriteResult, ApiError> {
    let release_document = serde_json::to_value(release).map_err(|err| {
        error!(release_id = release.release_id, error = %err, "Failed to serialize published release");
        ApiError::internal(
            "published_release_serialize_failed",
            "failed to serialize published release",
        )
    })?;
    let links = serde_json::to_value(&release.links).map_err(|err| {
        error!(release_id = release.release_id, error = %err, "Failed to serialize release links");
        ApiError::internal(
            "release_links_serialize_failed",
            "failed to serialize release links",
        )
    })?;

    let mut tx = pool.begin().await.map_err(map_db_write_error)?;

    for song in songs {
        let document = serde_json::to_value(song).map_err(|err| {
            error!(song_id = song.song_id, error = %err, "Failed to serialize published song");
            ApiError::internal(
                "published_song_serialize_failed",
                "failed to serialize published song",
            )
        })?;
        sqlx::query(
            "INSERT INTO music_published_songs (song_id, slug, title, artist_name, document)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (song_id) DO UPDATE SET
                 slug = EXCLUDED.slug,
                 title = EXCLUDED.title,
                 artist_name = EXCLUDED.artist_name,
                 document = EXCLUDED.document,
                 updated_at = now()",
        )
        .bind(&song.song_id)
        .bind(&song.slug)
        .bind(&song.title)
        .bind(&song.artist_name)
        .bind(Json(document))
        .execute(&mut *tx)
        .await
        .map_err(map_db_write_error)?;
    }

    sqlx::query(
        "INSERT INTO music_published_releases
            (release_id, slug, title, subtitle, artist_name, release_kind, release_status,
             release_date, visibility, published_at, description, copyright, artwork, credits,
             links, tags, track_count, total_duration_seconds, document)
         VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (release_id) DO UPDATE SET
             slug = EXCLUDED.slug,
             title = EXCLUDED.title,
             subtitle = EXCLUDED.subtitle,
             artist_name = EXCLUDED.artist_name,
             release_kind = EXCLUDED.release_kind,
             release_status = EXCLUDED.release_status,
             release_date = EXCLUDED.release_date,
             visibility = EXCLUDED.visibility,
             published_at = EXCLUDED.published_at,
             description = EXCLUDED.description,
             copyright = EXCLUDED.copyright,
             artwork = EXCLUDED.artwork,
             credits = EXCLUDED.credits,
             links = EXCLUDED.links,
             tags = EXCLUDED.tags,
             track_count = EXCLUDED.track_count,
             total_duration_seconds = EXCLUDED.total_duration_seconds,
             document = EXCLUDED.document,
             updated_at = now()",
    )
    .bind(&release.release_id)
    .bind(&release.slug)
    .bind(&release.title)
    .bind(&release.subtitle)
    .bind(&release.artist_name)
    .bind(&release.release_kind)
    .bind(&release.release_status)
    .bind(&release.release_date)
    .bind(visibility_value(release.visibility))
    .bind(parse_required_rfc3339(&release.published_at)?)
    .bind(&release.description)
    .bind(&release.copyright)
    .bind(Json(release.artwork.clone()))
    .bind(release.credits.clone().map(Json))
    .bind(if links.is_null() {
        None
    } else {
        Some(Json(links))
    })
    .bind(&release.tags)
    .bind(release.tracks.len() as i32)
    .bind(total_duration_seconds)
    .bind(Json(release_document))
    .execute(&mut *tx)
    .await
    .map_err(map_db_write_error)?;

    sqlx::query("DELETE FROM music_published_release_tracks WHERE release_id = $1")
        .bind(&release.release_id)
        .execute(&mut *tx)
        .await
        .map_err(map_db_write_error)?;

    for track in &release.tracks {
        let document = serde_json::to_value(track).map_err(|err| {
            error!(release_id = release.release_id, track_id = track.track_id, error = %err, "Failed to serialize published release track");
            ApiError::internal(
                "published_track_serialize_failed",
                "failed to serialize published release track",
            )
        })?;
        let playback = serde_json::to_value(&track.playback).map_err(|err| {
            error!(release_id = release.release_id, track_id = track.track_id, error = %err, "Failed to serialize published release track playback");
            ApiError::internal(
                "playback_serialize_failed",
                "failed to serialize published release track playback",
            )
        })?;
        let published_job_id = published_job_id(track)?;

        sqlx::query(
            "INSERT INTO music_published_release_tracks
                (release_id, track_id, song_id, recording_id, disc_number, track_number, slug,
                 title, song_title, recording_title, duration_seconds, explicit, isrc, description,
                 credits, playback, published_job_id, document)
             VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)",
        )
        .bind(&release.release_id)
        .bind(&track.track_id)
        .bind(&track.song_id)
        .bind(&track.recording_id)
        .bind(track.disc_number as i32)
        .bind(track.track_number as i32)
        .bind(&track.slug)
        .bind(&track.title)
        .bind(&track.song_title)
        .bind(&track.recording_title)
        .bind(track.duration_seconds)
        .bind(track.explicit)
        .bind(&track.isrc)
        .bind(&track.description)
        .bind(track.credits.clone().map(Json))
        .bind(Json(playback))
        .bind(published_job_id)
        .bind(Json(document))
        .execute(&mut *tx)
        .await
        .map_err(map_db_write_error)?;
    }

    tx.commit().await.map_err(map_db_write_error)?;

    Ok(WriteResult {
        bucket: "rds".to_string(),
        key: format!("published/releases/{}", release.release_id),
        e_tag: None,
        version_id: None,
    })
}

pub async fn get_public_catalog(pool: &PgPool) -> Result<PublishedCatalog, ApiError> {
    let release_rows = sqlx::query(
        "SELECT release_id, slug, title, subtitle, release_kind, release_status, release_date,
                visibility, artwork, track_count, total_duration_seconds, tags, links
         FROM music_published_releases
         WHERE visibility = 'public'
         ORDER BY release_date DESC, title ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_read_error)?;

    let releases = release_rows
        .into_iter()
        .map(|row| {
            let links: Option<Json<Value>> = row.get("links");
            let parsed_links = links
                .map(|value| serde_json::from_value(value.0))
                .transpose()
                .map_err(|err| {
                    error!(error = %err, "Stored public release links cannot be parsed");
                    ApiError::internal(
                        "invalid_stored_links",
                        "stored public release links cannot be parsed",
                    )
                })?;

            Ok(PublishedCatalogRelease {
                release_id: row.get("release_id"),
                slug: row.get("slug"),
                title: row.get("title"),
                subtitle: row.get("subtitle"),
                release_kind: row.get("release_kind"),
                release_status: row.get("release_status"),
                release_date: row.get("release_date"),
                status: PublishedStatus::Published,
                visibility: parse_visibility(row.get::<String, _>("visibility").as_str())?,
                manifest_path: format!("/catalog/releases/{}", row.get::<String, _>("slug")),
                artwork: row.get::<Json<Value>, _>("artwork").0,
                track_count: row.get::<i32, _>("track_count") as usize,
                total_duration_seconds: row.get("total_duration_seconds"),
                tags: row.get("tags"),
                links: parsed_links,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;

    let song_rows = sqlx::query(
        "SELECT DISTINCT s.song_id, s.slug, s.title, s.artist_name, s.document
         FROM music_published_songs s
         JOIN music_published_release_tracks t ON t.song_id = s.song_id
         JOIN music_published_releases r ON r.release_id = t.release_id
         WHERE r.visibility = 'public'
         ORDER BY s.title ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_read_error)?;

    let songs = song_rows
        .into_iter()
        .map(|row| {
            let document: Value = row.get::<Json<Value>, _>("document").0;
            Ok(PublishedCatalogSong {
                song_id: row.get("song_id"),
                slug: row.get("slug"),
                title: row.get("title"),
                artist_name: row.get("artist_name"),
                tags: document
                    .get("tags")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|err| {
                        error!(error = %err, "Stored public song tags cannot be parsed");
                        ApiError::internal(
                            "invalid_stored_tags",
                            "stored public song tags cannot be parsed",
                        )
                    })?,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;

    Ok(PublishedCatalog {
        schema_version: 1,
        entity_type: CatalogEntityType::Catalog,
        generated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        artist: CatalogArtist {
            name: ARTIST_NAME.to_string(),
            slug: ARTIST_SLUG.to_string(),
        },
        releases,
        songs,
    })
}

pub async fn get_public_release_by_slug(
    pool: &PgPool,
    slug: &str,
) -> Result<DbJsonObject, ApiError> {
    let row = sqlx::query(
        "SELECT document::text AS document, updated_at
         FROM music_published_releases
         WHERE slug = $1 AND visibility IN ('public', 'unlisted')",
    )
    .bind(slug)
    .fetch_optional(pool)
    .await
    .map_err(map_db_read_error)?
    .ok_or_else(|| ApiError::not_found(format!("published release not found: {slug}")))?;

    Ok(DbJsonObject {
        text: row.get("document"),
        e_tag: Some(timestamp_etag(row.get("updated_at"))),
    })
}

pub async fn get_public_song_by_slug(pool: &PgPool, slug: &str) -> Result<PublishedSong, ApiError> {
    let row = sqlx::query(
        "SELECT document::text AS document
         FROM music_published_songs
         WHERE slug = $1",
    )
    .bind(slug)
    .fetch_optional(pool)
    .await
    .map_err(map_db_read_error)?
    .ok_or_else(|| ApiError::not_found(format!("published song not found: {slug}")))?;

    let mut song: PublishedSong =
        serde_json::from_str(&row.get::<String, _>("document")).map_err(|err| {
            error!(slug, error = %err, "Stored published song cannot be parsed");
            ApiError::internal(
                "invalid_stored_song",
                "stored published song cannot be parsed",
            )
        })?;

    let placement_rows = sqlx::query(
        "SELECT r.release_id, r.slug AS release_slug, r.title AS release_title, r.release_kind,
                t.track_id, t.slug AS track_slug, t.recording_id, t.track_number
         FROM music_published_release_tracks t
         JOIN music_published_releases r ON r.release_id = t.release_id
         WHERE t.song_id = $1 AND r.visibility IN ('public', 'unlisted')
         ORDER BY r.release_date DESC, r.title ASC, t.disc_number ASC, t.track_number ASC",
    )
    .bind(&song.song_id)
    .fetch_all(pool)
    .await
    .map_err(map_db_read_error)?;

    song.placements = placement_rows
        .into_iter()
        .map(|row| PublishedSongPlacement {
            release_id: row.get("release_id"),
            release_slug: row.get("release_slug"),
            release_title: row.get("release_title"),
            release_kind: row.get("release_kind"),
            track_id: row.get("track_id"),
            track_slug: row.get("track_slug"),
            recording_id: row.get("recording_id"),
            track_number: row.get::<i32, _>("track_number") as u32,
        })
        .collect();

    if song.placements.is_empty() {
        return Err(ApiError::not_found(format!(
            "published song not found: {slug}"
        )));
    }

    Ok(song)
}

pub async fn check_analytics_rate_limit(
    pool: &PgPool,
    bucket_key: &str,
    max_requests: i32,
    window_seconds: i64,
) -> Result<RateLimitDecision, ApiError> {
    sqlx::query(
        "DELETE FROM music_analytics_rate_limits
         WHERE updated_at < now() - ($1::bigint * interval '1 second')",
    )
    .bind(window_seconds * 2)
    .execute(pool)
    .await
    .map_err(map_db_write_error)?;

    let row = sqlx::query(
        "INSERT INTO music_analytics_rate_limits
            (bucket_key, window_start, request_count, updated_at)
         VALUES ($1, now(), 1, now())
         ON CONFLICT (bucket_key) DO UPDATE SET
            window_start = CASE
                WHEN music_analytics_rate_limits.window_start <= now() - ($2::bigint * interval '1 second')
                    THEN now()
                ELSE music_analytics_rate_limits.window_start
            END,
            request_count = CASE
                WHEN music_analytics_rate_limits.window_start <= now() - ($2::bigint * interval '1 second')
                    THEN 1
                ELSE music_analytics_rate_limits.request_count + 1
            END,
            updated_at = now()
         RETURNING request_count",
    )
    .bind(bucket_key)
    .bind(window_seconds)
    .fetch_one(pool)
    .await
    .map_err(map_db_write_error)?;

    Ok(RateLimitDecision {
        allowed: row.get::<i32, _>("request_count") <= max_requests,
    })
}

pub async fn validate_play_event_track(
    pool: &PgPool,
    release_id: &str,
    track_id: &str,
    song_id: &str,
    recording_id: &str,
) -> Result<(), ApiError> {
    let exists = sqlx::query(
        "SELECT 1
         FROM music_published_release_tracks t
         JOIN music_published_releases r ON r.release_id = t.release_id
         WHERE t.release_id = $1
           AND t.track_id = $2
           AND t.song_id = $3
           AND t.recording_id = $4
           AND r.visibility IN ('public', 'unlisted')
         LIMIT 1",
    )
    .bind(release_id)
    .bind(track_id)
    .bind(song_id)
    .bind(recording_id)
    .fetch_optional(pool)
    .await
    .map_err(map_db_read_error)?
    .is_some();

    if exists {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "unknown_play_target",
            "play event does not reference a published track",
        ))
    }
}

pub async fn insert_play_event(pool: &PgPool, event: &StoredPlayEvent) -> Result<bool, ApiError> {
    let inserted = sqlx::query(
        "INSERT INTO music_play_events
            (dedupe_key, event_type, release_id, track_id, song_id, recording_id,
             asset_id, selected_quality, position_seconds, duration_seconds,
             site_session_id, playback_session_id, page_path, referrer_origin,
             referrer_host, occurred_at)
         VALUES
            ($1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10,
             $11, $12, $13, $14,
             $15, $16)
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING play_event_id",
    )
    .bind(&event.dedupe_key)
    .bind(&event.event_type)
    .bind(&event.release_id)
    .bind(&event.track_id)
    .bind(&event.song_id)
    .bind(&event.recording_id)
    .bind(&event.asset_id)
    .bind(&event.selected_quality)
    .bind(event.position_seconds)
    .bind(event.duration_seconds)
    .bind(&event.site_session_id)
    .bind(&event.playback_session_id)
    .bind(&event.page_path)
    .bind(&event.referrer_origin)
    .bind(&event.referrer_host)
    .bind(event.occurred_at)
    .fetch_optional(pool)
    .await
    .map_err(map_db_write_error)?
    .is_some();

    Ok(inserted)
}

pub async fn get_backend_play_summary(
    pool: &PgPool,
    start_time: DateTime<Utc>,
    end_time: DateTime<Utc>,
) -> Result<BackendPlaySummary, ApiError> {
    let event_rows = sqlx::query(
        "SELECT event_type, COUNT(*)::bigint AS count
         FROM music_play_events
         WHERE received_at >= $1 AND received_at <= $2
         GROUP BY event_type",
    )
    .bind(start_time)
    .bind(end_time)
    .fetch_all(pool)
    .await
    .map_err(map_db_read_error)?;

    let events = ["play_start", "play_10s", "play_25", "play_complete"]
        .into_iter()
        .map(|event_type| RumEventCount {
            event_type: event_type.to_string(),
            count: event_rows
                .iter()
                .find(|row| row.get::<String, _>("event_type") == event_type)
                .map(|row| row.get::<i64, _>("count") as u64)
                .unwrap_or_default(),
        })
        .collect::<Vec<_>>();

    let total_events = events.iter().map(|event| event.count).sum::<u64>();
    let play_starts = backend_event_count(&events, "play_start");
    let play_completes = backend_event_count(&events, "play_complete");

    let session_row = sqlx::query(
        "SELECT COUNT(DISTINCT site_session_id)::bigint AS count
         FROM music_play_events
         WHERE received_at >= $1 AND received_at <= $2",
    )
    .bind(start_time)
    .bind(end_time)
    .fetch_one(pool)
    .await
    .map_err(map_db_read_error)?;

    let song_rows = sqlx::query(
        "SELECT e.song_id, e.recording_id, s.title,
                COUNT(*)::bigint AS total_events,
                COUNT(*) FILTER (WHERE e.event_type = 'play_start')::bigint AS play_starts,
                COUNT(*) FILTER (WHERE e.event_type = 'play_10s')::bigint AS ten_second_plays,
                COUNT(*) FILTER (WHERE e.event_type = 'play_25')::bigint AS twenty_five_percent_plays,
                COUNT(*) FILTER (WHERE e.event_type = 'play_complete')::bigint AS play_completes
         FROM music_play_events e
         LEFT JOIN music_published_songs s ON s.song_id = e.song_id
         WHERE e.received_at >= $1 AND e.received_at <= $2
         GROUP BY e.song_id, e.recording_id, s.title
         ORDER BY ten_second_plays DESC, play_starts DESC, total_events DESC, e.song_id ASC
         LIMIT 20",
    )
    .bind(start_time)
    .bind(end_time)
    .fetch_all(pool)
    .await
    .map_err(map_db_read_error)?;

    let release_rows = sqlx::query(
        "SELECT e.release_id, e.track_id, e.song_id, e.recording_id, r.title,
                COUNT(*)::bigint AS total_events,
                COUNT(*) FILTER (WHERE e.event_type = 'play_start')::bigint AS play_starts,
                COUNT(*) FILTER (WHERE e.event_type = 'play_10s')::bigint AS ten_second_plays,
                COUNT(*) FILTER (WHERE e.event_type = 'play_25')::bigint AS twenty_five_percent_plays,
                COUNT(*) FILTER (WHERE e.event_type = 'play_complete')::bigint AS play_completes
         FROM music_play_events e
         LEFT JOIN music_published_releases r ON r.release_id = e.release_id
         WHERE e.received_at >= $1 AND e.received_at <= $2
         GROUP BY e.release_id, e.track_id, e.song_id, e.recording_id, r.title
         ORDER BY ten_second_plays DESC, play_starts DESC, total_events DESC, e.release_id ASC, e.track_id ASC
         LIMIT 20",
    )
    .bind(start_time)
    .bind(end_time)
    .fetch_all(pool)
    .await
    .map_err(map_db_read_error)?;

    Ok(BackendPlaySummary {
        total_events,
        unique_site_sessions: session_row.get::<i64, _>("count") as u64,
        play_starts,
        ten_second_plays: backend_event_count(&events, "play_10s"),
        twenty_five_percent_plays: backend_event_count(&events, "play_25"),
        play_completes,
        play_completion_rate: super::ratio(play_completes, play_starts),
        events,
        songs: song_rows
            .into_iter()
            .map(|row| BackendSongPlaySummary {
                song_id: row.get("song_id"),
                recording_id: row.get("recording_id"),
                title: row.get("title"),
                total_events: row.get::<i64, _>("total_events") as u64,
                play_starts: row.get::<i64, _>("play_starts") as u64,
                ten_second_plays: row.get::<i64, _>("ten_second_plays") as u64,
                twenty_five_percent_plays: row.get::<i64, _>("twenty_five_percent_plays") as u64,
                play_completes: row.get::<i64, _>("play_completes") as u64,
            })
            .collect(),
        releases: release_rows
            .into_iter()
            .map(|row| BackendReleasePlaySummary {
                release_id: row.get("release_id"),
                track_id: row.get("track_id"),
                song_id: row.get("song_id"),
                recording_id: row.get("recording_id"),
                title: row.get("title"),
                total_events: row.get::<i64, _>("total_events") as u64,
                play_starts: row.get::<i64, _>("play_starts") as u64,
                ten_second_plays: row.get::<i64, _>("ten_second_plays") as u64,
                twenty_five_percent_plays: row.get::<i64, _>("twenty_five_percent_plays") as u64,
                play_completes: row.get::<i64, _>("play_completes") as u64,
            })
            .collect(),
    })
}

fn backend_event_count(events: &[RumEventCount], event_type: &str) -> u64 {
    events
        .iter()
        .find(|event| event.event_type == event_type)
        .map(|event| event.count)
        .unwrap_or_default()
}

fn draft_song_fields(song_id: &str, document: &Value) -> Result<DraftSong, ApiError> {
    let song: DraftSong = serde_json::from_value(document.clone()).map_err(|err| {
        error!(song_id, error = %err, "Draft song payload cannot be parsed");
        ApiError::bad_request("invalid_song", "draft song payload cannot be parsed")
    })?;

    if song.song_id != song_id {
        return Err(ApiError::bad_request(
            "song_id_mismatch",
            "draft song songId does not match request songId",
        ));
    }

    if song.schema_version != 1 || song.entity_type != "draftSong" {
        return Err(ApiError::bad_request(
            "invalid_song",
            "draft song schemaVersion/entityType are invalid",
        ));
    }

    if song.slug.trim().is_empty()
        || song.title.trim().is_empty()
        || song.artist_name.trim().is_empty()
    {
        return Err(ApiError::bad_request(
            "invalid_song",
            "draft song slug, title, and artistName are required",
        ));
    }

    for recording in &song.recordings {
        if recording.recording_id.trim().is_empty()
            || recording.slug.trim().is_empty()
            || recording.title.trim().is_empty()
            || recording.version_type.trim().is_empty()
        {
            return Err(ApiError::bad_request(
                "invalid_recording",
                "draft recordings require recordingId, slug, title, and versionType",
            ));
        }

        if recording.artist_name.as_deref() == Some("") {
            return Err(ApiError::bad_request(
                "invalid_recording",
                "recording artistName must not be empty when provided",
            ));
        }

        if recording
            .duration_seconds
            .is_some_and(|duration| duration < 0.0)
        {
            return Err(ApiError::bad_request(
                "invalid_recording",
                "recording durationSeconds must not be negative",
            ));
        }

        if recording.description.as_deref() == Some("") {
            return Err(ApiError::bad_request(
                "invalid_recording",
                "recording description must not be empty when provided",
            ));
        }
    }

    Ok(song)
}

fn draft_release_fields(release_id: &str, document: &Value) -> Result<DraftRelease, ApiError> {
    let release: DraftRelease = serde_json::from_value(document.clone()).map_err(|err| {
        error!(release_id, error = %err, "Draft release payload cannot be parsed");
        ApiError::bad_request("invalid_release", "draft release payload cannot be parsed")
    })?;

    if release.release_id != release_id {
        return Err(ApiError::bad_request(
            "release_id_mismatch",
            "draft release releaseId does not match request releaseId",
        ));
    }

    Ok(release)
}

fn revision_etag(revision: i64) -> String {
    format!("\"rev-{revision}\"")
}

fn timestamp_etag(timestamp: DateTime<Utc>) -> String {
    format!("\"{}\"", timestamp.timestamp_millis())
}

fn parse_revision_etag(value: &str) -> Result<i64, ApiError> {
    let normalized = value
        .trim()
        .trim_start_matches("W/")
        .trim_matches('"')
        .strip_prefix("rev-")
        .ok_or_else(|| {
            ApiError::bad_request(
                "invalid_revision",
                "If-Match must be the revision ETag returned by the endpoint",
            )
        })?
        .parse::<i64>()
        .map_err(|_| {
            ApiError::bad_request(
                "invalid_revision",
                "If-Match must be the revision ETag returned by the endpoint",
            )
        })?;

    Ok(normalized)
}

fn parse_optional_rfc3339(value: Option<&str>) -> Option<DateTime<Utc>> {
    value
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
}

fn parse_required_rfc3339(value: &str) -> Result<DateTime<Utc>, ApiError> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|err| {
            ApiError::bad_request(
                "invalid_published_at",
                format!("publishedAt must be RFC3339: {err}"),
            )
        })
}

fn visibility_value(visibility: Visibility) -> &'static str {
    match visibility {
        Visibility::Public => "public",
        Visibility::Unlisted => "unlisted",
    }
}

fn parse_visibility(value: &str) -> Result<Visibility, ApiError> {
    match value {
        "public" => Ok(Visibility::Public),
        "unlisted" => Ok(Visibility::Unlisted),
        _ => Err(ApiError::internal(
            "invalid_stored_visibility",
            "stored release visibility is invalid",
        )),
    }
}

fn job_status(job: &EncodeJob) -> &'static str {
    match job.status {
        encode_contract::EncodeStatus::Queued => "queued",
        encode_contract::EncodeStatus::Running => "running",
        encode_contract::EncodeStatus::Succeeded => "succeeded",
        encode_contract::EncodeStatus::Failed => "failed",
        encode_contract::EncodeStatus::Canceled => "canceled",
    }
}

fn published_job_id(track: &super::PublishedReleaseTrack) -> Result<&str, ApiError> {
    let hls_path = track.playback.hls.path.as_str();
    hls_path
        .split('/')
        .find(|part| part.starts_with("job_"))
        .ok_or_else(|| {
            ApiError::internal(
                "invalid_published_playback_path",
                "published playback path does not include a job id",
            )
        })
}

fn map_db_read_error(err: sqlx::Error) -> ApiError {
    error!(error = %err, "Database read failed");
    ApiError::internal("db_read_failed", "failed to read catalog metadata")
}

fn map_db_write_error(err: sqlx::Error) -> ApiError {
    if let sqlx::Error::Database(db_err) = &err {
        if db_err.code().as_deref() == Some("23505") {
            return ApiError::new(
                lambda_http::http::StatusCode::CONFLICT,
                "db_unique_conflict",
                "catalog metadata conflicts with an existing record",
            );
        }
    }

    error!(error = %err, "Database write failed");
    ApiError::internal("db_write_failed", "failed to write catalog metadata")
}
