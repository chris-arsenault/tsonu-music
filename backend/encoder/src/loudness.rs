use crate::{path_arg, run_command_capture, EncoderError};
use encode_contract::LoudnessMetadata;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Deserialize)]
pub(crate) struct LoudnormReport {
    pub(crate) input_i: String,
    pub(crate) input_tp: String,
    pub(crate) input_lra: String,
    pub(crate) input_thresh: String,
}

pub(crate) fn measure_loudness(
    ffmpeg_path: &str,
    source: &Path,
) -> Result<LoudnessMetadata, EncoderError> {
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

pub(crate) fn parse_loudnorm_report(stderr: &str) -> Result<LoudnormReport, EncoderError> {
    let end = stderr
        .rfind('}')
        .ok_or_else(|| EncoderError::LoudnessMetadata("missing loudnorm JSON".to_string()))?;
    let start = stderr[..=end]
        .rfind('{')
        .ok_or_else(|| EncoderError::LoudnessMetadata("missing loudnorm JSON".to_string()))?;

    serde_json::from_str(&stderr[start..=end]).map_err(EncoderError::ParseLoudnormJson)
}

pub(crate) fn parse_loudness_value(value: &str) -> Option<f64> {
    let value = value.trim();
    if value.eq_ignore_ascii_case("inf")
        || value.eq_ignore_ascii_case("+inf")
        || value.eq_ignore_ascii_case("-inf")
    {
        return None;
    }

    value.parse::<f64>().ok().filter(|value| value.is_finite())
}
