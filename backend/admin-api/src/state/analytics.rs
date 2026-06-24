use super::AppState;
use crate::{
    analytics_rate_limit_key, backend_play_dedupe_key, db, parse_play_event_time,
    validate_play_event_request, ApiError, PlayEventRequest, PlayEventResponse, StoredPlayEvent,
    ANALYTICS_RATE_LIMIT_MAX_REQUESTS, ANALYTICS_RATE_LIMIT_WINDOW_SECONDS,
};
use lambda_http::http::HeaderMap;

impl AppState {
    pub(crate) fn validate_public_write_origin(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        // Public analytics is a browser-only beacon. Browsers always attach an
        // `Origin` header to cross-origin POSTs, so a missing origin indicates a
        // non-browser caller and is rejected outright. A present origin must be
        // on the allow-list.
        match headers.get("origin") {
            None => Err(ApiError::forbidden(
                "origin_required",
                "analytics events require a browser Origin header",
            )),
            Some(_) if self.cors_origin(headers).is_some() => Ok(()),
            Some(_) => Err(ApiError::forbidden(
                "origin_not_allowed",
                "origin is not allowed to write analytics events",
            )),
        }
    }

    pub(crate) async fn record_backend_play_event(
        &self,
        request: PlayEventRequest,
        headers: &HeaderMap,
    ) -> Result<PlayEventResponse, ApiError> {
        validate_play_event_request(&request)?;
        let occurred_at = parse_play_event_time(request.occurred_at.as_deref())?;
        let rate_limit_key = analytics_rate_limit_key(headers, &request.site_session_id);
        let rate_limit = db::check_analytics_rate_limit(
            &self.db,
            &rate_limit_key,
            ANALYTICS_RATE_LIMIT_MAX_REQUESTS,
            ANALYTICS_RATE_LIMIT_WINDOW_SECONDS,
        )
        .await?;

        if !rate_limit.allowed {
            return Err(ApiError::too_many_requests(
                "analytics_rate_limited",
                "too many analytics events",
            ));
        }

        db::validate_play_event_track(
            &self.db,
            &request.release_id,
            &request.track_id,
            &request.song_id,
            &request.recording_id,
        )
        .await?;

        let dedupe_key = backend_play_dedupe_key(&request);
        let inserted = db::insert_play_event(
            &self.db,
            &StoredPlayEvent {
                dedupe_key,
                event_type: request.event_type,
                release_id: request.release_id,
                track_id: request.track_id,
                song_id: request.song_id,
                recording_id: request.recording_id,
                asset_id: request.asset_id,
                selected_quality: request.selected_quality,
                position_seconds: request.position_seconds,
                duration_seconds: request.duration_seconds,
                site_session_id: request.site_session_id,
                playback_session_id: request.playback_session_id,
                page_path: request.page_path,
                referrer_origin: request.referrer_origin,
                referrer_host: request.referrer_host,
                occurred_at,
            },
        )
        .await?;

        Ok(PlayEventResponse {
            accepted: inserted,
            duplicate: !inserted,
        })
    }
}
