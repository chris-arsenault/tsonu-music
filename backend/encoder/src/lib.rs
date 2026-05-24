use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client as S3Client;
use chrono::{SecondsFormat, Utc};
mod db;
use encode_contract::{
    planned_ffmpeg_args, AssetRef, EncodeJob, EncodeJobEvent, EncodeMetadata, EncodeOutput,
    EncodeStatus, FfmpegDetails, LoudnessMetadata, ACTION_ENCODE_TRACK, ACTION_PACKAGING_CHECK,
    DRAFT_ENCODE_PREFIX,
};
use lambda_runtime::{Error, LambdaEvent};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::collections::HashMap;
use std::env;
use std::error::Error as StdError;
use std::fmt;
use std::fs;
use std::io::Read;
use std::num::{ParseFloatError, ParseIntError};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tracing::{info, warn};

const DEFAULT_FFMPEG_PATH: &str = "/opt/bin/ffmpeg";
const DEFAULT_FFPROBE_PATH: &str = "/opt/bin/ffprobe";
const WORK_ROOT: &str = "/tmp/tsonu-encoder";

#[derive(Clone)]
pub struct EncoderState {
    db: PgPool,
    s3: S3Client,
    masters_bucket: String,
    media_bucket: String,
    ffmpeg_path: String,
    ffprobe_path: String,
}

impl EncoderState {
    pub async fn from_env(s3: S3Client) -> Result<Self, ConfigError> {
        let db = db::connect_pool_from_env()
            .await
            .map_err(|source| ConfigError::db_connect(source.to_string()))?;
        Ok(Self {
            db,
            s3,
            masters_bucket: required_env("MASTERS_BUCKET")?,
            media_bucket: required_env("MEDIA_BUCKET")?,
            ffmpeg_path: env::var("FFMPEG_PATH")
                .unwrap_or_else(|_| DEFAULT_FFMPEG_PATH.to_string()),
            ffprobe_path: env::var("FFPROBE_PATH")
                .unwrap_or_else(|_| DEFAULT_FFPROBE_PATH.to_string()),
        })
    }

    async fn write_job_status(&self, job: &EncodeJob) -> Result<(), EncoderError> {
        if job.output.bucket != self.media_bucket {
            return Err(EncoderError::InvalidEvent(format!(
                "job output bucket {} does not match configured media bucket {}",
                job.output.bucket, self.media_bucket
            )));
        }

        db::upsert_encode_job(&self.db, job)
            .await
            .map_err(|source| EncoderError::WriteStatusDatabase {
                job_id: job.job_id.clone(),
                source,
            })?;

        Ok(())
    }

    async fn download_source(
        &self,
        job: &EncodeJob,
        destination: &Path,
    ) -> Result<u64, EncoderError> {
        let parent = destination
            .parent()
            .ok_or_else(|| EncoderError::PathEncoding(destination.to_path_buf()))?;
        fs::create_dir_all(parent).map_err(|source| EncoderError::Io {
            action: "create source directory",
            path: parent.to_path_buf(),
            source,
        })?;

        let mut request = self
            .s3
            .get_object()
            .bucket(&job.input.bucket)
            .key(&job.input.key);
        if let Some(version_id) = &job.input.version_id {
            request = request.version_id(version_id);
        }

        let object = request
            .send()
            .await
            .map_err(|source| EncoderError::DownloadSource {
                bucket: job.input.bucket.clone(),
                key: job.input.key.clone(),
                source: Box::new(source),
            })?;

        let mut file = tokio::fs::File::create(destination)
            .await
            .map_err(|source| EncoderError::Io {
                action: "create source file",
                path: destination.to_path_buf(),
                source,
            })?;
        let mut body = object.body;
        let mut bytes_written = 0u64;

        while let Some(bytes) =
            body.try_next()
                .await
                .map_err(|source| EncoderError::ReadSourceStream {
                    bucket: job.input.bucket.clone(),
                    key: job.input.key.clone(),
                    source: Box::new(source),
                })?
        {
            file.write_all(&bytes)
                .await
                .map_err(|source| EncoderError::Io {
                    action: "write source file",
                    path: destination.to_path_buf(),
                    source,
                })?;
            bytes_written += bytes.len() as u64;
        }

        file.flush().await.map_err(|source| EncoderError::Io {
            action: "flush source file",
            path: destination.to_path_buf(),
            source,
        })?;

        if bytes_written == 0 {
            return Err(EncoderError::InvalidEvent(format!(
                "source object {} is empty",
                job.input.key
            )));
        }

        Ok(bytes_written)
    }

    async fn upload_output_tree(
        &self,
        output: &EncodeOutput,
        root: &Path,
    ) -> Result<HashMap<String, UploadedFile>, EncoderError> {
        if output.bucket != self.media_bucket {
            return Err(EncoderError::InvalidEvent(format!(
                "job output bucket {} does not match configured media bucket {}",
                output.bucket, self.media_bucket
            )));
        }

        let files = collect_files(root)?;
        if files.is_empty() {
            return Err(EncoderError::NoGeneratedFiles(root.to_path_buf()));
        }

        let mut uploaded = HashMap::with_capacity(files.len());
        for file_path in files {
            let relative_path = relative_s3_path(root, &file_path)?;
            let key = join_s3_key(&output.prefix, &relative_path);
            let integrity = file_integrity(&file_path)?;
            let body = ByteStream::from_path(&file_path).await.map_err(|source| {
                EncoderError::ReadUploadFile {
                    path: file_path.clone(),
                    source: Box::new(source),
                }
            })?;

            self.s3
                .put_object()
                .bucket(&output.bucket)
                .key(&key)
                .content_type(content_type_for_path(&file_path))
                .body(body)
                .send()
                .await
                .map_err(|source| EncoderError::UploadOutput {
                    bucket: output.bucket.clone(),
                    key: key.clone(),
                    source: Box::new(source),
                })?;

            uploaded.insert(key, integrity);
        }

        Ok(uploaded)
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "responseType", rename_all = "camelCase")]
pub enum EncoderResponse {
    PackagingCheck(PackagingCheck),
    EncodeJob(EncodeJobResponse),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodeJobResponse {
    ok: bool,
    job_id: String,
    job_key: String,
    status: EncodeStatus,
    message: String,
    assets: Vec<AssetRef>,
    metadata: Option<EncodeMetadata>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagingCheck {
    ok: bool,
    action: String,
    encoder_implemented: bool,
    message: String,
    ffmpeg: BinaryCheck,
    ffprobe: BinaryCheck,
    tmp_directory: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryCheck {
    name: &'static str,
    path: String,
    version_line: String,
}

#[derive(Debug)]
struct UploadedFile {
    file_size_bytes: u64,
    checksum_sha256: String,
}

#[derive(Debug)]
struct CommandOutput {
    stdout: String,
    stderr: String,
}

#[derive(Debug)]
struct TranscodeResult {
    output: EncodeOutput,
    metadata: EncodeMetadata,
    ffmpeg_args: Vec<String>,
}

#[derive(Debug)]
struct WorkPaths {
    source: PathBuf,
    output_root: PathBuf,
}

pub async fn handle_event(
    event: LambdaEvent<Value>,
    state: Arc<EncoderState>,
) -> Result<EncoderResponse, Error> {
    match requested_action(&event.payload).as_str() {
        ACTION_PACKAGING_CHECK => Ok(EncoderResponse::PackagingCheck(packaging_check(&state)?)),
        ACTION_ENCODE_TRACK => Ok(EncoderResponse::EncodeJob(
            handle_encode_job(event.payload, &state).await?,
        )),
        action => Err(EncoderError::UnsupportedAction(action.to_string()).into()),
    }
}

fn packaging_check(state: &EncoderState) -> Result<PackagingCheck, EncoderError> {
    info!(
        ffmpeg = state.ffmpeg_path,
        ffprobe = state.ffprobe_path,
        "Checking encoder binary packaging"
    );

    Ok(PackagingCheck {
        ok: true,
        action: ACTION_PACKAGING_CHECK.to_string(),
        encoder_implemented: true,
        message: "ffmpeg and ffprobe are packaged and audio transcoding is enabled".to_string(),
        ffmpeg: check_binary("ffmpeg", &state.ffmpeg_path)?,
        ffprobe: check_binary("ffprobe", &state.ffprobe_path)?,
        tmp_directory: "/tmp",
    })
}

async fn handle_encode_job(
    payload: Value,
    state: &EncoderState,
) -> Result<EncodeJobResponse, EncoderError> {
    let event: EncodeJobEvent =
        serde_json::from_value(payload).map_err(EncoderError::DeserializeEvent)?;
    validate_encode_event(&event, state)?;

    let mut job = event.job;
    let started_at = now();
    job.mark_running(started_at);
    job.ffmpeg = Some(FfmpegDetails {
        version: None,
        args: planned_ffmpeg_args(&job.input.key, &job.output, includes_lossless(&job)),
    });
    state.write_job_status(&job).await?;

    let ffmpeg = match check_binary("ffmpeg", &state.ffmpeg_path)
        .and_then(|ffmpeg| check_binary("ffprobe", &state.ffprobe_path).map(|_| ffmpeg))
    {
        Ok(ffmpeg) => ffmpeg,
        Err(error) => return fail_job(event.job_key, job, state, error).await,
    };

    let result = run_transcode(&job, state).await;
    cleanup_work_dir(&job.job_id);

    match result {
        Ok(result) => {
            job.mark_succeeded(
                now(),
                result.output,
                result.metadata.clone(),
                FfmpegDetails {
                    version: Some(ffmpeg.version_line),
                    args: result.ffmpeg_args,
                },
            );
            state.write_job_status(&job).await?;

            Ok(EncodeJobResponse {
                ok: true,
                job_id: job.job_id,
                job_key: event.job_key,
                status: job.status,
                message: "encode job completed".to_string(),
                assets: job.output.assets,
                metadata: job.metadata,
            })
        }
        Err(error) => fail_job(event.job_key, job, state, error).await,
    }
}

async fn fail_job(
    job_key: String,
    mut job: EncodeJob,
    state: &EncoderState,
    error: EncoderError,
) -> Result<EncodeJobResponse, EncoderError> {
    let message = error.to_string();
    let details = error.job_details();
    job.mark_failed(now(), error.job_code(), message, details);
    state.write_job_status(&job).await?;

    Ok(EncodeJobResponse {
        ok: false,
        job_id: job.job_id,
        job_key,
        status: job.status,
        message: "encode job failed; status was written to RDS".to_string(),
        assets: job.output.assets,
        metadata: job.metadata,
    })
}

async fn run_transcode(
    job: &EncodeJob,
    state: &EncoderState,
) -> Result<TranscodeResult, EncoderError> {
    let paths = prepare_work_dir(job)?;
    let downloaded_bytes = state.download_source(job, &paths.source).await?;
    info!(
        job_id = job.job_id,
        input_key = job.input.key,
        downloaded_bytes,
        "Downloaded source master"
    );

    let probe = probe_audio(&state.ffprobe_path, &paths.source)?;
    let loudness = measure_loudness(&state.ffmpeg_path, &paths.source)?;
    let metadata = EncodeMetadata {
        duration_seconds: probe.duration_seconds,
        codec_name: probe.codec_name,
        sample_rate_hz: probe.sample_rate_hz,
        channels: probe.channels,
        loudness: Some(loudness),
    };

    let mut ffmpeg_args = Vec::new();
    let hls_root = paths.output_root.join("hls");
    let playlist_192 = hls_root.join("192k").join("index.m3u8");
    let playlist_320 = hls_root.join("320k").join("index.m3u8");

    let args_192 = encode_hls_rendition(&state.ffmpeg_path, &paths.source, &playlist_192, "192k")?;
    ffmpeg_args.push(command_line("ffmpeg", &args_192));
    assert_hls_rendition(&playlist_192)?;

    let args_320 = encode_hls_rendition(&state.ffmpeg_path, &paths.source, &playlist_320, "320k")?;
    ffmpeg_args.push(command_line("ffmpeg", &args_320));
    assert_hls_rendition(&playlist_320)?;

    write_master_playlist(&hls_root.join("master.m3u8"))?;

    if includes_lossless(job) {
        let flac_path = paths.output_root.join("lossless.flac");
        let flac_args = encode_lossless_flac(&state.ffmpeg_path, &paths.source, &flac_path)?;
        ffmpeg_args.push(command_line("ffmpeg", &flac_args));
        assert_file_exists(&flac_path)?;
    }

    write_metadata_file(&paths.output_root.join("metadata.json"), &metadata)?;

    let uploaded = state
        .upload_output_tree(&job.output, &paths.output_root)
        .await?;
    let mut output = job.output.clone();
    apply_asset_integrity(&mut output.assets, &uploaded)?;

    Ok(TranscodeResult {
        output,
        metadata,
        ffmpeg_args,
    })
}

fn validate_encode_event(event: &EncodeJobEvent, state: &EncoderState) -> Result<(), EncoderError> {
    validate_encode_event_targets(event, &state.masters_bucket, &state.media_bucket)
}

fn validate_encode_event_targets(
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

    if !event.job.output.prefix.starts_with(DRAFT_ENCODE_PREFIX) {
        return Err(EncoderError::InvalidEvent(format!(
            "job output prefix must be under {DRAFT_ENCODE_PREFIX}: {}",
            event.job.output.prefix
        )));
    }

    Ok(())
}

fn includes_lossless(job: &EncodeJob) -> bool {
    job.output
        .assets
        .iter()
        .any(|asset| asset.mime_type == "audio/flac")
}

fn prepare_work_dir(job: &EncodeJob) -> Result<WorkPaths, EncoderError> {
    let extension = source_extension(&job.input.key)?;
    let root = PathBuf::from(WORK_ROOT).join(&job.job_id);

    if root.exists() {
        fs::remove_dir_all(&root).map_err(|source| EncoderError::Io {
            action: "remove stale work directory",
            path: root.clone(),
            source,
        })?;
    }

    let input_root = root.join("input");
    let output_root = root.join("output");
    fs::create_dir_all(&input_root).map_err(|source| EncoderError::Io {
        action: "create input work directory",
        path: input_root.clone(),
        source,
    })?;
    fs::create_dir_all(&output_root).map_err(|source| EncoderError::Io {
        action: "create output work directory",
        path: output_root.clone(),
        source,
    })?;

    Ok(WorkPaths {
        source: input_root.join(format!("source.{extension}")),
        output_root,
    })
}

fn cleanup_work_dir(job_id: &str) {
    let root = PathBuf::from(WORK_ROOT).join(job_id);
    if let Err(error) = fs::remove_dir_all(&root) {
        if error.kind() != std::io::ErrorKind::NotFound {
            warn!(
                job_id,
                path = %root.display(),
                error = %error,
                "Failed to clean encoder work directory"
            );
        }
    }
}

fn source_extension(input_key: &str) -> Result<String, EncoderError> {
    let extension = Path::new(input_key)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| {
            EncoderError::InvalidEvent(format!(
                "source key has no supported extension: {input_key}"
            ))
        })?;

    match extension.as_str() {
        "wav" | "aif" | "aiff" | "flac" => Ok(extension),
        _ => Err(EncoderError::InvalidEvent(format!(
            "source key extension must be wav, aif, aiff, or flac: {input_key}"
        ))),
    }
}

#[derive(Debug)]
struct ProbeMetadata {
    duration_seconds: f64,
    codec_name: String,
    sample_rate_hz: u32,
    channels: u32,
}

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    streams: Vec<FfprobeStream>,
    format: Option<FfprobeFormat>,
}

#[derive(Debug, Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
}

fn probe_audio(ffprobe_path: &str, source: &Path) -> Result<ProbeMetadata, EncoderError> {
    let source = path_arg(source)?;
    let args = vec![
        "-v".to_string(),
        "error".to_string(),
        "-select_streams".to_string(),
        "a:0".to_string(),
        "-show_entries".to_string(),
        "format=duration:stream=codec_name,codec_type,sample_rate,channels".to_string(),
        "-of".to_string(),
        "json".to_string(),
        source,
    ];

    let output = run_command_capture("ffprobe", ffprobe_path, &args)?;
    parse_probe_output(&output.stdout)
}

fn parse_probe_output(stdout: &str) -> Result<ProbeMetadata, EncoderError> {
    let parsed: FfprobeOutput =
        serde_json::from_str(stdout).map_err(EncoderError::ParseProbeJson)?;
    let stream = parsed
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("audio"))
        .or_else(|| parsed.streams.first())
        .ok_or_else(|| EncoderError::ProbeMetadata("ffprobe found no audio stream".to_string()))?;

    let duration = parsed
        .format
        .as_ref()
        .and_then(|format| format.duration.as_deref())
        .ok_or_else(|| EncoderError::ProbeMetadata("missing format.duration".to_string()))?;
    let duration_seconds = parse_probe_float("duration", duration)?;
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return Err(EncoderError::ProbeMetadata(format!(
            "invalid duration: {duration}"
        )));
    }

    let codec_name = stream
        .codec_name
        .clone()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| EncoderError::ProbeMetadata("missing stream.codec_name".to_string()))?;
    let sample_rate = stream
        .sample_rate
        .as_deref()
        .ok_or_else(|| EncoderError::ProbeMetadata("missing stream.sample_rate".to_string()))?;
    let sample_rate_hz = parse_probe_u32("sample_rate", sample_rate)?;
    let channels = stream
        .channels
        .ok_or_else(|| EncoderError::ProbeMetadata("missing stream.channels".to_string()))?;
    if channels == 0 {
        return Err(EncoderError::ProbeMetadata(
            "stream.channels must be greater than zero".to_string(),
        ));
    }

    Ok(ProbeMetadata {
        duration_seconds,
        codec_name,
        sample_rate_hz,
        channels,
    })
}

#[derive(Debug, Deserialize)]
struct LoudnormReport {
    input_i: String,
    input_tp: String,
    input_lra: String,
    input_thresh: String,
}

fn measure_loudness(ffmpeg_path: &str, source: &Path) -> Result<LoudnessMetadata, EncoderError> {
    let source = path_arg(source)?;
    let args = vec![
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
        "-i".to_string(),
        source,
        "-af".to_string(),
        "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json".to_string(),
        "-f".to_string(),
        "null".to_string(),
        "-".to_string(),
    ];

    let output = run_command_capture("ffmpeg", ffmpeg_path, &args)?;
    let report = parse_loudnorm_report(&output.stderr)?;
    Ok(LoudnessMetadata {
        integrated_lufs: parse_loudness_value(&report.input_i),
        true_peak_dbfs: parse_loudness_value(&report.input_tp),
        loudness_range_lu: parse_loudness_value(&report.input_lra),
        threshold_lufs: parse_loudness_value(&report.input_thresh),
    })
}

fn parse_loudnorm_report(stderr: &str) -> Result<LoudnormReport, EncoderError> {
    let end = stderr
        .rfind('}')
        .ok_or_else(|| EncoderError::LoudnessMetadata("missing loudnorm JSON".to_string()))?;
    let start = stderr[..=end]
        .rfind('{')
        .ok_or_else(|| EncoderError::LoudnessMetadata("missing loudnorm JSON".to_string()))?;

    serde_json::from_str(&stderr[start..=end]).map_err(EncoderError::ParseLoudnormJson)
}

fn parse_loudness_value(value: &str) -> Option<f64> {
    let value = value.trim();
    if value.eq_ignore_ascii_case("inf")
        || value.eq_ignore_ascii_case("+inf")
        || value.eq_ignore_ascii_case("-inf")
    {
        return None;
    }

    value.parse::<f64>().ok().filter(|value| value.is_finite())
}

fn encode_hls_rendition(
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

fn encode_lossless_flac(
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

fn write_master_playlist(path: &Path) -> Result<(), EncoderError> {
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

fn write_metadata_file(path: &Path, metadata: &EncodeMetadata) -> Result<(), EncoderError> {
    let body = serde_json::to_vec_pretty(metadata).map_err(EncoderError::SerializeMetadata)?;
    fs::write(path, body).map_err(|source| EncoderError::Io {
        action: "write metadata file",
        path: path.to_path_buf(),
        source,
    })
}

fn assert_hls_rendition(playlist: &Path) -> Result<(), EncoderError> {
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

fn assert_file_exists(path: &Path) -> Result<(), EncoderError> {
    if path.is_file() {
        Ok(())
    } else {
        Err(EncoderError::MissingExpectedAsset(
            path.display().to_string(),
        ))
    }
}

fn apply_asset_integrity(
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

fn collect_files(root: &Path) -> Result<Vec<PathBuf>, EncoderError> {
    let mut files = Vec::new();
    collect_files_into(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_files_into(path: &Path, files: &mut Vec<PathBuf>) -> Result<(), EncoderError> {
    for entry in fs::read_dir(path).map_err(|source| EncoderError::Io {
        action: "read generated output directory",
        path: path.to_path_buf(),
        source,
    })? {
        let entry = entry.map_err(|source| EncoderError::Io {
            action: "read generated output entry",
            path: path.to_path_buf(),
            source,
        })?;
        let entry_path = entry.path();
        if entry_path.is_dir() {
            collect_files_into(&entry_path, files)?;
        } else if entry_path.is_file() {
            files.push(entry_path);
        }
    }

    Ok(())
}

fn relative_s3_path(root: &Path, path: &Path) -> Result<String, EncoderError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| EncoderError::InvalidRelativePath {
            root: root.to_path_buf(),
            path: path.to_path_buf(),
        })?;
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => {
                let value = value
                    .to_str()
                    .ok_or_else(|| EncoderError::PathEncoding(path.to_path_buf()))?;
                parts.push(value);
            }
            _ => {
                return Err(EncoderError::InvalidRelativePath {
                    root: root.to_path_buf(),
                    path: path.to_path_buf(),
                });
            }
        }
    }

    if parts.is_empty() {
        return Err(EncoderError::InvalidRelativePath {
            root: root.to_path_buf(),
            path: path.to_path_buf(),
        });
    }

    Ok(parts.join("/"))
}

fn join_s3_key(prefix: &str, relative_path: &str) -> String {
    format!(
        "{}/{}",
        prefix.trim_end_matches('/'),
        relative_path.trim_start_matches('/')
    )
}

fn file_integrity(path: &Path) -> Result<UploadedFile, EncoderError> {
    let mut file = fs::File::open(path).map_err(|source| EncoderError::Io {
        action: "open generated file",
        path: path.to_path_buf(),
        source,
    })?;
    let file_size_bytes = file
        .metadata()
        .map_err(|source| EncoderError::Io {
            action: "read generated file metadata",
            path: path.to_path_buf(),
            source,
        })?
        .len();

    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|source| EncoderError::Io {
            action: "read generated file",
            path: path.to_path_buf(),
            source,
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(UploadedFile {
        file_size_bytes,
        checksum_sha256: format!("{:x}", hasher.finalize()),
    })
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()) {
        Some("m3u8") => "application/vnd.apple.mpegurl",
        Some("ts") => "video/mp2t",
        Some("flac") => "audio/flac",
        Some("json") => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn path_arg(path: &Path) -> Result<String, EncoderError> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| EncoderError::PathEncoding(path.to_path_buf()))
}

fn run_command_capture(
    name: &'static str,
    path: &str,
    args: &[String],
) -> Result<CommandOutput, EncoderError> {
    let output = Command::new(path)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|source| EncoderError::SpawnFailed {
            name,
            path: path.to_string(),
            source,
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(EncoderError::CommandFailed {
            name,
            path: path.to_string(),
            args: args.to_vec(),
            status: output.status.code(),
            stderr,
        });
    }

    Ok(CommandOutput { stdout, stderr })
}

fn command_line(binary: &str, args: &[String]) -> String {
    let args = args
        .iter()
        .map(|arg| {
            if arg.chars().all(|character| {
                character.is_ascii_alphanumeric() || "-_./:=,%".contains(character)
            }) {
                arg.clone()
            } else {
                format!("'{}'", arg.replace('\'', "'\\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    format!("{binary} {args}")
}

fn parse_probe_float(field: &'static str, value: &str) -> Result<f64, EncoderError> {
    value
        .parse::<f64>()
        .map_err(|source| EncoderError::ParseProbeFloat {
            field,
            value: value.to_string(),
            source,
        })
}

fn parse_probe_u32(field: &'static str, value: &str) -> Result<u32, EncoderError> {
    value
        .parse::<u32>()
        .map_err(|source| EncoderError::ParseProbeInt {
            field,
            value: value.to_string(),
            source,
        })
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn requested_action(payload: &Value) -> String {
    payload
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or(ACTION_PACKAGING_CHECK)
        .to_string()
}

fn check_binary(name: &'static str, path: &str) -> Result<BinaryCheck, EncoderError> {
    let args = vec!["-version".to_string()];
    let output = run_command_capture(name, path, &args)?;
    let version_line =
        first_nonempty_line(&output.stdout).ok_or_else(|| EncoderError::EmptyVersion {
            name,
            path: path.to_string(),
        })?;

    Ok(BinaryCheck {
        name,
        path: path.to_string(),
        version_line,
    })
}

fn first_nonempty_line(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn required_env(name: &'static str) -> Result<String, ConfigError> {
    env::var(name).map_err(|_| ConfigError::missing_env(name))
}

#[derive(Debug)]
pub struct ConfigError {
    message: String,
}

impl ConfigError {
    fn missing_env(name: &'static str) -> Self {
        Self {
            message: format!("missing required environment variable {name}"),
        }
    }

    fn db_connect(error: String) -> Self {
        Self {
            message: format!("failed to connect to catalog database: {error}"),
        }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl StdError for ConfigError {}

#[derive(Debug)]
enum EncoderError {
    UnsupportedAction(String),
    InvalidEvent(String),
    DeserializeEvent(serde_json::Error),
    SerializeMetadata(serde_json::Error),
    ParseProbeJson(serde_json::Error),
    ParseLoudnormJson(serde_json::Error),
    ProbeMetadata(String),
    LoudnessMetadata(String),
    ParseProbeFloat {
        field: &'static str,
        value: String,
        source: ParseFloatError,
    },
    ParseProbeInt {
        field: &'static str,
        value: String,
        source: ParseIntError,
    },
    WriteStatusDatabase {
        job_id: String,
        source: sqlx::Error,
    },
    DownloadSource {
        bucket: String,
        key: String,
        source: Box<dyn StdError + Send + Sync>,
    },
    ReadSourceStream {
        bucket: String,
        key: String,
        source: Box<dyn StdError + Send + Sync>,
    },
    ReadUploadFile {
        path: PathBuf,
        source: Box<dyn StdError + Send + Sync>,
    },
    UploadOutput {
        bucket: String,
        key: String,
        source: Box<dyn StdError + Send + Sync>,
    },
    Io {
        action: &'static str,
        path: PathBuf,
        source: std::io::Error,
    },
    SpawnFailed {
        name: &'static str,
        path: String,
        source: std::io::Error,
    },
    CommandFailed {
        name: &'static str,
        path: String,
        args: Vec<String>,
        status: Option<i32>,
        stderr: String,
    },
    EmptyVersion {
        name: &'static str,
        path: String,
    },
    PathEncoding(PathBuf),
    InvalidRelativePath {
        root: PathBuf,
        path: PathBuf,
    },
    NoGeneratedFiles(PathBuf),
    MissingExpectedAsset(String),
}

impl EncoderError {
    fn job_code(&self) -> &'static str {
        match self {
            Self::InvalidEvent(_) => "invalid_event",
            Self::DownloadSource { .. } | Self::ReadSourceStream { .. } => "source_download_failed",
            Self::ParseProbeJson(_)
            | Self::ProbeMetadata(_)
            | Self::ParseProbeFloat { .. }
            | Self::ParseProbeInt { .. } => "ffprobe_failed",
            Self::LoudnessMetadata(_) | Self::ParseLoudnormJson(_) => "loudness_probe_failed",
            Self::CommandFailed { name, .. } if *name == "ffprobe" => "ffprobe_failed",
            Self::CommandFailed { name, .. } if *name == "ffmpeg" => "ffmpeg_failed",
            Self::UploadOutput { .. } | Self::ReadUploadFile { .. } => "output_upload_failed",
            Self::MissingExpectedAsset(_) | Self::NoGeneratedFiles(_) => "missing_output_asset",
            Self::SerializeMetadata(_) => "serialization_failed",
            Self::Io { .. } | Self::PathEncoding(_) | Self::InvalidRelativePath { .. } => {
                "filesystem_failed"
            }
            Self::WriteStatusDatabase { .. } => "status_write_failed",
            Self::SpawnFailed { name, .. } if *name == "ffmpeg" => "ffmpeg_unavailable",
            Self::SpawnFailed { name, .. } if *name == "ffprobe" => "ffprobe_unavailable",
            Self::EmptyVersion { .. } => "binary_check_failed",
            Self::DeserializeEvent(_) => "invalid_event",
            Self::UnsupportedAction(_) => "unsupported_action",
            Self::CommandFailed { .. } | Self::SpawnFailed { .. } => "command_failed",
        }
    }

    fn job_details(&self) -> Option<String> {
        match self {
            Self::CommandFailed { stderr, .. } => Some(truncate(stderr.trim(), 4_000)),
            Self::DownloadSource { source, .. }
            | Self::ReadSourceStream { source, .. }
            | Self::ReadUploadFile { source, .. }
            | Self::UploadOutput { source, .. } => Some(truncate(&source.to_string(), 4_000)),
            Self::WriteStatusDatabase { source, .. } => Some(truncate(&source.to_string(), 4_000)),
            Self::Io { source, .. } => Some(source.to_string()),
            _ => None,
        }
    }
}

impl fmt::Display for EncoderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedAction(action) => write!(
                f,
                "unsupported encoder action {action}; expected {ACTION_ENCODE_TRACK} or {ACTION_PACKAGING_CHECK}"
            ),
            Self::InvalidEvent(message) => write!(f, "invalid encode event: {message}"),
            Self::DeserializeEvent(source) => write!(f, "failed to parse encode event: {source}"),
            Self::SerializeMetadata(source) => write!(f, "failed to serialize metadata: {source}"),
            Self::ParseProbeJson(source) => write!(f, "failed to parse ffprobe JSON: {source}"),
            Self::ParseLoudnormJson(source) => {
                write!(f, "failed to parse loudnorm JSON: {source}")
            }
            Self::ProbeMetadata(message) => write!(f, "invalid ffprobe metadata: {message}"),
            Self::LoudnessMetadata(message) => write!(f, "invalid loudness metadata: {message}"),
            Self::ParseProbeFloat {
                field,
                value,
                source,
            } => write!(f, "failed to parse ffprobe {field} value {value}: {source}"),
            Self::ParseProbeInt {
                field,
                value,
                source,
            } => write!(f, "failed to parse ffprobe {field} value {value}: {source}"),
            Self::WriteStatusDatabase { job_id, source } => {
                write!(f, "failed to write job status {job_id} to database: {source}")
            }
            Self::DownloadSource {
                bucket,
                key,
                source,
            } => write!(f, "failed to download source s3://{bucket}/{key}: {source}"),
            Self::ReadSourceStream {
                bucket,
                key,
                source,
            } => write!(f, "failed to read source stream s3://{bucket}/{key}: {source}"),
            Self::ReadUploadFile { path, source } => {
                write!(f, "failed to stream upload file {}: {source}", path.display())
            }
            Self::UploadOutput {
                bucket,
                key,
                source,
            } => write!(f, "failed to upload output s3://{bucket}/{key}: {source}"),
            Self::Io {
                action,
                path,
                source,
            } => write!(f, "failed to {action} at {}: {source}", path.display()),
            Self::SpawnFailed { name, path, source } => {
                write!(f, "failed to execute {name} at {path}: {source}")
            }
            Self::CommandFailed {
                name,
                path,
                args,
                status,
                stderr,
            } => write!(
                f,
                "{name} at {path} failed with status {:?} running {}: {}",
                status,
                command_line(name, args),
                truncate(stderr.trim(), 1_000)
            ),
            Self::EmptyVersion { name, path } => {
                write!(f, "{name} at {path} did not emit a version line")
            }
            Self::PathEncoding(path) => write!(f, "path is not valid UTF-8: {}", path.display()),
            Self::InvalidRelativePath { root, path } => write!(
                f,
                "generated path {} is not relative to {}",
                path.display(),
                root.display()
            ),
            Self::NoGeneratedFiles(path) => {
                write!(f, "no generated files found under {}", path.display())
            }
            Self::MissingExpectedAsset(path) => write!(f, "missing expected output asset {path}"),
        }
    }
}

impl StdError for EncoderError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        match self {
            Self::DeserializeEvent(source)
            | Self::SerializeMetadata(source)
            | Self::ParseProbeJson(source)
            | Self::ParseLoudnormJson(source) => Some(source),
            Self::ParseProbeFloat { source, .. } => Some(source),
            Self::ParseProbeInt { source, .. } => Some(source),
            Self::DownloadSource { source, .. }
            | Self::ReadSourceStream { source, .. }
            | Self::ReadUploadFile { source, .. }
            | Self::UploadOutput { source, .. } => Some(source.as_ref()),
            Self::WriteStatusDatabase { source, .. } => Some(source),
            Self::Io { source, .. } | Self::SpawnFailed { source, .. } => Some(source),
            _ => None,
        }
    }
}

fn truncate(value: &str, max_len: usize) -> String {
    if value.len() <= max_len {
        return value.to_string();
    }

    let mut end = max_len;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &value[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use encode_contract::{planned_output, ObjectRef};
    use serde_json::json;

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
            "album_so-we-sleep".to_string(),
            "track_so-we-sleep_01".to_string(),
            "2026-05-23T19:55:30Z".to_string(),
            ObjectRef {
                bucket: "masters".to_string(),
                key: "masters/album_so-we-sleep/track_so-we-sleep_01/source.wav".to_string(),
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
            "album_so-we-sleep".to_string(),
            "track_so-we-sleep_01".to_string(),
            "2026-05-23T19:55:30Z".to_string(),
            ObjectRef {
                bucket: "masters".to_string(),
                key: "masters/album_so-we-sleep/track_so-we-sleep_01/source.wav".to_string(),
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
}
