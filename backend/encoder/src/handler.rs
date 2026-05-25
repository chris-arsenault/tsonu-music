use crate::{
    apply_asset_integrity, assert_file_exists, assert_hls_rendition, cleanup_work_dir,
    command_line, encode_hls_rendition, encode_lossless_flac, includes_lossless, measure_loudness,
    prepare_work_dir, probe_audio, run_command_capture, validate_encode_event,
    write_master_playlist, write_metadata_file, BinaryCheck, EncodeJobResponse, EncoderError,
    EncoderResponse, EncoderState, PackagingCheck, TranscodeResult,
};
use chrono::{SecondsFormat, Utc};
use encode_contract::{
    planned_ffmpeg_args, EncodeJob, EncodeJobEvent, EncodeMetadata, FfmpegDetails,
    ACTION_ENCODE_TRACK, ACTION_PACKAGING_CHECK,
};
use lambda_runtime::{Error, LambdaEvent};
use serde_json::Value;
use std::sync::Arc;
use tracing::info;

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

pub(crate) fn packaging_check(state: &EncoderState) -> Result<PackagingCheck, EncoderError> {
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

pub(crate) async fn handle_encode_job(
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

pub(crate) async fn fail_job(
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

pub(crate) async fn run_transcode(
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

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub(crate) fn requested_action(payload: &Value) -> String {
    payload
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or(ACTION_PACKAGING_CHECK)
        .to_string()
}

pub(crate) fn check_binary(name: &'static str, path: &str) -> Result<BinaryCheck, EncoderError> {
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

pub(crate) fn first_nonempty_line(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}
