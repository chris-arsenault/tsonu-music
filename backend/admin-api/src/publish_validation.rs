use crate::{validate_stable_id, ApiError, DraftRecording, DraftRelease, DraftSong};
use encode_contract::{recording_files_root_prefix, RecordingFileKind, RecordingFileQuality};
use std::collections::HashSet;

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

pub(crate) fn validate_publishable_recording(
    song: &DraftSong,
    recording: &DraftRecording,
) -> Result<(), ApiError> {
    if !song
        .recordings
        .iter()
        .any(|candidate| candidate.recording_id == recording.recording_id)
    {
        return Err(ApiError::bad_request(
            "recording_song_mismatch",
            format!(
                "song {} does not contain recording {}",
                song.song_id, recording.recording_id
            ),
        ));
    }

    if recording.duration_seconds.is_none() {
        return Err(ApiError::bad_request(
            "missing_recording_duration",
            format!(
                "recording {} does not have measured durationSeconds",
                recording.recording_id
            ),
        ));
    }

    let mut has_hls = false;
    let mut has_192 = false;
    let mut has_320 = false;
    let expected_prefix = recording_files_root_prefix(&recording.recording_id);
    for file in &recording.files {
        validate_stable_id("file", &file.file_id, "fileId")?;
        if !file.path.starts_with(&expected_prefix) {
            return Err(ApiError::bad_request(
                "invalid_recording_file_path",
                format!(
                    "recording {} file {} must be under {}",
                    recording.recording_id, file.path, expected_prefix
                ),
            ));
        }

        match (file.kind, file.quality) {
            (RecordingFileKind::HlsMaster, None) => has_hls = true,
            (RecordingFileKind::HlsRendition, Some(RecordingFileQuality::Aac192)) => has_192 = true,
            (RecordingFileKind::HlsRendition, Some(RecordingFileQuality::Aac320)) => has_320 = true,
            _ => {}
        }
    }

    if !(has_hls && has_192 && has_320) {
        return Err(ApiError::bad_request(
            "missing_required_recording_files",
            format!(
                "recording {} must include HLS master, 192k, and 320k files",
                recording.recording_id
            ),
        ));
    }

    Ok(())
}
