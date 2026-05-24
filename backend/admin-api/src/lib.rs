use aws_sdk_cloudfront::types::{InvalidationBatch, Paths};
use aws_sdk_cloudfront::Client as CloudFrontClient;
use aws_sdk_cloudwatchlogs::types::QueryStatus;
use aws_sdk_cloudwatchlogs::Client as CloudWatchLogsClient;
use aws_sdk_lambda::primitives::Blob;
use aws_sdk_lambda::types::InvocationType;
use aws_sdk_lambda::Client as LambdaClient;
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::Client as S3Client;
use chrono::{Duration as ChronoDuration, SecondsFormat, Utc};
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
const DRAFT_ALBUM_PREFIX: &str = "draft/albums/";
const PUBLIC_ALBUM_PREFIX: &str = "albums/";
const DEFAULT_UPLOAD_URL_EXPIRY_SECONDS: u64 = 900;
const MAX_UPLOAD_URL_EXPIRY_SECONDS: u64 = 3600;
const DEFAULT_RUM_SUMMARY_HOURS: u32 = 24;
const MAX_RUM_SUMMARY_HOURS: u32 = 720;
const MAX_RUM_QUERY_RESULTS: i32 = 10_000;
const RUM_QUERY_POLL_ATTEMPTS: usize = 12;
const RUM_QUERY_POLL_INTERVAL: Duration = Duration::from_millis(500);
const PLAYER_RUM_EVENT_NAMES: &[&str] = &[
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

    async fn create_upload_url(
        &self,
        request: UploadUrlRequest,
    ) -> Result<UploadUrlResponse, ApiError> {
        validate_stable_id("album", &request.album_id, "albumId")?;
        validate_stable_id("track", &request.track_id, "trackId")?;
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

        let key = master_key(
            &request.album_id,
            &request.track_id,
            upload_format.extension,
        );
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
            },
        })
    }

    async fn create_encode_job(
        &self,
        request: EncodeJobRequest,
    ) -> Result<EncodeJobCreateResponse, ApiError> {
        validate_stable_id("album", &request.album_id, "albumId")?;
        validate_stable_id("track", &request.track_id, "trackId")?;

        if let Some(job_id) = &request.job_id {
            validate_stable_id("job", job_id, "jobId")?;
        }

        let album_object = db::get_draft_album(&self.db, &request.album_id).await?;
        let album: DraftAlbum = serde_json::from_str(&album_object.text).map_err(|err| {
            error!(album_id = request.album_id, error = %err, "Stored draft album cannot be parsed for encode job");
            ApiError::internal("invalid_stored_album", "stored draft album cannot be parsed")
        })?;

        if album.album_id != request.album_id {
            return Err(ApiError::bad_request(
                "album_id_mismatch",
                "draft album albumId does not match request albumId",
            ));
        }

        let track = album
            .tracks
            .iter()
            .find(|track| track.track_id == request.track_id)
            .ok_or_else(|| ApiError::not_found("track not found in draft album"))?;

        validate_source_master(
            &track.source_master,
            &self.masters_bucket,
            &request.album_id,
            &request.track_id,
        )?;

        let now = Utc::now();
        let requested_at = now.to_rfc3339_opts(SecondsFormat::Secs, true);
        let timestamp = now
            .format("%Y%m%dT%H%M%SZ")
            .to_string()
            .to_ascii_lowercase();
        let job_id = request
            .job_id
            .clone()
            .unwrap_or_else(|| build_job_id(&request.track_id, &timestamp));
        validate_stable_id("job", &job_id, "jobId")?;

        let include_lossless = request.include_lossless.unwrap_or(false);
        let output = planned_output(&job_id, self.media_bucket.clone(), include_lossless);
        let prepared = build_encode_job_event(
            request,
            track,
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

    async fn publish_album(
        &self,
        album_id: String,
        request: PublishRequest,
    ) -> Result<PublishResponse, ApiError> {
        let album_object = db::get_draft_album(&self.db, &album_id).await?;
        let draft: DraftAlbum = serde_json::from_str(&album_object.text).map_err(|err| {
            error!(album_id, error = %err, "Stored draft album cannot be parsed for publishing");
            ApiError::internal(
                "invalid_stored_album",
                "stored draft album cannot be parsed",
            )
        })?;

        validate_publishable_album(&draft, &album_id)?;
        let visibility = request.visibility.unwrap_or(Visibility::Public);
        let published_at = request
            .published_at
            .unwrap_or_else(|| Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true));

        let mut published_tracks = Vec::with_capacity(draft.tracks.len());
        let mut copied_keys = Vec::new();
        let mut job_ids = Vec::with_capacity(draft.tracks.len());

        for track in &draft.tracks {
            let job_id = select_publish_job_id(track, &request.track_job_ids)?;
            validate_stable_id("job", &job_id, "jobId")?;
            let job = db::get_encode_job(&self.db, &job_id).await?;
            validate_publish_job(&job, &draft, track, &self.media_bucket)?;

            let public_prefix = public_track_media_prefix(&draft.slug, &track.slug, &job.job_id);
            let job_copied_keys = self
                .copy_encode_output_to_public_prefix(&job, &public_prefix)
                .await?;
            copied_keys.extend(job_copied_keys);

            let published_track = build_published_track(track, &job, &public_prefix)?;
            published_tracks.push(published_track);
            job_ids.push(job.job_id);
        }

        published_tracks.sort_by_key(|track| (track.disc_number, track.track_number));
        let total_duration_seconds = published_tracks
            .iter()
            .map(|track| track.duration_seconds)
            .sum::<f64>();

        let published_album =
            build_published_album(&draft, visibility, published_at, published_tracks)?;
        let album_write =
            db::replace_publication(&self.db, &published_album, total_duration_seconds).await?;

        let draft_write = self
            .mark_draft_album_published(&album_id, &album_object)
            .await?;

        let invalidation_paths = vec![
            "/music".to_string(),
            format!("/albums/{}", published_album.slug),
            format!("/tracks/{}/*", published_album.slug),
        ];
        let invalidation_id = self
            .invalidate_manifest_paths(&album_id, invalidation_paths.clone())
            .await?;

        Ok(PublishResponse {
            album_id,
            release_id: published_album.release_id,
            manifest_path: published_album.manifest_path,
            visibility: published_album.visibility,
            job_ids,
            copied_object_count: copied_keys.len(),
            copied_keys,
            album_write,
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

        Ok(build_rum_summary(
            &self.rum_log_group_name,
            query_id,
            query.hours,
            start_time.to_rfc3339_opts(SecondsFormat::Secs, true),
            end_time.to_rfc3339_opts(SecondsFormat::Secs, true),
            rows,
        ))
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

    async fn mark_draft_album_published(
        &self,
        album_id: &str,
        source: &db::DbJsonObject,
    ) -> Result<WriteResult, ApiError> {
        let mut document: Value = serde_json::from_str(&source.text).map_err(|err| {
            error!(album_id, error = %err, "Stored draft album is invalid JSON");
            ApiError::internal("invalid_stored_json", "stored draft album is invalid JSON")
        })?;

        let object = document.as_object_mut().ok_or_else(|| {
            ApiError::internal(
                "invalid_stored_album",
                "stored draft album is not an object",
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

        db::put_draft_album(&self.db, album_id, &document, source.e_tag.as_deref(), None).await
    }

    async fn invalidate_manifest_paths(
        &self,
        album_id: &str,
        paths: Vec<String>,
    ) -> Result<Option<String>, ApiError> {
        let invalidation_paths = Paths::builder()
            .quantity(paths.len() as i32)
            .set_items(Some(paths))
            .build()
            .map_err(|err| {
                error!(album_id, error = %err, "Failed to build CloudFront invalidation paths");
                ApiError::internal(
                    "cloudfront_invalidation_build_failed",
                    "failed to build CloudFront invalidation request",
                )
            })?;
        let caller_reference = format!(
            "publish-{album_id}-{}",
            Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
        );
        let batch = InvalidationBatch::builder()
            .paths(invalidation_paths)
            .caller_reference(caller_reference)
            .build()
            .map_err(|err| {
                error!(album_id, error = %err, "Failed to build CloudFront invalidation batch");
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
                error!(album_id, error = %err, "Failed to create CloudFront invalidation");
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
        (&Method::GET, ApiPath::PublicAlbum { slug }) => {
            validate_slug(&slug, "albumSlug")?;
            let album = db::get_public_album_by_slug(&state.db, &slug).await?;
            raw_json_response(StatusCode::OK, album.text, album.e_tag.as_deref(), None)
        }
        (&Method::GET, ApiPath::AdminAlbums) => {
            json_response(StatusCode::OK, db::list_draft_albums(&state.db).await?)
        }
        (&Method::GET, ApiPath::AdminAlbum { album_id }) => {
            validate_stable_id("album", &album_id, "albumId")?;
            let album = db::get_draft_album(&state.db, &album_id).await?;
            raw_json_response(StatusCode::OK, album.text, album.e_tag.as_deref(), None)
        }
        (&Method::PUT, ApiPath::AdminAlbum { album_id }) => {
            validate_stable_id("album", &album_id, "albumId")?;
            let preconditions = write_preconditions(request.headers())?;
            let mut document: Value = parse_json_body(request.body())?;
            validate_draft_album_document(&album_id, &document)?;
            normalize_updated_at(&mut document);
            let result = db::put_draft_album(
                &state.db,
                &album_id,
                &document,
                preconditions.if_match.as_deref(),
                preconditions.if_none_match.as_deref(),
            )
            .await?;
            json_response(StatusCode::OK, result)
        }
        (&Method::PUT, ApiPath::AdminTrack { album_id, track_id }) => {
            validate_stable_id("album", &album_id, "albumId")?;
            validate_stable_id("track", &track_id, "trackId")?;
            let preconditions = required_if_match(request.headers())?;
            let track: Value = parse_json_body(request.body())?;
            let album = db::get_draft_album(&state.db, &album_id).await?;
            let mut document: Value = serde_json::from_str(&album.text).map_err(|err| {
                error!(album_id, error = %err, "Stored draft album is invalid JSON");
                ApiError::internal("invalid_stored_json", "stored draft album is invalid JSON")
            })?;

            let created = upsert_track_document(&mut document, &album_id, &track_id, track)?;
            let result = db::put_draft_album(
                &state.db,
                &album_id,
                &document,
                preconditions.if_match.as_deref(),
                preconditions.if_none_match.as_deref(),
            )
            .await?;

            json_response(
                if created {
                    StatusCode::CREATED
                } else {
                    StatusCode::OK
                },
                TrackWriteResponse {
                    album_id,
                    track_id,
                    created,
                    write: result,
                },
            )
        }
        (&Method::DELETE, ApiPath::AdminTrack { album_id, track_id }) => {
            validate_stable_id("album", &album_id, "albumId")?;
            validate_stable_id("track", &track_id, "trackId")?;
            let preconditions = required_if_match(request.headers())?;
            let album = db::get_draft_album(&state.db, &album_id).await?;
            let mut document: Value = serde_json::from_str(&album.text).map_err(|err| {
                error!(album_id, error = %err, "Stored draft album is invalid JSON");
                ApiError::internal("invalid_stored_json", "stored draft album is invalid JSON")
            })?;

            remove_track_document(&mut document, &album_id, &track_id)?;
            let result = db::put_draft_album(
                &state.db,
                &album_id,
                &document,
                preconditions.if_match.as_deref(),
                preconditions.if_none_match.as_deref(),
            )
            .await?;

            json_response(
                StatusCode::OK,
                TrackWriteResponse {
                    album_id,
                    track_id,
                    created: false,
                    write: result,
                },
            )
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
        (&Method::POST, ApiPath::AdminPublish { album_id }) => {
            validate_stable_id("album", &album_id, "albumId")?;
            let request = parse_optional_json_body::<PublishRequest>(request.body())?;
            json_response(
                StatusCode::OK,
                state.publish_album(album_id, request).await?,
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
        ["catalog", "albums", slug] => ApiPath::PublicAlbum {
            slug: (*slug).to_string(),
        },
        ["admin", "catalog"] => ApiPath::AdminCatalog,
        ["admin", "albums"] => ApiPath::AdminAlbums,
        ["admin", "albums", album_id] => ApiPath::AdminAlbum {
            album_id: (*album_id).to_string(),
        },
        ["admin", "albums", album_id, "tracks", track_id] => ApiPath::AdminTrack {
            album_id: (*album_id).to_string(),
            track_id: (*track_id).to_string(),
        },
        ["admin", "jobs"] => ApiPath::AdminJobs,
        ["admin", "jobs", job_id] => ApiPath::AdminJob {
            job_id: (*job_id).to_string(),
        },
        ["admin", "rum", "summary"] => ApiPath::AdminRumSummary,
        ["admin", "upload-url"] => ApiPath::AdminUploadUrl,
        ["admin", "encode-jobs"] => ApiPath::AdminEncodeJobs,
        ["admin", "publish", album_id] => ApiPath::AdminPublish {
            album_id: (*album_id).to_string(),
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

fn build_player_rum_query() -> String {
    let event_names = PLAYER_RUM_EVENT_NAMES
        .iter()
        .map(|event_name| format!("\"{event_name}\""))
        .collect::<Vec<_>>()
        .join(", ");

    format!(
        "fields @timestamp, event_type, event_details.albumId as albumId, event_details.releaseId as releaseId, event_details.trackId as trackId, event_details.playbackSessionId as playbackSessionId, event_details.selectedQuality as selectedQuality, event_details.errorName as errorName, event_details.errorMessage as errorMessage | filter event_type in [{event_names}] | sort @timestamp desc | limit {MAX_RUM_QUERY_RESULTS}"
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
    let mut album_counts = HashMap::<String, RumAggregate>::new();
    let mut track_counts = HashMap::<String, RumTrackAggregate>::new();
    let mut playback_sessions = HashSet::<String>::new();
    let mut recent_errors = Vec::<RumRecentError>::new();

    for row in &rows {
        let Some(event_type) = query_row_value(row, "event_type") else {
            continue;
        };
        if !PLAYER_RUM_EVENT_NAMES.contains(&event_type) {
            continue;
        }

        *event_counts.entry(event_type.to_string()).or_default() += 1;

        if let Some(session_id) = query_row_value(row, "playbackSessionId") {
            playback_sessions.insert(session_id.to_string());
        }

        if let Some(album_id) = query_row_value(row, "albumId") {
            album_counts
                .entry(album_id.to_string())
                .or_default()
                .record(event_type);

            if let Some(track_id) = query_row_value(row, "trackId") {
                let track_key = format!("{album_id}/{track_id}");
                track_counts
                    .entry(track_key)
                    .or_insert_with(|| RumTrackAggregate {
                        album_id: album_id.to_string(),
                        track_id: track_id.to_string(),
                        counts: RumAggregate::default(),
                    })
                    .counts
                    .record(event_type);
            }
        }

        if event_type == "play_error" && recent_errors.len() < 10 {
            recent_errors.push(RumRecentError {
                timestamp: query_row_value(row, "@timestamp").map(str::to_string),
                album_id: query_row_value(row, "albumId").map(str::to_string),
                track_id: query_row_value(row, "trackId").map(str::to_string),
                error_name: query_row_value(row, "errorName").map(str::to_string),
                error_message: query_row_value(row, "errorMessage").map(str::to_string),
            });
        }
    }

    let mut albums = album_counts
        .into_iter()
        .map(|(album_id, counts)| RumAlbumSummary {
            album_id,
            total_events: counts.total_events,
            play_starts: counts.play_starts,
            play_completes: counts.play_completes,
            player_errors: counts.player_errors,
        })
        .collect::<Vec<_>>();
    albums.sort_by(|left, right| {
        right
            .total_events
            .cmp(&left.total_events)
            .then_with(|| left.album_id.cmp(&right.album_id))
    });

    let mut tracks = track_counts
        .into_values()
        .map(|track| RumTrackSummary {
            album_id: track.album_id,
            track_id: track.track_id,
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
            .then_with(|| left.album_id.cmp(&right.album_id))
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

    RumSummaryResponse {
        log_group_name: log_group_name.to_string(),
        query_id: query_id.to_string(),
        window_hours,
        start_time,
        end_time,
        result_limit: MAX_RUM_QUERY_RESULTS,
        truncated: rows.len() >= MAX_RUM_QUERY_RESULTS as usize,
        total_events,
        unique_playback_sessions: playback_sessions.len() as u64,
        play_starts,
        play_completes,
        play_completion_rate: ratio(play_completes, play_starts),
        player_errors: event_count(&event_counts, "play_error"),
        progress_25: event_count(&event_counts, "play_progress_25"),
        progress_50: event_count(&event_counts, "play_progress_50"),
        progress_75: event_count(&event_counts, "play_progress_75"),
        events,
        albums,
        tracks,
        recent_errors,
    }
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

fn required_if_match(headers: &HeaderMap) -> Result<WritePreconditions, ApiError> {
    let if_match = optional_header(headers, "if-match")?.ok_or_else(|| {
        ApiError::precondition_required("send If-Match: <album etag> when editing tracks")
    })?;

    Ok(WritePreconditions {
        if_match: Some(if_match),
        if_none_match: None,
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

fn validate_draft_album_document(album_id: &str, document: &Value) -> Result<(), ApiError> {
    let object = document.as_object().ok_or_else(|| {
        ApiError::bad_request(
            "invalid_album",
            "draft album document must be a JSON object",
        )
    })?;

    require_string_field(object.get("entityType"), "entityType", "draftAlbum")?;
    require_string_field(object.get("albumId"), "albumId", album_id)?;

    if !object.get("tracks").is_some_and(Value::is_array) {
        return Err(ApiError::bad_request(
            "invalid_album",
            "draft album document must include a tracks array",
        ));
    }

    Ok(())
}

fn validate_source_master(
    source_master: &DraftSourceMaster,
    masters_bucket: &str,
    album_id: &str,
    track_id: &str,
) -> Result<(), ApiError> {
    if source_master.bucket != masters_bucket {
        return Err(ApiError::bad_request(
            "invalid_source_master_bucket",
            "track sourceMaster bucket does not match the configured masters bucket",
        ));
    }

    let expected_prefix = format!("masters/{album_id}/{track_id}/source.");
    if !source_master.key.starts_with(&expected_prefix) {
        return Err(ApiError::bad_request(
            "invalid_source_master_key",
            format!("track sourceMaster key must start with {expected_prefix}"),
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
            "track sourceMaster key must end with wav, aif, aiff, or flac",
        ));
    }

    Ok(())
}

fn validate_publishable_album(album: &DraftAlbum, album_id: &str) -> Result<(), ApiError> {
    if album.schema_version != 1 {
        return Err(ApiError::bad_request(
            "invalid_album_schema_version",
            "draft album schemaVersion must be 1",
        ));
    }

    if album.entity_type != "draftAlbum" {
        return Err(ApiError::bad_request(
            "invalid_album_entity_type",
            "draft album entityType must be draftAlbum",
        ));
    }

    if album.album_id != album_id {
        return Err(ApiError::bad_request(
            "album_id_mismatch",
            "draft album albumId does not match request albumId",
        ));
    }

    if !matches!(album.publish_state.as_str(), "ready" | "published") {
        return Err(ApiError::bad_request(
            "album_not_ready",
            "draft album publishState must be ready or published before publishing",
        ));
    }

    if album.release_date.as_deref().is_none_or(str::is_empty) {
        return Err(ApiError::bad_request(
            "missing_release_date",
            "published albums require releaseDate",
        ));
    }

    if album.artwork.is_none() {
        return Err(ApiError::bad_request(
            "missing_artwork",
            "published albums require artwork",
        ));
    }

    if album.tracks.is_empty() {
        return Err(ApiError::bad_request(
            "missing_tracks",
            "published albums require at least one track",
        ));
    }

    let mut track_ids = HashSet::new();
    let mut track_positions = HashSet::new();
    for track in &album.tracks {
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

        if track.duration_seconds <= 0.0 {
            return Err(ApiError::bad_request(
                "invalid_track_duration",
                format!("track {} durationSeconds must be positive", track.track_id),
            ));
        }
    }

    Ok(())
}

fn validate_publish_job(
    job: &EncodeJob,
    album: &DraftAlbum,
    track: &DraftTrack,
    media_bucket: &str,
) -> Result<(), ApiError> {
    if job.status != EncodeStatus::Succeeded {
        return Err(ApiError::bad_request(
            "encode_job_not_succeeded",
            format!("encode job {} is not succeeded", job.job_id),
        ));
    }

    if job.album_id != album.album_id || job.track_id != track.track_id {
        return Err(ApiError::bad_request(
            "encode_job_mismatch",
            format!(
                "encode job {} does not match album {} track {}",
                job.job_id, album.album_id, track.track_id
            ),
        ));
    }

    if job.input.bucket != track.source_master.bucket || job.input.key != track.source_master.key {
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
    track: &DraftTrack,
    overrides: &HashMap<String, String>,
) -> Result<String, ApiError> {
    if let Some(job_id) = overrides.get(&track.track_id) {
        return Ok(job_id.clone());
    }

    track.encode_job_ids.last().cloned().ok_or_else(|| {
        ApiError::bad_request(
            "missing_encode_job",
            format!(
                "track {} has no encodeJobIds and no publish override",
                track.track_id
            ),
        )
    })
}

fn build_published_album(
    draft: &DraftAlbum,
    visibility: Visibility,
    published_at: String,
    tracks: Vec<PublishedTrack>,
) -> Result<PublishedAlbum, ApiError> {
    Ok(PublishedAlbum {
        schema_version: 1,
        entity_type: AlbumEntityType::Album,
        album_id: draft.album_id.clone(),
        release_id: draft.release_id.clone(),
        slug: draft.slug.clone(),
        title: draft.title.clone(),
        subtitle: draft.subtitle.clone(),
        artist_name: draft.artist_name.clone(),
        release_type: draft.release_type.clone(),
        release_date: draft.release_date.clone().ok_or_else(|| {
            ApiError::bad_request(
                "missing_release_date",
                "published albums require releaseDate",
            )
        })?,
        status: PublishedStatus::Published,
        visibility,
        published_at,
        manifest_path: published_album_api_path(&draft.slug),
        description: draft.description.clone(),
        copyright: draft.copyright.clone(),
        artwork: draft.artwork.clone().ok_or_else(|| {
            ApiError::bad_request("missing_artwork", "published albums require artwork")
        })?,
        credits: draft.credits.clone(),
        links: draft.links.clone(),
        tags: draft.tags.clone(),
        tracks,
    })
}

fn build_published_track(
    track: &DraftTrack,
    job: &EncodeJob,
    public_prefix: &str,
) -> Result<PublishedTrack, ApiError> {
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
            bit_depth: track.source_master.bit_depth,
        })?);
    }

    Ok(PublishedTrack {
        track_id: track.track_id.clone(),
        disc_number: track.disc_number,
        track_number: track.track_number,
        slug: track.slug.clone(),
        title: track.title.clone(),
        duration_seconds: metadata.duration_seconds,
        explicit: track.explicit,
        isrc: track.isrc.clone(),
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

fn public_track_media_prefix(album_slug: &str, track_slug: &str, job_id: &str) -> String {
    format!("{PUBLIC_ALBUM_PREFIX}{album_slug}/tracks/{track_slug}/{job_id}")
}

fn published_album_api_path(album_slug: &str) -> String {
    format!("/catalog/albums/{album_slug}")
}

struct PreparedEncodeJob {
    job: EncodeJob,
    job_key: String,
    event: EncodeJobEvent,
}

fn build_encode_job_event(
    request: EncodeJobRequest,
    track: &DraftTrack,
    job_id: String,
    requested_at: String,
    output: encode_contract::EncodeOutput,
    include_lossless: bool,
) -> PreparedEncodeJob {
    let mut job = EncodeJob::queued(
        job_id.clone(),
        request.album_id.clone(),
        request.track_id.clone(),
        requested_at,
        ObjectRef {
            bucket: track.source_master.bucket.clone(),
            key: track.source_master.key.clone(),
            version_id: track.source_master.version_id.clone(),
            etag: track.source_master.etag.clone(),
        },
        output,
    );
    job.ffmpeg = Some(encode_contract::FfmpegDetails {
        version: None,
        args: planned_ffmpeg_args(&track.source_master.key, &job.output, include_lossless),
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

fn upsert_track_document(
    album: &mut Value,
    album_id: &str,
    track_id: &str,
    track: Value,
) -> Result<bool, ApiError> {
    validate_draft_album_document(album_id, album)?;

    let track_object = track.as_object().ok_or_else(|| {
        ApiError::bad_request("invalid_track", "track payload must be a JSON object")
    })?;
    require_string_field(track_object.get("trackId"), "trackId", track_id)?;

    let tracks = album
        .get_mut("tracks")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| ApiError::bad_request("invalid_album", "tracks must be an array"))?;

    if let Some(existing) = tracks.iter_mut().find(|existing| {
        existing
            .get("trackId")
            .and_then(Value::as_str)
            .is_some_and(|existing_id| existing_id == track_id)
    }) {
        *existing = track;
        normalize_updated_at(album);
        return Ok(false);
    } else {
        tracks.push(track);
    }

    normalize_updated_at(album);
    Ok(true)
}

fn remove_track_document(
    album: &mut Value,
    album_id: &str,
    track_id: &str,
) -> Result<(), ApiError> {
    validate_draft_album_document(album_id, album)?;

    let tracks = album
        .get_mut("tracks")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| ApiError::bad_request("invalid_album", "tracks must be an array"))?;
    let original_len = tracks.len();
    tracks.retain(|track| {
        track
            .get("trackId")
            .and_then(Value::as_str)
            .is_none_or(|existing_id| existing_id != track_id)
    });

    if tracks.len() == original_len {
        return Err(ApiError::not_found("track not found"));
    }

    normalize_updated_at(album);
    Ok(())
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

fn master_key(album_id: &str, track_id: &str, extension: &str) -> String {
    format!("masters/{album_id}/{track_id}/source.{extension}")
}

fn draft_album_key(album_id: &str) -> String {
    format!("{DRAFT_ALBUM_PREFIX}{album_id}.json")
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
    PublicAlbum { slug: String },
    AdminCatalog,
    AdminAlbums,
    AdminAlbum { album_id: String },
    AdminTrack { album_id: String, track_id: String },
    AdminJobs,
    AdminJob { job_id: String },
    AdminRumSummary,
    AdminUploadUrl,
    AdminEncodeJobs,
    AdminPublish { album_id: String },
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
    album_id: String,
    track_id: String,
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
struct SourceMasterDraft {
    bucket: String,
    key: String,
    format: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncodeJobRequest {
    album_id: String,
    track_id: String,
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
    album_id: String,
    release_id: String,
    manifest_path: String,
    visibility: Visibility,
    job_ids: Vec<String>,
    copied_object_count: usize,
    copied_keys: Vec<String>,
    album_write: WriteResult,
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
    unique_playback_sessions: u64,
    play_starts: u64,
    play_completes: u64,
    play_completion_rate: f64,
    player_errors: u64,
    progress_25: u64,
    progress_50: u64,
    progress_75: u64,
    events: Vec<RumEventCount>,
    albums: Vec<RumAlbumSummary>,
    tracks: Vec<RumTrackSummary>,
    recent_errors: Vec<RumRecentError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RumEventCount {
    event_type: String,
    count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RumAlbumSummary {
    album_id: String,
    total_events: u64,
    play_starts: u64,
    play_completes: u64,
    player_errors: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RumTrackSummary {
    album_id: String,
    track_id: String,
    total_events: u64,
    play_starts: u64,
    play_completes: u64,
    player_errors: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RumRecentError {
    #[serde(skip_serializing_if = "Option::is_none")]
    timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    album_id: Option<String>,
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
    album_id: String,
    track_id: String,
    counts: RumAggregate,
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
struct DraftAlbum {
    schema_version: u8,
    entity_type: String,
    album_id: String,
    release_id: String,
    slug: String,
    title: String,
    #[serde(default)]
    subtitle: Option<String>,
    artist_name: String,
    release_type: String,
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
    tracks: Vec<DraftTrack>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftTrack {
    track_id: String,
    disc_number: u32,
    track_number: u32,
    slug: String,
    title: String,
    duration_seconds: f64,
    explicit: bool,
    #[serde(default)]
    isrc: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    credits: Option<Value>,
    source_master: DraftSourceMaster,
    #[serde(default)]
    encode_job_ids: Vec<String>,
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
    bit_depth: Option<u32>,
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
enum AlbumEntityType {
    Album,
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

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PublishedAlbum {
    schema_version: u8,
    entity_type: AlbumEntityType,
    album_id: String,
    release_id: String,
    slug: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    subtitle: Option<String>,
    artist_name: String,
    release_type: String,
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
    tracks: Vec<PublishedTrack>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PublishedTrack {
    track_id: String,
    disc_number: u32,
    track_number: u32,
    slug: String,
    title: String,
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

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TrackPlayback {
    hls: PlaybackHls,
    formats: Vec<PlaybackFormat>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PlaybackHls {
    asset_id: String,
    path: String,
    mime_type: String,
    codecs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
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

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum PlaybackFormatKind {
    HlsRendition,
    Download,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum PlaybackQuality {
    Aac192,
    Aac320,
    FlacLossless,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PublishedCatalog {
    schema_version: u8,
    entity_type: CatalogEntityType,
    generated_at: String,
    artist: CatalogArtist,
    albums: Vec<PublishedCatalogAlbum>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CatalogArtist {
    name: String,
    slug: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PublishedCatalogAlbum {
    album_id: String,
    release_id: String,
    slug: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    subtitle: Option<String>,
    release_type: String,
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
struct TrackWriteResponse {
    album_id: String,
    track_id: String,
    created: bool,
    write: WriteResult,
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

    #[test]
    fn parses_admin_paths() {
        assert_eq!(parse_path("/health"), ApiPath::Health);
        assert_eq!(parse_path("/admin/catalog"), ApiPath::AdminCatalog);
        assert_eq!(parse_path("/admin/albums"), ApiPath::AdminAlbums);
        assert_eq!(
            parse_path("/admin/albums/album_so-we-sleep"),
            ApiPath::AdminAlbum {
                album_id: "album_so-we-sleep".to_string()
            }
        );
        assert_eq!(
            parse_path("/admin/albums/album_so-we-sleep/tracks/track_so-we-sleep_01"),
            ApiPath::AdminTrack {
                album_id: "album_so-we-sleep".to_string(),
                track_id: "track_so-we-sleep_01".to_string()
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
            parse_path("/admin/publish/album_so-we-sleep"),
            ApiPath::AdminPublish {
                album_id: "album_so-we-sleep".to_string()
            }
        );
    }

    #[test]
    fn validates_manifest_stable_ids() {
        assert!(validate_stable_id("album", "album_so-we-sleep", "albumId").is_ok());
        assert!(validate_stable_id("track", "track_so-we-sleep_01", "trackId").is_ok());
        assert!(validate_stable_id("album", "track_so-we-sleep_01", "albumId").is_err());
        assert!(validate_stable_id("album", "album_No", "albumId").is_err());
        assert!(validate_stable_id("album", "album_ab", "albumId").is_err());
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
            key: "masters/album_so-we-sleep/track_so-we-sleep_01/source.wav".to_string(),
            version_id: None,
            etag: None,
            bit_depth: None,
        };

        assert!(validate_source_master(
            &source,
            "tsonu-music-masters",
            "album_so-we-sleep",
            "track_so-we-sleep_01"
        )
        .is_ok());

        let wrong_key = DraftSourceMaster {
            key: "masters/album_so-we-sleep/track_so-we-sleep_02/source.wav".to_string(),
            ..source
        };
        assert!(validate_source_master(
            &wrong_key,
            "tsonu-music-masters",
            "album_so-we-sleep",
            "track_so-we-sleep_01"
        )
        .is_err());
    }

    #[test]
    fn selects_publish_override_or_latest_job() {
        let track = sample_draft_track(vec![
            "job_so-we-sleep_01_encode_20260523".to_string(),
            "job_so-we-sleep_01_encode_20260524".to_string(),
        ]);

        assert_eq!(
            select_publish_job_id(&track, &HashMap::new()).unwrap(),
            "job_so-we-sleep_01_encode_20260524"
        );

        let overrides = HashMap::from([(
            "track_so-we-sleep_01".to_string(),
            "job_so-we-sleep_01_encode_manual".to_string(),
        )]);
        assert_eq!(
            select_publish_job_id(&track, &overrides).unwrap(),
            "job_so-we-sleep_01_encode_manual"
        );
    }

    #[test]
    fn maps_draft_encode_paths_to_public_job_prefix() {
        assert_eq!(
            public_track_media_prefix(
                "so-we-sleep",
                "opening-dream",
                "job_so-we-sleep_01_encode_20260523"
            ),
            "albums/so-we-sleep/tracks/opening-dream/job_so-we-sleep_01_encode_20260523"
        );
        assert_eq!(
            public_key_for_draft_object(
                "draft/encodes/job_x",
                "albums/so-we-sleep/tracks/opening-dream/job_x",
                "draft/encodes/job_x/hls/192k/segment_00001.ts"
            )
            .unwrap(),
            "albums/so-we-sleep/tracks/opening-dream/job_x/hls/192k/segment_00001.ts"
        );
    }

    #[test]
    fn builds_published_track_from_succeeded_encode_job() {
        let track = sample_draft_track(vec!["job_so-we-sleep_01_encode_20260523".to_string()]);
        let job = sample_succeeded_job();
        let public_prefix = public_track_media_prefix(&"so-we-sleep", &track.slug, &job.job_id);

        let published = build_published_track(&track, &job, &public_prefix).unwrap();

        assert_eq!(published.duration_seconds, 181.25);
        assert_eq!(
            published.playback.hls.path,
            "albums/so-we-sleep/tracks/opening-dream/job_so-we-sleep_01_encode_20260523/hls/master.m3u8"
        );
        assert_eq!(published.playback.formats.len(), 3);
        assert!(published
            .playback
            .formats
            .iter()
            .any(|format| format.quality == PlaybackQuality::FlacLossless
                && format.bit_depth == Some(24)));
    }

    #[test]
    fn serializes_published_album_without_private_publish_fields() {
        let draft = sample_draft_album();
        let track = sample_draft_track(vec!["job_so-we-sleep_01_encode_20260523".to_string()]);
        let job = sample_succeeded_job();
        let public_prefix = public_track_media_prefix(&draft.slug, &track.slug, &job.job_id);
        let published_track = build_published_track(&track, &job, &public_prefix).unwrap();
        let album = build_published_album(
            &draft,
            Visibility::Public,
            "2026-05-23T12:00:00Z".to_string(),
            vec![published_track],
        )
        .unwrap();

        let value = serde_json::to_value(album).unwrap();

        assert!(value.get("manifestPath").is_none());
        assert!(value.get("tags").is_none());
        assert!(value["tracks"][0].get("sourceMaster").is_none());
        assert_eq!(value["status"], "published");
    }

    #[test]
    fn upserts_track_without_replacing_album_fields() {
        let mut album = json!({
            "schemaVersion": 1,
            "entityType": "draftAlbum",
            "albumId": "album_so-we-sleep",
            "tracks": [
                { "trackId": "track_so-we-sleep_01", "title": "Old" }
            ],
            "updatedAt": "2026-05-23T00:00:00Z"
        });
        let track = json!({ "trackId": "track_so-we-sleep_01", "title": "New" });

        let created = upsert_track_document(
            &mut album,
            "album_so-we-sleep",
            "track_so-we-sleep_01",
            track,
        )
        .unwrap();

        assert!(!created);
        assert_eq!(album["tracks"][0]["title"], "New");
        assert_eq!(album["albumId"], "album_so-we-sleep");
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
        let mut track = sample_draft_track(vec![]);
        track.source_master.version_id = Some("source-version".to_string());
        track.source_master.etag = Some("\"source-etag\"".to_string());

        let request = EncodeJobRequest {
            album_id: "album_so-we-sleep".to_string(),
            track_id: "track_so-we-sleep_01".to_string(),
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
            &track,
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
            .any(|arg| arg == "masters/album_so-we-sleep/track_so-we-sleep_01/source.wav"));
        assert!(ffmpeg_args
            .iter()
            .any(|arg| arg.ends_with("/lossless.flac")));
    }

    fn sample_draft_album() -> DraftAlbum {
        DraftAlbum {
            schema_version: 1,
            entity_type: "draftAlbum".to_string(),
            album_id: "album_so-we-sleep".to_string(),
            release_id: "release_so-we-sleep_2026".to_string(),
            slug: "so-we-sleep".to_string(),
            title: "So We Sleep".to_string(),
            subtitle: None,
            artist_name: "Tsonu".to_string(),
            release_type: "album".to_string(),
            release_date: Some("2026-01-01".to_string()),
            publish_state: "ready".to_string(),
            description: Some("Debut album by Tsonu.".to_string()),
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
            tracks: vec![sample_draft_track(vec![
                "job_so-we-sleep_01_encode_20260523".to_string(),
            ])],
        }
    }

    fn sample_draft_track(encode_job_ids: Vec<String>) -> DraftTrack {
        DraftTrack {
            track_id: "track_so-we-sleep_01".to_string(),
            disc_number: 1,
            track_number: 1,
            slug: "opening-dream".to_string(),
            title: "Opening Dream".to_string(),
            duration_seconds: 180.0,
            explicit: false,
            isrc: None,
            description: None,
            credits: None,
            source_master: DraftSourceMaster {
                bucket: "tsonu-music-masters".to_string(),
                key: "masters/album_so-we-sleep/track_so-we-sleep_01/source.wav".to_string(),
                version_id: None,
                etag: None,
                bit_depth: Some(24),
            },
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
            "album_so-we-sleep".to_string(),
            "track_so-we-sleep_01".to_string(),
            "2026-05-23T00:00:00Z".to_string(),
            ObjectRef {
                bucket: "tsonu-music-masters".to_string(),
                key: "masters/album_so-we-sleep/track_so-we-sleep_01/source.wav".to_string(),
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
