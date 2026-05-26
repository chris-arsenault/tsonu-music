use super::*;
use crate::http::{parse_path, ApiPath};
use encode_contract::{
    planned_output, EncodeJob, EncodeMetadata, EncodeStatus, ObjectRef, RecordingFileSet,
    ACTION_ENCODE_TRACK,
};
use serde_json::json;
use std::collections::HashMap;

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
        parse_path("/admin/maintenance/stale"),
        ApiPath::AdminMaintenanceStale
    );
    assert_eq!(
        parse_path("/admin/artwork-upload-url"),
        ApiPath::AdminArtworkUploadUrl
    );
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
    assert!(validate_stable_id("recording", "recording_opening-dream_demo", "recordingId").is_ok());
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
fn infers_artwork_upload_formats() {
    assert_eq!(
        infer_artwork_format("cover.jpeg", Some("image/jpeg"))
            .unwrap()
            .extension,
        "jpg"
    );
    assert_eq!(
        infer_artwork_format("cover.webp", None)
            .unwrap()
            .content_type,
        "image/webp"
    );
    assert!(infer_artwork_format("cover.svg", None).is_err());
    assert!(infer_artwork_format("cover.png", Some("image/jpeg")).is_err());
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
fn validates_recording_files_as_publishable_media() {
    let song = sample_draft_song();
    let recording = &song.recordings[0];

    assert!(validate_publishable_recording(&song, recording).is_ok());

    let mut missing = recording.clone();
    missing.files = Vec::new();
    assert!(validate_publishable_recording(&song, &missing).is_err());
}

#[test]
fn builds_published_track_from_recording_files() {
    let song = sample_draft_song();
    let recording = &song.recordings[0];
    let track = sample_release_track();

    let published = build_published_track(&track, &song, recording).unwrap();

    assert_eq!(published.duration_seconds, 181.25);
    assert_eq!(
        published.playback.hls.path,
        "recordings/recording_opening-dream_demo/files/20260523t000000z/hls/master.m3u8"
    );
    assert!(published.playback.hls.file_id.starts_with("file_"));
    assert_eq!(published.song_id, "song_opening-dream");
    assert_eq!(published.recording_id, "recording_opening-dream_demo");
    assert_eq!(
        published.artwork.as_ref().unwrap()["assetId"],
        "asset_opening-dream_art"
    );
    assert_eq!(published.playback.formats.len(), 3);
    assert!(published
        .playback
        .formats
        .iter()
        .any(|format| format.quality == PlaybackQuality::FlacLossless
            && format.bit_depth == Some(24)));

    let value = serde_json::to_value(&published.playback.formats).unwrap();
    assert!(value
        .as_array()
        .unwrap()
        .iter()
        .any(|format| format["quality"] == "aac-192"));
    assert!(value
        .as_array()
        .unwrap()
        .iter()
        .any(|format| format["quality"] == "aac-320"));
}

#[test]
fn serializes_published_release_without_private_publish_fields() {
    let draft = sample_draft_release();
    let song = sample_draft_song();
    let recording = &song.recordings[0];
    let track = sample_release_track();
    let published_track = build_published_track(&track, &song, recording).unwrap();
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
fn published_release_disambiguates_duplicate_track_slugs() {
    let draft = sample_draft_release();
    let song = sample_draft_song();
    let normal = &song.recordings[0];
    let mut alternate = normal.clone();
    alternate.recording_id = "recording_opening-dream_orchestral-edit".to_string();
    alternate.version_title = Some("Orchestral Edit".to_string());

    let first_track = sample_release_track();
    let mut second_track = sample_release_track();
    second_track.track_id = "track_so-we-sleep_02".to_string();
    second_track.recording_id = alternate.recording_id.clone();
    second_track.track_number = 2;
    second_track.slug = first_track.slug.clone();

    let first = build_published_track(&first_track, &song, normal).unwrap();
    let second = build_published_track(&second_track, &song, &alternate).unwrap();
    let release = build_published_release(
        &draft,
        Visibility::Public,
        "2026-05-23T12:00:00Z".to_string(),
        vec![first, second],
    )
    .unwrap();

    assert_eq!(release.tracks[0].slug, "opening-dream");
    assert_eq!(release.tracks[1].slug, "opening-dream-orchestral-edit");
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
        "recording_opening-dream_demo",
        "20260524t000000z",
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
    assert!(prepared
        .job
        .output
        .assets
        .iter()
        .any(|asset| asset.mime_type == "audio/flac" && asset.path.ends_with("/lossless.flac")));
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
        artwork: Some(json!({
            "assetId": "asset_opening-dream_art",
            "altText": "Opening Dream artwork",
            "sources": [
                {
                    "path": "artwork/songs/song_opening-dream/cover-1024.jpg",
                    "width": 1024,
                    "height": 1024,
                    "mimeType": "image/jpeg"
                }
            ]
        })),
        recordings: vec![sample_encoded_recording()],
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
        files: Vec::new(),
    }
}

fn sample_encoded_recording() -> DraftRecording {
    let job = sample_succeeded_job();
    let file_set = RecordingFileSet::from_succeeded_job(&job).unwrap();
    let mut recording = sample_recording(vec![job.job_id]);
    recording.duration_seconds = file_set.duration_seconds;
    recording.files = file_set.files;
    recording
}

fn sample_succeeded_job() -> EncodeJob {
    let job_id = "job_so-we-sleep_01_encode_20260523";
    let mut output = planned_output(
        "recording_opening-dream_demo",
        "20260523t000000z",
        "tsonu-music-media",
        true,
    );
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
