use crate::{
    header_str, validate_optional_path, validate_optional_seconds, validate_optional_short_text,
    validate_optional_stable_id, validate_optional_url_origin, validate_session_id,
    validate_stable_id, ApiError, BackendPlaySummary, PlayEventRequest, RumAggregate,
    RumDimensionSummary, RumEventCount, RumPageSummary, RumRecentError, RumReleaseSummary,
    RumSiteSession, RumStandardSummary, RumSummaryQuery, RumSummaryResponse, RumTrackAggregate,
    RumTrackSummary,
};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use lambda_http::http::HeaderMap;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

pub(crate) const DEFAULT_RUM_SUMMARY_HOURS: u32 = 24;
pub(crate) const MAX_RUM_SUMMARY_HOURS: u32 = 720;
pub(crate) const MAX_RUM_QUERY_RESULTS: i32 = 10_000;
pub(crate) const RUM_QUERY_POLL_ATTEMPTS: usize = 12;
pub(crate) const RUM_QUERY_POLL_INTERVAL: Duration = Duration::from_millis(500);
pub(crate) const ANALYTICS_RATE_LIMIT_WINDOW_SECONDS: i64 = 60;
pub(crate) const ANALYTICS_RATE_LIMIT_MAX_REQUESTS: i32 = 120;
pub(crate) const MAX_ANALYTICS_EVENT_AGE_HOURS: i64 = 24;
pub(crate) const MAX_ANALYTICS_EVENT_FUTURE_SECONDS: i64 = 300;
pub(crate) const PLAYER_RUM_EVENT_NAMES: &[&str] = &[
    "release_view",
    "track_impression",
    "play_start",
    "play_pause",
    "play_seek",
    "play_progress_25",
    "play_progress_50",
    "play_progress_75",
    "play_complete",
    "quality_changed",
    "play_error",
];
pub(crate) const SITE_RUM_EVENT_NAMES: &[&str] = &["site_visit", "page_view"];
pub(crate) const STANDARD_RUM_EVENT_NAMES: &[&str] = &[
    "com.amazon.rum.page_view_event",
    "com.amazon.rum.performance_navigation_event",
    "com.amazon.rum.js_error_event",
    "com.amazon.rum.http_event",
];
pub(crate) const ENGAGED_SITE_EVENT_NAMES: &[&str] = &[
    "play_start",
    "play_pause",
    "play_seek",
    "play_progress_25",
    "play_progress_50",
    "play_progress_75",
    "play_complete",
    "quality_changed",
    "play_error",
];

pub(crate) fn parse_rum_summary_query(query: Option<&str>) -> Result<RumSummaryQuery, ApiError> {
    let mut hours = DEFAULT_RUM_SUMMARY_HOURS;
    for pair in query.unwrap_or_default().split('&') {
        if pair.is_empty() {
            continue;
        }

        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if name != "hours" {
            continue;
        }

        hours = value.parse::<u32>().map_err(|_| {
            ApiError::bad_request("invalid_hours", "hours must be a positive integer")
        })?;
    }

    if !(1..=MAX_RUM_SUMMARY_HOURS).contains(&hours) {
        return Err(ApiError::bad_request(
            "invalid_hours",
            format!("hours must be between 1 and {MAX_RUM_SUMMARY_HOURS}"),
        ));
    }

    Ok(RumSummaryQuery { hours })
}

pub(crate) fn validate_play_event_request(request: &PlayEventRequest) -> Result<(), ApiError> {
    if !matches!(
        request.event_type.as_str(),
        "play_start" | "play_10s" | "play_25" | "play_complete"
    ) {
        return Err(ApiError::bad_request(
            "invalid_event_type",
            "eventType must be play_start, play_10s, play_25, or play_complete",
        ));
    }

    validate_stable_id("release", &request.release_id, "releaseId")?;
    validate_stable_id("track", &request.track_id, "trackId")?;
    validate_stable_id("song", &request.song_id, "songId")?;
    validate_stable_id("recording", &request.recording_id, "recordingId")?;
    validate_session_id(&request.site_session_id, "siteSessionId")?;
    validate_session_id(&request.playback_session_id, "playbackSessionId")?;
    validate_optional_stable_id("asset", request.asset_id.as_deref(), "assetId")?;
    validate_optional_short_text(request.selected_quality.as_deref(), "selectedQuality", 64)?;
    validate_optional_path(request.page_path.as_deref(), "pagePath")?;
    validate_optional_url_origin(request.referrer_origin.as_deref(), "referrerOrigin")?;
    validate_optional_short_text(request.referrer_host.as_deref(), "referrerHost", 253)?;
    validate_optional_seconds(request.position_seconds, "positionSeconds")?;
    validate_optional_seconds(request.duration_seconds, "durationSeconds")?;

    Ok(())
}

pub(crate) fn parse_play_event_time(value: Option<&str>) -> Result<DateTime<Utc>, ApiError> {
    let Some(value) = value else {
        return Ok(Utc::now());
    };

    let occurred_at = DateTime::parse_from_rfc3339(value)
        .map_err(|_| ApiError::bad_request("invalid_occurred_at", "occurredAt must be RFC3339"))?
        .with_timezone(&Utc);
    let now = Utc::now();
    if occurred_at < now - ChronoDuration::hours(MAX_ANALYTICS_EVENT_AGE_HOURS) {
        return Err(ApiError::bad_request(
            "stale_event",
            "analytics event is too old",
        ));
    }
    if occurred_at > now + ChronoDuration::seconds(MAX_ANALYTICS_EVENT_FUTURE_SECONDS) {
        return Err(ApiError::bad_request(
            "future_event",
            "analytics event timestamp is too far in the future",
        ));
    }

    Ok(occurred_at)
}

pub(crate) fn backend_play_dedupe_key(request: &PlayEventRequest) -> String {
    hash_hex(&format!(
        "play:v1:{}:{}:{}:{}:{}:{}",
        request.site_session_id,
        request.event_type,
        request.release_id,
        request.track_id,
        request.song_id,
        request.recording_id
    ))
}

pub(crate) fn analytics_rate_limit_key(headers: &HeaderMap, site_session_id: &str) -> String {
    let origin = header_str(headers, "origin").unwrap_or("-");
    let forwarded_for = header_str(headers, "x-forwarded-for")
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("-");
    let user_agent = header_str(headers, "user-agent").unwrap_or("-");

    hash_hex(&format!(
        "analytics-rate:v1:{origin}:{forwarded_for}:{user_agent}:{site_session_id}"
    ))
}

fn hash_hex(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn build_player_rum_query() -> String {
    let event_names = PLAYER_RUM_EVENT_NAMES
        .iter()
        .chain(SITE_RUM_EVENT_NAMES)
        .chain(STANDARD_RUM_EVENT_NAMES)
        .map(|event_name| format!("\"{event_name}\""))
        .collect::<Vec<_>>()
        .join(", ");

    format!(
        "fields @timestamp, event_type, event_details.releaseId as releaseId, event_details.songId as songId, event_details.recordingId as recordingId, event_details.trackId as trackId, event_details.siteSessionId as siteSessionId, event_details.playbackSessionId as playbackSessionId, event_details.selectedQuality as selectedQuality, event_details.errorName as errorName, event_details.errorMessage as errorMessage, event_details.pagePath as pagePath, event_details.previousPagePath as previousPagePath, event_details.landingPagePath as landingPagePath, event_details.referrerOrigin as referrerOrigin, event_details.referrerHost as referrerHost, event_details.pageTitle as pageTitle, event_details.utmSource as utmSource, event_details.utmMedium as utmMedium, event_details.utmCampaign as utmCampaign, metadata.pageId as rumPageId, metadata.pageTitle as rumPageTitle, metadata.browserName as browserName, metadata.deviceType as deviceType, metadata.osName as osName, metadata.countryCode as countryCode | filter event_type in [{event_names}] | sort @timestamp desc | limit {MAX_RUM_QUERY_RESULTS}"
    )
}

pub(crate) fn build_rum_summary(
    log_group_name: &str,
    query_id: &str,
    window_hours: u32,
    start_time: String,
    end_time: String,
    rows: Vec<HashMap<String, String>>,
) -> RumSummaryResponse {
    let mut event_counts = HashMap::<String, u64>::new();
    let mut standard_counts = HashMap::<String, u64>::new();
    let mut release_counts = HashMap::<String, RumAggregate>::new();
    let mut track_counts = HashMap::<String, RumTrackAggregate>::new();
    let mut site_sessions = HashMap::<String, RumSiteSession>::new();
    let mut page_counts = HashMap::<String, u64>::new();
    let mut referrer_counts = HashMap::<String, u64>::new();
    let mut browser_counts = HashMap::<String, u64>::new();
    let mut device_counts = HashMap::<String, u64>::new();
    let mut country_counts = HashMap::<String, u64>::new();
    let mut playback_sessions = HashSet::<String>::new();
    let mut recent_errors = Vec::<RumRecentError>::new();

    for row in &rows {
        let Some(event_type) = query_row_value(row, "event_type") else {
            continue;
        };

        if STANDARD_RUM_EVENT_NAMES.contains(&event_type) {
            *standard_counts.entry(event_type.to_string()).or_default() += 1;
            increment_dimension(&mut browser_counts, query_row_value(row, "browserName"));
            increment_dimension(&mut device_counts, query_row_value(row, "deviceType"));
            increment_dimension(&mut country_counts, query_row_value(row, "countryCode"));
        }

        if !(PLAYER_RUM_EVENT_NAMES.contains(&event_type)
            || SITE_RUM_EVENT_NAMES.contains(&event_type)
            || STANDARD_RUM_EVENT_NAMES.contains(&event_type))
        {
            continue;
        }

        if SITE_RUM_EVENT_NAMES.contains(&event_type) {
            let session_id = query_row_value(row, "siteSessionId")
                .or_else(|| query_row_value(row, "playbackSessionId"));
            if let Some(session_id) = session_id {
                let session = site_sessions.entry(session_id.to_string()).or_default();
                session.record(row, event_type);
            }

            if event_type == "site_visit" {
                let referrer = traffic_source(row);
                *referrer_counts.entry(referrer).or_default() += 1;
            }

            if event_type == "page_view" {
                let page_path = query_row_value(row, "pagePath")
                    .or_else(|| query_row_value(row, "rumPageId"))
                    .unwrap_or("/");
                *page_counts.entry(page_path.to_string()).or_default() += 1;
            }
        }

        if PLAYER_RUM_EVENT_NAMES.contains(&event_type) {
            *event_counts.entry(event_type.to_string()).or_default() += 1;

            if let Some(session_id) = query_row_value(row, "playbackSessionId") {
                playback_sessions.insert(session_id.to_string());
            }

            if ENGAGED_SITE_EVENT_NAMES.contains(&event_type) {
                if let Some(session_id) = query_row_value(row, "siteSessionId") {
                    site_sessions
                        .entry(session_id.to_string())
                        .or_default()
                        .record_engagement();
                }
            }

            if let Some(release_id) = query_row_value(row, "releaseId") {
                release_counts
                    .entry(release_id.to_string())
                    .or_default()
                    .record(event_type);

                if let Some(track_id) = query_row_value(row, "trackId") {
                    let track_key = format!("{release_id}/{track_id}");
                    track_counts
                        .entry(track_key)
                        .or_insert_with(|| RumTrackAggregate {
                            release_id: release_id.to_string(),
                            track_id: track_id.to_string(),
                            song_id: query_row_value(row, "songId").map(str::to_string),
                            recording_id: query_row_value(row, "recordingId").map(str::to_string),
                            counts: RumAggregate::default(),
                        })
                        .counts
                        .record(event_type);
                }
            }

            if event_type == "play_error" && recent_errors.len() < 10 {
                recent_errors.push(RumRecentError {
                    timestamp: query_row_value(row, "@timestamp").map(str::to_string),
                    release_id: query_row_value(row, "releaseId").map(str::to_string),
                    song_id: query_row_value(row, "songId").map(str::to_string),
                    recording_id: query_row_value(row, "recordingId").map(str::to_string),
                    track_id: query_row_value(row, "trackId").map(str::to_string),
                    error_name: query_row_value(row, "errorName").map(str::to_string),
                    error_message: query_row_value(row, "errorMessage").map(str::to_string),
                });
            }
        }
    }

    let mut releases = release_counts
        .into_iter()
        .map(|(release_id, counts)| RumReleaseSummary {
            release_id,
            total_events: counts.total_events,
            play_starts: counts.play_starts,
            play_completes: counts.play_completes,
            player_errors: counts.player_errors,
        })
        .collect::<Vec<_>>();
    releases.sort_by(|left, right| {
        right
            .total_events
            .cmp(&left.total_events)
            .then_with(|| left.release_id.cmp(&right.release_id))
    });

    let mut tracks = track_counts
        .into_values()
        .map(|track| RumTrackSummary {
            release_id: track.release_id,
            track_id: track.track_id,
            song_id: track.song_id,
            recording_id: track.recording_id,
            total_events: track.counts.total_events,
            play_starts: track.counts.play_starts,
            play_completes: track.counts.play_completes,
            player_errors: track.counts.player_errors,
        })
        .collect::<Vec<_>>();
    tracks.sort_by(|left, right| {
        right
            .play_starts
            .cmp(&left.play_starts)
            .then_with(|| right.total_events.cmp(&left.total_events))
            .then_with(|| left.release_id.cmp(&right.release_id))
            .then_with(|| left.track_id.cmp(&right.track_id))
    });

    let events = PLAYER_RUM_EVENT_NAMES
        .iter()
        .map(|event_type| RumEventCount {
            event_type: (*event_type).to_string(),
            count: event_counts.get(*event_type).copied().unwrap_or_default(),
        })
        .collect::<Vec<_>>();
    let total_events = events.iter().map(|event| event.count).sum::<u64>();
    let play_starts = event_count(&event_counts, "play_start");
    let play_completes = event_count(&event_counts, "play_complete");
    let visits = site_sessions
        .values()
        .filter(|session| session.page_views > 0 || session.landing_page.is_some())
        .count() as u64;
    let page_views = page_counts.values().copied().sum::<u64>();
    let bounces = site_sessions
        .values()
        .filter(|session| session.is_bounce())
        .count() as u64;

    RumSummaryResponse {
        log_group_name: log_group_name.to_string(),
        query_id: query_id.to_string(),
        window_hours,
        start_time,
        end_time,
        result_limit: MAX_RUM_QUERY_RESULTS,
        truncated: rows.len() >= MAX_RUM_QUERY_RESULTS as usize,
        total_events,
        visits,
        page_views,
        bounces,
        bounce_rate: ratio(bounces, visits),
        standard: RumStandardSummary {
            page_views: event_count(&standard_counts, "com.amazon.rum.page_view_event"),
            navigation_events: event_count(
                &standard_counts,
                "com.amazon.rum.performance_navigation_event",
            ),
            js_errors: event_count(&standard_counts, "com.amazon.rum.js_error_event"),
            http_events: event_count(&standard_counts, "com.amazon.rum.http_event"),
        },
        unique_playback_sessions: playback_sessions.len() as u64,
        play_starts,
        play_completes,
        play_completion_rate: ratio(play_completes, play_starts),
        player_errors: event_count(&event_counts, "play_error"),
        progress_25: event_count(&event_counts, "play_progress_25"),
        progress_50: event_count(&event_counts, "play_progress_50"),
        progress_75: event_count(&event_counts, "play_progress_75"),
        events,
        releases,
        tracks,
        pages: build_page_summaries(page_counts, &site_sessions),
        referrers: build_dimension_summaries(referrer_counts),
        browsers: build_dimension_summaries(browser_counts),
        devices: build_dimension_summaries(device_counts),
        countries: build_dimension_summaries(country_counts),
        backend_play_events: BackendPlaySummary::default(),
        recent_errors,
    }
}

fn traffic_source(row: &HashMap<String, String>) -> String {
    if let Some(source) = query_row_value(row, "utmSource") {
        return format!("utm:{source}");
    }

    query_row_value(row, "referrerHost")
        .unwrap_or("(direct)")
        .to_string()
}

fn increment_dimension(counts: &mut HashMap<String, u64>, value: Option<&str>) {
    if let Some(value) = value {
        *counts.entry(value.to_string()).or_default() += 1;
    }
}

fn build_dimension_summaries(counts: HashMap<String, u64>) -> Vec<RumDimensionSummary> {
    let mut summaries = counts
        .into_iter()
        .map(|(value, count)| RumDimensionSummary { value, count })
        .collect::<Vec<_>>();
    summaries.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.value.cmp(&right.value))
    });
    summaries
}

fn build_page_summaries(
    page_counts: HashMap<String, u64>,
    site_sessions: &HashMap<String, RumSiteSession>,
) -> Vec<RumPageSummary> {
    let mut bounce_counts = HashMap::<String, u64>::new();
    for session in site_sessions.values().filter(|session| session.is_bounce()) {
        if let Some(landing_page) = &session.landing_page {
            *bounce_counts.entry(landing_page.clone()).or_default() += 1;
        }
    }

    let mut pages = page_counts
        .into_iter()
        .map(|(page_path, views)| {
            let bounces = bounce_counts.get(&page_path).copied().unwrap_or_default();
            RumPageSummary {
                page_path,
                views,
                bounces,
                bounce_rate: ratio(bounces, views),
            }
        })
        .collect::<Vec<_>>();
    pages.sort_by(|left, right| {
        right
            .views
            .cmp(&left.views)
            .then_with(|| left.page_path.cmp(&right.page_path))
    });
    pages
}

pub(crate) fn query_row_value<'a>(row: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    row.get(name)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "null")
}

fn event_count(counts: &HashMap<String, u64>, event_type: &str) -> u64 {
    counts.get(event_type).copied().unwrap_or_default()
}

pub(crate) fn ratio(numerator: u64, denominator: u64) -> f64 {
    if denominator == 0 {
        return 0.0;
    }

    ((numerator as f64 / denominator as f64) * 1000.0).round() / 1000.0
}
