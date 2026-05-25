use crate::{path_arg, run_command_capture, EncoderError};
use serde::Deserialize;
use std::path::Path;

#[derive(Debug)]
pub(crate) struct ProbeMetadata {
    pub(crate) duration_seconds: f64,
    pub(crate) codec_name: String,
    pub(crate) sample_rate_hz: u32,
    pub(crate) channels: u32,
}

#[derive(Debug, Deserialize)]
pub(crate) struct FfprobeOutput {
    pub(crate) streams: Vec<FfprobeStream>,
    pub(crate) format: Option<FfprobeFormat>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct FfprobeStream {
    pub(crate) codec_type: Option<String>,
    pub(crate) codec_name: Option<String>,
    pub(crate) sample_rate: Option<String>,
    pub(crate) channels: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct FfprobeFormat {
    pub(crate) duration: Option<String>,
}

pub(crate) fn probe_audio(
    ffprobe_path: &str,
    source: &Path,
) -> Result<ProbeMetadata, EncoderError> {
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

pub(crate) fn parse_probe_output(stdout: &str) -> Result<ProbeMetadata, EncoderError> {
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

pub(crate) fn parse_probe_float(field: &'static str, value: &str) -> Result<f64, EncoderError> {
    value
        .parse::<f64>()
        .map_err(|source| EncoderError::ParseProbeFloat {
            field,
            value: value.to_string(),
            source,
        })
}

pub(crate) fn parse_probe_u32(field: &'static str, value: &str) -> Result<u32, EncoderError> {
    value
        .parse::<u32>()
        .map_err(|source| EncoderError::ParseProbeInt {
            field,
            value: value.to_string(),
            source,
        })
}
