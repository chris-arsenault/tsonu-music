use super::{map_db_read_error, map_db_write_error, DbJsonObject};
use crate::{
    draft_release_key, draft_song_key, ApiError, DraftRelease, DraftSong, ObjectList,
    ObjectSummary, WriteResult,
};
use encode_contract::RecordingFileSet;
use serde_json::Value;
use sqlx::types::Json;
use sqlx::{PgPool, Row};
use tracing::{error, warn};

pub async fn get_draft_song(pool: &PgPool, song_id: &str) -> Result<DbJsonObject, ApiError> {
    let object = get_json_object(
        pool,
        "SELECT document::text AS document, revision FROM music_draft_songs WHERE song_id = $1",
        song_id,
        || ApiError::not_found(format!("draft song not found: {song_id}")),
    )
    .await?;

    // Backfill: any recording with encodeJobIds but no files predates the
    // recording-file model. Look up the most recent succeeded job for that
    // recording, stamp files back onto the recording, and return the freshly
    // patched document.
    let Some(patched) = backfill_recording_files(pool, song_id, &object.text).await? else {
        return Ok(object);
    };
    Ok(patched)
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

pub async fn create_draft_song(
    pool: &PgPool,
    song_id: &str,
    document: &Value,
) -> Result<WriteResult, ApiError> {
    let song = draft_song_fields(song_id, document)?;
    let revision = sqlx::query(
        "INSERT INTO music_draft_songs (song_id, slug, title, document)
         VALUES ($1, $2, $3, $4)
         RETURNING revision",
    )
    .bind(song_id)
    .bind(&song.slug)
    .bind(&song.title)
    .bind(Json(document.clone()))
    .fetch_one(pool)
    .await
    .map_err(map_db_write_error)?
    .get("revision");

    Ok(WriteResult {
        bucket: "rds".to_string(),
        key: draft_song_key(song_id),
        e_tag: Some(revision_etag(revision)),
        version_id: None,
    })
}

pub async fn update_draft_song(
    pool: &PgPool,
    song_id: &str,
    document: &Value,
) -> Result<WriteResult, ApiError> {
    let song = draft_song_fields(song_id, document)?;
    let row = sqlx::query(
        "UPDATE music_draft_songs
         SET slug = $2,
             title = $3,
             document = $4,
             revision = revision + 1,
             updated_at = now()
         WHERE song_id = $1
         RETURNING revision",
    )
    .bind(song_id)
    .bind(&song.slug)
    .bind(&song.title)
    .bind(Json(document.clone()))
    .fetch_optional(pool)
    .await
    .map_err(map_db_write_error)?
    .ok_or_else(|| ApiError::not_found(format!("draft song not found: {song_id}")))?;

    Ok(WriteResult {
        bucket: "rds".to_string(),
        key: draft_song_key(song_id),
        e_tag: Some(revision_etag(row.get("revision"))),
        version_id: None,
    })
}

pub async fn delete_draft_song(pool: &PgPool, song_id: &str) -> Result<(), ApiError> {
    let result = sqlx::query("DELETE FROM music_draft_songs WHERE song_id = $1")
        .bind(song_id)
        .execute(pool)
        .await
        .map_err(map_db_write_error)?;

    if result.rows_affected() == 0 {
        return Err(ApiError::not_found(format!(
            "draft song not found: {song_id}"
        )));
    }

    Ok(())
}

pub async fn create_draft_release(
    pool: &PgPool,
    release_id: &str,
    document: &Value,
) -> Result<WriteResult, ApiError> {
    let release = draft_release_fields(release_id, document)?;
    let revision = sqlx::query(
        "INSERT INTO music_draft_releases
            (release_id, slug, title, release_kind, release_status, release_date, publish_state, document)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
    .fetch_one(pool)
    .await
    .map_err(map_db_write_error)?
    .get("revision");

    Ok(WriteResult {
        bucket: "rds".to_string(),
        key: draft_release_key(release_id),
        e_tag: Some(revision_etag(revision)),
        version_id: None,
    })
}

pub async fn update_draft_release(
    pool: &PgPool,
    release_id: &str,
    document: &Value,
) -> Result<WriteResult, ApiError> {
    let release = draft_release_fields(release_id, document)?;
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
         WHERE release_id = $1
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
    .map_err(map_db_write_error)?
    .ok_or_else(|| ApiError::not_found(format!("draft release not found: {release_id}")))?;

    Ok(WriteResult {
        bucket: "rds".to_string(),
        key: draft_release_key(release_id),
        e_tag: Some(revision_etag(row.get("revision"))),
        version_id: None,
    })
}

pub async fn delete_draft_release(pool: &PgPool, release_id: &str) -> Result<(), ApiError> {
    let result = sqlx::query("DELETE FROM music_draft_releases WHERE release_id = $1")
        .bind(release_id)
        .execute(pool)
        .await
        .map_err(map_db_write_error)?;

    if result.rows_affected() == 0 {
        return Err(ApiError::not_found(format!(
            "draft release not found: {release_id}"
        )));
    }

    Ok(())
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

/// For each recording on the song that has `encodeJobIds` but no `files`,
/// resolve the latest succeeded job from `music_encode_jobs` and stamp
/// recording-owned files onto the recording.
async fn backfill_recording_files(
    pool: &PgPool,
    song_id: &str,
    document_text: &str,
) -> Result<Option<DbJsonObject>, ApiError> {
    let parsed: DraftSong = match serde_json::from_str(document_text) {
        Ok(value) => value,
        Err(_) => return Ok(None), // get_draft_song's own validation will surface this
    };

    let candidates: Vec<(String, Vec<String>)> = parsed
        .recordings
        .iter()
        .filter(|recording| recording.files.is_empty() && !recording.encode_job_ids.is_empty())
        .map(|recording| {
            (
                recording.recording_id.clone(),
                recording.encode_job_ids.clone(),
            )
        })
        .collect();

    if candidates.is_empty() {
        return Ok(None);
    }

    let mut file_sets: Vec<(String, RecordingFileSet)> = Vec::new();
    for (recording_id, job_ids) in candidates {
        // Walk from most-recently-appended back; the first succeeded job wins.
        for job_id in job_ids.into_iter().rev() {
            match super::get_encode_job(pool, &job_id).await {
                Ok(job) => {
                    if job.recording_id != recording_id {
                        continue;
                    }
                    if let Some(file_set) = RecordingFileSet::from_succeeded_job(&job) {
                        file_sets.push((recording_id, file_set));
                        break;
                    }
                }
                Err(api_err) => {
                    if api_err.status == lambda_http::http::StatusCode::NOT_FOUND {
                        continue;
                    }
                    warn!(
                        song_id,
                        recording_id,
                        job_id,
                        message = %api_err.message,
                        "Failed to load encode job during backfill"
                    );
                    continue;
                }
            }
        }
    }

    if file_sets.is_empty() {
        return Ok(None);
    }

    let updated_revision = apply_recording_files(pool, song_id, &file_sets).await?;

    let Some(refreshed) = sqlx::query(
        "SELECT document::text AS document, revision FROM music_draft_songs WHERE song_id = $1",
    )
    .bind(song_id)
    .fetch_optional(pool)
    .await
    .map_err(map_db_read_error)?
    else {
        return Ok(None);
    };

    tracing::info!(
        song_id,
        stamped = file_sets.len(),
        revision = updated_revision,
        "Backfilled missing recording.files from succeeded jobs"
    );

    Ok(Some(DbJsonObject {
        text: refreshed.get::<String, _>("document"),
        e_tag: Some(revision_etag(refreshed.get::<i64, _>("revision"))),
    }))
}

async fn apply_recording_files(
    pool: &PgPool,
    song_id: &str,
    file_sets: &[(String, RecordingFileSet)],
) -> Result<i64, ApiError> {
    let mut tx = pool.begin().await.map_err(map_db_write_error)?;
    for (recording_id, file_set) in file_sets {
        let mut patch = serde_json::Map::new();
        patch.insert(
            "files".to_string(),
            serde_json::to_value(&file_set.files)
                .map_err(|err| sqlx::Error::Encode(Box::new(err)))
                .map_err(map_db_write_error)?,
        );
        if let Some(duration_seconds) = file_set.duration_seconds {
            patch.insert(
                "durationSeconds".to_string(),
                serde_json::to_value(duration_seconds)
                    .map_err(|err| sqlx::Error::Encode(Box::new(err)))
                    .map_err(map_db_write_error)?,
            );
        }
        let patch_json = Value::Object(patch);

        sqlx::query(
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
        .execute(&mut *tx)
        .await
        .map_err(map_db_write_error)?;
    }
    let revision: i64 = sqlx::query("SELECT revision FROM music_draft_songs WHERE song_id = $1")
        .bind(song_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(map_db_read_error)?
        .get("revision");
    tx.commit().await.map_err(map_db_write_error)?;
    Ok(revision)
}
