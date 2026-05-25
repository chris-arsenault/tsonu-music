use encode_contract::{AssetRef, EncodeMetadata, EncodeOutput, EncodeStatus};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Serialize)]
#[serde(tag = "responseType", rename_all = "camelCase")]
pub enum EncoderResponse {
    PackagingCheck(PackagingCheck),
    EncodeJob(EncodeJobResponse),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodeJobResponse {
    pub(crate) ok: bool,
    pub(crate) job_id: String,
    pub(crate) job_key: String,
    pub(crate) status: EncodeStatus,
    pub(crate) message: String,
    pub(crate) assets: Vec<AssetRef>,
    pub(crate) metadata: Option<EncodeMetadata>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagingCheck {
    pub(crate) ok: bool,
    pub(crate) action: String,
    pub(crate) encoder_implemented: bool,
    pub(crate) message: String,
    pub(crate) ffmpeg: BinaryCheck,
    pub(crate) ffprobe: BinaryCheck,
    pub(crate) tmp_directory: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryCheck {
    pub(crate) name: &'static str,
    pub(crate) path: String,
    pub(crate) version_line: String,
}

#[derive(Debug)]
pub(crate) struct UploadedFile {
    pub(crate) file_size_bytes: u64,
    pub(crate) checksum_sha256: String,
}

#[derive(Debug)]
pub(crate) struct CommandOutput {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

#[derive(Debug)]
pub(crate) struct TranscodeResult {
    pub(crate) output: EncodeOutput,
    pub(crate) metadata: EncodeMetadata,
    pub(crate) ffmpeg_args: Vec<String>,
}

#[derive(Debug)]
pub(crate) struct WorkPaths {
    pub(crate) source: PathBuf,
    pub(crate) output_root: PathBuf,
}
