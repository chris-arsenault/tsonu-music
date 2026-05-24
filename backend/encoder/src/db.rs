use chrono::{DateTime, Utc};
use encode_contract::{EncodeJob, EncodeStatus};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::types::Json;
use sqlx::PgPool;
use std::env;

const DB_POOL_MAX_CONNECTIONS: u32 = 2;

pub async fn connect_pool_from_env() -> Result<PgPool, sqlx::Error> {
    let host = env::var("DB_HOST").expect("DB_HOST required");
    let port = env::var("DB_PORT").unwrap_or_else(|_| "5432".to_string());
    let db_name = env::var("DB_NAME").expect("DB_NAME required");
    let username = env::var("DB_USERNAME").expect("DB_USERNAME required");
    let password = env::var("DB_PASSWORD").expect("DB_PASSWORD required");
    let url = format!("postgres://{username}:{password}@{host}:{port}/{db_name}?sslmode=require");

    PgPoolOptions::new()
        .max_connections(DB_POOL_MAX_CONNECTIONS)
        .connect(&url)
        .await
}

pub async fn upsert_encode_job(pool: &PgPool, job: &EncodeJob) -> Result<(), sqlx::Error> {
    let document = serde_json::to_value(job).map_err(|err| sqlx::Error::Encode(Box::new(err)))?;
    upsert_encode_job_document(pool, job, document).await
}

async fn upsert_encode_job_document(
    pool: &PgPool,
    job: &EncodeJob,
    document: Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO music_encode_jobs
            (job_id, album_id, track_id, status, document, requested_at, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (job_id) DO UPDATE SET
             album_id = EXCLUDED.album_id,
             track_id = EXCLUDED.track_id,
             status = EXCLUDED.status,
             document = EXCLUDED.document,
             requested_at = EXCLUDED.requested_at,
             started_at = EXCLUDED.started_at,
             finished_at = EXCLUDED.finished_at,
             updated_at = now()",
    )
    .bind(&job.job_id)
    .bind(&job.album_id)
    .bind(&job.track_id)
    .bind(job_status(&job.status))
    .bind(Json(document))
    .bind(parse_optional_rfc3339(Some(&job.requested_at)))
    .bind(parse_optional_rfc3339(job.started_at.as_deref()))
    .bind(parse_optional_rfc3339(job.finished_at.as_deref()))
    .execute(pool)
    .await?;

    Ok(())
}

fn parse_optional_rfc3339(value: Option<&str>) -> Option<DateTime<Utc>> {
    value
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
}

fn job_status(status: &EncodeStatus) -> &'static str {
    match status {
        EncodeStatus::Queued => "queued",
        EncodeStatus::Running => "running",
        EncodeStatus::Succeeded => "succeeded",
        EncodeStatus::Failed => "failed",
        EncodeStatus::Canceled => "canceled",
    }
}
