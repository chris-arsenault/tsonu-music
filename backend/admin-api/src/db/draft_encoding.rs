use super::map_db_write_error;
use crate::ApiError;
use sqlx::PgPool;

pub async fn prepare_recording_for_encode(
    pool: &PgPool,
    song_id: &str,
    recording_id: &str,
    job_id: &str,
) -> Result<(), ApiError> {
    let result = sqlx::query(
        "UPDATE music_draft_songs
         SET document = jsonb_set(
                 document,
                 '{recordings}',
                 COALESCE(
                     (
                         SELECT jsonb_agg(
                             CASE WHEN recording->>'recordingId' = $2
                                 THEN (((recording - 'encodeOutput') - 'files') - 'durationSeconds')
                                      || jsonb_build_object(
                                          'encodeJobIds',
                                          CASE
                                              WHEN COALESCE(recording->'encodeJobIds', '[]'::jsonb) @> jsonb_build_array($3::text)
                                                  THEN COALESCE(recording->'encodeJobIds', '[]'::jsonb)
                                              ELSE COALESCE(recording->'encodeJobIds', '[]'::jsonb) || jsonb_build_array($3::text)
                                          END
                                      )
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
    .bind(job_id)
    .execute(pool)
    .await
    .map_err(map_db_write_error)?;

    if result.rows_affected() == 0 {
        return Err(ApiError::not_found(format!(
            "recording not found: {recording_id}"
        )));
    }

    Ok(())
}
