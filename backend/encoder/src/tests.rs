use super::*;
use crate::handler::{first_nonempty_line, requested_action};
use encode_contract::{
    planned_output, EncodeJob, EncodeJobEvent, ObjectRef, ACTION_ENCODE_TRACK,
    ACTION_PACKAGING_CHECK,
};
use serde_json::json;
use std::path::{Path, PathBuf};

#[test]
fn defaults_missing_action_to_packaging_check() {
    assert_eq!(requested_action(&json!({})), ACTION_PACKAGING_CHECK);
}

#[test]
fn reads_explicit_action() {
    assert_eq!(
        requested_action(&json!({ "action": ACTION_ENCODE_TRACK })),
        ACTION_ENCODE_TRACK
    );
}

#[test]
fn extracts_first_nonempty_version_line() {
    assert_eq!(
        first_nonempty_line("\n\nffmpeg version 7.0.2-static\nbuilt with gcc"),
        Some("ffmpeg version 7.0.2-static".to_string())
    );
}

#[test]
fn validates_encode_event_contract() {
    let job = EncodeJob::queued(
        "job_so-we-sleep_01_encode_20260523".to_string(),
        "song_so-we-sleep_01".to_string(),
        "recording_so-we-sleep_01".to_string(),
        "2026-05-23T19:55:30Z".to_string(),
        ObjectRef {
            bucket: "masters".to_string(),
            key: "masters/recording_so-we-sleep_01/source.wav".to_string(),
            version_id: None,
            etag: None,
        },
        planned_output("job_so-we-sleep_01_encode_20260523", "media", false),
    );
    let event = EncodeJobEvent {
        action: ACTION_ENCODE_TRACK.to_string(),
        job_key: "jobs/job_so-we-sleep_01_encode_20260523".to_string(),
        job,
        requested_by: None,
    };

    assert!(validate_encode_event_targets(&event, "masters", "media").is_ok());
}

#[test]
fn rejects_non_queued_encode_event() {
    let mut job = EncodeJob::queued(
        "job_so-we-sleep_01_encode_20260523".to_string(),
        "song_so-we-sleep_01".to_string(),
        "recording_so-we-sleep_01".to_string(),
        "2026-05-23T19:55:30Z".to_string(),
        ObjectRef {
            bucket: "masters".to_string(),
            key: "masters/recording_so-we-sleep_01/source.wav".to_string(),
            version_id: None,
            etag: None,
        },
        planned_output("job_so-we-sleep_01_encode_20260523", "media", false),
    );
    job.mark_running("2026-05-23T19:55:31Z".to_string());
    let event = EncodeJobEvent {
        action: ACTION_ENCODE_TRACK.to_string(),
        job_key: "jobs/job_so-we-sleep_01_encode_20260523".to_string(),
        job,
        requested_by: None,
    };

    assert!(validate_encode_event_targets(&event, "masters", "media").is_err());
}

#[test]
#[ignore = "requires local ffmpeg and ffprobe binaries on PATH"]
fn local_fixture_transcodes_short_wav_to_hls_and_lossless() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "tsonu-encoder-fixture-{}-{unique}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();

    let source = root.join("source.wav");
    let generate_args = vec![
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
        "-y".to_string(),
        "-f".to_string(),
        "lavfi".to_string(),
        "-i".to_string(),
        "sine=frequency=440:duration=1".to_string(),
        "-ar".to_string(),
        "48000".to_string(),
        "-ac".to_string(),
        "2".to_string(),
        path_arg(&source).unwrap(),
    ];
    run_command_capture("ffmpeg", "ffmpeg", &generate_args).unwrap();

    let probe = probe_audio("ffprobe", &source).unwrap();
    assert!((0.95..=1.05).contains(&probe.duration_seconds));
    assert_eq!(probe.sample_rate_hz, 48_000);
    assert_eq!(probe.channels, 2);

    let loudness = measure_loudness("ffmpeg", &source).unwrap();
    assert!(loudness.integrated_lufs.is_some());

    let hls_root = root.join("hls");
    let playlist_192 = hls_root.join("192k").join("index.m3u8");
    let playlist_320 = hls_root.join("320k").join("index.m3u8");
    encode_hls_rendition("ffmpeg", &source, &playlist_192, "192k").unwrap();
    encode_hls_rendition("ffmpeg", &source, &playlist_320, "320k").unwrap();
    assert_hls_rendition(&playlist_192).unwrap();
    assert_hls_rendition(&playlist_320).unwrap();

    let master_playlist = hls_root.join("master.m3u8");
    write_master_playlist(&master_playlist).unwrap();
    assert_file_exists(&master_playlist).unwrap();

    let lossless = root.join("lossless.flac");
    encode_lossless_flac("ffmpeg", &source, &lossless).unwrap();
    assert_file_exists(&lossless).unwrap();

    let files = collect_files(&root).unwrap();
    assert!(files.iter().any(|path| path.ends_with("hls/master.m3u8")));
    assert!(files
        .iter()
        .any(|path| path.extension().and_then(|value| value.to_str()) == Some("ts")));
    assert!(files.iter().any(|path| path.ends_with("lossless.flac")));

    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn parses_loudnorm_json_from_ffmpeg_stderr() {
    let stderr = r#"
size=N/A time=00:00:01.00 bitrate=N/A speed=1x
[Parsed_loudnorm_0 @ 0x123] 
{
        "input_i" : "-14.52",
        "input_tp" : "-1.13",
        "input_lra" : "3.40",
        "input_thresh" : "-24.89",
        "output_i" : "-16.00"
}
"#;

    let report = parse_loudnorm_report(stderr).unwrap();

    assert_eq!(parse_loudness_value(&report.input_i), Some(-14.52));
    assert_eq!(parse_loudness_value(&report.input_tp), Some(-1.13));
    assert_eq!(parse_loudness_value(&report.input_lra), Some(3.40));
    assert_eq!(parse_loudness_value(&report.input_thresh), Some(-24.89));
}

#[test]
fn parses_ffprobe_audio_metadata() {
    let stdout = r#"
{
  "streams": [
    {
      "codec_name": "pcm_s24le",
      "codec_type": "audio",
      "sample_rate": "48000",
      "channels": 2
    }
  ],
  "format": {
    "duration": "183.040000"
  }
}
"#;

    let metadata = parse_probe_output(stdout).unwrap();

    assert_eq!(metadata.codec_name, "pcm_s24le");
    assert_eq!(metadata.sample_rate_hz, 48_000);
    assert_eq!(metadata.channels, 2);
    assert_eq!(metadata.duration_seconds, 183.04);
}

#[test]
fn maps_generated_files_to_output_prefix() {
    let root = PathBuf::from("/tmp/output");
    let path = PathBuf::from("/tmp/output/hls/192k/index.m3u8");

    assert_eq!(
        relative_s3_path(&root, &path).unwrap(),
        "hls/192k/index.m3u8"
    );
    assert_eq!(
        join_s3_key("draft/encodes/job_x", "hls/192k/index.m3u8"),
        "draft/encodes/job_x/hls/192k/index.m3u8"
    );
}

#[test]
fn assigns_hls_content_types() {
    assert_eq!(
        content_type_for_path(Path::new("hls/master.m3u8")),
        "application/vnd.apple.mpegurl"
    );
    assert_eq!(
        content_type_for_path(Path::new("hls/192k/segment_00001.ts")),
        "video/mp2t"
    );
}
