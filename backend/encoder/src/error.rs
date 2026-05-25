use crate::command_line;
use encode_contract::{ACTION_ENCODE_TRACK, ACTION_PACKAGING_CHECK};
use std::error::Error as StdError;
use std::fmt;
use std::num::{ParseFloatError, ParseIntError};
use std::path::PathBuf;

#[derive(Debug)]
pub(crate) enum EncoderError {
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
    pub(crate) fn job_code(&self) -> &'static str {
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

    pub(crate) fn job_details(&self) -> Option<String> {
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

pub(crate) fn truncate(value: &str, max_len: usize) -> String {
    if value.len() <= max_len {
        return value.to_string();
    }

    let mut end = max_len;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &value[..end])
}
