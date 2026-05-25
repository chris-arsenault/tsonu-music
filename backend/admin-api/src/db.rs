mod analytics;
mod publication;

pub use analytics::*;
pub use publication::*;

use super::{
    draft_release_key, draft_song_key, encode_job_key, ApiError, DraftRelease, DraftSong,
    ObjectList, ObjectSummary, Visibility, WriteResult,
};
use chrono::{DateTime, Utc};
use encode_contract::EncodeJob;
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

pub(super) fn timestamp_etag(timestamp: DateTime<Utc>) -> String {
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

pub(super) fn parse_required_rfc3339(value: &str) -> Result<DateTime<Utc>, ApiError> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|err| {
            ApiError::bad_request(
                "invalid_published_at",
                format!("publishedAt must be RFC3339: {err}"),
            )
        })
}

pub(super) fn visibility_value(visibility: Visibility) -> &'static str {
    match visibility {
        Visibility::Public => "public",
        Visibility::Unlisted => "unlisted",
    }
}

pub(super) fn parse_visibility(value: &str) -> Result<Visibility, ApiError> {
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

pub(super) fn map_db_read_error(err: sqlx::Error) -> ApiError {
    error!(error = %err, "Database read failed");
    ApiError::internal("db_read_failed", "failed to read catalog metadata")
}

pub(super) fn map_db_write_error(err: sqlx::Error) -> ApiError {
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
