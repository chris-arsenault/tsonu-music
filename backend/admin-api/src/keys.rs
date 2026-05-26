use crate::{DRAFT_RELEASE_PREFIX, DRAFT_SONG_PREFIX};
use encode_contract::encode_job_key as contract_encode_job_key;

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
