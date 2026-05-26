use crate::{
    published_release_api_path, ApiError, DraftRecording, DraftRelease, DraftReleaseTrack,
    DraftSong, DraftSourceMaster, EncodeJobRequest, PlaybackFormat, PlaybackFormatKind,
    PlaybackHls, PlaybackQuality, PublishedRelease, PublishedReleaseTrack, PublishedSong,
    PublishedStatus, ReleaseEntityType, SongEntityType, TrackPlayback, Visibility,
};
use encode_contract::{
    encode_job_key as contract_encode_job_key, planned_ffmpeg_args, EncodeJob, EncodeJobEvent,
    ObjectRef, RecordingFile, RecordingFileKind, RecordingFileQuality, ACTION_ENCODE_TRACK,
};
use std::collections::HashSet;

pub(crate) fn build_published_song(draft: &DraftSong) -> PublishedSong {
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
        artwork: draft.artwork.clone(),
        placements: Vec::new(),
    }
}

pub(crate) fn build_published_release(
    draft: &DraftRelease,
    visibility: Visibility,
    published_at: String,
    tracks: Vec<PublishedReleaseTrack>,
) -> Result<PublishedRelease, ApiError> {
    let mut tracks = tracks;
    make_track_slugs_unique(&mut tracks);

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

fn make_track_slugs_unique(tracks: &mut [PublishedReleaseTrack]) {
    let mut used = HashSet::<String>::new();
    for track in tracks {
        let base = track.slug.clone();
        let mut candidate = base.clone();
        if used.contains(&candidate) {
            let disambiguated = disambiguated_track_slug(&base, track);
            candidate = disambiguated.clone();
            let mut index = 2;
            while used.contains(&candidate) {
                candidate = format!("{disambiguated}-{index}");
                index += 1;
            }
            track.slug = candidate.clone();
        }
        used.insert(candidate);
    }
}

fn disambiguated_track_slug(base: &str, track: &PublishedReleaseTrack) -> String {
    if let Some(version_slug) = track
        .version_title
        .as_deref()
        .map(slugify_component)
        .filter(|slug| !slug.is_empty())
    {
        return append_slug(base, &version_slug);
    }

    let recording_slug = recording_id_slug(&track.recording_id);
    if !recording_slug.is_empty() && recording_slug != base {
        return recording_slug;
    }

    format!("{}-{}", base, track.track_number)
}

fn recording_id_slug(recording_id: &str) -> String {
    let source = recording_id
        .strip_prefix("recording_")
        .unwrap_or(recording_id);
    slugify_component(source)
}

fn append_slug(base: &str, suffix: &str) -> String {
    if suffix == base || suffix.starts_with(&format!("{base}-")) {
        suffix.to_string()
    } else {
        format!("{base}-{suffix}")
    }
}

fn slugify_component(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .fold(String::new(), |mut slug, c| {
            if c.is_ascii_alphanumeric() {
                slug.push(c);
            } else if !slug.ends_with('-') {
                slug.push('-');
            }
            slug
        })
        .trim_matches('-')
        .to_string()
}

pub(crate) fn build_published_track(
    track: &DraftReleaseTrack,
    song: &DraftSong,
    recording: &DraftRecording,
) -> Result<PublishedReleaseTrack, ApiError> {
    let duration_seconds = recording.duration_seconds.ok_or_else(|| {
        ApiError::bad_request(
            "missing_recording_duration",
            format!(
                "recording {} does not have measured durationSeconds",
                recording.recording_id
            ),
        )
    })?;
    let hls_file = required_file(recording, RecordingFileKind::HlsMaster, None)?;
    let aac_192_file = required_file(
        recording,
        RecordingFileKind::HlsRendition,
        Some(RecordingFileQuality::Aac192),
    )?;
    let aac_320_file = required_file(
        recording,
        RecordingFileKind::HlsRendition,
        Some(RecordingFileQuality::Aac320),
    )?;
    let flac_file = optional_file(
        recording,
        RecordingFileKind::Download,
        Some(RecordingFileQuality::FlacLossless),
    );

    let mut formats = vec![
        playback_format(PlaybackFormatBuild {
            file: aac_192_file,
            kind: PlaybackFormatKind::HlsRendition,
            quality: PlaybackQuality::Aac192,
            bitrate_kbps: Some(192),
            bit_depth: None,
        })?,
        playback_format(PlaybackFormatBuild {
            file: aac_320_file,
            kind: PlaybackFormatKind::HlsRendition,
            quality: PlaybackQuality::Aac320,
            bitrate_kbps: Some(320),
            bit_depth: None,
        })?,
    ];

    if let Some(file) = flac_file {
        formats.push(playback_format(PlaybackFormatBuild {
            file,
            kind: PlaybackFormatKind::Download,
            quality: PlaybackQuality::FlacLossless,
            bitrate_kbps: None,
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
        duration_seconds,
        explicit: track.explicit.unwrap_or(recording.explicit),
        isrc: track.isrc.clone().or_else(|| recording.isrc.clone()),
        description: track.description.clone(),
        credits: track.credits.clone(),
        artwork: song.artwork.clone(),
        playback: TrackPlayback {
            hls: PlaybackHls {
                file_id: hls_file.file_id.clone(),
                asset_id: hls_file.file_id.clone(),
                path: hls_file.path.clone(),
                mime_type: hls_file.mime_type.clone(),
                codecs: vec!["mp4a.40.2".to_string()],
            },
            formats,
        },
    })
}

struct PlaybackFormatBuild<'a> {
    file: &'a RecordingFile,
    kind: PlaybackFormatKind,
    quality: PlaybackQuality,
    bitrate_kbps: Option<u32>,
    bit_depth: Option<u32>,
}

fn playback_format(params: PlaybackFormatBuild<'_>) -> Result<PlaybackFormat, ApiError> {
    Ok(PlaybackFormat {
        file_id: params.file.file_id.clone(),
        asset_id: params.file.file_id.clone(),
        kind: params.kind,
        quality: params.quality,
        path: params.file.path.clone(),
        mime_type: params.file.mime_type.clone(),
        bitrate_kbps: params.bitrate_kbps,
        sample_rate_hz: params.file.sample_rate_hz,
        bit_depth: params.bit_depth,
        channels: params.file.channels,
        file_size_bytes: params.file.file_size_bytes,
    })
}

fn required_file(
    recording: &DraftRecording,
    kind: RecordingFileKind,
    quality: Option<RecordingFileQuality>,
) -> Result<&RecordingFile, ApiError> {
    optional_file(recording, kind, quality).ok_or_else(|| {
        ApiError::bad_request(
            "missing_required_recording_file",
            format!(
                "recording {} is missing required file {:?} {:?}",
                recording.recording_id, kind, quality
            ),
        )
    })
}

fn optional_file(
    recording: &DraftRecording,
    kind: RecordingFileKind,
    quality: Option<RecordingFileQuality>,
) -> Option<&RecordingFile> {
    recording
        .files
        .iter()
        .find(|file| file.kind == kind && file.quality == quality)
}

pub(crate) struct PreparedEncodeJob {
    pub(crate) job: EncodeJob,
    pub(crate) job_key: String,
    pub(crate) event: EncodeJobEvent,
}

pub(crate) fn build_encode_job_event(
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
