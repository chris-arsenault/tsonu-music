mod analytics;
mod drafts;
mod maintenance;
mod publication;

pub use analytics::*;
pub use drafts::*;
pub use maintenance::*;
pub use publication::*;

use super::{encode_job_key, ApiError, ObjectList, ObjectSummary, Visibility};
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

pub(super) fn timestamp_etag(timestamp: DateTime<Utc>) -> String {
    format!("\"{}\"", timestamp.timestamp_millis())
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
