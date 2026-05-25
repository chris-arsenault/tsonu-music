use crate::{
    ensure_trailing_slash, public_asset_path, published_release_api_path, ApiError, DraftRecording,
    DraftRelease, DraftReleaseTrack, DraftSong, DraftSourceMaster, EncodeJobRequest,
    PlaybackFormat, PlaybackFormatKind, PlaybackHls, PlaybackQuality, PublishedRelease,
    PublishedReleaseTrack, PublishedSong, PublishedStatus, ReleaseEntityType, SongEntityType,
    TrackPlayback, Visibility,
};
use encode_contract::{
    encode_job_key as contract_encode_job_key, planned_ffmpeg_args, AssetRef, EncodeJob,
    EncodeJobEvent, EncodeMetadata, ObjectRef, ACTION_ENCODE_TRACK,
};

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
        placements: Vec::new(),
    }
}

pub(crate) fn build_published_release(
    draft: &DraftRelease,
    visibility: Visibility,
    published_at: String,
    tracks: Vec<PublishedReleaseTrack>,
) -> Result<PublishedRelease, ApiError> {
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

pub(crate) fn build_published_track(
    track: &DraftReleaseTrack,
    song: &DraftSong,
    recording: &DraftRecording,
    job: &EncodeJob,
    public_prefix: &str,
) -> Result<PublishedReleaseTrack, ApiError> {
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
        duration_seconds: metadata.duration_seconds,
        explicit: track.explicit.unwrap_or(recording.explicit),
        isrc: track.isrc.clone().or_else(|| recording.isrc.clone()),
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
