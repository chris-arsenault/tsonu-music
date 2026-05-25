use super::AppState;
use crate::{
    build_published_release, build_published_song, build_published_track, db,
    ensure_trailing_slash, public_key_for_draft_object, public_recording_media_prefix,
    select_publish_job_id, validate_publish_job, validate_publishable_release, validate_stable_id,
    ApiError, CloudFrontInvalidationResult, DraftRelease, DraftSong, PublishRequest,
    PublishResponse, PublishedSong, Visibility, WriteResult,
};
use aws_sdk_cloudfront::types::{InvalidationBatch, Paths};
use chrono::{SecondsFormat, Utc};
use encode_contract::EncodeJob;
use serde_json::Value;
use std::collections::HashSet;
use tracing::error;

impl AppState {
    pub(crate) async fn publish_release(
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
            "/catalog".to_string(),
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
}
