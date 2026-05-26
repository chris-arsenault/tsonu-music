use serde::{Deserialize, Serialize};

pub const ACTION_ENCODE_TRACK: &str = "encodeTrack";
pub const ACTION_PACKAGING_CHECK: &str = "packagingCheck";
pub const ENCODE_ENTITY_TYPE: &str = "encodeJob";
pub const ENCODE_JOB_KEY_PREFIX: &str = "jobs/";
pub const RECORDING_MEDIA_PREFIX: &str = "recordings/";
pub const SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EncodeJobEvent {
    pub action: String,
    pub job_key: String,
    pub job: EncodeJob,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EncodeJob {
    pub schema_version: u8,
    pub entity_type: String,
    pub job_id: String,
    pub song_id: String,
    pub recording_id: String,
    pub status: EncodeStatus,
    pub requested_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    pub input: ObjectRef,
    pub output: EncodeOutput,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ffmpeg: Option<FfmpegDetails>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<EncodeMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JobError>,
}

impl EncodeJob {
    pub fn queued(
        job_id: String,
        song_id: String,
        recording_id: String,
        requested_at: String,
        input: ObjectRef,
        output: EncodeOutput,
    ) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            entity_type: ENCODE_ENTITY_TYPE.to_string(),
            job_id,
            song_id,
            recording_id,
            status: EncodeStatus::Queued,
            requested_at,
            started_at: None,
            finished_at: None,
            input,
            output,
            ffmpeg: None,
            metadata: None,
            error: None,
        }
    }

    pub fn mark_running(&mut self, started_at: String) {
        self.status = EncodeStatus::Running;
        self.started_at = Some(started_at);
        self.finished_at = None;
        self.error = None;
    }

    pub fn mark_succeeded(
        &mut self,
        finished_at: String,
        output: EncodeOutput,
        metadata: EncodeMetadata,
        ffmpeg: FfmpegDetails,
    ) {
        self.status = EncodeStatus::Succeeded;
        if self.started_at.is_none() {
            self.started_at = Some(finished_at.clone());
        }
        self.finished_at = Some(finished_at);
        self.output = output;
        self.metadata = Some(metadata);
        self.ffmpeg = Some(ffmpeg);
        self.error = None;
    }

    pub fn mark_failed(
        &mut self,
        finished_at: String,
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<String>,
    ) {
        self.status = EncodeStatus::Failed;
        if self.started_at.is_none() {
            self.started_at = Some(finished_at.clone());
        }
        self.finished_at = Some(finished_at);
        self.error = Some(JobError {
            code: Some(code.into()),
            message: message.into(),
            details,
        });
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EncodeMetadata {
    pub duration_seconds: f64,
    pub codec_name: String,
    pub sample_rate_hz: u32,
    pub channels: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loudness: Option<LoudnessMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub integrated_lufs: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub true_peak_dbfs: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loudness_range_lu: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threshold_lufs: Option<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EncodeStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRef {
    pub bucket: String,
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    #[serde(rename = "etag", skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EncodeOutput {
    pub bucket: String,
    pub prefix: String,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub assets: Vec<AssetRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssetRef {
    pub asset_id: String,
    pub path: String,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checksum_sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RecordingFileKind {
    HlsMaster,
    HlsRendition,
    Download,
    Metadata,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RecordingFileQuality {
    Aac192,
    Aac320,
    FlacLossless,
}

/// Recording-owned generated media. This is the catalog-facing media model:
/// songs contain recordings, and recordings contain file ids/paths.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingFile {
    pub file_id: String,
    pub kind: RecordingFileKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<RecordingFileQuality>,
    pub path: String,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate_kbps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate_hz: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channels: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checksum_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingFileSet {
    pub files: Vec<RecordingFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
}

impl RecordingFileSet {
    pub fn from_succeeded_job(job: &EncodeJob) -> Option<Self> {
        if job.status != EncodeStatus::Succeeded {
            return None;
        }
        if !job
            .output
            .prefix
            .starts_with(&recording_files_root_prefix(&job.recording_id))
        {
            return None;
        }
        let finished_at = job.finished_at.clone()?;
        let metadata = job.metadata.as_ref();
        let mut files = Vec::new();

        if let Some(asset) = asset_by_relative_path(job, "hls/master.m3u8") {
            files.push(recording_file(
                asset,
                RecordingFileKind::HlsMaster,
                None,
                None,
                metadata,
                &finished_at,
            ));
        }
        if let Some(asset) = asset_by_relative_path(job, "hls/192k/index.m3u8") {
            files.push(recording_file(
                asset,
                RecordingFileKind::HlsRendition,
                Some(RecordingFileQuality::Aac192),
                Some(192),
                metadata,
                &finished_at,
            ));
        }
        if let Some(asset) = asset_by_relative_path(job, "hls/320k/index.m3u8") {
            files.push(recording_file(
                asset,
                RecordingFileKind::HlsRendition,
                Some(RecordingFileQuality::Aac320),
                Some(320),
                metadata,
                &finished_at,
            ));
        }
        if let Some(asset) = asset_by_relative_path(job, "lossless.flac") {
            files.push(recording_file(
                asset,
                RecordingFileKind::Download,
                Some(RecordingFileQuality::FlacLossless),
                None,
                metadata,
                &finished_at,
            ));
        }
        if let Some(asset) = asset_by_relative_path(job, "metadata.json") {
            files.push(recording_file(
                asset,
                RecordingFileKind::Metadata,
                None,
                None,
                None,
                &finished_at,
            ));
        }

        Some(Self {
            files,
            duration_seconds: metadata.map(|m| m.duration_seconds),
        })
    }
}

fn asset_by_relative_path<'a>(job: &'a EncodeJob, relative_path: &str) -> Option<&'a AssetRef> {
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

fn recording_file(
    asset: &AssetRef,
    kind: RecordingFileKind,
    quality: Option<RecordingFileQuality>,
    bitrate_kbps: Option<u32>,
    metadata: Option<&EncodeMetadata>,
    created_at: &str,
) -> RecordingFile {
    RecordingFile {
        file_id: asset.asset_id.clone(),
        kind,
        quality,
        path: asset.path.clone(),
        mime_type: asset.mime_type.clone(),
        bitrate_kbps,
        sample_rate_hz: metadata.map(|value| value.sample_rate_hz),
        channels: metadata.map(|value| value.channels),
        file_size_bytes: asset.file_size_bytes,
        checksum_sha256: asset.checksum_sha256.clone(),
        created_at: Some(created_at.to_string()),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JobError {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

pub fn encode_job_key(job_id: &str) -> String {
    format!("{ENCODE_JOB_KEY_PREFIX}{job_id}")
}

pub fn build_job_id(recording_id: &str, timestamp: &str) -> String {
    let track_suffix = recording_id
        .strip_prefix("recording_")
        .unwrap_or(recording_id);
    let suffix = bounded_component(
        track_suffix,
        96usize.saturating_sub("_encode_".len() + timestamp.len()),
    );
    format!("job_{suffix}_encode_{timestamp}")
}

pub fn planned_output(
    recording_id: &str,
    output_set_id: &str,
    bucket: impl Into<String>,
    include_lossless: bool,
) -> EncodeOutput {
    let prefix = recording_file_set_prefix(recording_id, output_set_id);
    let mut assets = vec![
        asset_ref(
            recording_id,
            output_set_id,
            "hls",
            format!("{prefix}/hls/master.m3u8"),
            "application/vnd.apple.mpegurl",
        ),
        asset_ref(
            recording_id,
            output_set_id,
            "aac_192",
            format!("{prefix}/hls/192k/index.m3u8"),
            "application/vnd.apple.mpegurl",
        ),
        asset_ref(
            recording_id,
            output_set_id,
            "aac_320",
            format!("{prefix}/hls/320k/index.m3u8"),
            "application/vnd.apple.mpegurl",
        ),
        asset_ref(
            recording_id,
            output_set_id,
            "metadata",
            format!("{prefix}/metadata.json"),
            "application/json",
        ),
    ];

    if include_lossless {
        assets.push(asset_ref(
            recording_id,
            output_set_id,
            "flac",
            format!("{prefix}/lossless.flac"),
            "audio/flac",
        ));
    }

    EncodeOutput {
        bucket: bucket.into(),
        prefix,
        assets,
    }
}

pub fn recording_files_root_prefix(recording_id: &str) -> String {
    format!("{RECORDING_MEDIA_PREFIX}{recording_id}/files/")
}

pub fn recording_file_set_prefix(recording_id: &str, output_set_id: &str) -> String {
    format!(
        "{}{}",
        recording_files_root_prefix(recording_id),
        bounded_component(output_set_id, 48)
    )
}

fn asset_ref(
    recording_id: &str,
    output_set_id: &str,
    suffix: &str,
    path: String,
    mime_type: &str,
) -> AssetRef {
    AssetRef {
        asset_id: file_id(recording_id, output_set_id, suffix),
        path,
        mime_type: mime_type.to_string(),
        file_size_bytes: None,
        checksum_sha256: None,
    }
}

pub fn planned_ffmpeg_args(
    input_key: &str,
    output: &EncodeOutput,
    include_lossless: bool,
) -> Vec<String> {
    let mut args = vec![
        "-i".to_string(),
        input_key.to_string(),
        "-map".to_string(),
        "0:a:0".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a:0".to_string(),
        "192k".to_string(),
        "-b:a:1".to_string(),
        "320k".to_string(),
        "-f".to_string(),
        "hls".to_string(),
        format!("{}/hls/master.m3u8", output.prefix),
    ];

    if include_lossless {
        args.extend([
            "-c:a".to_string(),
            "flac".to_string(),
            format!("{}/lossless.flac", output.prefix),
        ]);
    }

    args
}

fn file_id(recording_id: &str, output_set_id: &str, suffix: &str) -> String {
    let recording = recording_id
        .strip_prefix("recording_")
        .unwrap_or(recording_id);
    let base = format!("{recording}_{output_set_id}");
    let available = 96usize.saturating_sub(suffix.len() + 1);
    format!("file_{}_{}", bounded_component(&base, available), suffix)
}

fn bounded_component(value: &str, max_len: usize) -> String {
    let mut component = value
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_' || *c == '-')
        .take(max_len)
        .collect::<String>();

    while component.ends_with(['_', '-']) {
        component.pop();
    }

    if component.is_empty() {
        "x".to_string()
    } else {
        component
    }
}

#[cfg(test)]
mod tests;
