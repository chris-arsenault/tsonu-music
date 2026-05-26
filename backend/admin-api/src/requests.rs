use crate::{Visibility, WriteResult};
use encode_contract::EncodeJob;
use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub(crate) struct UploadFormat<'a> {
    pub(crate) extension: &'a str,
    pub(crate) format: &'a str,
    pub(crate) content_type: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadUrlRequest {
    pub(crate) recording_id: String,
    pub(crate) filename: String,
    #[serde(default)]
    pub(crate) content_type: Option<String>,
    #[serde(default)]
    pub(crate) expires_in_seconds: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadUrlResponse {
    pub(crate) bucket: String,
    pub(crate) key: String,
    pub(crate) url: String,
    pub(crate) method: &'static str,
    pub(crate) headers: UploadHeaders,
    pub(crate) expires_in_seconds: u64,
    pub(crate) source_master: SourceMasterDraft,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArtworkUploadUrlRequest {
    pub(crate) owner_type: ArtworkOwnerType,
    pub(crate) owner_id: String,
    pub(crate) filename: String,
    #[serde(default)]
    pub(crate) content_type: Option<String>,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) alt_text: String,
    #[serde(default)]
    pub(crate) expires_in_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ArtworkOwnerType {
    Release,
    Song,
}

impl ArtworkOwnerType {
    pub(crate) fn stable_id_prefix(&self) -> &'static str {
        match self {
            Self::Release => "release",
            Self::Song => "song",
        }
    }

    pub(crate) fn path_segment(&self) -> &'static str {
        match self {
            Self::Release => "releases",
            Self::Song => "songs",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArtworkUploadUrlResponse {
    pub(crate) bucket: String,
    pub(crate) key: String,
    pub(crate) url: String,
    pub(crate) method: &'static str,
    pub(crate) headers: UploadHeaders,
    pub(crate) expires_in_seconds: u64,
    pub(crate) artwork: ArtworkDraft,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArtworkDraft {
    pub(crate) asset_id: String,
    pub(crate) alt_text: String,
    pub(crate) sources: Vec<ArtworkSourceDraft>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArtworkSourceDraft {
    pub(crate) path: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) mime_type: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct UploadHeaders {
    #[serde(rename = "Content-Type")]
    pub(crate) content_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceMasterDraft {
    pub(crate) bucket: String,
    pub(crate) key: String,
    pub(crate) format: String,
    pub(crate) uploaded_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EncodeJobRequest {
    pub(crate) song_id: String,
    pub(crate) recording_id: String,
    #[serde(default)]
    pub(crate) job_id: Option<String>,
    #[serde(default)]
    pub(crate) include_lossless: Option<bool>,
    #[serde(default)]
    pub(crate) requested_by: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EncodeJobCreateResponse {
    pub(crate) job: EncodeJob,
    pub(crate) job_key: String,
    pub(crate) encoder_function_name: String,
    pub(crate) invocation_status_code: i32,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishRequest {
    #[serde(default)]
    pub(crate) visibility: Option<Visibility>,
    #[serde(default)]
    pub(crate) published_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishResponse {
    pub(crate) release_id: String,
    pub(crate) manifest_path: String,
    pub(crate) visibility: Visibility,
    pub(crate) file_ids: Vec<String>,
    pub(crate) release_write: WriteResult,
    pub(crate) draft_write: WriteResult,
    pub(crate) invalidation: CloudFrontInvalidationResult,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaintenanceReport {
    pub(crate) generated_at: String,
    pub(crate) stale_draft_recordings: Vec<StaleDraftRecording>,
    pub(crate) orphan_release_tracks: Vec<OrphanReleaseTrack>,
    pub(crate) stale_encode_jobs: Vec<StaleEncodeJob>,
    pub(crate) stale_media_prefixes: Vec<StaleMediaPrefix>,
    pub(crate) stale_published_songs: Vec<StalePublishedSong>,
    pub(crate) totals: MaintenanceTotals,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StaleDraftRecording {
    pub(crate) song_id: String,
    pub(crate) song_title: String,
    pub(crate) recording_id: String,
    pub(crate) recording_title: String,
    pub(crate) reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OrphanReleaseTrack {
    pub(crate) release_id: String,
    pub(crate) release_title: String,
    pub(crate) track_id: String,
    pub(crate) track_title: String,
    pub(crate) song_id: String,
    pub(crate) recording_id: String,
    pub(crate) reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StaleEncodeJob {
    pub(crate) job_id: String,
    pub(crate) song_id: String,
    pub(crate) recording_id: String,
    pub(crate) status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) requested_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) finished_at: Option<String>,
    pub(crate) reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StalePublishedSong {
    pub(crate) song_id: String,
    pub(crate) slug: String,
    pub(crate) title: String,
    pub(crate) reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StaleMediaPrefix {
    pub(crate) prefix: String,
    pub(crate) object_count: usize,
    pub(crate) size_bytes: u64,
    pub(crate) reason: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaintenanceTotals {
    pub(crate) stale_draft_recordings: usize,
    pub(crate) orphan_release_tracks: usize,
    pub(crate) stale_encode_jobs: usize,
    pub(crate) stale_media_prefixes: usize,
    pub(crate) stale_published_songs: usize,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaintenanceCleanupRequest {
    #[serde(default)]
    pub(crate) draft_recordings: Vec<MaintenanceDraftRecordingTarget>,
    #[serde(default)]
    pub(crate) release_tracks: Vec<MaintenanceReleaseTrackTarget>,
    #[serde(default)]
    pub(crate) encode_job_ids: Vec<String>,
    #[serde(default)]
    pub(crate) media_prefixes: Vec<String>,
    #[serde(default)]
    pub(crate) published_song_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaintenanceDraftRecordingTarget {
    pub(crate) song_id: String,
    pub(crate) recording_id: String,
}

#[derive(Debug, Clone, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaintenanceReleaseTrackTarget {
    pub(crate) release_id: String,
    pub(crate) track_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaintenanceCleanupResponse {
    pub(crate) deleted: MaintenanceCleanupCounts,
    pub(crate) report: MaintenanceReport,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaintenanceCleanupCounts {
    pub(crate) draft_recordings: usize,
    pub(crate) release_tracks: usize,
    pub(crate) encode_jobs: usize,
    pub(crate) media_prefixes: usize,
    pub(crate) published_songs: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudFrontInvalidationResult {
    pub(crate) distribution_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) invalidation_id: Option<String>,
    pub(crate) paths: Vec<String>,
}
