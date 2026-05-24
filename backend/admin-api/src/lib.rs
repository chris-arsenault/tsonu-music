use aws_sdk_cloudfront::types::{InvalidationBatch, Paths};
use aws_sdk_cloudfront::Client as CloudFrontClient;
use aws_sdk_cloudwatchlogs::types::QueryStatus;
use aws_sdk_cloudwatchlogs::Client as CloudWatchLogsClient;
use aws_sdk_lambda::primitives::Blob;
use aws_sdk_lambda::types::InvocationType;
use aws_sdk_lambda::Client as LambdaClient;
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::Client as S3Client;
use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
mod db;
use encode_contract::{
    build_job_id, encode_job_key as contract_encode_job_key, planned_ffmpeg_args, planned_output,
    AssetRef, EncodeJob, EncodeJobEvent, EncodeMetadata, EncodeStatus, ObjectRef,
    ACTION_ENCODE_TRACK, DRAFT_ENCODE_PREFIX,
};
use lambda_http::http::{HeaderMap, HeaderValue, Method, StatusCode};
use lambda_http::{Body, Error, Request, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::env;
use std::error::Error as StdError;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;
use tracing::{error, info};

pub use db::connect_pool_from_env;

const ARTIST_NAME: &str = "Tsonu";
const ARTIST_SLUG: &str = "tsonu";
const DRAFT_SONG_PREFIX: &str = "draft/songs/";
const DRAFT_RELEASE_PREFIX: &str = "draft/releases/";
const PUBLIC_RECORDING_PREFIX: &str = "recordings/";
const DEFAULT_UPLOAD_URL_EXPIRY_SECONDS: u64 = 900;
const MAX_UPLOAD_URL_EXPIRY_SECONDS: u64 = 3600;
const DEFAULT_RUM_SUMMARY_HOURS: u32 = 24;
const MAX_RUM_SUMMARY_HOURS: u32 = 720;
const MAX_RUM_QUERY_RESULTS: i32 = 10_000;
const RUM_QUERY_POLL_ATTEMPTS: usize = 12;
const RUM_QUERY_POLL_INTERVAL: Duration = Duration::from_millis(500);
const ANALYTICS_RATE_LIMIT_WINDOW_SECONDS: i64 = 60;
const ANALYTICS_RATE_LIMIT_MAX_REQUESTS: i32 = 120;
const MAX_ANALYTICS_EVENT_AGE_HOURS: i64 = 24;
const MAX_ANALYTICS_EVENT_FUTURE_SECONDS: i64 = 300;
const PLAYER_RUM_EVENT_NAMES: &[&str] = &[
    "release_view",
    "album_view",
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
const SITE_RUM_EVENT_NAMES: &[&str] = &["site_visit", "page_view"];
const STANDARD_RUM_EVENT_NAMES: &[&str] = &[
    "com.amazon.rum.page_view_event",
    "com.amazon.rum.performance_navigation_event",
    "com.amazon.rum.js_error_event",
    "com.amazon.rum.http_event",
];
const ENGAGED_SITE_EVENT_NAMES: &[&str] = &[
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

const DEFAULT_ALLOWED_ORIGINS: &[&str] = &[
    "https://music.tsonu.com",
    "https://tsonu.com",
    "https://www.tsonu.com",
    "https://music.ahara.io",
    "http://localhost:3000",
    "http://localhost:5173",
];

#[derive(Clone)]
pub struct AppState {
    db: PgPool,
    s3: S3Client,
    cloudfront: CloudFrontClient,
    cloudwatch_logs: CloudWatchLogsClient,
    lambda: LambdaClient,
    encoder_function_name: String,
    masters_bucket: String,
    media_bucket: String,
    media_base_url: String,
    frontend_distribution_id: String,
    rum_log_group_name: String,
    allowed_origins: Vec<String>,
}

impl AppState {
    pub fn from_env(
        db: PgPool,
        s3: S3Client,
        cloudfront: CloudFrontClient,
        cloudwatch_logs: CloudWatchLogsClient,
        lambda: LambdaClient,
    ) -> Result<Self, ConfigError> {
        Ok(Self {
            db,
            s3,
            cloudfront,
            cloudwatch_logs,
            lambda,
            encoder_function_name: required_env("ENCODER_FUNCTION_NAME")?,
            masters_bucket: required_env("MASTERS_BUCKET")?,
            media_bucket: required_env("MEDIA_BUCKET")?,
            media_base_url: required_env("MEDIA_BASE_URL")?,
            frontend_distribution_id: required_env("FRONTEND_DISTRIBUTION_ID")?,
            rum_log_group_name: required_env("RUM_LOG_GROUP_NAME")?,
            allowed_origins: env::var("ALLOWED_ORIGINS")
                .ok()
                .map(|origins| split_env_list(&origins))
                .filter(|origins| !origins.is_empty())
                .unwrap_or_else(|| {
                    DEFAULT_ALLOWED_ORIGINS
                        .iter()
                        .map(|origin| (*origin).to_string())
                        .collect()
                }),
        })
    }

    fn cors_origin(&self, headers: &HeaderMap) -> Option<String> {
        let origin = headers.get("origin")?.to_str().ok()?;
        if self.allowed_origins.iter().any(|allowed| allowed == "*") {
            return Some("*".to_string());
        }

        self.allowed_origins
            .iter()
            .any(|allowed| allowed == origin)
            .then(|| origin.to_string())
    }

    fn decorate_response(&self, response: &mut Response<Body>, cors_origin: Option<String>) {
        let headers = response.headers_mut();
        if let Some(origin) = cors_origin {
            if let Ok(origin) = HeaderValue::from_str(&origin) {
                headers.insert("access-control-allow-origin", origin);
                headers.insert("vary", HeaderValue::from_static("Origin"));
                headers.insert(
                    "access-control-expose-headers",
                    HeaderValue::from_static("ETag, X-S3-Version-Id"),
                );
                headers.insert(
                    "access-control-allow-headers",
                    HeaderValue::from_static(
                        "Authorization, Content-Type, If-Match, If-None-Match",
                    ),
                );
                headers.insert(
                    "access-control-allow-methods",
                    HeaderValue::from_static("GET, HEAD, POST, PUT, DELETE, OPTIONS"),
                );
                headers.insert("access-control-max-age", HeaderValue::from_static("600"));
            }
        }
    }

    fn validate_public_write_origin(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        if headers.get("origin").is_none() || self.cors_origin(headers).is_some() {
            return Ok(());
        }

        Err(ApiError::forbidden(
            "origin_not_allowed",
            "origin is not allowed to write analytics events",
        ))
    }

    async fn record_backend_play_event(
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

    async fn create_upload_url(
        &self,
        request: UploadUrlRequest,
    ) -> Result<UploadUrlResponse, ApiError> {
        validate_stable_id("recording", &request.recording_id, "recordingId")?;
        validate_filename(&request.filename)?;

        let upload_format =
            infer_upload_format(&request.filename, request.content_type.as_deref())?;
        let expires_in_seconds = request
            .expires_in_seconds
            .unwrap_or(DEFAULT_UPLOAD_URL_EXPIRY_SECONDS);

        if !(60..=MAX_UPLOAD_URL_EXPIRY_SECONDS).contains(&expires_in_seconds) {
            return Err(ApiError::bad_request(
                "invalid_expiry",
                format!("expiresInSeconds must be between 60 and {MAX_UPLOAD_URL_EXPIRY_SECONDS}"),
            ));
        }

        let key = master_key(&request.recording_id, upload_format.extension);
        let presigning_config = PresigningConfig::expires_in(Duration::from_secs(
            expires_in_seconds,
        ))
        .map_err(|err| {
            error!(error = %err, "Failed to create S3 presigning config");
            ApiError::internal("presign_config_failed", "failed to configure upload URL")
        })?;

        let presigned = self
            .s3
            .put_object()
            .bucket(&self.masters_bucket)
            .key(&key)
            .content_type(upload_format.content_type)
            .presigned(presigning_config)
            .await
            .map_err(|err| {
                error!(key, error = %err, "Failed to presign S3 upload");
                ApiError::internal("presign_failed", "failed to create upload URL")
            })?;

        Ok(UploadUrlResponse {
            bucket: self.masters_bucket.clone(),
            key: key.clone(),
            url: presigned.uri().to_string(),
            method: "PUT",
            headers: UploadHeaders {
                content_type: upload_format.content_type.to_string(),
            },
            expires_in_seconds,
            source_master: SourceMasterDraft {
                bucket: self.masters_bucket.clone(),
                key,
                format: upload_format.format.to_string(),
                uploaded_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
            },
        })
    }

    async fn create_encode_job(
        &self,
        request: EncodeJobRequest,
    ) -> Result<EncodeJobCreateResponse, ApiError> {
        validate_stable_id("song", &request.song_id, "songId")?;
        validate_stable_id("recording", &request.recording_id, "recordingId")?;

        if let Some(job_id) = &request.job_id {
            validate_stable_id("job", job_id, "jobId")?;
        }

        let song_object = db::get_draft_song(&self.db, &request.song_id).await?;
        let song: DraftSong = serde_json::from_str(&song_object.text).map_err(|err| {
            error!(song_id = request.song_id, error = %err, "Stored draft song cannot be parsed for encode job");
            ApiError::internal("invalid_stored_song", "stored draft song cannot be parsed")
        })?;

        if song.song_id != request.song_id {
            return Err(ApiError::bad_request(
                "song_id_mismatch",
                "draft song songId does not match request songId",
            ));
        }

        let recording = song
            .recordings
            .iter()
            .find(|recording| recording.recording_id == request.recording_id)
            .ok_or_else(|| ApiError::not_found("recording not found in draft song"))?;

        let source_master = recording.source_master.as_ref().ok_or_else(|| {
            ApiError::bad_request(
                "missing_source_master",
                format!(
                    "recording {} does not have a sourceMaster",
                    recording.recording_id
                ),
            )
        })?;

        validate_source_master(source_master, &self.masters_bucket, &request.recording_id)?;

        let now = Utc::now();
        let requested_at = now.to_rfc3339_opts(SecondsFormat::Secs, true);
        let timestamp = now
            .format("%Y%m%dT%H%M%SZ")
            .to_string()
            .to_ascii_lowercase();
        let job_id = request
            .job_id
            .clone()
            .unwrap_or_else(|| build_job_id(&request.recording_id, &timestamp));
        validate_stable_id("job", &job_id, "jobId")?;

        let include_lossless = request.include_lossless.unwrap_or(false);
        let output = planned_output(&job_id, self.media_bucket.clone(), include_lossless);
        let prepared = build_encode_job_event(
            request,
            recording,
            source_master,
            job_id,
            requested_at,
            output,
            include_lossless,
        );
        let mut job = prepared.job;
        let job_key = prepared.job_key;
        db::put_encode_job(&self.db, &job).await?;

        let payload = serde_json::to_vec(&prepared.event).map_err(|err| {
            error!(job_id = job.job_id, error = %err, "Failed to serialize encoder invocation payload");
            ApiError::internal(
                "encoder_payload_serialize_failed",
                "failed to serialize encoder invocation payload",
            )
        })?;

        let invoke_result = self
            .lambda
            .invoke()
            .function_name(&self.encoder_function_name)
            .invocation_type(InvocationType::Event)
            .payload(Blob::new(payload))
            .send()
            .await;

        let invocation_status_code = match invoke_result {
            Ok(output) if output.status_code() == 202 => output.status_code(),
            Ok(output) => {
                let details = format!("unexpected Lambda invoke status {}", output.status_code());
                self.mark_job_failed_after_invoke_error(&mut job, details.clone())
                    .await?;
                return Err(ApiError::bad_gateway(
                    "encoder_invoke_failed",
                    format!("encoder Lambda invocation failed: {details}"),
                ));
            }
            Err(err) => {
                let details = err.to_string();
                self.mark_job_failed_after_invoke_error(&mut job, details.clone())
                    .await?;
                return Err(ApiError::bad_gateway(
                    "encoder_invoke_failed",
                    format!("encoder Lambda invocation failed: {details}"),
                ));
            }
        };

        Ok(EncodeJobCreateResponse {
            job,
            job_key,
            encoder_function_name: self.encoder_function_name.clone(),
            invocation_status_code,
        })
    }

    async fn publish_release(
        &self,
        release_id: String,
        request: PublishRequest,
    ) -> Result<PublishResponse, ApiError> {
        let release_object = db::get_draft_release(&self.db, &release_id).await?;
        let draft: DraftRelease = serde_json::from_str(&release_object.text).map_err(|err| {
            error!(release_id, error = %err, "Stored draft release cannot be parsed for publishing");
            ApiError::internal(
                "invalid_stored_release",
                "stored draft release cannot be parsed",
            )
        })?;

        validate_publishable_release(&draft, &release_id)?;
        let visibility = request.visibility.unwrap_or(Visibility::Public);
        let published_at = request
            .published_at
            .unwrap_or_else(|| Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true));

        let mut published_tracks = Vec::with_capacity(draft.tracks.len());
        let mut published_songs = Vec::<PublishedSong>::new();
        let mut copied_keys = Vec::new();
        let mut job_ids = Vec::with_capacity(draft.tracks.len());

        for track in &draft.tracks {
            let song_object = db::get_draft_song(&self.db, &track.song_id).await?;
            let song: DraftSong = serde_json::from_str(&song_object.text).map_err(|err| {
                error!(song_id = track.song_id, error = %err, "Stored draft song cannot be parsed for publishing");
                ApiError::internal("invalid_stored_song", "stored draft song cannot be parsed")
            })?;
            let recording = song
                .recordings
                .iter()
                .find(|recording| recording.recording_id == track.recording_id)
                .ok_or_else(|| {
                    ApiError::not_found(format!("recording not found: {}", track.recording_id))
                })?;
            let job_id = select_publish_job_id(track, recording, &request.track_job_ids)?;
            validate_stable_id("job", &job_id, "jobId")?;
            let job = db::get_encode_job(&self.db, &job_id).await?;
            validate_publish_job(&job, &song, recording, &self.media_bucket)?;

            let public_prefix = public_recording_media_prefix(&recording.recording_id, &job.job_id);
            let job_copied_keys = self
                .copy_encode_output_to_public_prefix(&job, &public_prefix)
                .await?;
            copied_keys.extend(job_copied_keys);

            let published_track =
                build_published_track(track, &song, recording, &job, &public_prefix)?;
            published_tracks.push(published_track);
            if !published_songs
                .iter()
                .any(|existing| existing.song_id == song.song_id)
            {
                published_songs.push(build_published_song(&song));
            }
            job_ids.push(job.job_id);
        }

        published_tracks.sort_by_key(|track| (track.disc_number, track.track_number));
        let total_duration_seconds = published_tracks
            .iter()
            .map(|track| track.duration_seconds)
            .sum::<f64>();

        let published_release =
            build_published_release(&draft, visibility, published_at, published_tracks)?;
        let release_write = db::replace_publication(
            &self.db,
            &published_release,
            &published_songs,
            total_duration_seconds,
        )
        .await?;

        let draft_write = self
            .mark_draft_release_published(&release_id, &release_object)
            .await?;

        let invalidation_paths = vec![
            "/music".to_string(),
            format!("/releases/{}", published_release.slug),
            format!("/catalog/releases/{}", published_release.slug),
            format!("/catalog/songs/*"),
        ];
        let invalidation_id = self
            .invalidate_manifest_paths(&release_id, invalidation_paths.clone())
            .await?;

        Ok(PublishResponse {
            release_id,
            manifest_path: published_release.manifest_path,
            visibility: published_release.visibility,
            job_ids,
            copied_object_count: copied_keys.len(),
            copied_keys,
            release_write,
            draft_write,
            invalidation: CloudFrontInvalidationResult {
                distribution_id: self.frontend_distribution_id.clone(),
                invalidation_id,
                paths: invalidation_paths,
            },
        })
    }

    async fn get_rum_summary(
        &self,
        query: RumSummaryQuery,
    ) -> Result<RumSummaryResponse, ApiError> {
        let end_time = Utc::now();
        let start_time = end_time - ChronoDuration::hours(i64::from(query.hours));
        let query_string = build_player_rum_query();
        let started = self
            .cloudwatch_logs
            .start_query()
            .log_group_name(&self.rum_log_group_name)
            .start_time(start_time.timestamp())
            .end_time(end_time.timestamp())
            .limit(MAX_RUM_QUERY_RESULTS)
            .query_string(query_string)
            .send()
            .await
            .map_err(|err| {
                error!(error = %err, log_group = self.rum_log_group_name, "Failed to start RUM Logs Insights query");
                ApiError::bad_gateway("rum_query_start_failed", "failed to start RUM stats query")
            })?;

        let query_id = started.query_id().ok_or_else(|| {
            ApiError::bad_gateway(
                "rum_query_missing_id",
                "CloudWatch Logs did not return a query id",
            )
        })?;
        let rows = self.await_logs_query(query_id).await?;

        let mut summary = build_rum_summary(
            &self.rum_log_group_name,
            query_id,
            query.hours,
            start_time.to_rfc3339_opts(SecondsFormat::Secs, true),
            end_time.to_rfc3339_opts(SecondsFormat::Secs, true),
            rows,
        );
        summary.backend_play_events =
            db::get_backend_play_summary(&self.db, start_time, end_time).await?;

        Ok(summary)
    }

    async fn await_logs_query(
        &self,
        query_id: &str,
    ) -> Result<Vec<HashMap<String, String>>, ApiError> {
        for _ in 0..RUM_QUERY_POLL_ATTEMPTS {
            let output = self
                .cloudwatch_logs
                .get_query_results()
                .query_id(query_id)
                .send()
                .await
                .map_err(|err| {
                    error!(query_id, error = %err, "Failed to read RUM Logs Insights query results");
                    ApiError::bad_gateway(
                        "rum_query_results_failed",
                        "failed to read RUM stats query results",
                    )
                })?;

            match output.status() {
                Some(QueryStatus::Complete) => {
                    return Ok(output
                        .results()
                        .iter()
                        .map(|fields| {
                            let mut row = HashMap::new();
                            for field in fields {
                                if let (Some(name), Some(value)) = (field.field(), field.value()) {
                                    row.insert(name.to_string(), value.to_string());
                                }
                            }
                            row
                        })
                        .collect());
                }
                Some(QueryStatus::Failed) => {
                    return Err(ApiError::bad_gateway(
                        "rum_query_failed",
                        "RUM stats query failed",
                    ))
                }
                Some(QueryStatus::Cancelled) => {
                    return Err(ApiError::bad_gateway(
                        "rum_query_cancelled",
                        "RUM stats query was cancelled",
                    ))
                }
                Some(QueryStatus::Timeout) => {
                    return Err(ApiError::bad_gateway(
                        "rum_query_timeout",
                        "RUM stats query timed out",
                    ))
                }
                _ => sleep(RUM_QUERY_POLL_INTERVAL).await,
            }
        }

        Err(ApiError::bad_gateway(
            "rum_query_poll_timeout",
            "RUM stats query did not complete before the API timeout budget",
        ))
    }

    async fn copy_encode_output_to_public_prefix(
        &self,
        job: &EncodeJob,
        public_prefix: &str,
    ) -> Result<Vec<String>, ApiError> {
        let source_prefix = ensure_trailing_slash(&job.output.prefix);
        let source_keys = self.list_media_keys(&source_prefix).await?;
        if source_keys.is_empty() {
            return Err(ApiError::bad_request(
                "missing_encode_outputs",
                format!(
                    "encode job {} has no objects under {}",
                    job.job_id, job.output.prefix
                ),
            ));
        }

        let expected_assets = job
            .output
            .assets
            .iter()
            .map(|asset| asset.path.as_str())
            .collect::<HashSet<_>>();
        let listed = source_keys
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        for asset_path in expected_assets {
            if !listed.contains(asset_path) {
                return Err(ApiError::bad_request(
                    "missing_encode_asset",
                    format!(
                        "encode job {} is missing generated asset {asset_path}",
                        job.job_id
                    ),
                ));
            }
        }

        let mut copied_keys = Vec::with_capacity(source_keys.len());
        for source_key in source_keys {
            let destination_key =
                public_key_for_draft_object(&job.output.prefix, public_prefix, &source_key)?;
            self.copy_media_object(&source_key, &destination_key)
                .await?;
            copied_keys.push(destination_key);
        }

        Ok(copied_keys)
    }

    async fn copy_media_object(
        &self,
        source_key: &str,
        destination_key: &str,
    ) -> Result<(), ApiError> {
        let copy_source = format!("{}/{}", self.media_bucket, source_key);
        self.s3
            .copy_object()
            .bucket(&self.media_bucket)
            .key(destination_key)
            .copy_source(copy_source)
            .send()
            .await
            .map_err(|err| {
                error!(
                    source_key,
                    destination_key,
                    error = %err,
                    "Failed to copy generated media object for publishing"
                );
                ApiError::internal("s3_copy_failed", "failed to publish generated media object")
            })?;

        Ok(())
    }

    async fn list_media_keys(&self, prefix: &str) -> Result<Vec<String>, ApiError> {
        let mut keys = Vec::new();
        let mut continuation_token = None;

        loop {
            let mut request = self
                .s3
                .list_objects_v2()
                .bucket(&self.media_bucket)
                .prefix(prefix);
            if let Some(token) = continuation_token {
                request = request.continuation_token(token);
            }

            let output = request.send().await.map_err(|err| {
                error!(prefix, error = %err, "Failed to list S3 prefix for publishing");
                ApiError::internal("s3_list_failed", "failed to list generated media objects")
            })?;

            keys.extend(
                output
                    .contents()
                    .iter()
                    .filter_map(|object| object.key())
                    .filter(|key| !key.ends_with('/'))
                    .map(str::to_string),
            );

            if output.is_truncated().unwrap_or(false) {
                continuation_token = output.next_continuation_token().map(str::to_string);
                if continuation_token.is_none() {
                    return Err(ApiError::internal(
                        "s3_list_pagination_failed",
                        "S3 list response was truncated without a continuation token",
                    ));
                }
            } else {
                break;
            }
        }

        keys.sort();
        Ok(keys)
    }

    async fn mark_draft_release_published(
        &self,
        release_id: &str,
        source: &db::DbJsonObject,
    ) -> Result<WriteResult, ApiError> {
        let mut document: Value = serde_json::from_str(&source.text).map_err(|err| {
            error!(release_id, error = %err, "Stored draft release is invalid JSON");
            ApiError::internal(
                "invalid_stored_json",
                "stored draft release is invalid JSON",
            )
        })?;

        let object = document.as_object_mut().ok_or_else(|| {
            ApiError::internal(
                "invalid_stored_release",
                "stored draft release is not an object",
            )
        })?;
        object.insert(
            "publishState".to_string(),
            Value::String("published".to_string()),
        );
        object.insert(
            "updatedAt".to_string(),
            Value::String(Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)),
        );

        db::put_draft_release(
            &self.db,
            release_id,
            &document,
            source.e_tag.as_deref(),
            None,
        )
        .await
    }

    async fn invalidate_manifest_paths(
        &self,
        release_id: &str,
        paths: Vec<String>,
    ) -> Result<Option<String>, ApiError> {
        let invalidation_paths = Paths::builder()
            .quantity(paths.len() as i32)
            .set_items(Some(paths))
            .build()
            .map_err(|err| {
                error!(release_id, error = %err, "Failed to build CloudFront invalidation paths");
                ApiError::internal(
                    "cloudfront_invalidation_build_failed",
                    "failed to build CloudFront invalidation request",
                )
            })?;
        let caller_reference = format!(
            "publish-{release_id}-{}",
            Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
        );
        let batch = InvalidationBatch::builder()
            .paths(invalidation_paths)
            .caller_reference(caller_reference)
            .build()
            .map_err(|err| {
                error!(release_id, error = %err, "Failed to build CloudFront invalidation batch");
                ApiError::internal(
                    "cloudfront_invalidation_build_failed",
                    "failed to build CloudFront invalidation request",
                )
            })?;

        let output = self
            .cloudfront
            .create_invalidation()
            .distribution_id(&self.frontend_distribution_id)
            .invalidation_batch(batch)
            .send()
            .await
            .map_err(|err| {
                error!(release_id, error = %err, "Failed to create CloudFront invalidation");
                ApiError::bad_gateway(
                    "cloudfront_invalidation_failed",
                    "published metadata was written, but CloudFront invalidation failed",
                )
            })?;

        Ok(output
            .invalidation()
            .map(|invalidation| invalidation.id().to_string()))
    }

    async fn mark_job_failed_after_invoke_error(
        &self,
        job: &mut EncodeJob,
        details: String,
    ) -> Result<(), ApiError> {
        job.mark_failed(
            Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
            "encoder_invoke_failed",
            "encoder Lambda invocation failed",
            Some(details),
        );
        db::put_encode_job(&self.db, job).await
    }
}

pub async fn handle_request(
    request: Request,
    state: Arc<AppState>,
) -> Result<Response<Body>, Error> {
    let cors_origin = state.cors_origin(request.headers());
    let response = match dispatch(&request, &state).await {
        Ok(response) => response,
        Err(err) => {
            error!(
                status = err.status.as_u16(),
                code = err.code,
                message = %err.message,
                "Admin API request failed"
            );
            err.to_response()?
        }
    };

    let mut response = response;
    state.decorate_response(&mut response, cors_origin);
    Ok(response)
}

async fn dispatch(request: &Request, state: &AppState) -> Result<Response<Body>, ApiError> {
    let method = request.method();
    let path = request.uri().path();
    info!(method = method.as_str(), path, "Admin API request");

    match (method, parse_path(path)) {
        (&Method::OPTIONS, _) => empty_response(StatusCode::NO_CONTENT),
        (&Method::GET, ApiPath::Health) => json_response(
            StatusCode::OK,
            json!({ "ok": true, "mediaBaseUrl": state.media_base_url }),
        ),
        (&Method::HEAD, ApiPath::Health) => empty_response(StatusCode::NO_CONTENT),
        (&Method::GET, ApiPath::PublicCatalog | ApiPath::AdminCatalog) => {
            json_response(StatusCode::OK, db::get_public_catalog(&state.db).await?)
        }
        (&Method::GET, ApiPath::PublicRelease { slug }) => {
            validate_slug(&slug, "releaseSlug")?;
            let release = db::get_public_release_by_slug(&state.db, &slug).await?;
            raw_json_response(StatusCode::OK, release.text, release.e_tag.as_deref(), None)
        }
        (&Method::GET, ApiPath::PublicSong { slug }) => {
            validate_slug(&slug, "songSlug")?;
            json_response(
                StatusCode::OK,
                db::get_public_song_by_slug(&state.db, &slug).await?,
            )
        }
        (&Method::POST, ApiPath::PublicAnalyticsPlay) => {
            state.validate_public_write_origin(request.headers())?;
            let play_event: PlayEventRequest = parse_json_body(request.body())?;
            json_response(
                StatusCode::ACCEPTED,
                state
                    .record_backend_play_event(play_event, request.headers())
                    .await?,
            )
        }
        (&Method::GET, ApiPath::AdminSongs) => {
            json_response(StatusCode::OK, db::list_draft_songs(&state.db).await?)
        }
        (&Method::GET, ApiPath::AdminSong { song_id }) => {
            validate_stable_id("song", &song_id, "songId")?;
            let song = db::get_draft_song(&state.db, &song_id).await?;
            raw_json_response(StatusCode::OK, song.text, song.e_tag.as_deref(), None)
        }
        (&Method::PUT, ApiPath::AdminSong { song_id }) => {
            validate_stable_id("song", &song_id, "songId")?;
            let preconditions = write_preconditions(request.headers())?;
            let mut document: Value = parse_json_body(request.body())?;
            validate_draft_song_document(&song_id, &document)?;
            normalize_updated_at(&mut document);
            let result = db::put_draft_song(
                &state.db,
                &song_id,
                &document,
                preconditions.if_match.as_deref(),
                preconditions.if_none_match.as_deref(),
            )
            .await?;
            json_response(StatusCode::OK, result)
        }
        (&Method::GET, ApiPath::AdminReleases) => {
            json_response(StatusCode::OK, db::list_draft_releases(&state.db).await?)
        }
        (&Method::GET, ApiPath::AdminRelease { release_id }) => {
            validate_stable_id("release", &release_id, "releaseId")?;
            let release = db::get_draft_release(&state.db, &release_id).await?;
            raw_json_response(StatusCode::OK, release.text, release.e_tag.as_deref(), None)
        }
        (&Method::PUT, ApiPath::AdminRelease { release_id }) => {
            validate_stable_id("release", &release_id, "releaseId")?;
            let preconditions = write_preconditions(request.headers())?;
            let mut document: Value = parse_json_body(request.body())?;
            validate_draft_release_document(&release_id, &document)?;
            normalize_updated_at(&mut document);
            let result = db::put_draft_release(
                &state.db,
                &release_id,
                &document,
                preconditions.if_match.as_deref(),
                preconditions.if_none_match.as_deref(),
            )
            .await?;
            json_response(StatusCode::OK, result)
        }
        (&Method::GET, ApiPath::AdminJobs) => {
            json_response(StatusCode::OK, db::list_encode_jobs(&state.db).await?)
        }
        (&Method::GET, ApiPath::AdminJob { job_id }) => {
            validate_stable_id("job", &job_id, "jobId")?;
            json_response(
                StatusCode::OK,
                db::get_encode_job(&state.db, &job_id).await?,
            )
        }
        (&Method::GET, ApiPath::AdminRumSummary) => {
            let query = parse_rum_summary_query(request.uri().query())?;
            json_response(StatusCode::OK, state.get_rum_summary(query).await?)
        }
        (&Method::POST, ApiPath::AdminUploadUrl) => {
            let request: UploadUrlRequest = parse_json_body(request.body())?;
            json_response(StatusCode::OK, state.create_upload_url(request).await?)
        }
        (&Method::POST, ApiPath::AdminEncodeJobs) => {
            let request: EncodeJobRequest = parse_json_body(request.body())?;
            json_response(
                StatusCode::ACCEPTED,
                state.create_encode_job(request).await?,
            )
        }
        (&Method::POST, ApiPath::AdminPublish { release_id }) => {
            validate_stable_id("release", &release_id, "releaseId")?;
            let request = parse_optional_json_body::<PublishRequest>(request.body())?;
            json_response(
                StatusCode::OK,
                state.publish_release(release_id, request).await?,
            )
        }
        (_, ApiPath::NotFound) => Err(ApiError::not_found("route not found")),
        _ => Err(ApiError::method_not_allowed()),
    }
}

fn parse_path(path: &str) -> ApiPath {
    let parts = path
        .trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();

    match parts.as_slice() {
        ["health"] => ApiPath::Health,
        ["catalog"] => ApiPath::PublicCatalog,
        ["catalog", "releases", slug] => ApiPath::PublicRelease {
            slug: (*slug).to_string(),
        },
        ["catalog", "albums", slug] => ApiPath::PublicRelease {
            slug: (*slug).to_string(),
        },
        ["catalog", "songs", slug] => ApiPath::PublicSong {
            slug: (*slug).to_string(),
        },
        ["analytics", "play"] => ApiPath::PublicAnalyticsPlay,
        ["admin", "catalog"] => ApiPath::AdminCatalog,
        ["admin", "songs"] => ApiPath::AdminSongs,
        ["admin", "songs", song_id] => ApiPath::AdminSong {
            song_id: (*song_id).to_string(),
        },
        ["admin", "releases"] => ApiPath::AdminReleases,
        ["admin", "releases", release_id] => ApiPath::AdminRelease {
            release_id: (*release_id).to_string(),
        },
        ["admin", "jobs"] => ApiPath::AdminJobs,
        ["admin", "jobs", job_id] => ApiPath::AdminJob {
            job_id: (*job_id).to_string(),
        },
        ["admin", "rum", "summary"] => ApiPath::AdminRumSummary,
        ["admin", "upload-url"] => ApiPath::AdminUploadUrl,
        ["admin", "encode-jobs"] => ApiPath::AdminEncodeJobs,
        ["admin", "publish", release_id] => ApiPath::AdminPublish {
            release_id: (*release_id).to_string(),
        },
        _ => ApiPath::NotFound,
    }
}

fn json_response(status: StatusCode, body: impl Serialize) -> Result<Response<Body>, ApiError> {
    let body = serde_json::to_string(&body).map_err(|err| {
        error!(error = %err, "Failed to serialize API response");
        ApiError::internal(
            "response_serialize_failed",
            "failed to serialize API response",
        )
    })?;

    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::Text(body))
        .map_err(|err| {
            error!(error = %err, "Failed to build API response");
            ApiError::internal("response_build_failed", "failed to build API response")
        })
}

fn raw_json_response(
    status: StatusCode,
    body: String,
    e_tag: Option<&str>,
    version_id: Option<&str>,
) -> Result<Response<Body>, ApiError> {
    let mut builder = Response::builder()
        .status(status)
        .header("content-type", "application/json");

    if let Some(e_tag) = e_tag {
        builder = builder.header("etag", e_tag);
    }

    if let Some(version_id) = version_id {
        builder = builder.header("x-s3-version-id", version_id);
    }

    builder.body(Body::Text(body)).map_err(|err| {
        error!(error = %err, "Failed to build raw JSON API response");
        ApiError::internal("response_build_failed", "failed to build API response")
    })
}

fn empty_response(status: StatusCode) -> Result<Response<Body>, ApiError> {
    Response::builder()
        .status(status)
        .body(Body::Empty)
        .map_err(|err| {
            error!(error = %err, "Failed to build empty API response");
            ApiError::internal("response_build_failed", "failed to build API response")
        })
}

fn parse_json_body<T: for<'de> Deserialize<'de>>(body: &Body) -> Result<T, ApiError> {
    if body.as_ref().is_empty() {
        return Err(ApiError::bad_request(
            "empty_body",
            "request body must be JSON",
        ));
    }

    serde_json::from_slice(body.as_ref()).map_err(|err| {
        ApiError::bad_request(
            "invalid_json",
            format!("request body is invalid JSON: {err}"),
        )
    })
}

fn parse_optional_json_body<T>(body: &Body) -> Result<T, ApiError>
where
    T: for<'de> Deserialize<'de> + Default,
{
    if body.as_ref().is_empty() {
        return Ok(T::default());
    }

    parse_json_body(body)
}

fn parse_rum_summary_query(query: Option<&str>) -> Result<RumSummaryQuery, ApiError> {
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

fn validate_play_event_request(request: &PlayEventRequest) -> Result<(), ApiError> {
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

fn parse_play_event_time(value: Option<&str>) -> Result<DateTime<Utc>, ApiError> {
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

fn backend_play_dedupe_key(request: &PlayEventRequest) -> String {
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

fn analytics_rate_limit_key(headers: &HeaderMap, site_session_id: &str) -> String {
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

fn build_player_rum_query() -> String {
    let event_names = PLAYER_RUM_EVENT_NAMES
        .iter()
        .chain(SITE_RUM_EVENT_NAMES)
        .chain(STANDARD_RUM_EVENT_NAMES)
        .map(|event_name| format!("\"{event_name}\""))
        .collect::<Vec<_>>()
        .join(", ");

    format!(
        "fields @timestamp, event_type, event_details.releaseId as releaseId, event_details.albumId as albumId, event_details.songId as songId, event_details.recordingId as recordingId, event_details.trackId as trackId, event_details.siteSessionId as siteSessionId, event_details.playbackSessionId as playbackSessionId, event_details.selectedQuality as selectedQuality, event_details.errorName as errorName, event_details.errorMessage as errorMessage, event_details.pagePath as pagePath, event_details.previousPagePath as previousPagePath, event_details.landingPagePath as landingPagePath, event_details.referrerOrigin as referrerOrigin, event_details.referrerHost as referrerHost, event_details.pageTitle as pageTitle, event_details.utmSource as utmSource, event_details.utmMedium as utmMedium, event_details.utmCampaign as utmCampaign, metadata.pageId as rumPageId, metadata.pageTitle as rumPageTitle, metadata.browserName as browserName, metadata.deviceType as deviceType, metadata.osName as osName, metadata.countryCode as countryCode | filter event_type in [{event_names}] | sort @timestamp desc | limit {MAX_RUM_QUERY_RESULTS}"
    )
}

fn build_rum_summary(
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

            if let Some(release_id) =
                query_row_value(row, "releaseId").or_else(|| query_row_value(row, "albumId"))
            {
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
                    release_id: query_row_value(row, "releaseId")
                        .or_else(|| query_row_value(row, "albumId"))
                        .map(str::to_string),
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

fn query_row_value<'a>(row: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    row.get(name)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "null")
}

fn event_count(counts: &HashMap<String, u64>, event_type: &str) -> u64 {
    counts.get(event_type).copied().unwrap_or_default()
}

fn ratio(numerator: u64, denominator: u64) -> f64 {
    if denominator == 0 {
        return 0.0;
    }

    ((numerator as f64 / denominator as f64) * 1000.0).round() / 1000.0
}

fn write_preconditions(headers: &HeaderMap) -> Result<WritePreconditions, ApiError> {
    let if_match = optional_header(headers, "if-match")?;
    let if_none_match = optional_header(headers, "if-none-match")?;

    if if_match.is_some() && if_none_match.is_some() {
        return Err(ApiError::bad_request(
            "ambiguous_precondition",
            "send either If-Match or If-None-Match, not both",
        ));
    }

    if if_match.is_none() && if_none_match.is_none() {
        return Err(ApiError::precondition_required(
            "send If-None-Match: * to create or If-Match: <etag> to update",
        ));
    }

    if let Some(value) = &if_none_match {
        if value != "*" {
            return Err(ApiError::bad_request(
                "invalid_if_none_match",
                "If-None-Match must be *",
            ));
        }
    }

    Ok(WritePreconditions {
        if_match,
        if_none_match,
    })
}

fn optional_header(headers: &HeaderMap, name: &'static str) -> Result<Option<String>, ApiError> {
    headers
        .get(name)
        .map(|value| {
            value.to_str().map(str::to_string).map_err(|_| {
                ApiError::bad_request(
                    "invalid_header",
                    format!("{name} contains non-UTF-8 header data"),
                )
            })
        })
        .transpose()
}

fn header_str<'a>(headers: &'a HeaderMap, name: &'static str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn validate_draft_song_document(song_id: &str, document: &Value) -> Result<(), ApiError> {
    let object = document.as_object().ok_or_else(|| {
        ApiError::bad_request("invalid_song", "draft song document must be a JSON object")
    })?;

    require_string_field(object.get("entityType"), "entityType", "draftSong")?;
    require_string_field(object.get("songId"), "songId", song_id)?;

    if !object.get("recordings").is_some_and(Value::is_array) {
        return Err(ApiError::bad_request(
            "invalid_song",
            "draft song document must include a recordings array",
        ));
    }

    Ok(())
}

fn validate_draft_release_document(release_id: &str, document: &Value) -> Result<(), ApiError> {
    let object = document.as_object().ok_or_else(|| {
        ApiError::bad_request(
            "invalid_release",
            "draft release document must be a JSON object",
        )
    })?;

    require_string_field(object.get("entityType"), "entityType", "draftRelease")?;
    require_string_field(object.get("releaseId"), "releaseId", release_id)?;

    if !object.get("tracks").is_some_and(Value::is_array) {
        return Err(ApiError::bad_request(
            "invalid_release",
            "draft release document must include a tracks array",
        ));
    }

    Ok(())
}

fn validate_source_master(
    source_master: &DraftSourceMaster,
    masters_bucket: &str,
    recording_id: &str,
) -> Result<(), ApiError> {
    if source_master.bucket != masters_bucket {
        return Err(ApiError::bad_request(
            "invalid_source_master_bucket",
            "recording sourceMaster bucket does not match the configured masters bucket",
        ));
    }

    let expected_prefix = format!("masters/{recording_id}/source.");
    if !source_master.key.starts_with(&expected_prefix) {
        return Err(ApiError::bad_request(
            "invalid_source_master_key",
            format!("recording sourceMaster key must start with {expected_prefix}"),
        ));
    }

    let format = source_master
        .key
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or("");
    if !matches!(format, "wav" | "aif" | "aiff" | "flac") {
        return Err(ApiError::bad_request(
            "unsupported_source_master_format",
            "recording sourceMaster key must end with wav, aif, aiff, or flac",
        ));
    }

    if let Some(declared_format) = &source_master.format {
        let expected_format = if matches!(format, "aif" | "aiff") {
            "aiff"
        } else {
            format
        };
        if declared_format != expected_format {
            return Err(ApiError::bad_request(
                "source_master_format_mismatch",
                format!("recording sourceMaster format must be {expected_format}"),
            ));
        }
    }

    if source_master.sample_rate_hz == Some(0) || source_master.channels == Some(0) {
        return Err(ApiError::bad_request(
            "invalid_source_master_metadata",
            "recording sourceMaster sampleRateHz and channels must be positive when provided",
        ));
    }

    if let Some(uploaded_at) = &source_master.uploaded_at {
        DateTime::parse_from_rfc3339(uploaded_at).map_err(|err| {
            ApiError::bad_request(
                "invalid_source_master_uploaded_at",
                format!("recording sourceMaster uploadedAt must be RFC3339: {err}"),
            )
        })?;
    }

    Ok(())
}

fn validate_publishable_release(release: &DraftRelease, release_id: &str) -> Result<(), ApiError> {
    if release.schema_version != 1 {
        return Err(ApiError::bad_request(
            "invalid_release_schema_version",
            "draft release schemaVersion must be 1",
        ));
    }

    if release.entity_type != "draftRelease" {
        return Err(ApiError::bad_request(
            "invalid_release_entity_type",
            "draft release entityType must be draftRelease",
        ));
    }

    if release.release_id != release_id {
        return Err(ApiError::bad_request(
            "release_id_mismatch",
            "draft release releaseId does not match request releaseId",
        ));
    }

    if !matches!(release.publish_state.as_str(), "ready" | "published") {
        return Err(ApiError::bad_request(
            "release_not_ready",
            "draft release publishState must be ready or published before publishing",
        ));
    }

    if release.release_date.as_deref().is_none_or(str::is_empty) {
        return Err(ApiError::bad_request(
            "missing_release_date",
            "published releases require releaseDate",
        ));
    }

    if release.artwork.is_none() {
        return Err(ApiError::bad_request(
            "missing_artwork",
            "published releases require artwork",
        ));
    }

    if release.tracks.is_empty() {
        return Err(ApiError::bad_request(
            "missing_tracks",
            "published releases require at least one track",
        ));
    }

    let mut track_ids = HashSet::new();
    let mut track_positions = HashSet::new();
    for track in &release.tracks {
        if !track_ids.insert(&track.track_id) {
            return Err(ApiError::bad_request(
                "duplicate_track_id",
                format!("trackId {} appears more than once", track.track_id),
            ));
        }

        if !track_positions.insert((track.disc_number, track.track_number)) {
            return Err(ApiError::bad_request(
                "duplicate_track_position",
                format!(
                    "disc {} track {} appears more than once",
                    track.disc_number, track.track_number
                ),
            ));
        }

        validate_stable_id("track", &track.track_id, "trackId")?;
        validate_stable_id("song", &track.song_id, "songId")?;
        validate_stable_id("recording", &track.recording_id, "recordingId")?;
    }

    Ok(())
}

fn validate_publish_job(
    job: &EncodeJob,
    song: &DraftSong,
    recording: &DraftRecording,
    media_bucket: &str,
) -> Result<(), ApiError> {
    let source_master = recording.source_master.as_ref().ok_or_else(|| {
        ApiError::bad_request(
            "missing_source_master",
            format!(
                "recording {} does not have a sourceMaster",
                recording.recording_id
            ),
        )
    })?;

    if job.status != EncodeStatus::Succeeded {
        return Err(ApiError::bad_request(
            "encode_job_not_succeeded",
            format!("encode job {} is not succeeded", job.job_id),
        ));
    }

    if job.song_id != song.song_id || job.recording_id != recording.recording_id {
        return Err(ApiError::bad_request(
            "encode_job_mismatch",
            format!(
                "encode job {} does not match song {} recording {}",
                job.job_id, song.song_id, recording.recording_id
            ),
        ));
    }

    if job.input.bucket != source_master.bucket || job.input.key != source_master.key {
        return Err(ApiError::bad_request(
            "encode_job_source_mismatch",
            format!(
                "encode job {} does not match the draft source master",
                job.job_id
            ),
        ));
    }

    if job.output.bucket != media_bucket {
        return Err(ApiError::bad_request(
            "encode_job_output_bucket_mismatch",
            format!(
                "encode job {} output bucket does not match media bucket",
                job.job_id
            ),
        ));
    }

    if !job.output.prefix.starts_with(DRAFT_ENCODE_PREFIX) {
        return Err(ApiError::bad_request(
            "invalid_encode_output_prefix",
            format!(
                "encode job {} output prefix must be under {}",
                job.job_id, DRAFT_ENCODE_PREFIX
            ),
        ));
    }

    let expected_prefix = format!("{DRAFT_ENCODE_PREFIX}{}", job.job_id);
    if job.output.prefix != expected_prefix {
        return Err(ApiError::bad_request(
            "invalid_encode_output_prefix",
            format!(
                "encode job {} output prefix must be {}",
                job.job_id, expected_prefix
            ),
        ));
    }

    if job.metadata.is_none() {
        return Err(ApiError::bad_request(
            "missing_encode_metadata",
            format!("encode job {} has no measured metadata", job.job_id),
        ));
    }

    let mut has_hls = false;
    let mut has_192 = false;
    let mut has_320 = false;
    for asset in &job.output.assets {
        if !asset
            .path
            .starts_with(&ensure_trailing_slash(&job.output.prefix))
        {
            return Err(ApiError::bad_request(
                "invalid_encode_asset_path",
                format!(
                    "encode job {} asset {} is outside output prefix",
                    job.job_id, asset.path
                ),
            ));
        }

        match asset
            .path
            .strip_prefix(&ensure_trailing_slash(&job.output.prefix))
        {
            Some("hls/master.m3u8") => has_hls = true,
            Some("hls/192k/index.m3u8") => has_192 = true,
            Some("hls/320k/index.m3u8") => has_320 = true,
            _ => {}
        }
    }

    if !(has_hls && has_192 && has_320) {
        return Err(ApiError::bad_request(
            "missing_required_encode_assets",
            format!(
                "encode job {} must include HLS master, 192k, and 320k playlists",
                job.job_id
            ),
        ));
    }

    Ok(())
}

fn select_publish_job_id(
    track: &DraftReleaseTrack,
    recording: &DraftRecording,
    overrides: &HashMap<String, String>,
) -> Result<String, ApiError> {
    if let Some(job_id) = overrides
        .get(&track.track_id)
        .or_else(|| overrides.get(&track.recording_id))
    {
        return Ok(job_id.clone());
    }

    recording.encode_job_ids.last().cloned().ok_or_else(|| {
        ApiError::bad_request(
            "missing_encode_job",
            format!(
                "track {} recording {} has no encode job history",
                track.track_id, track.recording_id
            ),
        )
    })
}

fn build_published_song(draft: &DraftSong) -> PublishedSong {
    PublishedSong {
        schema_version: 1,
        entity_type: SongEntityType::Song,
        song_id: draft.song_id.clone(),
        slug: draft.slug.clone(),
        title: draft.title.clone(),
        artist_name: draft.artist_name.clone(),
        description: draft.description.clone(),
        lyrics: draft.lyrics.clone(),
        credits: draft.credits.clone(),
        tags: draft.tags.clone(),
        placements: Vec::new(),
    }
}

fn build_published_release(
    draft: &DraftRelease,
    visibility: Visibility,
    published_at: String,
    tracks: Vec<PublishedReleaseTrack>,
) -> Result<PublishedRelease, ApiError> {
    Ok(PublishedRelease {
        schema_version: 1,
        entity_type: ReleaseEntityType::Release,
        release_id: draft.release_id.clone(),
        slug: draft.slug.clone(),
        title: draft.title.clone(),
        subtitle: draft.subtitle.clone(),
        artist_name: draft.artist_name.clone(),
        release_kind: draft.release_kind.clone(),
        release_status: draft.release_status.clone(),
        release_date: draft.release_date.clone().ok_or_else(|| {
            ApiError::bad_request(
                "missing_release_date",
                "published releases require releaseDate",
            )
        })?,
        status: PublishedStatus::Published,
        visibility,
        published_at,
        manifest_path: published_release_api_path(&draft.slug),
        description: draft.description.clone(),
        copyright: draft.copyright.clone(),
        artwork: draft.artwork.clone().ok_or_else(|| {
            ApiError::bad_request("missing_artwork", "published releases require artwork")
        })?,
        credits: draft.credits.clone(),
        links: draft.links.clone(),
        tags: draft.tags.clone(),
        tracks,
    })
}

fn build_published_track(
    track: &DraftReleaseTrack,
    song: &DraftSong,
    recording: &DraftRecording,
    job: &EncodeJob,
    public_prefix: &str,
) -> Result<PublishedReleaseTrack, ApiError> {
    let metadata = job.metadata.as_ref().ok_or_else(|| {
        ApiError::bad_request(
            "missing_encode_metadata",
            format!("encode job {} has no measured metadata", job.job_id),
        )
    })?;
    let output_prefix = ensure_trailing_slash(&job.output.prefix);
    let hls_asset = required_asset(job, "hls/master.m3u8")?;
    let aac_192_asset = required_asset(job, "hls/192k/index.m3u8")?;
    let aac_320_asset = required_asset(job, "hls/320k/index.m3u8")?;
    let flac_asset = optional_asset(job, "lossless.flac");

    let mut formats = vec![
        playback_format(PlaybackFormatBuild {
            asset: aac_192_asset,
            draft_prefix: &output_prefix,
            public_prefix,
            kind: PlaybackFormatKind::HlsRendition,
            quality: PlaybackQuality::Aac192,
            bitrate_kbps: Some(192),
            metadata,
            bit_depth: None,
        })?,
        playback_format(PlaybackFormatBuild {
            asset: aac_320_asset,
            draft_prefix: &output_prefix,
            public_prefix,
            kind: PlaybackFormatKind::HlsRendition,
            quality: PlaybackQuality::Aac320,
            bitrate_kbps: Some(320),
            metadata,
            bit_depth: None,
        })?,
    ];

    if let Some(asset) = flac_asset {
        formats.push(playback_format(PlaybackFormatBuild {
            asset,
            draft_prefix: &output_prefix,
            public_prefix,
            kind: PlaybackFormatKind::Download,
            quality: PlaybackQuality::FlacLossless,
            bitrate_kbps: None,
            metadata,
            bit_depth: recording
                .source_master
                .as_ref()
                .and_then(|source_master| source_master.bit_depth),
        })?);
    }

    Ok(PublishedReleaseTrack {
        track_id: track.track_id.clone(),
        song_id: track.song_id.clone(),
        recording_id: track.recording_id.clone(),
        disc_number: track.disc_number,
        track_number: track.track_number,
        slug: track.slug.clone(),
        title: track.title.clone(),
        song_title: song.title.clone(),
        recording_title: recording.title.clone(),
        version_title: recording.version_title.clone(),
        duration_seconds: metadata.duration_seconds,
        explicit: track.explicit.unwrap_or(recording.explicit),
        isrc: track.isrc.clone().or_else(|| recording.isrc.clone()),
        description: track.description.clone(),
        credits: track.credits.clone(),
        playback: TrackPlayback {
            hls: PlaybackHls {
                asset_id: hls_asset.asset_id.clone(),
                path: public_asset_path(&hls_asset.path, &output_prefix, public_prefix)?,
                mime_type: hls_asset.mime_type.clone(),
                codecs: vec!["mp4a.40.2".to_string()],
            },
            formats,
        },
    })
}

struct PlaybackFormatBuild<'a> {
    asset: &'a AssetRef,
    draft_prefix: &'a str,
    public_prefix: &'a str,
    kind: PlaybackFormatKind,
    quality: PlaybackQuality,
    bitrate_kbps: Option<u32>,
    metadata: &'a EncodeMetadata,
    bit_depth: Option<u32>,
}

fn playback_format(params: PlaybackFormatBuild<'_>) -> Result<PlaybackFormat, ApiError> {
    Ok(PlaybackFormat {
        asset_id: params.asset.asset_id.clone(),
        kind: params.kind,
        quality: params.quality,
        path: public_asset_path(
            &params.asset.path,
            params.draft_prefix,
            params.public_prefix,
        )?,
        mime_type: params.asset.mime_type.clone(),
        bitrate_kbps: params.bitrate_kbps,
        sample_rate_hz: Some(params.metadata.sample_rate_hz),
        bit_depth: params.bit_depth,
        channels: Some(params.metadata.channels),
        file_size_bytes: params.asset.file_size_bytes,
    })
}

fn required_asset<'a>(job: &'a EncodeJob, relative_path: &str) -> Result<&'a AssetRef, ApiError> {
    optional_asset(job, relative_path).ok_or_else(|| {
        ApiError::bad_request(
            "missing_required_encode_asset",
            format!("encode job {} is missing {relative_path}", job.job_id),
        )
    })
}

fn optional_asset<'a>(job: &'a EncodeJob, relative_path: &str) -> Option<&'a AssetRef> {
    let expected = format!(
        "{}/{}",
        job.output.prefix.trim_end_matches('/'),
        relative_path
    );
    job.output
        .assets
        .iter()
        .find(|asset| asset.path == expected)
}

fn public_asset_path(
    draft_asset_path: &str,
    draft_prefix: &str,
    public_prefix: &str,
) -> Result<String, ApiError> {
    let relative = draft_asset_path.strip_prefix(draft_prefix).ok_or_else(|| {
        ApiError::bad_request(
            "invalid_encode_asset_path",
            format!("asset {draft_asset_path} is outside output prefix {draft_prefix}"),
        )
    })?;

    Ok(format!(
        "{}/{}",
        public_prefix.trim_end_matches('/'),
        relative.trim_start_matches('/')
    ))
}

fn public_key_for_draft_object(
    draft_prefix: &str,
    public_prefix: &str,
    source_key: &str,
) -> Result<String, ApiError> {
    public_asset_path(
        source_key,
        &ensure_trailing_slash(draft_prefix),
        public_prefix,
    )
}

fn ensure_trailing_slash(value: &str) -> String {
    format!("{}/", value.trim_end_matches('/'))
}

fn public_recording_media_prefix(recording_id: &str, job_id: &str) -> String {
    format!("{PUBLIC_RECORDING_PREFIX}{recording_id}/{job_id}")
}

fn published_release_api_path(release_slug: &str) -> String {
    format!("/catalog/releases/{release_slug}")
}

struct PreparedEncodeJob {
    job: EncodeJob,
    job_key: String,
    event: EncodeJobEvent,
}

fn build_encode_job_event(
    request: EncodeJobRequest,
    _recording: &DraftRecording,
    source_master: &DraftSourceMaster,
    job_id: String,
    requested_at: String,
    output: encode_contract::EncodeOutput,
    include_lossless: bool,
) -> PreparedEncodeJob {
    let mut job = EncodeJob::queued(
        job_id.clone(),
        request.song_id.clone(),
        request.recording_id.clone(),
        requested_at,
        ObjectRef {
            bucket: source_master.bucket.clone(),
            key: source_master.key.clone(),
            version_id: source_master.version_id.clone(),
            etag: source_master.etag.clone(),
        },
        output,
    );
    job.ffmpeg = Some(encode_contract::FfmpegDetails {
        version: None,
        args: planned_ffmpeg_args(&source_master.key, &job.output, include_lossless),
    });

    let job_key = contract_encode_job_key(&job_id);
    let event = EncodeJobEvent {
        action: ACTION_ENCODE_TRACK.to_string(),
        job_key: job_key.clone(),
        job: job.clone(),
        requested_by: request.requested_by,
    };

    PreparedEncodeJob {
        job,
        job_key,
        event,
    }
}

fn normalize_updated_at(document: &mut Value) {
    if let Some(object) = document.as_object_mut() {
        object.insert(
            "updatedAt".to_string(),
            Value::String(Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)),
        );
    }
}

fn require_string_field(
    value: Option<&Value>,
    field: &'static str,
    expected: &str,
) -> Result<(), ApiError> {
    match value.and_then(Value::as_str) {
        Some(actual) if actual == expected => Ok(()),
        _ => Err(ApiError::bad_request(
            "invalid_manifest_field",
            format!("{field} must be {expected}"),
        )),
    }
}

fn validate_stable_id(prefix: &str, value: &str, field: &'static str) -> Result<(), ApiError> {
    let expected_prefix = format!("{prefix}_");
    let suffix = value.strip_prefix(&expected_prefix).ok_or_else(|| {
        ApiError::bad_request(
            "invalid_stable_id",
            format!("{field} must start with {expected_prefix}"),
        )
    })?;

    if !(3..=97).contains(&suffix.len()) {
        return Err(ApiError::bad_request(
            "invalid_stable_id",
            format!("{field} has an invalid length"),
        ));
    }

    let mut chars = suffix.chars();
    let first = chars.next().expect("suffix length checked");
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return Err(ApiError::bad_request(
            "invalid_stable_id",
            format!("{field} must have a lowercase alphanumeric first suffix character"),
        ));
    }

    if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
        return Err(ApiError::bad_request(
            "invalid_stable_id",
            format!("{field} may only contain lowercase letters, digits, hyphens, and underscores"),
        ));
    }

    Ok(())
}

fn validate_optional_stable_id(
    prefix: &str,
    value: Option<&str>,
    field: &'static str,
) -> Result<(), ApiError> {
    if let Some(value) = value {
        validate_stable_id(prefix, value, field)?;
    }

    Ok(())
}

fn validate_session_id(value: &str, field: &'static str) -> Result<(), ApiError> {
    if !(8..=128).contains(&value.len()) {
        return Err(ApiError::bad_request(
            "invalid_session_id",
            format!("{field} has an invalid length"),
        ));
    }

    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(ApiError::bad_request(
            "invalid_session_id",
            format!("{field} may only contain letters, digits, hyphens, and underscores"),
        ));
    }

    Ok(())
}

fn validate_optional_short_text(
    value: Option<&str>,
    field: &'static str,
    max_len: usize,
) -> Result<(), ApiError> {
    if let Some(value) = value {
        if value.is_empty() || value.len() > max_len || value.chars().any(char::is_control) {
            return Err(ApiError::bad_request(
                "invalid_text_field",
                format!("{field} has an invalid value"),
            ));
        }
    }

    Ok(())
}

fn validate_optional_path(value: Option<&str>, field: &'static str) -> Result<(), ApiError> {
    if let Some(value) = value {
        if value.is_empty()
            || value.len() > 512
            || !value.starts_with('/')
            || value.chars().any(char::is_control)
        {
            return Err(ApiError::bad_request(
                "invalid_path",
                format!("{field} has an invalid value"),
            ));
        }
    }

    Ok(())
}

fn validate_optional_url_origin(value: Option<&str>, field: &'static str) -> Result<(), ApiError> {
    if let Some(value) = value {
        let valid = value.len() <= 256
            && (value.starts_with("https://") || value.starts_with("http://"))
            && !value.contains('?')
            && !value.contains('#')
            && !value.chars().any(char::is_control);
        if !valid {
            return Err(ApiError::bad_request(
                "invalid_origin",
                format!("{field} has an invalid value"),
            ));
        }
    }

    Ok(())
}

fn validate_optional_seconds(value: Option<f64>, field: &'static str) -> Result<(), ApiError> {
    if let Some(value) = value {
        if !value.is_finite() || !(0.0..=86_400.0).contains(&value) {
            return Err(ApiError::bad_request(
                "invalid_seconds",
                format!("{field} has an invalid value"),
            ));
        }
    }

    Ok(())
}

fn validate_slug(value: &str, field: &'static str) -> Result<(), ApiError> {
    if value.is_empty() || value.len() > 120 {
        return Err(ApiError::bad_request(
            "invalid_slug",
            format!("{field} has an invalid length"),
        ));
    }

    let mut previous_was_hyphen = false;
    for (index, c) in value.chars().enumerate() {
        let valid = c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-';
        if !valid {
            return Err(ApiError::bad_request(
                "invalid_slug",
                format!("{field} may only contain lowercase letters, digits, and hyphens"),
            ));
        }
        if c == '-' {
            if index == 0 || previous_was_hyphen {
                return Err(ApiError::bad_request(
                    "invalid_slug",
                    format!("{field} must not contain empty slug segments"),
                ));
            }
            previous_was_hyphen = true;
        } else {
            previous_was_hyphen = false;
        }
    }

    if previous_was_hyphen {
        return Err(ApiError::bad_request(
            "invalid_slug",
            format!("{field} must not end with a hyphen"),
        ));
    }

    Ok(())
}

fn validate_filename(filename: &str) -> Result<(), ApiError> {
    if filename.is_empty() || filename == "." || filename == ".." {
        return Err(ApiError::bad_request(
            "invalid_filename",
            "filename must not be empty",
        ));
    }

    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err(ApiError::bad_request(
            "invalid_filename",
            "filename must not contain path segments",
        ));
    }

    if !filename
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err(ApiError::bad_request(
            "invalid_filename",
            "filename may only contain ASCII letters, digits, dot, hyphen, and underscore",
        ));
    }

    Ok(())
}

fn infer_upload_format(
    filename: &str,
    requested_content_type: Option<&str>,
) -> Result<UploadFormat<'static>, ApiError> {
    let lower = filename.to_ascii_lowercase();
    let format = if lower.ends_with(".wav") {
        UploadFormat {
            extension: "wav",
            format: "wav",
            content_type: "audio/wav",
        }
    } else if lower.ends_with(".aif") {
        UploadFormat {
            extension: "aif",
            format: "aiff",
            content_type: "audio/aiff",
        }
    } else if lower.ends_with(".aiff") {
        UploadFormat {
            extension: "aiff",
            format: "aiff",
            content_type: "audio/aiff",
        }
    } else if lower.ends_with(".flac") {
        UploadFormat {
            extension: "flac",
            format: "flac",
            content_type: "audio/flac",
        }
    } else {
        return Err(ApiError::bad_request(
            "unsupported_master_format",
            "source masters must be WAV, AIFF, or FLAC",
        ));
    };

    if let Some(requested) = requested_content_type {
        let allowed = match format.format {
            "wav" => ["audio/wav", "audio/x-wav", "audio/wave"].as_slice(),
            "aiff" => ["audio/aiff", "audio/x-aiff"].as_slice(),
            "flac" => ["audio/flac", "audio/x-flac"].as_slice(),
            _ => &[],
        };

        if !allowed.contains(&requested) {
            return Err(ApiError::bad_request(
                "content_type_mismatch",
                format!("{requested} is not valid for {}", format.extension),
            ));
        }
    }

    Ok(format)
}

fn master_key(recording_id: &str, extension: &str) -> String {
    format!("masters/{recording_id}/source.{extension}")
}

fn draft_song_key(song_id: &str) -> String {
    format!("{DRAFT_SONG_PREFIX}{song_id}.json")
}

fn draft_release_key(release_id: &str) -> String {
    format!("{DRAFT_RELEASE_PREFIX}{release_id}.json")
}

fn encode_job_key(job_id: &str) -> String {
    contract_encode_job_key(job_id)
}

fn split_env_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn required_env(name: &'static str) -> Result<String, ConfigError> {
    env::var(name).map_err(|_| ConfigError { name })
}

#[derive(Debug, PartialEq, Eq)]
enum ApiPath {
    Health,
    PublicCatalog,
    PublicRelease { slug: String },
    PublicSong { slug: String },
    PublicAnalyticsPlay,
    AdminCatalog,
    AdminSongs,
    AdminSong { song_id: String },
    AdminReleases,
    AdminRelease { release_id: String },
    AdminJobs,
    AdminJob { job_id: String },
    AdminRumSummary,
    AdminUploadUrl,
    AdminEncodeJobs,
    AdminPublish { release_id: String },
    NotFound,
}

#[derive(Debug)]
pub struct ConfigError {
    name: &'static str,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "missing required environment variable {}", self.name)
    }
}

impl StdError for ConfigError {}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    fn forbidden(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, message)
    }

    fn too_many_requests(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, code, message)
    }

    fn internal(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, code, message)
    }

    fn bad_gateway(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, code, message)
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }

    fn method_not_allowed() -> Self {
        Self::new(
            StatusCode::METHOD_NOT_ALLOWED,
            "method_not_allowed",
            "method not allowed for this route",
        )
    }

    fn precondition_required(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::PRECONDITION_REQUIRED,
            "precondition_required",
            message,
        )
    }

    fn precondition_failed(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::PRECONDITION_FAILED, code, message)
    }

    fn to_response(&self) -> Result<Response<Body>, Error> {
        let body = json!({
            "error": {
                "code": self.code,
                "message": self.message,
            }
        });

        Ok(Response::builder()
            .status(self.status)
            .header("content-type", "application/json")
            .body(Body::Text(serde_json::to_string(&body)?))?)
    }
}

#[derive(Debug)]
struct WritePreconditions {
    if_match: Option<String>,
    if_none_match: Option<String>,
}

#[derive(Debug)]
struct UploadFormat<'a> {
    extension: &'a str,
    format: &'a str,
    content_type: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadUrlRequest {
    recording_id: String,
    filename: String,
    #[serde(default)]
    content_type: Option<String>,
    #[serde(default)]
    expires_in_seconds: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadUrlResponse {
    bucket: String,
    key: String,
    url: String,
    method: &'static str,
    headers: UploadHeaders,
    expires_in_seconds: u64,
    source_master: SourceMasterDraft,
}

#[derive(Debug, Serialize)]
struct UploadHeaders {
    #[serde(rename = "Content-Type")]
    content_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceMasterDraft {
    bucket: String,
    key: String,
    format: String,
    uploaded_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncodeJobRequest {
    song_id: String,
    recording_id: String,
    #[serde(default)]
    job_id: Option<String>,
    #[serde(default)]
    include_lossless: Option<bool>,
    #[serde(default)]
    requested_by: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EncodeJobCreateResponse {
    job: EncodeJob,
    job_key: String,
    encoder_function_name: String,
    invocation_status_code: i32,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishRequest {
    #[serde(default)]
    visibility: Option<Visibility>,
    #[serde(default)]
    track_job_ids: HashMap<String, String>,
    #[serde(default)]
    published_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishResponse {
    release_id: String,
    manifest_path: String,
    visibility: Visibility,
    job_ids: Vec<String>,
    copied_object_count: usize,
    copied_keys: Vec<String>,
    release_write: WriteResult,
    draft_write: WriteResult,
    invalidation: CloudFrontInvalidationResult,
}

#[derive(Debug)]
struct RumSummaryQuery {
    hours: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RumSummaryResponse {
    log_group_name: String,
    query_id: String,
    window_hours: u32,
    start_time: String,
    end_time: String,
    result_limit: i32,
    truncated: bool,
    total_events: u64,
    visits: u64,
    page_views: u64,
    bounces: u64,
    bounce_rate: f64,
    standard: RumStandardSummary,
    unique_playback_sessions: u64,
    play_starts: u64,
    play_completes: u64,
    play_completion_rate: f64,
    player_errors: u64,
    progress_25: u64,
    progress_50: u64,
    progress_75: u64,
    events: Vec<RumEventCount>,
    releases: Vec<RumReleaseSummary>,
    tracks: Vec<RumTrackSummary>,
    pages: Vec<RumPageSummary>,
    referrers: Vec<RumDimensionSummary>,
    browsers: Vec<RumDimensionSummary>,
    devices: Vec<RumDimensionSummary>,
    countries: Vec<RumDimensionSummary>,
    backend_play_events: BackendPlaySummary,
    recent_errors: Vec<RumRecentError>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct BackendPlaySummary {
    total_events: u64,
    unique_site_sessions: u64,
    play_starts: u64,
    ten_second_plays: u64,
    twenty_five_percent_plays: u64,
    play_completes: u64,
    play_completion_rate: f64,
    events: Vec<RumEventCount>,
    songs: Vec<BackendSongPlaySummary>,
    releases: Vec<BackendReleasePlaySummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendSongPlaySummary {
    song_id: String,
    recording_id: String,
    title: Option<String>,
    total_events: u64,
    play_starts: u64,
    ten_second_plays: u64,
    twenty_five_percent_plays: u64,
    play_completes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendReleasePlaySummary {
    release_id: String,
    track_id: String,
    song_id: String,
    recording_id: String,
    title: Option<String>,
    total_events: u64,
    play_starts: u64,
    ten_second_plays: u64,
    twenty_five_percent_plays: u64,
    play_completes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RumStandardSummary {
    page_views: u64,
    navigation_events: u64,
    js_errors: u64,
    http_events: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RumEventCount {
    event_type: String,
    count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RumReleaseSummary {
    release_id: String,
    total_events: u64,
    play_starts: u64,
    play_completes: u64,
    player_errors: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RumTrackSummary {
    release_id: String,
    track_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    song_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recording_id: Option<String>,
    total_events: u64,
    play_starts: u64,
    play_completes: u64,
    player_errors: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RumPageSummary {
    page_path: String,
    views: u64,
    bounces: u64,
    bounce_rate: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RumDimensionSummary {
    value: String,
    count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RumRecentError {
    #[serde(skip_serializing_if = "Option::is_none")]
    timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    release_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    song_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recording_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    track_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_message: Option<String>,
}

#[derive(Debug, Default)]
struct RumAggregate {
    total_events: u64,
    play_starts: u64,
    play_completes: u64,
    player_errors: u64,
}

impl RumAggregate {
    fn record(&mut self, event_type: &str) {
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
struct RumTrackAggregate {
    release_id: String,
    track_id: String,
    song_id: Option<String>,
    recording_id: Option<String>,
    counts: RumAggregate,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlayEventRequest {
    event_type: String,
    release_id: String,
    track_id: String,
    song_id: String,
    recording_id: String,
    #[serde(default)]
    asset_id: Option<String>,
    #[serde(default)]
    selected_quality: Option<String>,
    #[serde(default)]
    position_seconds: Option<f64>,
    #[serde(default)]
    duration_seconds: Option<f64>,
    site_session_id: String,
    playback_session_id: String,
    #[serde(default)]
    page_path: Option<String>,
    #[serde(default)]
    referrer_origin: Option<String>,
    #[serde(default)]
    referrer_host: Option<String>,
    #[serde(default)]
    occurred_at: Option<String>,
}

#[derive(Debug)]
struct StoredPlayEvent {
    dedupe_key: String,
    event_type: String,
    release_id: String,
    track_id: String,
    song_id: String,
    recording_id: String,
    asset_id: Option<String>,
    selected_quality: Option<String>,
    position_seconds: Option<f64>,
    duration_seconds: Option<f64>,
    site_session_id: String,
    playback_session_id: String,
    page_path: Option<String>,
    referrer_origin: Option<String>,
    referrer_host: Option<String>,
    occurred_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayEventResponse {
    accepted: bool,
    duplicate: bool,
}

#[derive(Debug)]
struct RateLimitDecision {
    allowed: bool,
}

#[derive(Debug, Default)]
struct RumSiteSession {
    page_views: u64,
    engaged: bool,
    landing_page: Option<String>,
}

impl RumSiteSession {
    fn record(&mut self, row: &HashMap<String, String>, event_type: &str) {
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

    fn record_engagement(&mut self) {
        self.engaged = true;
    }

    fn is_bounce(&self) -> bool {
        self.page_views == 1 && !self.engaged
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudFrontInvalidationResult {
    distribution_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    invalidation_id: Option<String>,
    paths: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftSong {
    schema_version: u8,
    entity_type: String,
    song_id: String,
    slug: String,
    title: String,
    artist_name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    lyrics: Option<String>,
    #[serde(default)]
    credits: Option<Value>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    recordings: Vec<DraftRecording>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftRecording {
    recording_id: String,
    slug: String,
    title: String,
    #[serde(default)]
    version_title: Option<String>,
    version_type: String,
    #[serde(default)]
    artist_name: Option<String>,
    #[serde(default)]
    duration_seconds: Option<f64>,
    explicit: bool,
    #[serde(default)]
    isrc: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    source_master: Option<DraftSourceMaster>,
    #[serde(default)]
    encode_job_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftRelease {
    schema_version: u8,
    entity_type: String,
    release_id: String,
    slug: String,
    title: String,
    #[serde(default)]
    subtitle: Option<String>,
    artist_name: String,
    release_kind: String,
    release_status: String,
    #[serde(default)]
    release_date: Option<String>,
    publish_state: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    copyright: Option<String>,
    #[serde(default)]
    artwork: Option<Value>,
    #[serde(default)]
    credits: Option<Value>,
    #[serde(default)]
    links: Option<Vec<ExternalLink>>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    tracks: Vec<DraftReleaseTrack>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftReleaseTrack {
    track_id: String,
    song_id: String,
    recording_id: String,
    disc_number: u32,
    track_number: u32,
    slug: String,
    title: String,
    #[serde(default)]
    explicit: Option<bool>,
    #[serde(default)]
    isrc: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    credits: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftSourceMaster {
    bucket: String,
    key: String,
    #[serde(default)]
    version_id: Option<String>,
    #[serde(default, rename = "etag")]
    etag: Option<String>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    uploaded_at: Option<String>,
    #[serde(default)]
    sample_rate_hz: Option<u32>,
    #[serde(default)]
    bit_depth: Option<u32>,
    #[serde(default)]
    channels: Option<u32>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Visibility {
    #[default]
    Public,
    Unlisted,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum PublishedStatus {
    Published,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum ReleaseEntityType {
    Release,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum SongEntityType {
    Song,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum CatalogEntityType {
    Catalog,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ExternalLink {
    label: String,
    url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PublishedRelease {
    schema_version: u8,
    entity_type: ReleaseEntityType,
    release_id: String,
    slug: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    subtitle: Option<String>,
    artist_name: String,
    release_kind: String,
    release_status: String,
    release_date: String,
    status: PublishedStatus,
    visibility: Visibility,
    published_at: String,
    #[serde(skip_serializing)]
    manifest_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    copyright: Option<String>,
    artwork: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    credits: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    links: Option<Vec<ExternalLink>>,
    #[serde(skip_serializing)]
    tags: Option<Vec<String>>,
    tracks: Vec<PublishedReleaseTrack>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PublishedReleaseTrack {
    track_id: String,
    song_id: String,
    recording_id: String,
    disc_number: u32,
    track_number: u32,
    slug: String,
    title: String,
    song_title: String,
    recording_title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version_title: Option<String>,
    duration_seconds: f64,
    explicit: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    isrc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credits: Option<Value>,
    playback: TrackPlayback,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TrackPlayback {
    hls: PlaybackHls,
    formats: Vec<PlaybackFormat>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PlaybackHls {
    asset_id: String,
    path: String,
    mime_type: String,
    codecs: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PlaybackFormat {
    asset_id: String,
    kind: PlaybackFormatKind,
    quality: PlaybackQuality,
    path: String,
    mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    bitrate_kbps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sample_rate_hz: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bit_depth: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    channels: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum PlaybackFormatKind {
    HlsRendition,
    Download,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum PlaybackQuality {
    Aac192,
    Aac320,
    FlacLossless,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PublishedSong {
    schema_version: u8,
    entity_type: SongEntityType,
    song_id: String,
    slug: String,
    title: String,
    artist_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lyrics: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credits: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
    placements: Vec<PublishedSongPlacement>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PublishedSongPlacement {
    release_id: String,
    release_slug: String,
    release_title: String,
    release_kind: String,
    track_id: String,
    track_slug: String,
    recording_id: String,
    track_number: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PublishedCatalog {
    schema_version: u8,
    entity_type: CatalogEntityType,
    generated_at: String,
    artist: CatalogArtist,
    releases: Vec<PublishedCatalogRelease>,
    songs: Vec<PublishedCatalogSong>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CatalogArtist {
    name: String,
    slug: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PublishedCatalogRelease {
    release_id: String,
    slug: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    subtitle: Option<String>,
    release_kind: String,
    release_status: String,
    release_date: String,
    status: PublishedStatus,
    visibility: Visibility,
    manifest_path: String,
    artwork: Value,
    track_count: usize,
    total_duration_seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    links: Option<Vec<ExternalLink>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PublishedCatalogSong {
    song_id: String,
    slug: String,
    title: String,
    artist_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteResult {
    bucket: String,
    key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    e_tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObjectList {
    bucket: String,
    prefix: String,
    objects: Vec<ObjectSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObjectSummary {
    key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    e_tag: Option<String>,
    size_bytes: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rum_row(fields: &[(&str, &str)]) -> HashMap<String, String> {
        fields
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn parses_admin_paths() {
        assert_eq!(parse_path("/health"), ApiPath::Health);
        assert_eq!(parse_path("/analytics/play"), ApiPath::PublicAnalyticsPlay);
        assert_eq!(parse_path("/admin/catalog"), ApiPath::AdminCatalog);
        assert_eq!(parse_path("/admin/songs"), ApiPath::AdminSongs);
        assert_eq!(
            parse_path("/admin/songs/song_opening-dream"),
            ApiPath::AdminSong {
                song_id: "song_opening-dream".to_string()
            }
        );
        assert_eq!(parse_path("/admin/releases"), ApiPath::AdminReleases);
        assert_eq!(
            parse_path("/admin/releases/release_so-we-sleep"),
            ApiPath::AdminRelease {
                release_id: "release_so-we-sleep".to_string()
            }
        );
        assert_eq!(
            parse_path("/admin/jobs/job_so-we-sleep_01_encode_20260523"),
            ApiPath::AdminJob {
                job_id: "job_so-we-sleep_01_encode_20260523".to_string()
            }
        );
        assert_eq!(parse_path("/admin/rum/summary"), ApiPath::AdminRumSummary);
        assert_eq!(
            parse_path("/admin/publish/release_so-we-sleep"),
            ApiPath::AdminPublish {
                release_id: "release_so-we-sleep".to_string()
            }
        );
    }

    #[test]
    fn summarizes_site_and_standard_rum_events() {
        let summary = build_rum_summary(
            "rum-log",
            "query-id",
            24,
            "2026-05-24T00:00:00Z".to_string(),
            "2026-05-25T00:00:00Z".to_string(),
            vec![
                rum_row(&[
                    ("event_type", "site_visit"),
                    ("siteSessionId", "session-1"),
                    ("landingPagePath", "/music"),
                    ("referrerHost", "example.com"),
                ]),
                rum_row(&[
                    ("event_type", "page_view"),
                    ("siteSessionId", "session-1"),
                    ("pagePath", "/music"),
                ]),
                rum_row(&[
                    ("event_type", "play_start"),
                    ("siteSessionId", "session-1"),
                    ("playbackSessionId", "playback-1"),
                    ("releaseId", "release_demo"),
                    ("trackId", "track_demo_01"),
                ]),
                rum_row(&[
                    ("event_type", "site_visit"),
                    ("siteSessionId", "session-2"),
                    ("landingPagePath", "/"),
                ]),
                rum_row(&[
                    ("event_type", "page_view"),
                    ("siteSessionId", "session-2"),
                    ("pagePath", "/"),
                ]),
                rum_row(&[
                    ("event_type", "com.amazon.rum.page_view_event"),
                    ("browserName", "Chrome"),
                    ("deviceType", "desktop"),
                    ("countryCode", "US"),
                ]),
            ],
        );

        assert_eq!(summary.visits, 2);
        assert_eq!(summary.page_views, 2);
        assert_eq!(summary.bounces, 1);
        assert_eq!(summary.bounce_rate, 0.5);
        assert_eq!(summary.standard.page_views, 1);
        assert_eq!(summary.browsers[0].value, "Chrome");
        assert_eq!(summary.devices[0].value, "desktop");
        assert_eq!(summary.countries[0].value, "US");
        assert_eq!(summary.referrers[0].value, "(direct)");
        assert_eq!(summary.referrers[1].value, "example.com");
        assert_eq!(summary.unique_playback_sessions, 1);
        assert_eq!(summary.play_starts, 1);
        assert_eq!(summary.pages[0].views, 1);
    }

    #[test]
    fn validates_manifest_stable_ids() {
        assert!(validate_stable_id("song", "song_opening-dream", "songId").is_ok());
        assert!(
            validate_stable_id("recording", "recording_opening-dream_demo", "recordingId").is_ok()
        );
        assert!(validate_stable_id("release", "release_so-we-sleep", "releaseId").is_ok());
        assert!(validate_stable_id("track", "track_so-we-sleep_01", "trackId").is_ok());
        assert!(validate_stable_id("song", "track_so-we-sleep_01", "songId").is_err());
        assert!(validate_stable_id("song", "song_No", "songId").is_err());
        assert!(validate_stable_id("song", "song_ab", "songId").is_err());
    }

    #[test]
    fn rejects_path_like_upload_filenames() {
        assert!(validate_filename("source.wav").is_ok());
        assert!(validate_filename("../source.wav").is_err());
        assert!(validate_filename("folder/source.wav").is_err());
        assert!(validate_filename("source wav.wav").is_err());
    }

    #[test]
    fn infers_lossless_upload_formats() {
        assert_eq!(
            infer_upload_format("source.wav", None)
                .unwrap()
                .content_type,
            "audio/wav"
        );
        assert_eq!(
            infer_upload_format("source.aiff", Some("audio/x-aiff"))
                .unwrap()
                .format,
            "aiff"
        );
        assert_eq!(
            infer_upload_format("source.flac", Some("audio/flac"))
                .unwrap()
                .extension,
            "flac"
        );
        assert!(infer_upload_format("source.mp3", None).is_err());
        assert!(infer_upload_format("source.wav", Some("audio/mpeg")).is_err());
    }

    #[test]
    fn validates_canonical_source_master_keys() {
        let source = DraftSourceMaster {
            bucket: "tsonu-music-masters".to_string(),
            key: "masters/recording_opening-dream_demo/source.wav".to_string(),
            version_id: None,
            etag: None,
            format: Some("wav".to_string()),
            uploaded_at: None,
            sample_rate_hz: None,
            bit_depth: None,
            channels: None,
        };

        assert!(validate_source_master(
            &source,
            "tsonu-music-masters",
            "recording_opening-dream_demo"
        )
        .is_ok());

        let wrong_key = DraftSourceMaster {
            key: "masters/recording_opening-dream_album/source.wav".to_string(),
            ..source
        };
        assert!(validate_source_master(
            &wrong_key,
            "tsonu-music-masters",
            "recording_opening-dream_demo"
        )
        .is_err());
    }

    #[test]
    fn selects_publish_override_or_latest_job() {
        let track = sample_release_track();
        let recording = sample_recording(vec![
            "job_so-we-sleep_01_encode_20260523".to_string(),
            "job_so-we-sleep_01_encode_20260524".to_string(),
        ]);

        assert_eq!(
            select_publish_job_id(&track, &recording, &HashMap::new()).unwrap(),
            "job_so-we-sleep_01_encode_20260524"
        );

        let overrides = HashMap::from([(
            "track_so-we-sleep_01".to_string(),
            "job_so-we-sleep_01_encode_manual".to_string(),
        )]);
        assert_eq!(
            select_publish_job_id(&track, &recording, &overrides).unwrap(),
            "job_so-we-sleep_01_encode_manual"
        );
    }

    #[test]
    fn maps_draft_encode_paths_to_public_job_prefix() {
        assert_eq!(
            public_recording_media_prefix(
                "recording_opening-dream_demo",
                "job_so-we-sleep_01_encode_20260523"
            ),
            "recordings/recording_opening-dream_demo/job_so-we-sleep_01_encode_20260523"
        );
        assert_eq!(
            public_key_for_draft_object(
                "draft/encodes/job_x",
                "recordings/recording_opening-dream_demo/job_x",
                "draft/encodes/job_x/hls/192k/segment_00001.ts"
            )
            .unwrap(),
            "recordings/recording_opening-dream_demo/job_x/hls/192k/segment_00001.ts"
        );
    }

    #[test]
    fn builds_published_track_from_succeeded_encode_job() {
        let song = sample_draft_song();
        let recording = sample_recording(vec!["job_so-we-sleep_01_encode_20260523".to_string()]);
        let track = sample_release_track();
        let job = sample_succeeded_job();
        let public_prefix = public_recording_media_prefix(&recording.recording_id, &job.job_id);

        let published =
            build_published_track(&track, &song, &recording, &job, &public_prefix).unwrap();

        assert_eq!(published.duration_seconds, 181.25);
        assert_eq!(
            published.playback.hls.path,
            "recordings/recording_opening-dream_demo/job_so-we-sleep_01_encode_20260523/hls/master.m3u8"
        );
        assert_eq!(published.song_id, "song_opening-dream");
        assert_eq!(published.recording_id, "recording_opening-dream_demo");
        assert_eq!(published.playback.formats.len(), 3);
        assert!(published
            .playback
            .formats
            .iter()
            .any(|format| format.quality == PlaybackQuality::FlacLossless
                && format.bit_depth == Some(24)));
    }

    #[test]
    fn serializes_published_release_without_private_publish_fields() {
        let draft = sample_draft_release();
        let song = sample_draft_song();
        let recording = sample_recording(vec!["job_so-we-sleep_01_encode_20260523".to_string()]);
        let track = sample_release_track();
        let job = sample_succeeded_job();
        let public_prefix = public_recording_media_prefix(&recording.recording_id, &job.job_id);
        let published_track =
            build_published_track(&track, &song, &recording, &job, &public_prefix).unwrap();
        let release = build_published_release(
            &draft,
            Visibility::Public,
            "2026-05-23T12:00:00Z".to_string(),
            vec![published_track],
        )
        .unwrap();

        let value = serde_json::to_value(release).unwrap();

        assert!(value.get("manifestPath").is_none());
        assert!(value.get("tags").is_none());
        assert!(value["tracks"][0].get("sourceMaster").is_none());
        assert_eq!(value["status"], "published");
    }

    #[test]
    fn validates_draft_documents() {
        let song = json!({
            "schemaVersion": 1,
            "entityType": "draftSong",
            "songId": "song_opening-dream",
            "recordings": [],
            "updatedAt": "2026-05-23T00:00:00Z"
        });
        let release = json!({
            "schemaVersion": 1,
            "entityType": "draftRelease",
            "releaseId": "release_so-we-sleep",
            "tracks": [],
            "updatedAt": "2026-05-23T00:00:00Z"
        });

        assert!(validate_draft_song_document("song_opening-dream", &song).is_ok());
        assert!(validate_draft_release_document("release_so-we-sleep", &release).is_ok());
        assert!(validate_draft_song_document("song_other", &song).is_err());
    }

    #[test]
    fn rejects_ambiguous_or_missing_write_preconditions() {
        let mut headers = HeaderMap::new();
        assert_eq!(
            write_preconditions(&headers).unwrap_err().status,
            StatusCode::PRECONDITION_REQUIRED
        );

        headers.insert("if-match", HeaderValue::from_static("\"etag\""));
        headers.insert("if-none-match", HeaderValue::from_static("*"));

        let error = write_preconditions(&headers).unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert_eq!(error.code, "ambiguous_precondition");
    }

    #[test]
    fn builds_encode_job_event_with_lossless_outputs_and_source_identity() {
        let mut recording = sample_recording(vec![]);
        let source_master = recording.source_master.as_mut().unwrap();
        source_master.version_id = Some("source-version".to_string());
        source_master.etag = Some("\"source-etag\"".to_string());
        let source_master = recording.source_master.as_ref().unwrap();

        let request = EncodeJobRequest {
            song_id: "song_opening-dream".to_string(),
            recording_id: "recording_opening-dream_demo".to_string(),
            job_id: Some("job_so-we-sleep_01_encode_manual".to_string()),
            include_lossless: Some(true),
            requested_by: Some("admin@example.com".to_string()),
        };
        let output = planned_output(
            "job_so-we-sleep_01_encode_manual",
            "tsonu-music-media",
            true,
        );

        let prepared = build_encode_job_event(
            request,
            &recording,
            source_master,
            "job_so-we-sleep_01_encode_manual".to_string(),
            "2026-05-24T00:00:00Z".to_string(),
            output,
            true,
        );

        assert_eq!(prepared.job_key, "jobs/job_so-we-sleep_01_encode_manual");
        assert_eq!(prepared.event.action, ACTION_ENCODE_TRACK);
        assert_eq!(
            prepared.event.requested_by.as_deref(),
            Some("admin@example.com")
        );
        assert_eq!(prepared.event.job, prepared.job);
        assert_eq!(prepared.job.status, EncodeStatus::Queued);
        assert_eq!(
            prepared.job.input.version_id.as_deref(),
            Some("source-version")
        );
        assert_eq!(prepared.job.input.etag.as_deref(), Some("\"source-etag\""));
        assert!(
            prepared
                .job
                .output
                .assets
                .iter()
                .any(|asset| asset.mime_type == "audio/flac"
                    && asset.path.ends_with("/lossless.flac"))
        );
        let ffmpeg_args = &prepared.job.ffmpeg.as_ref().unwrap().args;
        assert!(ffmpeg_args
            .iter()
            .any(|arg| arg == "masters/recording_opening-dream_demo/source.wav"));
        assert!(ffmpeg_args
            .iter()
            .any(|arg| arg.ends_with("/lossless.flac")));
    }

    fn sample_draft_song() -> DraftSong {
        DraftSong {
            schema_version: 1,
            entity_type: "draftSong".to_string(),
            song_id: "song_opening-dream".to_string(),
            slug: "opening-dream".to_string(),
            title: "Opening Dream".to_string(),
            artist_name: "Tsonu".to_string(),
            description: None,
            lyrics: None,
            credits: None,
            tags: Some(vec!["demo".to_string()]),
            recordings: vec![sample_recording(vec![
                "job_so-we-sleep_01_encode_20260523".to_string()
            ])],
        }
    }

    fn sample_draft_release() -> DraftRelease {
        DraftRelease {
            schema_version: 1,
            entity_type: "draftRelease".to_string(),
            release_id: "release_so-we-sleep".to_string(),
            slug: "so-we-sleep".to_string(),
            title: "So We Sleep".to_string(),
            subtitle: None,
            artist_name: "Tsonu".to_string(),
            release_kind: "album".to_string(),
            release_status: "official".to_string(),
            release_date: Some("2026-01-01".to_string()),
            publish_state: "ready".to_string(),
            description: Some("Debut release by Tsonu.".to_string()),
            copyright: None,
            artwork: Some(json!({
                "assetId": "asset_so-we-sleep_cover",
                "altText": "So We Sleep cover art",
                "sources": [
                    {
                        "path": "artwork/so-we-sleep/cover-1024.jpg",
                        "width": 1024,
                        "height": 1024,
                        "mimeType": "image/jpeg"
                    }
                ]
            })),
            credits: None,
            links: None,
            tags: Some(vec!["album".to_string()]),
            tracks: vec![sample_release_track()],
        }
    }

    fn sample_release_track() -> DraftReleaseTrack {
        DraftReleaseTrack {
            track_id: "track_so-we-sleep_01".to_string(),
            song_id: "song_opening-dream".to_string(),
            recording_id: "recording_opening-dream_demo".to_string(),
            disc_number: 1,
            track_number: 1,
            slug: "opening-dream".to_string(),
            title: "Opening Dream".to_string(),
            explicit: None,
            isrc: None,
            description: None,
            credits: None,
        }
    }

    fn sample_recording(encode_job_ids: Vec<String>) -> DraftRecording {
        DraftRecording {
            recording_id: "recording_opening-dream_demo".to_string(),
            slug: "opening-dream-demo".to_string(),
            title: "Opening Dream Demo".to_string(),
            version_title: Some("Demo".to_string()),
            version_type: "demo".to_string(),
            artist_name: None,
            duration_seconds: Some(180.0),
            explicit: false,
            isrc: None,
            description: None,
            source_master: Some(DraftSourceMaster {
                bucket: "tsonu-music-masters".to_string(),
                key: "masters/recording_opening-dream_demo/source.wav".to_string(),
                version_id: None,
                etag: None,
                format: Some("wav".to_string()),
                uploaded_at: None,
                sample_rate_hz: None,
                bit_depth: Some(24),
                channels: None,
            }),
            encode_job_ids,
        }
    }

    fn sample_succeeded_job() -> EncodeJob {
        let job_id = "job_so-we-sleep_01_encode_20260523";
        let mut output = planned_output(job_id, "tsonu-music-media", true);
        for asset in &mut output.assets {
            asset.file_size_bytes = Some(1024);
            asset.checksum_sha256 = Some("a".repeat(64));
        }
        let mut job = EncodeJob::queued(
            job_id.to_string(),
            "song_opening-dream".to_string(),
            "recording_opening-dream_demo".to_string(),
            "2026-05-23T00:00:00Z".to_string(),
            ObjectRef {
                bucket: "tsonu-music-masters".to_string(),
                key: "masters/recording_opening-dream_demo/source.wav".to_string(),
                version_id: None,
                etag: None,
            },
            output.clone(),
        );
        job.mark_succeeded(
            "2026-05-23T00:00:08Z".to_string(),
            output,
            EncodeMetadata {
                duration_seconds: 181.25,
                codec_name: "pcm_s24le".to_string(),
                sample_rate_hz: 48_000,
                channels: 2,
                loudness: None,
            },
            encode_contract::FfmpegDetails {
                version: Some("ffmpeg version 7".to_string()),
                args: vec![],
            },
        );
        job
    }
}
