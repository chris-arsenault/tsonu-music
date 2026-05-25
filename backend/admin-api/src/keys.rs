use crate::{ApiError, DRAFT_RELEASE_PREFIX, DRAFT_SONG_PREFIX, PUBLIC_RECORDING_PREFIX};
use encode_contract::encode_job_key as contract_encode_job_key;

pub(crate) fn public_asset_path(
    draft_asset_path: &str,
    draft_prefix: &str,
    public_prefix: &str,
) -> Result<String, ApiError> {
    let relative = draft_asset_path.strip_prefix(draft_prefix).ok_or_else(|| {
        ApiError::bad_request(
            "invalid_encode_asset_path",
            format!("asset {draft_asset_path} is outside output prefix {draft_prefix}"),
        )
    })?;

    Ok(format!(
        "{}/{}",
        public_prefix.trim_end_matches('/'),
        relative.trim_start_matches('/')
    ))
}

pub(crate) fn public_key_for_draft_object(
    draft_prefix: &str,
    public_prefix: &str,
    source_key: &str,
) -> Result<String, ApiError> {
    public_asset_path(
        source_key,
        &ensure_trailing_slash(draft_prefix),
        public_prefix,
    )
}

pub(crate) fn ensure_trailing_slash(value: &str) -> String {
    format!("{}/", value.trim_end_matches('/'))
}

pub(crate) fn public_recording_media_prefix(recording_id: &str, job_id: &str) -> String {
    format!("{PUBLIC_RECORDING_PREFIX}{recording_id}/{job_id}")
}

pub(crate) fn published_release_api_path(release_slug: &str) -> String {
    format!("/catalog/releases/{release_slug}")
}
pub(crate) fn master_key(recording_id: &str, extension: &str) -> String {
    format!("masters/{recording_id}/source.{extension}")
}

pub(crate) fn draft_song_key(song_id: &str) -> String {
    format!("{DRAFT_SONG_PREFIX}{song_id}.json")
}

pub(crate) fn draft_release_key(release_id: &str) -> String {
    format!("{DRAFT_RELEASE_PREFIX}{release_id}.json")
}

pub(crate) fn encode_job_key(job_id: &str) -> String {
    contract_encode_job_key(job_id)
}
