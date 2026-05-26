use chrono::{DateTime, Utc};
use encode_contract::{EncodeJob, EncodeStatus, RecordingFileSet};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::types::Json;
use sqlx::{PgPool, Postgres, Transaction};
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

/// Persist the job's current state. When the job has succeeded, also stamp the
/// recording-owned generated files onto the matching `DraftRecording`.
pub async fn upsert_encode_job(pool: &PgPool, job: &EncodeJob) -> Result<(), sqlx::Error> {
    let document = serde_json::to_value(job).map_err(|err| sqlx::Error::Encode(Box::new(err)))?;
    let mut tx = pool.begin().await?;
    upsert_encode_job_document(&mut tx, job, document).await?;
    if let Some(file_set) = RecordingFileSet::from_succeeded_job(job) {
        stamp_recording_files(&mut tx, &job.song_id, &job.recording_id, &file_set).await?;
    }
    tx.commit().await
}

async fn upsert_encode_job_document(
    tx: &mut Transaction<'_, Postgres>,
    job: &EncodeJob,
    document: Value,
) -> Result<(), sqlx::Error> {
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
    .bind(job_status(&job.status))
    .bind(Json(document))
    .bind(parse_optional_rfc3339(Some(&job.requested_at)))
    .bind(parse_optional_rfc3339(job.started_at.as_deref()))
    .bind(parse_optional_rfc3339(job.finished_at.as_deref()))
    .execute(&mut **tx)
    .await?;

    Ok(())
}

/// Patch the generated files of the matching recording inside a draft song's
/// JSONB document. Atomic: no read-modify-write race with admin-api saves.
pub async fn stamp_recording_files(
    tx: &mut Transaction<'_, Postgres>,
    song_id: &str,
    recording_id: &str,
    file_set: &RecordingFileSet,
) -> Result<bool, sqlx::Error> {
    let mut patch = serde_json::Map::new();
    patch.insert(
        "files".to_string(),
        serde_json::to_value(&file_set.files).map_err(|err| sqlx::Error::Encode(Box::new(err)))?,
    );
    if let Some(duration_seconds) = file_set.duration_seconds {
        patch.insert(
            "durationSeconds".to_string(),
            serde_json::to_value(duration_seconds)
                .map_err(|err| sqlx::Error::Encode(Box::new(err)))?,
        );
    }
    let patch_json = Value::Object(patch);
    let result = sqlx::query(
        "UPDATE music_draft_songs
         SET document = jsonb_set(
                 document,
                 '{recordings}',
                 COALESCE(
                     (
                         SELECT jsonb_agg(
                             CASE WHEN recording->>'recordingId' = $2
                                 THEN (recording - 'encodeOutput') || $3::jsonb
                                 ELSE recording
                             END
                         )
                         FROM jsonb_array_elements(document->'recordings') AS recording
                     ),
                     '[]'::jsonb
                 ),
                 true
             ),
             revision = revision + 1,
             updated_at = now()
         WHERE song_id = $1
           AND document->'recordings' @> jsonb_build_array(
               jsonb_build_object('recordingId', $2)
           )",
    )
    .bind(song_id)
    .bind(recording_id)
    .bind(Json(patch_json))
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() > 0)
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
