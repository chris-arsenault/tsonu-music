use super::{map_db_read_error, map_db_write_error};
use crate::{
    ratio, ApiError, BackendPlaySummary, BackendReleasePlaySummary, BackendSongPlaySummary,
    RateLimitDecision, RumEventCount, StoredPlayEvent,
};
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};

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
        play_completion_rate: ratio(play_completes, play_starts),
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
