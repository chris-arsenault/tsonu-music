use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftSong {
    pub(crate) schema_version: u8,
    pub(crate) entity_type: String,
    pub(crate) song_id: String,
    pub(crate) slug: String,
    pub(crate) title: String,
    pub(crate) artist_name: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) lyrics: Option<String>,
    #[serde(default)]
    pub(crate) credits: Option<Value>,
    #[serde(default)]
    pub(crate) tags: Option<Vec<String>>,
    pub(crate) recordings: Vec<DraftRecording>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftRecording {
    pub(crate) recording_id: String,
    pub(crate) slug: String,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) version_title: Option<String>,
    pub(crate) version_type: String,
    #[serde(default)]
    pub(crate) artist_name: Option<String>,
    #[serde(default)]
    pub(crate) duration_seconds: Option<f64>,
    pub(crate) explicit: bool,
    #[serde(default)]
    pub(crate) isrc: Option<String>,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) source_master: Option<DraftSourceMaster>,
    #[serde(default)]
    pub(crate) encode_job_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftRelease {
    pub(crate) schema_version: u8,
    pub(crate) entity_type: String,
    pub(crate) release_id: String,
    pub(crate) slug: String,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) subtitle: Option<String>,
    pub(crate) artist_name: String,
    pub(crate) release_kind: String,
    pub(crate) release_status: String,
    #[serde(default)]
    pub(crate) release_date: Option<String>,
    pub(crate) publish_state: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) copyright: Option<String>,
    #[serde(default)]
    pub(crate) artwork: Option<Value>,
    #[serde(default)]
    pub(crate) credits: Option<Value>,
    #[serde(default)]
    pub(crate) links: Option<Vec<ExternalLink>>,
    #[serde(default)]
    pub(crate) tags: Option<Vec<String>>,
    pub(crate) tracks: Vec<DraftReleaseTrack>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftReleaseTrack {
    pub(crate) track_id: String,
    pub(crate) song_id: String,
    pub(crate) recording_id: String,
    pub(crate) disc_number: u32,
    pub(crate) track_number: u32,
    pub(crate) slug: String,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) explicit: Option<bool>,
    #[serde(default)]
    pub(crate) isrc: Option<String>,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) credits: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftSourceMaster {
    pub(crate) bucket: String,
    pub(crate) key: String,
    #[serde(default)]
    pub(crate) version_id: Option<String>,
    #[serde(default, rename = "etag")]
    pub(crate) etag: Option<String>,
    #[serde(default)]
    pub(crate) format: Option<String>,
    #[serde(default)]
    pub(crate) uploaded_at: Option<String>,
    #[serde(default)]
    pub(crate) sample_rate_hz: Option<u32>,
    #[serde(default)]
    pub(crate) bit_depth: Option<u32>,
    #[serde(default)]
    pub(crate) channels: Option<u32>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Visibility {
    #[default]
    Public,
    Unlisted,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PublishedStatus {
    Published,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ReleaseEntityType {
    Release,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SongEntityType {
    Song,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CatalogEntityType {
    Catalog,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalLink {
    pub(crate) label: String,
    pub(crate) url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishedRelease {
    pub(crate) schema_version: u8,
    pub(crate) entity_type: ReleaseEntityType,
    pub(crate) release_id: String,
    pub(crate) slug: String,
    pub(crate) title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) subtitle: Option<String>,
    pub(crate) artist_name: String,
    pub(crate) release_kind: String,
    pub(crate) release_status: String,
    pub(crate) release_date: String,
    pub(crate) status: PublishedStatus,
    pub(crate) visibility: Visibility,
    pub(crate) published_at: String,
    #[serde(skip_serializing)]
    pub(crate) manifest_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) copyright: Option<String>,
    pub(crate) artwork: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) credits: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) links: Option<Vec<ExternalLink>>,
    #[serde(skip_serializing)]
    pub(crate) tags: Option<Vec<String>>,
    pub(crate) tracks: Vec<PublishedReleaseTrack>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishedReleaseTrack {
    pub(crate) track_id: String,
    pub(crate) song_id: String,
    pub(crate) recording_id: String,
    pub(crate) disc_number: u32,
    pub(crate) track_number: u32,
    pub(crate) slug: String,
    pub(crate) title: String,
    pub(crate) song_title: String,
    pub(crate) recording_title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) version_title: Option<String>,
    pub(crate) duration_seconds: f64,
    pub(crate) explicit: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) isrc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) credits: Option<Value>,
    pub(crate) playback: TrackPlayback,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrackPlayback {
    pub(crate) hls: PlaybackHls,
    pub(crate) formats: Vec<PlaybackFormat>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaybackHls {
    pub(crate) asset_id: String,
    pub(crate) path: String,
    pub(crate) mime_type: String,
    pub(crate) codecs: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaybackFormat {
    pub(crate) asset_id: String,
    pub(crate) kind: PlaybackFormatKind,
    pub(crate) quality: PlaybackQuality,
    pub(crate) path: String,
    pub(crate) mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) bitrate_kbps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) sample_rate_hz: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) bit_depth: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) channels: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) file_size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum PlaybackFormatKind {
    HlsRendition,
    Download,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum PlaybackQuality {
    Aac192,
    Aac320,
    FlacLossless,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishedSong {
    pub(crate) schema_version: u8,
    pub(crate) entity_type: SongEntityType,
    pub(crate) song_id: String,
    pub(crate) slug: String,
    pub(crate) title: String,
    pub(crate) artist_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) lyrics: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) credits: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tags: Option<Vec<String>>,
    pub(crate) placements: Vec<PublishedSongPlacement>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishedSongPlacement {
    pub(crate) release_id: String,
    pub(crate) release_slug: String,
    pub(crate) release_title: String,
    pub(crate) release_kind: String,
    pub(crate) track_id: String,
    pub(crate) track_slug: String,
    pub(crate) recording_id: String,
    pub(crate) track_number: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishedCatalog {
    pub(crate) schema_version: u8,
    pub(crate) entity_type: CatalogEntityType,
    pub(crate) generated_at: String,
    pub(crate) artist: CatalogArtist,
    pub(crate) releases: Vec<PublishedCatalogRelease>,
    pub(crate) songs: Vec<PublishedCatalogSong>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogArtist {
    pub(crate) name: String,
    pub(crate) slug: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishedCatalogRelease {
    pub(crate) release_id: String,
    pub(crate) slug: String,
    pub(crate) title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) subtitle: Option<String>,
    pub(crate) release_kind: String,
    pub(crate) release_status: String,
    pub(crate) release_date: String,
    pub(crate) status: PublishedStatus,
    pub(crate) visibility: Visibility,
    pub(crate) manifest_path: String,
    pub(crate) artwork: Value,
    pub(crate) track_count: usize,
    pub(crate) total_duration_seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) links: Option<Vec<ExternalLink>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishedCatalogSong {
    pub(crate) song_id: String,
    pub(crate) slug: String,
    pub(crate) title: String,
    pub(crate) artist_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tags: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteResult {
    pub(crate) bucket: String,
    pub(crate) key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) e_tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) version_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObjectList {
    pub(crate) bucket: String,
    pub(crate) prefix: String,
    pub(crate) objects: Vec<ObjectSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObjectSummary {
    pub(crate) key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) e_tag: Option<String>,
    pub(crate) size_bytes: i64,
}
