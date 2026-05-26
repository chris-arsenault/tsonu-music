use super::{map_db_read_error, map_db_write_error};
use crate::{
    ApiError, MaintenanceCleanupCounts, MaintenanceCleanupRequest, MaintenanceCleanupResponse,
    MaintenanceReport, MaintenanceTotals, OrphanReleaseTrack, StaleDraftRecording, StaleEncodeJob,
    StalePublishedSong,
};
use chrono::{DateTime, SecondsFormat, Utc};
use encode_contract::recording_files_root_prefix;
use serde_json::Value;
use sqlx::types::Json;
use sqlx::{PgPool, Row};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
struct RecordingSummary {
    song_id: String,
    song_title: String,
    recording_id: String,
    recording_title: String,
    has_source_master: bool,
    file_count: usize,
    encode_job_ids: HashSet<String>,
}

#[derive(Debug)]
struct DraftSnapshot {
    known_song_ids: HashSet<String>,
    recordings: HashMap<(String, String), RecordingSummary>,
    stale_draft_recordings: Vec<StaleDraftRecording>,
    orphan_release_tracks: Vec<OrphanReleaseTrack>,
}

pub async fn maintenance_report(pool: &PgPool) -> Result<MaintenanceReport, ApiError> {
    let snapshot = draft_snapshot(pool).await?;
    let stale_encode_jobs =
        stale_encode_jobs(pool, &snapshot.known_song_ids, &snapshot.recordings).await?;
    let stale_published_songs = stale_published_songs(pool).await?;
    let totals = MaintenanceTotals {
        stale_draft_recordings: snapshot.stale_draft_recordings.len(),
        orphan_release_tracks: snapshot.orphan_release_tracks.len(),
        stale_encode_jobs: stale_encode_jobs.len(),
        stale_media_prefixes: 0,
        stale_published_songs: stale_published_songs.len(),
    };

    Ok(MaintenanceReport {
        generated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        stale_draft_recordings: snapshot.stale_draft_recordings,
        orphan_release_tracks: snapshot.orphan_release_tracks,
        stale_encode_jobs,
        stale_media_prefixes: Vec::new(),
        stale_published_songs,
        totals,
    })
}

pub async fn cleanup_maintenance(
    pool: &PgPool,
    request: MaintenanceCleanupRequest,
) -> Result<MaintenanceCleanupResponse, ApiError> {
    let report = maintenance_report(pool).await?;
    validate_cleanup_request(&request, &report)?;

    let mut tx = pool.begin().await.map_err(map_db_write_error)?;
    let mut deleted = MaintenanceCleanupCounts::default();

    let draft_recordings = dedupe(request.draft_recordings);
    for target in &draft_recordings {
        let result = sqlx::query(
            "UPDATE music_draft_songs
             SET document = jsonb_set(
                     document,
                     '{recordings}',
                     COALESCE(
                         (
                             SELECT jsonb_agg(recording)
                             FROM jsonb_array_elements(document->'recordings') AS recording
                             WHERE recording->>'recordingId' <> $2
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
        .bind(&target.song_id)
        .bind(&target.recording_id)
        .execute(&mut *tx)
        .await
        .map_err(map_db_write_error)?;
        if result.rows_affected() > 0 {
            deleted.draft_recordings += 1;
        }
    }

    let release_tracks = dedupe(request.release_tracks);
    for target in &release_tracks {
        let result = sqlx::query(
            "UPDATE music_draft_releases
             SET document = jsonb_set(
                     document,
                     '{tracks}',
                     COALESCE(
                         (
                             SELECT jsonb_agg(track)
                             FROM jsonb_array_elements(document->'tracks') AS track
                             WHERE track->>'trackId' <> $2
                         ),
                         '[]'::jsonb
                     ),
                     true
                 ),
                 revision = revision + 1,
                 updated_at = now()
             WHERE release_id = $1
               AND document->'tracks' @> jsonb_build_array(
                   jsonb_build_object('trackId', $2)
               )",
        )
        .bind(&target.release_id)
        .bind(&target.track_id)
        .execute(&mut *tx)
        .await
        .map_err(map_db_write_error)?;
        if result.rows_affected() > 0 {
            deleted.release_tracks += 1;
        }
    }

    let encode_job_ids = dedupe(request.encode_job_ids);
    if !encode_job_ids.is_empty() {
        sqlx::query(
            "UPDATE music_draft_songs
             SET document = jsonb_set(
                     document,
                     '{recordings}',
                     COALESCE(
                         (
                             SELECT jsonb_agg(
                                 CASE WHEN recording ? 'encodeJobIds'
                                     THEN recording || jsonb_build_object(
                                         'encodeJobIds',
                                         COALESCE(
                                             (
                                                 SELECT jsonb_agg(job_id)
                                                 FROM jsonb_array_elements_text(recording->'encodeJobIds') AS job_id
                                                 WHERE NOT job_id = ANY($1)
                                             ),
                                             '[]'::jsonb
                                         )
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
             WHERE EXISTS (
                 SELECT 1
                 FROM jsonb_array_elements(document->'recordings') AS recording,
                      jsonb_array_elements_text(COALESCE(recording->'encodeJobIds', '[]'::jsonb)) AS job_id
                 WHERE job_id = ANY($1)
             )",
        )
        .bind(&encode_job_ids)
        .execute(&mut *tx)
        .await
        .map_err(map_db_write_error)?;

        let result = sqlx::query("DELETE FROM music_encode_jobs WHERE job_id = ANY($1)")
            .bind(&encode_job_ids)
            .execute(&mut *tx)
            .await
            .map_err(map_db_write_error)?;
        deleted.encode_jobs = result.rows_affected() as usize;
    }

    let published_song_ids = dedupe(request.published_song_ids);
    if !published_song_ids.is_empty() {
        let result = sqlx::query(
            "DELETE FROM music_published_songs s
             WHERE s.song_id = ANY($1)
               AND NOT EXISTS (
                   SELECT 1
                   FROM music_published_release_tracks t
                   WHERE t.song_id = s.song_id
               )",
        )
        .bind(&published_song_ids)
        .execute(&mut *tx)
        .await
        .map_err(map_db_write_error)?;
        deleted.published_songs = result.rows_affected() as usize;
    }

    tx.commit().await.map_err(map_db_write_error)?;
    let report = maintenance_report(pool).await?;
    Ok(MaintenanceCleanupResponse { deleted, report })
}

fn validate_cleanup_request(
    request: &MaintenanceCleanupRequest,
    report: &MaintenanceReport,
) -> Result<(), ApiError> {
    let allowed_recordings = report
        .stale_draft_recordings
        .iter()
        .map(|item| (item.song_id.as_str(), item.recording_id.as_str()))
        .collect::<HashSet<_>>();
    for target in &request.draft_recordings {
        if !allowed_recordings.contains(&(target.song_id.as_str(), target.recording_id.as_str())) {
            return Err(ApiError::bad_request(
                "invalid_cleanup_target",
                format!(
                    "recording {} on {} is not currently a stale cleanup candidate",
                    target.recording_id, target.song_id
                ),
            ));
        }
    }

    let allowed_tracks = report
        .orphan_release_tracks
        .iter()
        .map(|item| (item.release_id.as_str(), item.track_id.as_str()))
        .collect::<HashSet<_>>();
    for target in &request.release_tracks {
        if !allowed_tracks.contains(&(target.release_id.as_str(), target.track_id.as_str())) {
            return Err(ApiError::bad_request(
                "invalid_cleanup_target",
                format!(
                    "track {} on {} is not currently an orphan cleanup candidate",
                    target.track_id, target.release_id
                ),
            ));
        }
    }

    let allowed_jobs = report
        .stale_encode_jobs
        .iter()
        .map(|item| item.job_id.as_str())
        .collect::<HashSet<_>>();
    for job_id in &request.encode_job_ids {
        if !allowed_jobs.contains(job_id.as_str()) {
            return Err(ApiError::bad_request(
                "invalid_cleanup_target",
                format!("job {job_id} is not currently a stale cleanup candidate"),
            ));
        }
    }

    let allowed_songs = report
        .stale_published_songs
        .iter()
        .map(|item| item.song_id.as_str())
        .collect::<HashSet<_>>();
    for song_id in &request.published_song_ids {
        if !allowed_songs.contains(song_id.as_str()) {
            return Err(ApiError::bad_request(
                "invalid_cleanup_target",
                format!("published song {song_id} is not currently a stale cleanup candidate"),
            ));
        }
    }

    Ok(())
}

async fn draft_snapshot(pool: &PgPool) -> Result<DraftSnapshot, ApiError> {
    let song_rows = sqlx::query(
        "SELECT song_id, title, document
         FROM music_draft_songs
         ORDER BY title ASC, song_id ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_read_error)?;

    let mut recordings = HashMap::new();
    let mut known_song_ids = HashSet::new();
    for row in song_rows {
        let song_id: String = row.get("song_id");
        let song_title: String = row.get("title");
        known_song_ids.insert(song_id.clone());
        let document = row.get::<Json<Value>, _>("document").0;
        for recording in document
            .get("recordings")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let recording_id = string_value(recording, "recordingId");
            if recording_id.is_empty() {
                continue;
            }
            let recording_title = string_value(recording, "title");
            let files = recording
                .get("files")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let encode_job_ids = recording
                .get("encodeJobIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<HashSet<_>>();
            recordings.insert(
                (song_id.clone(), recording_id.clone()),
                RecordingSummary {
                    song_id: song_id.clone(),
                    song_title: song_title.clone(),
                    recording_id,
                    recording_title,
                    has_source_master: recording
                        .get("sourceMaster")
                        .is_some_and(|value| !value.is_null()),
                    file_count: files,
                    encode_job_ids,
                },
            );
        }
    }

    let release_rows = sqlx::query(
        "SELECT release_id, title, document
         FROM music_draft_releases
         ORDER BY title ASC, release_id ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_read_error)?;

    let mut referenced_recordings = HashSet::new();
    let mut orphan_release_tracks = Vec::new();
    for row in release_rows {
        let release_id: String = row.get("release_id");
        let release_title: String = row.get("title");
        let document = row.get::<Json<Value>, _>("document").0;
        for track in document
            .get("tracks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let track_id = string_value(track, "trackId");
            let track_title = string_value(track, "title");
            let song_id = string_value(track, "songId");
            let recording_id = string_value(track, "recordingId");
            if !song_id.is_empty() && !recording_id.is_empty() {
                referenced_recordings.insert((song_id.clone(), recording_id.clone()));
            }

            let song_exists = known_song_ids.contains(&song_id);
            let recording_exists =
                recordings.contains_key(&(song_id.clone(), recording_id.clone()));
            let reason = if !song_exists {
                Some("missing_draft_song")
            } else if !recording_exists {
                Some("missing_recording")
            } else {
                None
            };
            if let Some(reason) = reason {
                orphan_release_tracks.push(OrphanReleaseTrack {
                    release_id: release_id.clone(),
                    release_title: release_title.clone(),
                    track_id,
                    track_title,
                    song_id,
                    recording_id,
                    reason: reason.to_string(),
                });
            }
        }
    }

    let mut stale_draft_recordings = recordings
        .values()
        .filter(|recording| {
            !referenced_recordings
                .contains(&(recording.song_id.clone(), recording.recording_id.clone()))
                && !recording.has_source_master
                && recording.file_count == 0
                && recording.encode_job_ids.is_empty()
        })
        .map(|recording| StaleDraftRecording {
            song_id: recording.song_id.clone(),
            song_title: recording.song_title.clone(),
            recording_id: recording.recording_id.clone(),
            recording_title: recording.recording_title.clone(),
            reason: "unreferenced_empty_recording".to_string(),
        })
        .collect::<Vec<_>>();
    stale_draft_recordings.sort_by(|left, right| {
        left.song_title
            .cmp(&right.song_title)
            .then(left.recording_title.cmp(&right.recording_title))
            .then(left.recording_id.cmp(&right.recording_id))
    });
    orphan_release_tracks.sort_by(|left, right| {
        left.release_title
            .cmp(&right.release_title)
            .then(left.track_title.cmp(&right.track_title))
            .then(left.track_id.cmp(&right.track_id))
    });

    Ok(DraftSnapshot {
        known_song_ids,
        recordings,
        stale_draft_recordings,
        orphan_release_tracks,
    })
}

async fn stale_encode_jobs(
    pool: &PgPool,
    known_song_ids: &HashSet<String>,
    recordings: &HashMap<(String, String), RecordingSummary>,
) -> Result<Vec<StaleEncodeJob>, ApiError> {
    let rows = sqlx::query(
        "SELECT job_id, song_id, recording_id, status, requested_at, finished_at, document
         FROM music_encode_jobs
         ORDER BY updated_at DESC, job_id ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_read_error)?;

    let mut jobs = Vec::new();
    for row in rows {
        let job_id: String = row.get("job_id");
        let song_id: String = row.get("song_id");
        let recording_id: String = row.get("recording_id");
        let status: String = row.get("status");
        let document = row.get::<Json<Value>, _>("document").0;
        let recording = recordings.get(&(song_id.clone(), recording_id.clone()));
        let reason = if !known_song_ids.contains(&song_id) {
            Some("missing_draft_song")
        } else if recording.is_none() {
            Some("missing_recording")
        } else if recording.is_some_and(|value| !value.encode_job_ids.contains(&job_id)) {
            Some("not_linked_to_recording")
        } else if matches!(status.as_str(), "failed" | "canceled") {
            Some("terminal_unsuccessful_job")
        } else if status == "succeeded" && !job_uses_recording_files(&document, &recording_id) {
            Some("legacy_encode_output")
        } else {
            None
        };

        if let Some(reason) = reason {
            jobs.push(StaleEncodeJob {
                job_id,
                song_id,
                recording_id,
                status,
                requested_at: row
                    .get::<Option<DateTime<Utc>>, _>("requested_at")
                    .map(|value| value.to_rfc3339_opts(SecondsFormat::Secs, true)),
                finished_at: row
                    .get::<Option<DateTime<Utc>>, _>("finished_at")
                    .map(|value| value.to_rfc3339_opts(SecondsFormat::Secs, true)),
                reason: reason.to_string(),
            });
        }
    }

    Ok(jobs)
}

async fn stale_published_songs(pool: &PgPool) -> Result<Vec<StalePublishedSong>, ApiError> {
    let rows = sqlx::query(
        "SELECT s.song_id, s.slug, s.title
         FROM music_published_songs s
         LEFT JOIN music_published_release_tracks t ON t.song_id = s.song_id
         WHERE t.song_id IS NULL
         ORDER BY s.title ASC, s.song_id ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_read_error)?;

    Ok(rows
        .into_iter()
        .map(|row| StalePublishedSong {
            song_id: row.get("song_id"),
            slug: row.get("slug"),
            title: row.get("title"),
            reason: "published_song_without_tracks".to_string(),
        })
        .collect())
}

fn job_uses_recording_files(document: &Value, recording_id: &str) -> bool {
    document
        .get("output")
        .and_then(|output| output.get("prefix"))
        .and_then(Value::as_str)
        .is_some_and(|prefix| prefix.starts_with(&recording_files_root_prefix(recording_id)))
}

fn string_value(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn dedupe<T>(items: Vec<T>) -> Vec<T>
where
    T: Clone + Eq + std::hash::Hash,
{
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for item in items {
        if seen.insert(item.clone()) {
            deduped.push(item);
        }
    }
    deduped
}
