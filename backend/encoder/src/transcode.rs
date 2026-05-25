use crate::{path_arg, run_command_capture, EncoderError, UploadedFile};
use encode_contract::{AssetRef, EncodeMetadata};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

pub(crate) fn encode_hls_rendition(
    ffmpeg_path: &str,
    source: &Path,
    playlist: &Path,
    bitrate: &str,
) -> Result<Vec<String>, EncoderError> {
    let parent = playlist
        .parent()
        .ok_or_else(|| EncoderError::PathEncoding(playlist.to_path_buf()))?;
    fs::create_dir_all(parent).map_err(|source| EncoderError::Io {
        action: "create HLS rendition directory",
        path: parent.to_path_buf(),
        source,
    })?;

    let segment_pattern = parent.join("segment_%05d.ts");
    let args = vec![
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
        "-y".to_string(),
        "-i".to_string(),
        path_arg(source)?,
        "-map".to_string(),
        "0:a:0".to_string(),
        "-vn".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        bitrate.to_string(),
        "-f".to_string(),
        "hls".to_string(),
        "-hls_time".to_string(),
        "6".to_string(),
        "-hls_playlist_type".to_string(),
        "vod".to_string(),
        "-hls_segment_type".to_string(),
        "mpegts".to_string(),
        "-hls_segment_filename".to_string(),
        path_arg(&segment_pattern)?,
        path_arg(playlist)?,
    ];

    run_command_capture("ffmpeg", ffmpeg_path, &args)?;
    Ok(args)
}

pub(crate) fn encode_lossless_flac(
    ffmpeg_path: &str,
    source: &Path,
    output: &Path,
) -> Result<Vec<String>, EncoderError> {
    let parent = output
        .parent()
        .ok_or_else(|| EncoderError::PathEncoding(output.to_path_buf()))?;
    fs::create_dir_all(parent).map_err(|source| EncoderError::Io {
        action: "create lossless output directory",
        path: parent.to_path_buf(),
        source,
    })?;

    let args = vec![
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
        "-y".to_string(),
        "-i".to_string(),
        path_arg(source)?,
        "-map".to_string(),
        "0:a:0".to_string(),
        "-vn".to_string(),
        "-c:a".to_string(),
        "flac".to_string(),
        path_arg(output)?,
    ];

    run_command_capture("ffmpeg", ffmpeg_path, &args)?;
    Ok(args)
}

pub(crate) fn write_master_playlist(path: &Path) -> Result<(), EncoderError> {
    let parent = path
        .parent()
        .ok_or_else(|| EncoderError::PathEncoding(path.to_path_buf()))?;
    fs::create_dir_all(parent).map_err(|source| EncoderError::Io {
        action: "create HLS master directory",
        path: parent.to_path_buf(),
        source,
    })?;

    let body = concat!(
        "#EXTM3U\n",
        "#EXT-X-VERSION:3\n",
        "#EXT-X-STREAM-INF:BANDWIDTH=212000,AVERAGE-BANDWIDTH=192000,CODECS=\"mp4a.40.2\"\n",
        "192k/index.m3u8\n",
        "#EXT-X-STREAM-INF:BANDWIDTH=352000,AVERAGE-BANDWIDTH=320000,CODECS=\"mp4a.40.2\"\n",
        "320k/index.m3u8\n"
    );

    fs::write(path, body).map_err(|source| EncoderError::Io {
        action: "write HLS master playlist",
        path: path.to_path_buf(),
        source,
    })
}

pub(crate) fn write_metadata_file(
    path: &Path,
    metadata: &EncodeMetadata,
) -> Result<(), EncoderError> {
    let body = serde_json::to_vec_pretty(metadata).map_err(EncoderError::SerializeMetadata)?;
    fs::write(path, body).map_err(|source| EncoderError::Io {
        action: "write metadata file",
        path: path.to_path_buf(),
        source,
    })
}

pub(crate) fn assert_hls_rendition(playlist: &Path) -> Result<(), EncoderError> {
    assert_file_exists(playlist)?;
    let parent = playlist
        .parent()
        .ok_or_else(|| EncoderError::PathEncoding(playlist.to_path_buf()))?;
    let segments = fs::read_dir(parent)
        .map_err(|source| EncoderError::Io {
            action: "read HLS rendition directory",
            path: parent.to_path_buf(),
            source,
        })?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("ts"))
        .count();

    if segments == 0 {
        return Err(EncoderError::MissingExpectedAsset(format!(
            "{}/*.ts",
            parent.display()
        )));
    }

    Ok(())
}
pub(crate) fn assert_file_exists(path: &Path) -> Result<(), EncoderError> {
    if path.is_file() {
        Ok(())
    } else {
        Err(EncoderError::MissingExpectedAsset(
            path.display().to_string(),
        ))
    }
}

pub(crate) fn apply_asset_integrity(
    assets: &mut [AssetRef],
    uploaded: &HashMap<String, UploadedFile>,
) -> Result<(), EncoderError> {
    for asset in assets {
        let integrity = uploaded
            .get(&asset.path)
            .ok_or_else(|| EncoderError::MissingExpectedAsset(asset.path.clone()))?;
        asset.file_size_bytes = Some(integrity.file_size_bytes);
        asset.checksum_sha256 = Some(integrity.checksum_sha256.clone());
    }

    Ok(())
}
