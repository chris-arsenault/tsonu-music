use crate::{EncoderError, EncoderState};
use encode_contract::{
    recording_files_root_prefix, EncodeJob, EncodeJobEvent, EncodeStatus, ACTION_ENCODE_TRACK,
};

pub(crate) fn validate_encode_event(
    event: &EncodeJobEvent,
    state: &EncoderState,
) -> Result<(), EncoderError> {
    validate_encode_event_targets(event, &state.masters_bucket, &state.media_bucket)
}

pub(crate) fn validate_encode_event_targets(
    event: &EncodeJobEvent,
    masters_bucket: &str,
    media_bucket: &str,
) -> Result<(), EncoderError> {
    if event.action != ACTION_ENCODE_TRACK {
        return Err(EncoderError::InvalidEvent(format!(
            "expected action {ACTION_ENCODE_TRACK}, got {}",
            event.action
        )));
    }

    let expected_job_key = encode_contract::encode_job_key(&event.job.job_id);
    if event.job_key != expected_job_key {
        return Err(EncoderError::InvalidEvent(format!(
            "jobKey must be {expected_job_key}"
        )));
    }

    if event.job.status != EncodeStatus::Queued {
        return Err(EncoderError::InvalidEvent(
            "encode job event must start from queued status".to_string(),
        ));
    }

    if event.job.input.bucket != masters_bucket {
        return Err(EncoderError::InvalidEvent(format!(
            "job input bucket {} does not match configured masters bucket {}",
            event.job.input.bucket, masters_bucket
        )));
    }

    if !event.job.input.key.starts_with("masters/") {
        return Err(EncoderError::InvalidEvent(format!(
            "job input key must be under masters/: {}",
            event.job.input.key
        )));
    }

    if event.job.output.bucket != media_bucket {
        return Err(EncoderError::InvalidEvent(format!(
            "job output bucket {} does not match configured media bucket {}",
            event.job.output.bucket, media_bucket
        )));
    }

    let recording_files_prefix = recording_files_root_prefix(&event.job.recording_id);
    if !event.job.output.prefix.starts_with(&recording_files_prefix) {
        return Err(EncoderError::InvalidEvent(format!(
            "job output prefix must be under {recording_files_prefix}: {}",
            event.job.output.prefix
        )));
    }

    Ok(())
}

pub(crate) fn includes_lossless(job: &EncodeJob) -> bool {
    job.output
        .assets
        .iter()
        .any(|asset| asset.mime_type == "audio/flac")
}
