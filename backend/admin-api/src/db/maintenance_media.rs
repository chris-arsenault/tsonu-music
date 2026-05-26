use super::{map_db_read_error, map_db_write_error};
use crate::ApiError;
use encode_contract::recording_files_root_prefix;
use serde_json::Value;
use sqlx::types::Json;
use sqlx::{PgPool, Row};
use std::collections::HashSet;

pub async fn active_media_paths(pool: &PgPool) -> Result<HashSet<String>, ApiError> {
    let mut paths = HashSet::new();

    let song_rows = sqlx::query("SELECT document FROM music_draft_songs")
        .fetch_all(pool)
        .await
        .map_err(map_db_read_error)?;
    for row in song_rows {
        let document = row.get::<Json<Value>, _>("document").0;
        collect_draft_recording_file_paths(&document, &mut paths);
    }

    let playback_rows = sqlx::query("SELECT playback FROM music_published_release_tracks")
        .fetch_all(pool)
        .await
        .map_err(map_db_read_error)?;
    for row in playback_rows {
        let playback = row.get::<Json<Value>, _>("playback").0;
        collect_playback_paths(&playback, &mut paths);
    }

    Ok(paths)
}

pub async fn remove_recording_files_with_prefixes(
    pool: &PgPool,
    prefixes: &[String],
) -> Result<(), ApiError> {
    if prefixes.is_empty() {
        return Ok(());
    }

    sqlx::query(
        "UPDATE music_draft_songs
         SET document = jsonb_set(
                 document,
                 '{recordings}',
                 COALESCE(
                     (
                         SELECT jsonb_agg(
                             CASE WHEN recording ? 'files'
                                 THEN CASE
                                     WHEN filtered.files = '[]'::jsonb
                                         THEN (recording - 'files') - 'durationSeconds'
                                     ELSE jsonb_set(recording, '{files}', filtered.files, true)
                                 END
                                 ELSE recording
                             END
                         )
                         FROM jsonb_array_elements(document->'recordings') AS recording
                         CROSS JOIN LATERAL (
                             SELECT COALESCE(jsonb_agg(file), '[]'::jsonb) AS files
                             FROM jsonb_array_elements(COALESCE(recording->'files', '[]'::jsonb)) AS file
                             WHERE NOT EXISTS (
                                 SELECT 1 FROM unnest($1::text[]) AS prefix
                                 WHERE file->>'path' LIKE prefix || '%'
                             )
                         ) AS filtered
                     ),
                     '[]'::jsonb
                 ),
                 true
             ),
             revision = revision + 1,
             updated_at = now()
         WHERE EXISTS (
             SELECT 1
             FROM jsonb_array_elements(document->'recordings') AS recording,
                  jsonb_array_elements(COALESCE(recording->'files', '[]'::jsonb)) AS file
             WHERE EXISTS (
                 SELECT 1 FROM unnest($1::text[]) AS prefix
                 WHERE file->>'path' LIKE prefix || '%'
             )
         )",
    )
    .bind(prefixes)
    .execute(pool)
    .await
    .map_err(map_db_write_error)?;

    Ok(())
}

fn collect_draft_recording_file_paths(document: &Value, paths: &mut HashSet<String>) {
    for recording in document
        .get("recordings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let recording_id = string_value(recording, "recordingId");
        let expected_prefix = recording_files_root_prefix(&recording_id);
        for file in recording
            .get("files")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            insert_path_with_prefix(paths, file.get("path"), &expected_prefix);
        }
    }
}

fn collect_playback_paths(playback: &Value, paths: &mut HashSet<String>) {
    insert_path(paths, playback.get("hls").and_then(|hls| hls.get("path")));
    for format in playback
        .get("formats")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        insert_path(paths, format.get("path"));
    }
}

fn insert_path(paths: &mut HashSet<String>, value: Option<&Value>) {
    if let Some(path) = value
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
    {
        paths.insert(path.to_string());
    }
}

fn insert_path_with_prefix(paths: &mut HashSet<String>, value: Option<&Value>, prefix: &str) {
    if let Some(path) = value
        .and_then(Value::as_str)
        .filter(|path| path.starts_with(prefix))
    {
        paths.insert(path.to_string());
    }
}

fn string_value(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}
