use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::query_row_value;

#[derive(Debug)]
pub(crate) struct RumSummaryQuery {
    pub(crate) hours: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RumSummaryResponse {
    pub(crate) log_group_name: String,
    pub(crate) query_id: String,
    pub(crate) window_hours: u32,
    pub(crate) start_time: String,
    pub(crate) end_time: String,
    pub(crate) result_limit: i32,
    pub(crate) truncated: bool,
    pub(crate) total_events: u64,
    pub(crate) visits: u64,
    pub(crate) page_views: u64,
    pub(crate) bounces: u64,
    pub(crate) bounce_rate: f64,
    pub(crate) standard: RumStandardSummary,
    pub(crate) unique_playback_sessions: u64,
    pub(crate) play_starts: u64,
    pub(crate) play_completes: u64,
    pub(crate) play_completion_rate: f64,
    pub(crate) player_errors: u64,
    pub(crate) progress_25: u64,
    pub(crate) progress_50: u64,
    pub(crate) progress_75: u64,
    pub(crate) events: Vec<RumEventCount>,
    pub(crate) releases: Vec<RumReleaseSummary>,
    pub(crate) tracks: Vec<RumTrackSummary>,
    pub(crate) pages: Vec<RumPageSummary>,
    pub(crate) referrers: Vec<RumDimensionSummary>,
    pub(crate) browsers: Vec<RumDimensionSummary>,
    pub(crate) devices: Vec<RumDimensionSummary>,
    pub(crate) countries: Vec<RumDimensionSummary>,
    pub(crate) backend_play_events: BackendPlaySummary,
    pub(crate) recent_errors: Vec<RumRecentError>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackendPlaySummary {
    pub(crate) total_events: u64,
    pub(crate) unique_site_sessions: u64,
    pub(crate) play_starts: u64,
    pub(crate) ten_second_plays: u64,
    pub(crate) twenty_five_percent_plays: u64,
    pub(crate) play_completes: u64,
    pub(crate) play_completion_rate: f64,
    pub(crate) events: Vec<RumEventCount>,
    pub(crate) songs: Vec<BackendSongPlaySummary>,
    pub(crate) releases: Vec<BackendReleasePlaySummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackendSongPlaySummary {
    pub(crate) song_id: String,
    pub(crate) recording_id: String,
    pub(crate) title: Option<String>,
    pub(crate) total_events: u64,
    pub(crate) play_starts: u64,
    pub(crate) ten_second_plays: u64,
    pub(crate) twenty_five_percent_plays: u64,
    pub(crate) play_completes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackendReleasePlaySummary {
    pub(crate) release_id: String,
    pub(crate) track_id: String,
    pub(crate) song_id: String,
    pub(crate) recording_id: String,
    pub(crate) title: Option<String>,
    pub(crate) total_events: u64,
    pub(crate) play_starts: u64,
    pub(crate) ten_second_plays: u64,
    pub(crate) twenty_five_percent_plays: u64,
    pub(crate) play_completes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RumStandardSummary {
    pub(crate) page_views: u64,
    pub(crate) navigation_events: u64,
    pub(crate) js_errors: u64,
    pub(crate) http_events: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RumEventCount {
    pub(crate) event_type: String,
    pub(crate) count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RumReleaseSummary {
    pub(crate) release_id: String,
    pub(crate) total_events: u64,
    pub(crate) play_starts: u64,
    pub(crate) play_completes: u64,
    pub(crate) player_errors: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RumTrackSummary {
    pub(crate) release_id: String,
    pub(crate) track_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) song_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) recording_id: Option<String>,
    pub(crate) total_events: u64,
    pub(crate) play_starts: u64,
    pub(crate) play_completes: u64,
    pub(crate) player_errors: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RumPageSummary {
    pub(crate) page_path: String,
    pub(crate) views: u64,
    pub(crate) bounces: u64,
    pub(crate) bounce_rate: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RumDimensionSummary {
    pub(crate) value: String,
    pub(crate) count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RumRecentError {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) release_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) song_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) recording_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) track_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error_message: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct RumAggregate {
    pub(crate) total_events: u64,
    pub(crate) play_starts: u64,
    pub(crate) play_completes: u64,
    pub(crate) player_errors: u64,
}

impl RumAggregate {
    pub(crate) fn record(&mut self, event_type: &str) {
        self.total_events += 1;
        match event_type {
            "play_start" => self.play_starts += 1,
            "play_complete" => self.play_completes += 1,
            "play_error" => self.player_errors += 1,
            _ => {}
        }
    }
}

#[derive(Debug)]
pub(crate) struct RumTrackAggregate {
    pub(crate) release_id: String,
    pub(crate) track_id: String,
    pub(crate) song_id: Option<String>,
    pub(crate) recording_id: Option<String>,
    pub(crate) counts: RumAggregate,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlayEventRequest {
    pub(crate) event_type: String,
    pub(crate) release_id: String,
    pub(crate) track_id: String,
    pub(crate) song_id: String,
    pub(crate) recording_id: String,
    #[serde(default)]
    pub(crate) asset_id: Option<String>,
    #[serde(default)]
    pub(crate) selected_quality: Option<String>,
    #[serde(default)]
    pub(crate) position_seconds: Option<f64>,
    #[serde(default)]
    pub(crate) duration_seconds: Option<f64>,
    pub(crate) site_session_id: String,
    pub(crate) playback_session_id: String,
    #[serde(default)]
    pub(crate) page_path: Option<String>,
    #[serde(default)]
    pub(crate) referrer_origin: Option<String>,
    #[serde(default)]
    pub(crate) referrer_host: Option<String>,
    #[serde(default)]
    pub(crate) occurred_at: Option<String>,
}

#[derive(Debug)]
pub(crate) struct StoredPlayEvent {
    pub(crate) dedupe_key: String,
    pub(crate) event_type: String,
    pub(crate) release_id: String,
    pub(crate) track_id: String,
    pub(crate) song_id: String,
    pub(crate) recording_id: String,
    pub(crate) asset_id: Option<String>,
    pub(crate) selected_quality: Option<String>,
    pub(crate) position_seconds: Option<f64>,
    pub(crate) duration_seconds: Option<f64>,
    pub(crate) site_session_id: String,
    pub(crate) playback_session_id: String,
    pub(crate) page_path: Option<String>,
    pub(crate) referrer_origin: Option<String>,
    pub(crate) referrer_host: Option<String>,
    pub(crate) occurred_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlayEventResponse {
    pub(crate) accepted: bool,
    pub(crate) duplicate: bool,
}

#[derive(Debug)]
pub(crate) struct RateLimitDecision {
    pub(crate) allowed: bool,
}

#[derive(Debug, Default)]
pub(crate) struct RumSiteSession {
    pub(crate) page_views: u64,
    pub(crate) engaged: bool,
    pub(crate) landing_page: Option<String>,
}

impl RumSiteSession {
    pub(crate) fn record(&mut self, row: &HashMap<String, String>, event_type: &str) {
        match event_type {
            "site_visit" => {
                self.landing_page = query_row_value(row, "landingPagePath")
                    .or_else(|| query_row_value(row, "pagePath"))
                    .map(str::to_string)
                    .or_else(|| self.landing_page.clone());
            }
            "page_view" => {
                self.page_views += 1;
                if self.landing_page.is_none() {
                    self.landing_page = query_row_value(row, "pagePath").map(str::to_string);
                }
            }
            _ => {}
        }
    }

    pub(crate) fn record_engagement(&mut self) {
        self.engaged = true;
    }

    pub(crate) fn is_bounce(&self) -> bool {
        self.page_views == 1 && !self.engaged
    }
}
