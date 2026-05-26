use super::AppState;
use crate::{
    build_published_release, build_published_song, build_published_track, db,
    validate_publishable_recording, validate_publishable_release, ApiError,
    CloudFrontInvalidationResult, DraftRelease, DraftSong, PublishRequest, PublishResponse,
    PublishedSong, Visibility, WriteResult,
};
use aws_sdk_cloudfront::types::{InvalidationBatch, Paths};
use chrono::{SecondsFormat, Utc};
use serde_json::Value;
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
        let mut file_ids = Vec::<String>::new();

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
            validate_publishable_recording(&song, recording)?;

            let published_track = build_published_track(track, &song, recording)?;
            if !file_ids.contains(&published_track.playback.hls.file_id) {
                file_ids.push(published_track.playback.hls.file_id.clone());
            }
            for format in &published_track.playback.formats {
                if !file_ids.contains(&format.file_id) {
                    file_ids.push(format.file_id.clone());
                }
            }
            published_tracks.push(published_track);
            if !published_songs
                .iter()
                .any(|existing| existing.song_id == song.song_id)
            {
                published_songs.push(build_published_song(&song));
            }
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
            file_ids,
            release_write,
            draft_write,
            invalidation: CloudFrontInvalidationResult {
                distribution_id: self.frontend_distribution_id.clone(),
                invalidation_id,
                paths: invalidation_paths,
            },
        })
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

        db::update_draft_release(&self.db, release_id, &document).await
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
