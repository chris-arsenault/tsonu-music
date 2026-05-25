use crate::{
    ensure_trailing_slash, validate_stable_id, ApiError, DraftRecording, DraftRelease,
    DraftReleaseTrack, DraftSong,
};
use encode_contract::{EncodeJob, EncodeStatus, DRAFT_ENCODE_PREFIX};
use std::collections::{HashMap, HashSet};

pub(crate) fn validate_publishable_release(
    release: &DraftRelease,
    release_id: &str,
) -> Result<(), ApiError> {
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

    if !matches!(
        release.publish_state.as_str(),
        "draft" | "ready" | "published" | "withdrawn"
    ) {
        return Err(ApiError::bad_request(
            "invalid_publish_state",
            "draft release publishState has an invalid value",
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

pub(crate) fn validate_publish_job(
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

pub(crate) fn select_publish_job_id(
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
