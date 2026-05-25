use chrono::{DateTime, Utc};
use encode_contract::{EncodeJob, EncodeStatus, RecordingEncodeOutput};
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

/// Persist the job's current state. When the job has succeeded, also stamp
/// the matching `DraftRecording.encodeOutput` so the recording itself
/// becomes the source of truth for "is this publishable?". Both writes
/// happen in a single transaction so publish-readiness can never be
/// silently out of sync with the job status.
pub async fn upsert_encode_job(pool: &PgPool, job: &EncodeJob) -> Result<(), sqlx::Error> {
    let document = serde_json::to_value(job).map_err(|err| sqlx::Error::Encode(Box::new(err)))?;
    let mut tx = pool.begin().await?;
    upsert_encode_job_document(&mut tx, job, document).await?;
    if let Some(output) = RecordingEncodeOutput::from_succeeded_job(job) {
        stamp_recording_encode_output(&mut tx, &job.song_id, &job.recording_id, &output).await?;
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

/// Patch the encodeOutput field of the matching recording inside a
/// draft song's JSONB document. Atomic: no read-modify-write race with
/// admin-api saves. Returns true if a row was updated, false if the
/// song or recording was not found (e.g. user deleted the draft after
/// the encode was queued — logged by the caller, not an error).
pub async fn stamp_recording_encode_output(
    tx: &mut Transaction<'_, Postgres>,
    song_id: &str,
    recording_id: &str,
    output: &RecordingEncodeOutput,
) -> Result<bool, sqlx::Error> {
    let output_json =
        serde_json::to_value(output).map_err(|err| sqlx::Error::Encode(Box::new(err)))?;
    let result = sqlx::query(
        "UPDATE music_draft_songs
         SET document = jsonb_set(
                 document,
                 '{recordings}',
                 COALESCE(
                     (
                         SELECT jsonb_agg(
                             CASE WHEN recording->>'recordingId' = $2
                                 THEN recording || jsonb_build_object('encodeOutput', $3::jsonb)
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
    .bind(Json(output_json))
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
