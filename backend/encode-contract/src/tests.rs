use super::*;

#[test]
fn builds_bounded_job_ids() {
    let long_recording = format!("recording_{}", "a".repeat(140));
    let job_id = build_job_id(&long_recording, "20260523t195530z");

    assert!(job_id.starts_with("job_"));
    assert!(job_id.len() <= 100);
    assert!(job_id.ends_with("_encode_20260523t195530z"));
}

#[test]
fn creates_recording_owned_output_assets() {
    let output = planned_output(
        "recording_so-we-sleep_01",
        "20260523t195530z",
        "media",
        true,
    );

    assert_eq!(
        output.prefix,
        "recordings/recording_so-we-sleep_01/files/20260523t195530z"
    );
    assert_eq!(output.assets.len(), 5);
    assert!(output.assets.iter().all(|asset| asset
        .path
        .starts_with("recordings/recording_so-we-sleep_01/files/")));
    assert!(output
        .assets
        .iter()
        .all(|asset| asset.asset_id.starts_with("file_")));
    assert!(output
        .assets
        .iter()
        .any(|asset| asset.path.ends_with("/metadata.json")));
}

#[test]
fn recording_files_only_from_succeeded_jobs() {
    let output = planned_output("recording_x", "20260523t195530z", "media", false);
    let mut job = EncodeJob::queued(
        "job_x_encode_20260523t195530z".to_string(),
        "song_x".to_string(),
        "recording_x".to_string(),
        "2026-05-23T19:55:30Z".to_string(),
        ObjectRef {
            bucket: "masters".to_string(),
            key: "masters/recording_x/source.wav".to_string(),
            version_id: None,
            etag: None,
        },
        output.clone(),
    );

    // Not yet succeeded
    assert!(RecordingFileSet::from_succeeded_job(&job).is_none());

    job.mark_running("2026-05-23T19:55:31Z".to_string());
    assert!(RecordingFileSet::from_succeeded_job(&job).is_none());

    job.mark_succeeded(
        "2026-05-23T19:55:42Z".to_string(),
        output.clone(),
        EncodeMetadata {
            duration_seconds: 215.4,
            codec_name: "pcm_s16le".to_string(),
            sample_rate_hz: 48_000,
            channels: 2,
            loudness: None,
        },
        FfmpegDetails {
            version: Some("ffmpeg 6.0".to_string()),
            args: vec!["-i".to_string()],
        },
    );

    let files = RecordingFileSet::from_succeeded_job(&job).expect("succeeded job");
    assert_eq!(files.duration_seconds, Some(215.4));
    assert_eq!(files.files.len(), 4);
    assert!(files.files.iter().any(|file| {
        file.kind == RecordingFileKind::HlsMaster
            && file.file_id.starts_with("file_x_20260523t195530z_hls")
    }));
    assert!(files.files.iter().any(|file| {
        file.kind == RecordingFileKind::HlsRendition
            && file.quality == Some(RecordingFileQuality::Aac320)
            && file.bitrate_kbps == Some(320)
            && file.sample_rate_hz == Some(48_000)
    }));
}

#[test]
fn state_transitions_add_timestamps_and_error() {
    let mut job = EncodeJob::queued(
        "job_x_encode_20260523t195530z".to_string(),
        "song_x".to_string(),
        "recording_x".to_string(),
        "2026-05-23T19:55:30Z".to_string(),
        ObjectRef {
            bucket: "masters".to_string(),
            key: "masters/recording_x/source.wav".to_string(),
            version_id: None,
            etag: None,
        },
        planned_output("recording_x", "20260523t195530z", "media", false),
    );

    job.mark_running("2026-05-23T19:55:31Z".to_string());
    job.mark_failed(
        "2026-05-23T19:55:32Z".to_string(),
        "not_implemented",
        "not implemented",
        None,
    );

    assert_eq!(job.status, EncodeStatus::Failed);
    assert_eq!(job.started_at.as_deref(), Some("2026-05-23T19:55:31Z"));
    assert_eq!(job.finished_at.as_deref(), Some("2026-05-23T19:55:32Z"));
    assert_eq!(
        job.error.as_ref().unwrap().code.as_deref(),
        Some("not_implemented")
    );
}
