use crate::{Visibility, WriteResult};
use encode_contract::EncodeJob;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
    pub(crate) track_job_ids: HashMap<String, String>,
    #[serde(default)]
    pub(crate) published_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishResponse {
    pub(crate) release_id: String,
    pub(crate) manifest_path: String,
    pub(crate) visibility: Visibility,
    pub(crate) job_ids: Vec<String>,
    pub(crate) copied_object_count: usize,
    pub(crate) copied_keys: Vec<String>,
    pub(crate) release_write: WriteResult,
    pub(crate) draft_write: WriteResult,
    pub(crate) invalidation: CloudFrontInvalidationResult,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudFrontInvalidationResult {
    pub(crate) distribution_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) invalidation_id: Option<String>,
    pub(crate) paths: Vec<String>,
}
