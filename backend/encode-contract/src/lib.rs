use serde::{Deserialize, Serialize};

pub const ACTION_ENCODE_TRACK: &str = "encodeTrack";
pub const ACTION_PACKAGING_CHECK: &str = "packagingCheck";
pub const DRAFT_ENCODE_PREFIX: &str = "draft/encodes/";
pub const ENCODE_ENTITY_TYPE: &str = "encodeJob";
pub const ENCODE_JOB_KEY_PREFIX: &str = "jobs/";
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

/// Snapshot of an encode result, stamped onto a `DraftRecording` once the
/// corresponding `EncodeJob` reaches `Succeeded`. The recording itself
/// becomes the source of truth for "is this publishable?" — code that
/// asks the question should not need to read the job record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingEncodeOutput {
    pub job_id: String,
    pub bucket: String,
    pub prefix: String,
    pub finished_at: String,
    pub assets: Vec<AssetRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
}

impl RecordingEncodeOutput {
    pub fn from_succeeded_job(job: &EncodeJob) -> Option<Self> {
        if job.status != EncodeStatus::Succeeded {
            return None;
        }
        let finished_at = job.finished_at.clone()?;
        Some(Self {
            job_id: job.job_id.clone(),
            bucket: job.output.bucket.clone(),
            prefix: job.output.prefix.clone(),
            finished_at,
            assets: job.output.assets.clone(),
            duration_seconds: job.metadata.as_ref().map(|m| m.duration_seconds),
        })
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
    job_id: &str,
    bucket: impl Into<String>,
    include_lossless: bool,
) -> EncodeOutput {
    let prefix = format!("{DRAFT_ENCODE_PREFIX}{job_id}");
    let mut assets = vec![
        asset_ref(
            job_id,
            "hls",
            format!("{prefix}/hls/master.m3u8"),
            "application/vnd.apple.mpegurl",
        ),
        asset_ref(
            job_id,
            "aac_192",
            format!("{prefix}/hls/192k/index.m3u8"),
            "application/vnd.apple.mpegurl",
        ),
        asset_ref(
            job_id,
            "aac_320",
            format!("{prefix}/hls/320k/index.m3u8"),
            "application/vnd.apple.mpegurl",
        ),
        asset_ref(
            job_id,
            "metadata",
            format!("{prefix}/metadata.json"),
            "application/json",
        ),
    ];

    if include_lossless {
        assets.push(asset_ref(
            job_id,
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

fn asset_ref(job_id: &str, suffix: &str, path: String, mime_type: &str) -> AssetRef {
    AssetRef {
        asset_id: asset_id(job_id, suffix),
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

fn asset_id(job_id: &str, suffix: &str) -> String {
    let base = job_id.strip_prefix("job_").unwrap_or(job_id);
    let available = 96usize.saturating_sub(suffix.len() + 1);
    format!("asset_{}_{}", bounded_component(base, available), suffix)
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
mod tests {
    use super::*;

    #[test]
    fn builds_bounded_job_ids() {
        let long_recording = format!("recording_{}", "a".repeat(140));
        let job_id = build_job_id(&long_recording, "20260523t195530z");

        assert!(job_id.starts_with("job_"));
        assert!(job_id.len() <= 100);
        assert!(job_id.ends_with("_encode_20260523t195530z"));
    }

    #[test]
    fn creates_draft_only_output_assets() {
        let output = planned_output("job_so-we-sleep_01_encode_20260523", "media", true);

        assert_eq!(
            output.prefix,
            "draft/encodes/job_so-we-sleep_01_encode_20260523"
        );
        assert_eq!(output.assets.len(), 5);
        assert!(output
            .assets
            .iter()
            .all(|asset| asset.path.starts_with("draft/encodes/")));
        assert!(output
            .assets
            .iter()
            .any(|asset| asset.path.ends_with("/metadata.json")));
    }

    #[test]
    fn recording_encode_output_only_from_succeeded_jobs() {
        let output = planned_output("job_x_encode_20260523t195530z", "media", false);
        let mut job = EncodeJob::queued(
            "job_x_encode_20260523t195530z".to_string(),
            "song_x".to_string(),
            "recording_x".to_string(),
            "2026-05-23T19:55:30Z".to_string(),
            ObjectRef {
                bucket: "masters".to_string(),
                key: "masters/recording_x/source.wav".to_string(),
                version_id: None,
                etag: None,
            },
            output.clone(),
        );

        // Not yet succeeded
        assert!(RecordingEncodeOutput::from_succeeded_job(&job).is_none());

        job.mark_running("2026-05-23T19:55:31Z".to_string());
        assert!(RecordingEncodeOutput::from_succeeded_job(&job).is_none());

        job.mark_succeeded(
            "2026-05-23T19:55:42Z".to_string(),
            output.clone(),
            EncodeMetadata {
                duration_seconds: 215.4,
                codec_name: "pcm_s16le".to_string(),
                sample_rate_hz: 48_000,
                channels: 2,
                loudness: None,
            },
            FfmpegDetails {
                version: Some("ffmpeg 6.0".to_string()),
                args: vec!["-i".to_string()],
            },
        );

        let snapshot = RecordingEncodeOutput::from_succeeded_job(&job).expect("succeeded job");
        assert_eq!(snapshot.job_id, "job_x_encode_20260523t195530z");
        assert_eq!(snapshot.bucket, "media");
        assert_eq!(snapshot.prefix, output.prefix);
        assert_eq!(snapshot.finished_at, "2026-05-23T19:55:42Z");
        assert_eq!(snapshot.assets, output.assets);
        assert_eq!(snapshot.duration_seconds, Some(215.4));
    }

    #[test]
    fn state_transitions_add_timestamps_and_error() {
        let mut job = EncodeJob::queued(
            "job_x_encode_20260523t195530z".to_string(),
            "song_x".to_string(),
            "recording_x".to_string(),
            "2026-05-23T19:55:30Z".to_string(),
            ObjectRef {
                bucket: "masters".to_string(),
                key: "masters/recording_x/source.wav".to_string(),
                version_id: None,
                etag: None,
            },
            planned_output("job_x_encode_20260523t195530z", "media", false),
        );

        job.mark_running("2026-05-23T19:55:31Z".to_string());
        job.mark_failed(
            "2026-05-23T19:55:32Z".to_string(),
            "not_implemented",
            "not implemented",
            None,
        );

        assert_eq!(job.status, EncodeStatus::Failed);
        assert_eq!(job.started_at.as_deref(), Some("2026-05-23T19:55:31Z"));
        assert_eq!(job.finished_at.as_deref(), Some("2026-05-23T19:55:32Z"));
        assert_eq!(
            job.error.as_ref().unwrap().code.as_deref(),
            Some("not_implemented")
        );
    }
}
